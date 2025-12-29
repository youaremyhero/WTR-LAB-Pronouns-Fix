// ==UserScript==
// @name         WTR-LAB PF Test
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      1.3.10
// @description  Uses a custom JSON glossary on Github to detect gender and changes pronouns on WTR-Lab for a better reading experience.
// @match        *://wtr-lab.com/en/novel/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wtr-lab.com
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @connect      githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";
  if (!location.hostname.endsWith("wtr-lab.com")) return;

  // ==========================================================
  // USER SETTINGS
  // ==========================================================
  const GLOSSARY_URL =
    "https://raw.githubusercontent.com/youaremyhero/WTR-LAB-Pronouns-Fix/main/glossary.template.json"; // duplicate this file to your Github repo and change the link

  const DEFAULT_CARRY_PARAGRAPHS = 2;
  const EARLY_PRONOUN_WINDOW = 160;
  const LOCAL_ANCHOR_WINDOW = 160;
  const MAX_NAMES_SHOWN = 3;

  const TERM_MEM_MAX_KEYS = 300;

  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v1";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000;

  const UI_KEY_MIN = "wtrpf_ui_min_v1";
  const UI_KEY_POS = "wtrpf_ui_pos_v1";
  const UI_KEY_ON  = "wtrpf_enabled_v1";

  const DRAFT_KEY_PREFIX = "wtrpf_draft_v1:";
  const TERM_MEM_KEY_PREFIX = "wtrpf_term_mem_v1:";
  const CHAPTER_STATE_KEY_PREFIX = "wtrpf_chapter_state_v1:";

  const SELF_MUTATION_COOLDOWN_MS = 450;

  const NAV_SWEEP_MS = 9000;
  const NAV_POLL_MS  = 250;
  const CHAPTER_MONITOR_MS = 350;      // watchdog interval
  const CHAPTER_MONITOR_WARMUP_MS = 12000; // optional: run more often right after load/nav


  const LONGPRESS_MS = 420;

  const CHAPTER_OBS_DEBOUNCE_MS = 180;

  // Post-render resilience (React re-render overwrite protection)
  const POST_SWEEP_DELAYS = [150, 450, 900, 1600, 2600];
  const APPLIED_SIG_KEY_PREFIX = "wtrpf_applied_sig_v1:"; // per novelKey

  // ==========================================================
  // Utilities
  // ==========================================================
  const SENT_PREFIX = String.raw`(^|[\r\n]+|[.!?…]\s+)(["'“‘(\[]\s*)?`;
  const LETTER = String.raw`\p{L}`;

  const RX_PRONOUN_MALE = /\b(he|him|his|himself)\b/gi;
  const RX_PRONOUN_FEMALE = /\b(she|her|hers|herself)\b/gi;

  const RX_ATTACK_CUES = /\b(knife|blade|sword|dagger|stab|stabs|stabbed|slash|slashed|strike|struck|hit|hits|punched|kicked|cut|pierce|pierced|neck|chest)\b/i;

  function caseLike(src, target) {
    if (!src) return target;
    if (src.toUpperCase() === src) return target.toUpperCase();
    if (src[0] === src[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1);
    return target.toLowerCase();
  }

  function normalizeWeirdSpaces(s) {
    return String(s || "").replace(/\u00A0|\u2009|\u202F/g, " ");
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function wordBoundaryRegex(phrase) {
  // Unicode-ish boundaries: not a letter/number/_ on either side
  const p = escapeRegExp(String(phrase || "").trim());
  if (!p) return null;
  return new RegExp(String.raw`(^|[^\p{L}\p{N}_])(${p})(?=[^\p{L}\p{N}_]|$)`, "giu");
  }
  
  function findAllMatches(rx, text, max = 20) {
    rx.lastIndex = 0;
    const out = [];
    let m;
    while ((m = rx.exec(text)) && out.length < max) out.push({ index: m.index, match: m[2] || m[0] });
    return out;
  }
  
  function scoreGenderInText(text, entries) {
    const s = normalizeWeirdSpaces(String(text || ""));
    const sL = s.toLowerCase();
  
    // Weight pronouns (weak signal), names/aliases (strong signal)
    const maleP = countMatches(RX_PRONOUN_MALE, s);
    const femP  = countMatches(RX_PRONOUN_FEMALE, s);
  
    // If paragraph contains only pronouns and no names, don’t “invent” a gender
    // (carry heuristics already handle this better)
    let anyNameHit = false;
  
    const candidates = []; // {gender, score, name}
    for (const [name, info] of entries) {
      const g = String(info?.gender || "").toLowerCase();
      if (g !== "male" && g !== "female") continue;
  
      const names = [name, ...(Array.isArray(info.aliases) ? info.aliases : [])]
        .filter(Boolean)
        .sort((a,b) => String(b).length - String(a).length);
  
      let hitScore = 0;
      let hitCount = 0;
  
      for (const n of names) {
        const rx = wordBoundaryRegex(n);
        if (!rx) continue;
  
        // match count (capped) so long paragraphs don’t explode CPU
        const matches = findAllMatches(rx, s, 12);
        if (!matches.length) continue;
  
        anyNameHit = true;
        hitCount += matches.length;
  
        // Proximity pronoun score: look around each name match
        for (const mm of matches) {
          const center = mm.index;
          const lo = Math.max(0, center - 180);
          const hi = Math.min(s.length, center + 260);
          const window = s.slice(lo, hi);
  
          // Pronouns in the local window matter more than the whole paragraph
          const mLocal = countMatches(RX_PRONOUN_MALE, window);
          const fLocal = countMatches(RX_PRONOUN_FEMALE, window);
  
          // Base for “name present”
          hitScore += 6;
  
          // Local pronouns bias the name
          hitScore += (g === "male" ? mLocal : fLocal) * 2;
          hitScore -= (g === "male" ? fLocal : mLocal) * 1;
        }
      }
  
      if (hitCount > 0) {
        // Small global pronoun nudge (kept weak)
        const globalBias = (g === "male" ? maleP : femP) - (g === "male" ? femP : maleP);
        hitScore += clamp(globalBias, -2, 3);
        candidates.push({ gender: g, score: hitScore, name });
      }
    }
  
      if (!anyNameHit) return null;
      if (!candidates.length) return null;
    
      candidates.sort((a,b) => b.score - a.score);
      const best = candidates[0];
      const second = candidates[1];
    
      // Require separation so we don’t flip-flop in mixed paragraphs
      if (second && (best.score - second.score) < 4) return null;
      if (best.score < 6) return null;
    
      return best.gender;
    }

  function isSceneBreak(t) {
    const s = (t || "").trim();
    return (s === "***" || s === "— — —" || /^(\*{3,}|-{3,}|={3,}|_{3,})$/.test(s));
  }

  function startsWithPronoun(t) {
    const s = (t || "").trim();
    return /^["'“‘(\[]?\s*(she|he|her|him|his|hers|herself|himself)\b/i.test(s);
  }

  function pronounAppearsEarly(t, limit = EARLY_PRONOUN_WINDOW) {
    const s = (t || "").trim();
    return /\b(she|he|her|him|his|hers|herself|himself)\b/i.test(s.slice(0, limit));
  }

  function countMatches(rx, text) {
    rx.lastIndex = 0;
    const m = String(text).match(rx);
    return m ? m.length : 0;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function getUrlChapterId() {
    const m = location.href.match(/\/chapter-(\d+)(?:\/|$|\?)/i);
    return m ? `chapter-${m[1]}` : "unknown";
  }

  function getDomChapterId(root) {
    // Preferred: tracker element (your screenshot confirms this exists)
    const tracker =
      document.querySelector(".chapter-tracker.active[data-chapter-no]") ||
      root?.closest?.(".chapter-infinite-reader")?.querySelector?.(".chapter-tracker.active[data-chapter-no]") ||
      null;
  
    const no = tracker?.getAttribute?.("data-chapter-no");
    if (no && /^\d+$/.test(no)) return `chapter-${no}`;
  
    // Fallback: tracker id="tracker-776"
    const tid = tracker?.id || "";
    const m1 = tid.match(/tracker-(\d+)/i);
    if (m1) return `chapter-${m1[1]}`;
  
    // Fallback: if they ever put chapter number on container ids like id="chapter-775"
    const host =
      root?.closest?.("[id^='chapter-']") ||
      root?.querySelector?.("[id^='chapter-']") ||
      null;
    const hid = host?.id || "";
    const m2 = hid.match(/chapter-(\d+)/i);
    if (m2) return `chapter-${m2[1]}`;
  
    // Legacy fallback (your old approach) — keep last
    const el = root?.closest?.("[data-chapter-id]") || root?.querySelector?.("[data-chapter-id]");
    const id = el?.getAttribute?.("data-chapter-id");
    if (id) return id;
  
    return "unknown";
  }

  // cheap 32-bit hash (fast enough for innerText)
  function hash32(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

      /* =========================
       A) NEW: Fast sampled text + signature
       ========================= */
    
    function getSampledText(root, { head = 6, tail = 2 } = {}) {
      if (!root) return "";
      const blocks = getTextBlocks(root);
      if (!blocks.length) return "";
    
      const pick = [];
      const n = blocks.length;
    
      const h = Math.min(head, n);
      for (let i = 0; i < h; i++) pick.push(blocks[i]);
    
      const t = Math.min(tail, Math.max(0, n - h));
      for (let i = n - t; i < n; i++) if (i >= 0) pick.push(blocks[i]);
    
      return pick
        .map(b => normalizeWeirdSpaces((b.textContent || "").trim()))
        .filter(Boolean)
        .join("\n");
    }
    
    function approxChapterMetrics(root) {
      const blocks = getTextBlocks(root);
      let totalLen = 0;
      // cheap-ish length sum
      for (const b of blocks) totalLen += ((b.innerText || "").length || 0);
      return { blocksCount: blocks.length, totalLen };
    }

    // REPLACED chapterSignature(root) with this cheaper version
  function chapterSignature(root, forcedCid = null) {
    if (!root) return "";
    const cid = forcedCid || getChapterId(root) || "unknown";
    const { blocksCount, totalLen } = approxChapterMetrics(root);
    const sampled = getSampledText(root, { head: 6, tail: 2 });
    const h = sampled ? hash32(sampled) : "0";
    return `${cid}|b:${blocksCount}|len:${totalLen}|h:${h}`;
  }

  function appliedSigKey(novelKey) {
    return APPLIED_SIG_KEY_PREFIX + novelKey;
  }
  function loadAppliedSigMap(novelKey) {
    try {
      return JSON.parse(sessionStorage.getItem(appliedSigKey(novelKey)) || "{}");
    } catch {
      return {};
    }
  }
  function saveAppliedSigMap(novelKey, map) {
    sessionStorage.setItem(appliedSigKey(novelKey), JSON.stringify(map || {}));
  }
  function getAppliedSig(novelKey, chapterId) {
    const m = loadAppliedSigMap(novelKey);
    return String(m?.[chapterId] || "");
  }
  function setAppliedSig(novelKey, chapterId, sig) {
    const m = loadAppliedSigMap(novelKey);
    m[chapterId] = String(sig || "");
    saveAppliedSigMap(novelKey, m);
  }


  // ==========================================================
  // Pronoun replacement
  // ==========================================================
  function replacePronounsSmart(text, direction) {
    text = normalizeWeirdSpaces(text);
    const original = text;
    let changed = 0;

    const rep = (rx, toFn) => {
      text = text.replace(rx, (m, ...rest) => {
        const out = toFn(m, ...rest);
        if (out !== m) changed++;
        return out;
      });
    };

    if (direction === "toFemale") {
      rep(/\bhim[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "herself"));
    } else {
      rep(/\bher[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "himself"));
    }

    if (direction === "toMale") {
      rep(new RegExp(SENT_PREFIX + `(she)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "He")}`);
      rep(new RegExp(SENT_PREFIX + `(herself)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Himself")}`);
      rep(new RegExp(SENT_PREFIX + `(hers)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "His")}`);
      rep(new RegExp(SENT_PREFIX + `(her)\\b(?=\\s+${LETTER})`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "His")}`);
      rep(new RegExp(SENT_PREFIX + `(her)\\b(?!\\s+${LETTER})`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Him")}`);
    } else {
      rep(new RegExp(SENT_PREFIX + `(he)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "She")}`);
      rep(new RegExp(SENT_PREFIX + `(himself)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Herself")}`);
      rep(new RegExp(SENT_PREFIX + `(him)\\b`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Her")}`);
      rep(new RegExp(SENT_PREFIX + `(his)\\b(?=\\s+${LETTER})`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Her")}`);
      rep(new RegExp(SENT_PREFIX + `(his)\\b(?!\\s+${LETTER})`, "giu"), (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Hers")}`);
    }

    if (direction === "toMale") {
      rep(/\bshe\b/giu, (m) => caseLike(m, "he"));
      rep(/\bherself\b/giu, (m) => caseLike(m, "himself"));
      rep(/\bhers\b/giu, (m) => caseLike(m, "his"));
      rep(new RegExp(String.raw`\bher\b(?=\s+${LETTER})`, "giu"), (m) => caseLike(m, "his"));
      rep(/\bher\b/giu, (m) => caseLike(m, "him"));
    } else {
      rep(/\bhe\b/giu, (m) => caseLike(m, "she"));
      rep(/\bhimself\b/giu, (m) => caseLike(m, "herself"));
      rep(/\bhim\b/giu, (m) => caseLike(m, "her"));
      rep(new RegExp(String.raw`\bhis\b(?=\s+${LETTER})`, "giu"), (m) => caseLike(m, "her"));
      rep(/\bhis\b/giu, (m) => caseLike(m, "hers"));
    }

    return { text, changed: text === original ? 0 : changed };
  }

  function conservativeShouldApply(region, gender) {
    const maleCount = countMatches(RX_PRONOUN_MALE, region);
    const femCount = countMatches(RX_PRONOUN_FEMALE, region);
    if (gender === "male") return femCount > 0;
    return maleCount > 0;
  }

  // ==========================================================
  // Anchored fixes (kept from your base)
  // ==========================================================
  function getSentenceEndIndex(s, start, maxExtra = 320) {
    const limit = Math.min(s.length, start + maxExtra);
    for (let i = start; i < limit; i++) {
      const ch = s[i];
      if (ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === "\n") return i + 1;
    }
    return Math.min(s.length, start + maxExtra);
  }

  function detectPassiveAgentGender(text, entries) {
    const s = text;
    for (const [name, info] of entries) {
      const g = String(info.gender || "").toLowerCase();
      if (g !== "male" && g !== "female") continue;
      const nEsc = escapeRegExp(name);
      const rx = new RegExp(String.raw`\b(?:was|were|is|are|been)\b[^.?!\n]{0,80}\bby\s+${nEsc}\b`, "i");
      if (rx.test(s)) return g;
    }
    return null;
  }

  function detectDialogueSpeakerGender(text, entries) {
    const s = text;
    const found = [];
    for (const [name, info] of entries) {
      const g = String(info.gender || "").toLowerCase();
      if (g !== "male" && g !== "female") continue;
      const nEsc = escapeRegExp(name);

      const rx1 = new RegExp(String.raw`["“][^"”]{3,}["”]\s*(?:,?\s*)?(?:said|asked|shouted|whispered|replied|muttered|yelled)\s+${nEsc}\b`, "i");
      const rx2 = new RegExp(String.raw`\b${nEsc}\b\s*(?:said|asked|shouted|whispered|replied|muttered|yelled)\s*(?:,?\s*)?["“]`, "i");

      if (rx1.test(s) || rx2.test(s)) found.push(g);
    }
    if (!found.length) return null;
    return found.every(x => x === found[0]) ? found[0] : null;
  }

  function applyAnchoredFixes(text, entries, opts) {
    let changed = 0;
    let s = normalizeWeirdSpaces(text);

    const { verbBasedWindow = false, passiveVoice = false, onlyChangeIfWrong = false } = opts;

    for (const [name, info] of entries) {
      const gender = String(info.gender || "").toLowerCase();
      if (gender !== "male" && gender !== "female") continue;

      const strictPossessive = !!info.strictPossessive;

      const allNames = [name, ...(Array.isArray(info.aliases) ? info.aliases : [])]
        .filter(Boolean)
        .sort((a, b) => String(b).length - String(a).length);

      const dir = (gender === "female") ? "toFemale" : "toMale";

      for (const n of allNames) {
        const nEsc = escapeRegExp(n);
        const re = new RegExp(String.raw`\b${nEsc}\b`, "g");
        let m;

        while ((m = re.exec(s)) !== null) {
          const start = m.index;

          const baseEnd = verbBasedWindow
            ? getSentenceEndIndex(s, start + n.length, 360)
            : Math.min(s.length, start + n.length + LOCAL_ANCHOR_WINDOW);

          let end = baseEnd;
          if (strictPossessive) end = Math.min(s.length, Math.max(end, start + n.length + 220));

          const region = s.slice(start, end);
          if (onlyChangeIfWrong && !conservativeShouldApply(region, gender)) continue;

          let out = replacePronounsSmart(region, dir);

          if (passiveVoice) {
            const gAgent = detectPassiveAgentGender(region, entries);
            if (gAgent) {
              const d2 = (gAgent === "female") ? "toFemale" : "toMale";
              const out2 = replacePronounsSmart(out.text, d2);
              out = { text: out2.text, changed: out.changed + out2.changed };
            }
          }

          if (out.text !== region) {
            s = s.slice(0, start) + out.text + s.slice(end);
            changed += Math.max(1, out.changed);
            re.lastIndex = start + out.text.length;
          }
        }
      }
    }

    return { text: s, changed };
  }

  // ==========================================================
  // Term memory + patches (unchanged)
  // ==========================================================
  function getNovelKeyFromURL() {
    const m = location.href.match(/wtr-lab\.com\/en\/novel\/(\d+)\//i);
    return m ? `wtr-lab.com/en/novel/${m[1]}/` : "wtr-lab.com/en/novel/";
  }
  function getChapterId(root) {
  const domCid = getDomChapterId(root);
  if (domCid && domCid !== "unknown") return domCid;

  const urlCid = getUrlChapterId();
  if (urlCid && urlCid !== "unknown") return urlCid;

  return "unknown";
}


  function termMemKey(novelKey) { return TERM_MEM_KEY_PREFIX + novelKey; }

  function loadTermMemory(novelKey) {
    try { return JSON.parse(localStorage.getItem(termMemKey(novelKey)) || "{}"); }
    catch { return {}; }
  }
  function saveTermMemory(novelKey, mem) {
    try {
      const keys = Object.keys(mem || {});
      if (keys.length > TERM_MEM_MAX_KEYS) {
        const excess = keys.length - TERM_MEM_MAX_KEYS;
        for (let i = 0; i < excess; i++) delete mem[keys[i]];
      }
    } catch {}
    localStorage.setItem(termMemKey(novelKey), JSON.stringify(mem || {}));
  }

  function applyTermPatches(root, cfgTerms, mem, opts) {
    const enforcePlainText = !!opts?.enforcePinnedTermsOnPlainText;
    const map = Object.assign({}, cfgTerms || {}, mem || {});
    let changed = 0;

    const spans = Array.from(root.querySelectorAll("span.text-patch.system[data-hash]"));
    for (const sp of spans) {
      const h = sp.getAttribute("data-hash");
      if (!h) continue;
      const rec = map[h];
      if (!rec || !rec.preferred) continue;

      const desired = String(rec.preferred);
      if (sp.textContent !== desired) {
        sp.textContent = desired;
        changed++;
      }
    }

    if (enforcePlainText) {
      const pinned = [];
      for (const [, rec] of Object.entries(map)) {
        if (!rec || !rec.preferred || !rec.pinned) continue;
        const al = Array.isArray(rec.aliases) ? rec.aliases : [];
        pinned.push({ preferred: String(rec.preferred), variants: [String(rec.preferred), ...al].filter(Boolean) });
      }
      if (pinned.length) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const p = node.parentNode;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.nodeName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
            const el = p.nodeType === 1 ? p : p.parentElement;
            if (el && el.closest && el.closest("a, button, input, textarea, select")) return NodeFilter.FILTER_REJECT;
            if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });

        while (walker.nextNode()) {
          const node = walker.currentNode;
          const t = node.nodeValue;
          let t2 = t;

          for (const it of pinned) {
            for (const v of it.variants) {
              if (!v) continue;
              const rx = new RegExp(String.raw`(^|[^\p{L}\p{N}_])${escapeRegExp(v)}([^\p{L}\p{N}_]|$)`, "giu");
              t2 = t2.replace(rx, (m, p1, p2) => `${p1}${it.preferred}${p2}`);
            }
          }

          if (t2 !== t) {
            node.nodeValue = t2;
            changed++;
          }
        }
      }
    }

    return changed;
  }

  // ==========================================================
  // Draft helpers (PER-NOVEL)
  // ==========================================================
  function draftKeyFor(novelKey) {
    // novelKey is like "wtr-lab.com/en/novel/14370/"
    const nk = novelKey || getNovelKeyFromURL();
    return DRAFT_KEY_PREFIX + nk;
  }
  
  function loadDraft(novelKey) {
    try {
      return JSON.parse(localStorage.getItem(draftKeyFor(novelKey)) || '{"items":[],"snippet":""}');
    } catch {
      return { items: [], snippet: "" };
    }
  }
  
  function saveDraft(novelKey, d) {
    localStorage.setItem(draftKeyFor(novelKey), JSON.stringify(d || { items: [], snippet: "" }));
  }

  function oneLineCharacterSnippet(name, gender, aliases) {
    const obj = { gender: String(gender) };
    if (Array.isArray(aliases) && aliases.length) obj.aliases = aliases;
    const inner = JSON.stringify(obj);
    return `"${name}": ${inner},`;
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
    function findContentRoot() {
      // 1) Prefer ACTIVE chapter in infinite reader mode (or when tracker exists)
      const activeTracker = document.querySelector(".chapter-tracker.active[data-chapter-no]");
      const no = activeTracker?.getAttribute?.("data-chapter-no");
    
      if (no && /^\d+$/.test(no)) {
        // Common patterns observed on WTR-like readers
        const idCandidates = [
          `#chapter-${no}`,
          `#tracker-${no}`,
          `[data-chapter-no="${no}"]`,
          `[data-chapter-id="chapter-${no}"]`,
        ];
    
        for (const sel of idCandidates) {
          const host = document.querySelector(sel);
          if (!host) continue;
    
          // Try to find the text container inside this chapter host
          const cb =
            host.querySelector?.(".chapter-body") ||
            host.closest?.(".chapter-body") ||
            host.querySelector?.("article, main, section") ||
            host;
    
          if (cb && (cb.innerText || "").trim().length > 200) return cb;
        }
    
        // Fallback: pick the chapter-body closest to the active tracker
        const near =
          activeTracker.closest?.(".chapter-infinite-reader, .chapter, article, main, section") ||
          activeTracker.parentElement;
        const cbNear = near?.querySelector?.(".chapter-body");
        if (cbNear && (cbNear.innerText || "").trim().length > 200) return cbNear;
      }
    

      // 2) Infinite mode fallback: newest chapter-body that isn't patched yet
      const inf = document.querySelector(".chapter-infinite-reader");
      if (inf) {
        const bodies = Array.from(inf.querySelectorAll(".chapter-body"));
        const newestUnpatched = bodies.reverse().find(el => {
          const ok = (el.innerText || "").trim().length > 200;
          const already = el.dataset?.wtrpfPatchedChapter; // your root marker
          return ok && !already;
        });
        if (newestUnpatched) return newestUnpatched;
      
        // fallback to last good if all patched
        const lastGood = bodies.reverse().find(el => (el.innerText || "").trim().length > 200);
        if (lastGood) return lastGood;
      }
    
      // 3) Single chapter fallback (original behavior)
      const cb = document.querySelector(".chapter-body");
      if (cb) return cb;
    
      const likely = document.querySelector("[data-chapter-id]")?.closest?.(".chapter-body, .chapter, main, article");
      if (likely) return likely;
    
      const candidates = Array.from(document.querySelectorAll(
        "article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section"
      ));
      let best = null, bestScore = 0;
      for (const el of candidates) {
        const pCount = el.querySelectorAll("p").length;
        const textLen = (el.innerText || "").trim().length;
        const score = (pCount * 1200) + textLen;
        if (score > bestScore && textLen > 300) { bestScore = score; best = el; }
      }
      return best || null;
    }

  const SKIP_CLOSEST = [
    "header","nav","footer","aside","form",
    "button","input","textarea","select",
    "[role='navigation']",
    ".breadcrumbs",".breadcrumb",".toolbar",".tools",".tool",
    ".pagination",".pager",".share",".social",
    ".menu",".navbar",".nav",".btn",".button"
  ].join(",");

  function isSkippable(el) {
    return !!(el && el.closest && el.closest(SKIP_CLOSEST));
  }

  function getTextBlocks(root) {
    const blocks = Array.from(root.querySelectorAll("p, blockquote, li"));
    return blocks.filter(b => {
      if (isSkippable(b)) return false;
      const t = (b.innerText || "").trim();
      return t.length >= 20;
    });
  }

  function contentReady(root) {
    if (!root) return false;
    const blocks = getTextBlocks(root);
    const textLen = (root.innerText || "").trim().length;
    return (blocks.length >= 2 && textLen >= 200);
  }

  function getInfiniteHost() {
  return document.querySelector(".chapter-infinite-reader") || null;
}

  function getAllChapterBodiesInInfinite() {
    const host = getInfiniteHost();
    if (!host) return [];
    return Array.from(host.querySelectorAll(".chapter-body"))
      .filter(b => (b.innerText || "").trim().length > 200);
  }
  
  function getChapterIdForBody(body) {
    // Prefer tracker inside / near this body:
    const tracker =
      body.querySelector?.(".chapter-tracker.active[data-chapter-no]") ||
      body.querySelector?.(".chapter-tracker[data-chapter-no]") ||
      body.closest?.(".chapter, .chapter-infinite-reader")?.querySelector?.(".chapter-tracker.active[data-chapter-no]");
  
    const no = tracker?.getAttribute?.("data-chapter-no");
    if (no && /^\d+$/.test(no)) return `chapter-${no}`;
  
    // Try id="tracker-776"
    const tid = tracker?.id || "";
    const m1 = tid.match(/tracker-(\d+)/i);
    if (m1) return `chapter-${m1[1]}`;
  
    // Fall back to DOM chapter id logic using this body as root
    const domCid = getDomChapterId(body);
    if (domCid && domCid !== "unknown") return domCid;
  
    // As last resort: URL
    const urlCid = getUrlChapterId();
    if (urlCid && urlCid !== "unknown") return urlCid;
  
    return "unknown";
  }

  // SWEEPER HELPERS 
  // Mark bodies we’ve already fully handled (separate from your per-block markers)
  function bodyIsSwept(body) {
    return body?.dataset?.wtrpfSwept === "1";
  }
  function markBodySwept(body) {
    if (body?.dataset) body.dataset.wtrpfSwept = "1";
  }

    // Mark bodies we have queued for a run (prevents re-queue spam)
  function bodyIsQueued(body) {
    return body?.dataset?.wtrpfQueued === "1";
  }
  function markBodyQueued(body) {
    if (body?.dataset) body.dataset.wtrpfQueued = "1";
  }
  function clearBodyQueued(body) {
    if (body?.dataset) delete body.dataset.wtrpfQueued;
  }

    // ==========================================================
  // Chapter-page gate (NEW)
  // ==========================================================
    function isLikelyChapterUrl() {
      // Fast path: your chapters use /chapter-<n>
      return /\/chapter-\d+(?:\/|$|\?)/i.test(location.href);
    }
  
  function isChapterReadingPage() {
    // 1) URL is authoritative and fast
    if (isLikelyChapterUrl()) return true;
  
    // 2) DOM-authoritative signals (NO contentReady / scoring fallbacks)
    // These should not exist on TOC/description pages.
    if (document.querySelector(".chapter-infinite-reader")) return true;
    if (document.querySelector(".chapter-body")) return true;
    if (document.querySelector(".chapter-tracker.active[data-chapter-no]")) return true;
  
    return false;
  }

  // ==========================================================
  // Root Observer Manager (NEW)
  // ==========================================================
  function createRootObserverManager(onRootChange) {
    let currentRoot = null;
    let rootObserver = null;
  
    function disconnect() {
      if (rootObserver) {
        try { rootObserver.disconnect(); } catch {}
        rootObserver = null;
      }
    }

    // add a short retry when findContentRoot() returns null
    let resolveRetryTimer = null;
    function scheduleResolveRetry() {
      if (resolveRetryTimer) return;
      resolveRetryTimer = setTimeout(() => {
        resolveRetryTimer = null;
        resolve();
      }, 180);
    }

    function observe(root) {
      disconnect();
      if (!root) return;
  
      currentRoot = root;
  
      rootObserver = new MutationObserver((muts) => {
        // NEW: if React/SPA detached the root without a clean "removedNodes includes root" signal
        if (currentRoot && !document.contains(currentRoot)) {
          resolve();
          return;
        }
      
        for (const m of muts) {
          if (m.type !== "childList") continue;
      
          // Keep your original strict check too (still useful when it does happen)
          if (Array.from(m.removedNodes || []).includes(currentRoot)) {
            resolve();
            return;
          }
        }
      });

      // Observe parent, not the root itself (React replaces children)
      const parent = root.parentNode || document.body;
      rootObserver.observe(parent, { childList: true });
    }
  
    function resolve() {
      const newRoot = findContentRoot();
    
      // NEW: during remounts findContentRoot can be temporarily null — retry once shortly
      if (!newRoot) {
        scheduleResolveRetry();
        return false;
      }
    
      if (newRoot === currentRoot) return true;
    
      observe(newRoot);
      onRootChange(newRoot);
      return true;
    }

    // Initial resolve
    resolve();
  
    return {
      resolve,
      getRoot: () => currentRoot,
      disconnect
    };
  }

  // ==========================================================
  // Root manager instance (ADD THIS)
  // ==========================================================
  const rootManager = createRootObserverManager((newRoot) => {
    console.log("[WTRPF] Root changed:", newRoot);
    try { window.__wtrpf_ui?.syncPillVisibility?.(); } catch {}
    // Do NOT auto-run here; nav sweep controls execution
  });

  // ==========================================================
  // Character detection
  // ==========================================================

  function detectCharactersOnPage(root, entries) {
  const hay = normalizeWeirdSpaces(root?.innerText || "").toLowerCase();
  const detected = [];
  for (const [name, info] of entries) {
    const names = [name, ...(Array.isArray(info.aliases) ? info.aliases : [])]
      .filter(Boolean)
      .map(s => normalizeWeirdSpaces(String(s)).toLowerCase());

    if (names.some(n => n && hay.includes(n))) detected.push([name, info]);
  }
  return detected;
}


  // ==========================================================
  // Glossary helpers
  // ==========================================================
  function pickKey(glossary) {
    const url = location.href;
    const keys = Object.keys(glossary || {}).filter(k => k !== "default");
    const matches = keys.filter(k => url.includes(k)).sort((a, b) => b.length - a.length);
    return matches[0] || "default";
  }

  // ==========================================================
  // Reliable glossary loader (+ cache)
  // ==========================================================
  function loadGlossaryJSON(url) {
    return new Promise((resolve, reject) => {
      const cached = localStorage.getItem(GLOSSARY_CACHE_KEY);
      const cachedTs = Number(localStorage.getItem(GLOSSARY_CACHE_TS) || "0");
      const cacheFresh = cached && cachedTs && (Date.now() - cachedTs) <= GLOSSARY_CACHE_TTL_MS;

      const useCache = () => {
        if (!cached) return reject(new Error("Glossary error"));
        try { resolve(JSON.parse(cached)); }
        catch { reject(new Error("Glossary error")); }
      };

      if (cacheFresh) return useCache();

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers: { "Cache-Control": "no-cache" },
          onload: (r) => {
            try {
              if (r.status < 200 || r.status >= 300) {
                if (cached) return useCache();
                return reject(new Error("Glossary error"));
              }
              localStorage.setItem(GLOSSARY_CACHE_KEY, r.responseText);
              localStorage.setItem(GLOSSARY_CACHE_TS, String(Date.now()));
              resolve(JSON.parse(r.responseText));
            } catch {
              if (cached) return useCache();
              reject(new Error("Glossary error"));
            }
          },
          onerror: () => {
            if (cached) return useCache();
            reject(new Error("Glossary error"));
          }
        });
        return;
      }

      fetch(url, { cache: "no-store" })
        .then(async (res) => {
          const txt = await res.text();
          if (!res.ok) throw new Error("Glossary error");
          localStorage.setItem(GLOSSARY_CACHE_KEY, txt);
          localStorage.setItem(GLOSSARY_CACHE_TS, String(Date.now()));
          return JSON.parse(txt);
        })
        .then(resolve)
        .catch(() => {
          if (cached) return useCache();
          reject(new Error("Glossary error"));
        });
    });
  }

  // ==========================================================
  // Node replacement counting
  // ==========================================================
  function replaceInTextNodes(blockEl, fnReplace) {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        const el = parent.nodeType === 1 ? parent : parent.parentElement;
        if (el && el.closest && el.closest("a, button, input, textarea, select")) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let changed = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const before = node.nodeValue;
      const out = fnReplace(before);
      if (!out || typeof out !== "object") continue;

      const after = out.text ?? before;
      let delta = Number(out.changed || 0);

      if (after !== before) {
        if (delta <= 0) {
          const b0 = countMatches(RX_PRONOUN_MALE, before) + countMatches(RX_PRONOUN_FEMALE, before);
          const b1 = countMatches(RX_PRONOUN_MALE, after) + countMatches(RX_PRONOUN_FEMALE, after);
          delta = Math.max(1, Math.abs(b0 - b1));
        }
        node.nodeValue = after;
        changed += delta;
      }
    }
    return changed;
  }

  // ==========================================================
  // UI (same behavior as your requirements)
  // ==========================================================
      function makeUI() {
        let savedPos = {};
        try { savedPos = JSON.parse(localStorage.getItem(UI_KEY_POS) || "{}"); }
        catch { savedPos = {}; localStorage.removeItem(UI_KEY_POS); }
      
        const enabledInit = localStorage.getItem(UI_KEY_ON);
        if (enabledInit !== "0" && enabledInit !== "1") localStorage.setItem(UI_KEY_ON, "1");
      
        function enabled() { return localStorage.getItem(UI_KEY_ON) !== "0"; }
        function setEnabled(v) { localStorage.setItem(UI_KEY_ON, v ? "1" : "0"); }
      
        let glossaryOk = true;
      
        // Summary state
        let charactersCount = 0;
        let charactersList3 = "";
        let changedTotal = 0;
      
        // Full detected cache (for UI view)
        let lastDetectedEntries = [];
      
        // View state: "main" or "chars"
        let view = "main";
      
        const ONBOARD_KEY = "wtrpf_onboard_seen_v1";
        let showOnboard = false;
      
        const style = document.createElement("style");
        style.textContent = `
          .wtrpf-added-term {
            text-shadow: 0 0 10px rgba(255,255,255,0.25);
            outline: 1px solid rgba(255,255,255,0.18);
            border-radius: 4px;
            padding: 0 2px;
          }
          .wtrpf-linklike {
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
          }
          .wtrpf-linklike:hover { opacity: .92; }
        `;
        document.documentElement.appendChild(style);
      
        function applyPos(el) {
          if (savedPos.left != null) {
            el.style.left = savedPos.left + "px";
            el.style.right = "auto";
          } else {
            el.style.left = "12px";
            el.style.right = "auto";
          }
          el.style.top = (savedPos.top ?? 12) + "px";
        }
      
        function clampToViewport(el) {
          const rect = el.getBoundingClientRect();
          const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
          const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
          const left = Math.min(Math.max(6, rect.left), maxLeft);
          const top = Math.min(Math.max(6, rect.top), maxTop);
          el.style.left = left + "px";
          el.style.top = top + "px";
          el.style.right = "auto";
          localStorage.setItem(UI_KEY_POS, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
        }
      
        function enableDrag(el, allowButtonClicks = true) {
          let startX = 0, startY = 0, startTop = 0, startLeft = 0, dragging = false;
      
          el.addEventListener("pointerdown", e => {
            if (allowButtonClicks && e.target && e.target.tagName === "BUTTON") return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startTop = rect.top;
            startLeft = rect.left;
            try { el.setPointerCapture(e.pointerId); } catch {}
          });
      
          el.addEventListener("pointermove", e => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            el.style.top = (startTop + dy) + "px";
            el.style.left = (startLeft + dx) + "px";
            el.style.right = "auto";
          });
      
          const end = () => {
            if (!dragging) return;
            dragging = false;
            clampToViewport(el);
          };
      
          el.addEventListener("pointerup", end);
          el.addEventListener("pointercancel", end);
        }
      
        const isMobile = window.innerWidth <= 480;
      
        const box = document.createElement("div");
        box.style.cssText = `
          position: fixed; z-index: 2147483647;
          background: rgba(0,0,0,0.50);
          color: #fff;
          border-radius: 12px;
          padding: 10px 12px;
          font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
          box-shadow: 0 10px 28px rgba(0,0,0,.25);
          max-width: ${isMobile ? "60vw" : "min(520px, 58vw)"};
          width: ${isMobile ? "60vw" : "auto"};
          height: auto;
          backdrop-filter: blur(6px);
          user-select: none;
          touch-action: none;
        `;
      
        const topRow = document.createElement("div");
        topRow.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:10px;`;
      
        const title = document.createElement("div");
        title.textContent = "PronounsFix";
        title.style.cssText = `font-weight: 600;`;
      
        const controls = document.createElement("div");
        controls.style.cssText = `display:flex; gap:8px; align-items:center;`;
      
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          padding: 6px 10px; border-radius: 999px;
          background: rgba(255,255,255,0.12); color:#fff;
          font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        `;
      
        const helpBtn = document.createElement("button");
        helpBtn.type = "button";
        helpBtn.textContent = "?";
        helpBtn.title = "Help";
        helpBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          width:26px; height:26px; border-radius:9px;
          background:rgba(255,255,255,0.10); color:#fff;
          font-size:14px; line-height:26px; padding:0;
        `;
      
        const minBtn = document.createElement("button");
        minBtn.type = "button";
        minBtn.textContent = "—";
        minBtn.title = "Minimise";
        minBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          width:26px; height:26px; border-radius:9px;
          background:rgba(255,255,255,0.12); color:#fff;
          font-size:16px; line-height:26px; padding:0;
        `;
      
        const disclaimer = document.createElement("div");
        disclaimer.textContent = "Works best on single page reader type";
        disclaimer.style.cssText = `
          margin-top: 4px;
          font-size: 11px;
          font-style: italic;
          opacity: .78;
          user-select: none;
        `;
      
        // SUMMARY (clickable line1)
        const summary = document.createElement("div");
        summary.style.cssText = `white-space: pre-line; opacity: .95; margin-top:8px;`;
      
        const summaryLine1 = document.createElement("div");
        summaryLine1.style.cssText = `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
        summaryLine1.classList.add("wtrpf-linklike");
      
        const summaryLine2 = document.createElement("div");
        summaryLine2.style.cssText = `margin-top: 2px;`;
      
        summary.appendChild(summaryLine1);
        summary.appendChild(summaryLine2);
      
        // Onboard block
        const onboard = document.createElement("div");
        onboard.style.cssText = `
          display:none;
          margin-top:10px;
          padding: 8px 10px;
          border-radius: 10px;
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.12);
          opacity: .95;
        `;
      
        const tipsTitle = document.createElement("div");
        tipsTitle.textContent = "Tips:";
        tipsTitle.style.cssText = `font-weight: 600; margin-bottom: 6px;`;
      
        const tipsList = document.createElement("ul");
        tipsList.style.cssText = `margin: 0; padding-left: 18px; white-space: normal;`;
      
        const tipItems = [
          "Long-press a WTR term (span) to open the character menu.",
          "Choose Male/Female to add a one-line JSON snippet to Draft.",
          "Draft persists; Copy JSON copies the snippet.",
          "Pronoun fixes rerun automatically when you go Next."
        ];
        for (const t of tipItems) {
          const li = document.createElement("li");
          li.textContent = t;
          li.style.cssText = `margin: 4px 0;`;
          tipsList.appendChild(li);
        }
        onboard.appendChild(tipsTitle);
        onboard.appendChild(tipsList);
      
        const divider = document.createElement("div");
        divider.style.cssText = `height:1px; background: rgba(255,255,255,0.12); margin:10px 0;`;
      
        // Draft / New Character section (unchanged UI)
        const sectionHeader = document.createElement("div");
        sectionHeader.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px;`;
      
        const sectionTitle = document.createElement("div");
        sectionTitle.textContent = "New Character (JSON)";
        sectionTitle.style.cssText = `font-weight: 700; opacity:.95;`;
      
        const sectionToggle = document.createElement("button");
        sectionToggle.type = "button";
        sectionToggle.textContent = "Open";
        sectionToggle.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          padding: 6px 10px; border-radius: 10px;
          background: rgba(255,255,255,0.12); color:#fff;
          font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
          flex: 0 0 auto;
        `;
      
        let draftSectionOpen = false;
      
        const draftWrap = document.createElement("div");
        draftWrap.style.cssText = `display:none; margin-top:10px;`;
      
        const draftLabel = document.createElement("div");
        draftLabel.textContent = "Draft (copy into glossary.json)";
        draftLabel.style.cssText = `font-weight:600; opacity:.9; margin-bottom:6px;`;
      
        const draftBox = document.createElement("textarea");
        draftBox.readOnly = true;
        draftBox.spellcheck = false;
        draftBox.style.cssText = `
          width: 100%;
          min-height: 54px;
          max-height: 160px;
          resize: vertical;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 10px;
          background: rgba(255,255,255,0.08);
          color: #fff;
          padding: 8px 10px;
          font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          outline: none;
        `;
      
        const btnRow = document.createElement("div");
        btnRow.style.cssText = `display:flex; gap:8px; margin-top:8px; flex-wrap: wrap;`;
      
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "Copy JSON";
        copyBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          padding: 6px 10px; border-radius: 10px;
          background: rgba(255,255,255,0.16); color:#fff;
          font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        `;
      
        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.textContent = "Clear Draft";
        clearBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          padding: 6px 10px; border-radius: 10px;
          background: rgba(255,255,255,0.10); color:#fff;
          font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        `;
      
        const draftCountRow = document.createElement("div");
        draftCountRow.style.cssText = `opacity:.85; margin-top:8px;`;
        draftCountRow.textContent = "Draft: 0";
      
        // Minimized pill
        const pill = document.createElement("div");
        pill.style.cssText = `
          display:none; position: fixed; z-index: 2147483647;
          background: rgba(0,0,0,0.37);
          color:#fff;
          border-radius: 999px;
          padding: 4px 6px;
          font: 11px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
          box-shadow: 0 10px 28px rgba(0,0,0,.25);
          backdrop-filter: blur(6px);
          user-select: none;
          touch-action: none;
          max-width: 220px;
          overflow: hidden;
        `;
      
        const pillRow = document.createElement("div");
        pillRow.style.cssText = `display:flex; align-items:center; gap:8px; min-width: 0;`;
      
        const pillText = document.createElement("div");
        pillText.style.cssText = `padding: 1px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width:0; max-width: 150px;`;
      
        const pillExpandBtn = document.createElement("button");
        pillExpandBtn.type = "button";
        pillExpandBtn.textContent = "+";
        pillExpandBtn.title = "Expand";
        pillExpandBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          width:22px; height:22px; border-radius:8px;
          background:rgba(255,255,255,0.10); color:#fff;
          font-size:14px; line-height:22px; padding:0;
          flex: 0 0 auto;
        `;
      
        // Characters view container (NEW)
        const charView = document.createElement("div");
        charView.style.cssText = `display:none; margin-top:10px;`;
      
        const charHeader = document.createElement("div");
        charHeader.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;`;
      
        const charTitle = document.createElement("div");
        charTitle.textContent = "Characters on this page";
        charTitle.style.cssText = `font-weight:700; opacity:.95;`;
      
        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.textContent = "Back";
        backBtn.style.cssText = `
          appearance:none; border:0; cursor:pointer;
          padding: 6px 10px; border-radius: 10px;
          background: rgba(255,255,255,0.12); color:#fff;
          font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
          flex: 0 0 auto;
        `;
      
        const charListWrap = document.createElement("div");
        // Height capped; internal scroll
        charListWrap.style.cssText = `
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px;
          background: rgba(255,255,255,0.06);
          padding: 8px 10px;
          max-height: ${isMobile ? "38vh" : "42vh"};
          overflow: auto;
          overscroll-behavior: contain;
        `;
      
        const charList = document.createElement("ul");
        charList.style.cssText = `margin: 0; padding-left: 18px; white-space: normal;`;
      
        charListWrap.appendChild(charList);
        charHeader.appendChild(charTitle);
        charHeader.appendChild(backBtn);
        charView.appendChild(charHeader);
        charView.appendChild(charListWrap);
      
        function refreshToggleUI() {
          const on = enabled();
          toggleBtn.textContent = on ? "ON" : "OFF";
          toggleBtn.style.background = on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)";
          pillText.textContent = `PF (${on ? "ON" : "OFF"})`;
        }
      
        function refreshSummary() {
          if (!glossaryOk) {
            summaryLine1.textContent = "Glossary error";
            summaryLine2.textContent = "";
            summaryLine1.classList.remove("wtrpf-linklike");
            return;
          }
      
          // line1 is clickable to open character view
          summaryLine1.classList.add("wtrpf-linklike");
          summaryLine1.textContent =
            `• Characters: ${charactersCount}` + (charactersList3 ? ` • ${charactersList3}` : "");
      
          summaryLine2.textContent = `• Changed: ${changedTotal}`;
        }
      
        function renderCharList(detectedEntries) {
          charList.innerHTML = "";
          const list = Array.isArray(detectedEntries) ? detectedEntries : [];
      
          if (!list.length) {
            const li = document.createElement("li");
            li.textContent = "No characters detected on this page.";
            li.style.cssText = `margin: 4px 0; opacity: .9;`;
            charList.appendChild(li);
            return;
          }
      
          for (const [name, info] of list) {
            const g = String(info?.gender || "").toLowerCase();
            const label = (g === "female" || g === "male") ? g : "unknown";
      
            const li = document.createElement("li");
            li.style.cssText = `margin: 4px 0;`;
      
            // name (gender)
            const strong = document.createElement("span");
            strong.textContent = `${name}`;
            strong.style.cssText = `font-weight: 600;`;
      
            const meta = document.createElement("span");
            meta.textContent = ` (${label})`;
            meta.style.cssText = `opacity: .85;`;
      
            li.appendChild(strong);
            li.appendChild(meta);
      
            charList.appendChild(li);
          }
        }
      
        function setView(next) {
          view = next === "chars" ? "chars" : "main";
      
          const inChars = (view === "chars");
      
          // In Characters view: hide everything except topRow + charView
          disclaimer.style.display = inChars ? "none" : "block";
          summary.style.display = inChars ? "none" : "block";
          onboard.style.display = inChars ? "none" : (showOnboard ? "block" : "none");
          divider.style.display = inChars ? "none" : "block";
          sectionHeader.style.display = inChars ? "none" : "flex";
          draftWrap.style.display = inChars ? "none" : (draftSectionOpen ? "block" : "none");
          draftCountRow.style.display = inChars ? "none" : "block";
      
          charView.style.display = inChars ? "block" : "none";
      
          clampToViewport(box);
        }
      
        function setDraftUI(jsonSnippet, count) {
          const draftCount = count || 0;
          draftCountRow.textContent = `Draft: ${draftCount}`;
      
          const show = draftSectionOpen;
          draftWrap.style.display = show ? "block" : "none";
      
          const hasDraft = draftCount > 0 && !!jsonSnippet;
          draftBox.value = show ? (hasDraft ? jsonSnippet : "") : "";
      
          copyBtn.disabled = !hasDraft;
          clearBtn.disabled = !hasDraft;
          copyBtn.style.opacity = hasDraft ? "1" : "0.55";
          clearBtn.style.opacity = hasDraft ? "1" : "0.55";
      
          sectionToggle.textContent = draftSectionOpen ? "Close" : "Open";
        }
      
        toggleBtn.onclick = () => {
          setEnabled(!enabled());
          refreshToggleUI();
          setTimeout(() => location.reload(), 150);
        };
      
        helpBtn.onclick = () => {
          showOnboard = !showOnboard;
          onboard.style.display = showOnboard ? "block" : "none";
          localStorage.setItem(ONBOARD_KEY, "1");
          clampToViewport(box);
        };
      
        function setMin(min) {
          localStorage.setItem(UI_KEY_MIN, min ? "1" : "0");
          box.style.display = min ? "none" : "block";

          // Pill visibility is now gated by chapter reading page detection
          const canShowPill = min && isChapterReadingPage();
          pill.style.display = canShowPill ? "block" : "none";
        }

        minBtn.onclick = () => setMin(true);
        pillExpandBtn.onclick = () => setMin(false);
        pillText.onclick = () => setMin(false);
      
        sectionToggle.onclick = () => {
          draftSectionOpen = !draftSectionOpen;
          const d = loadDraft(getNovelKeyFromURL());
          setDraftUI(d?.snippet || "", (d?.items || []).length);
          clampToViewport(box);
        };
      
        // Click line1 to enter Characters view (NEW)
        summaryLine1.onclick = () => {
          if (!glossaryOk) return;
          renderCharList(lastDetectedEntries);
          setView("chars");
        };
      
        backBtn.onclick = () => {
          setView("main");
        };
      
        controls.appendChild(toggleBtn);
        controls.appendChild(helpBtn);
        controls.appendChild(minBtn);
      
        topRow.appendChild(title);
        topRow.appendChild(controls);
      
        sectionHeader.appendChild(sectionTitle);
        sectionHeader.appendChild(sectionToggle);
      
        box.appendChild(topRow);
        box.appendChild(disclaimer);
        box.appendChild(summary);
        box.appendChild(onboard);
        box.appendChild(divider);
        box.appendChild(sectionHeader);
      
        draftWrap.appendChild(draftLabel);
        draftWrap.appendChild(draftBox);
      
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(clearBtn);
      
        draftWrap.appendChild(btnRow);
        box.appendChild(draftWrap);
        box.appendChild(draftCountRow);
      
        // Characters view goes after summary area (still inside expanded box)
        box.appendChild(charView);
      
        pillRow.appendChild(pillText);
        pillRow.appendChild(pillExpandBtn);
        pill.appendChild(pillRow);
      
        document.documentElement.appendChild(box);
        document.documentElement.appendChild(pill);
      
        applyPos(box);
        applyPos(pill);
      
        enableDrag(box, true);
        enableDrag(pill, true);
      
        refreshToggleUI();
        refreshSummary();
      
        // minimized by default
        setMin(true);
      
        if (localStorage.getItem(ONBOARD_KEY) === "1") {
          showOnboard = false;
          onboard.style.display = "none";
        }
      
        // Ensure correct initial view
        setView("main");
      
        async function writeClipboard(text) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch {
            try {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.style.position = "fixed";
              ta.style.left = "-9999px";
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              const ok = document.execCommand("copy");
              document.body.removeChild(ta);
              return ok;
            } catch {
              return false;
            }
          }
        }
      
        copyBtn.onclick = async () => {
          if (copyBtn.disabled) return;
          const d = loadDraft(getNovelKeyFromURL());
          const txt = d?.snippet || "";
          if (!txt) return;
          await writeClipboard(txt);
        };
      
        clearBtn.onclick = () => {
          if (clearBtn.disabled) return;
          saveDraft(getNovelKeyFromURL(), { items: [], snippet: "" });
          setDraftUI("", 0);
        };
      
        return {
          isEnabled: () => enabled(),
          setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshSummary(); },
          setCharacters: (detectedEntries, meta = {}) => {
            const base = Array.isArray(detectedEntries) ? detectedEntries : [];
            lastDetectedEntries = base;
      
            charactersCount = base.length;
      
            const names = base.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
              const g = String(info.gender || "").toLowerCase();
              const label = (g === "female" || g === "male") ? g : "unknown";
              return `${name} (${label})`;
            });
            charactersList3 = names.join(", ") + (base.length > MAX_NAMES_SHOWN ? " …" : "");
            refreshSummary();
      
            // If user is currently in character view, live-refresh the list
            if (view === "chars") {
              renderCharList(lastDetectedEntries);
            }
          },
          setChanged: (val) => {
            changedTotal = clamp(Number(val) || 0, 0, 999999);
            refreshSummary();
          },
          setMinimized: (min) => setMin(!!min),
          setDraftUI,
          refreshDraftUI: () => {
            const d = loadDraft(getNovelKeyFromURL());
            setDraftUI(d?.snippet || "", (d?.items || []).length);
          },
          syncPillVisibility: () => {
            const isMin = localStorage.getItem(UI_KEY_MIN) === "1";
            // Only show pill if minimized AND on chapter reading page
            pill.style.display = (isMin && isChapterReadingPage()) ? "block" : "none";
          },
        };
      }

  // ==========================================================
  // Add popup (small + X + Male/Female only)
  // - FIX: add touch long-press fallback (Firefox Android)
  // ==========================================================
  function installAddPopup({ ui }) {
    const popup = document.createElement("div");
    popup.style.cssText = `
      position: fixed; z-index: 2147483647;
      display:none;
      background: rgba(0,0,0,0.80);
      color:#fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 8px;
      font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      backdrop-filter: blur(6px);
      width: min(220px, 70vw);
      user-select: none;
    `;

    const header = document.createElement("div");
    header.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;`;

    const hTitle = document.createElement("div");
    hTitle.textContent = "Add Character";
    hTitle.style.cssText = `font-weight:700; opacity:.95;`;

    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.textContent = "✕";
    xBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:24px; height:24px; border-radius:9px;
      background:rgba(255,255,255,0.10); color:#fff;
      font-size:13px; line-height:24px; padding:0;
      flex: 0 0 auto;
    `;

    const picked = document.createElement("div");
    picked.style.cssText = `opacity:.92; margin-bottom:8px; white-space: nowrap; overflow:hidden; text-overflow: ellipsis;`;

    const row = document.createElement("div");
    row.style.cssText = `display:flex; gap:6px;`;

    const mkBtn = (label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = `
        appearance:none; border:0; cursor:pointer;
        padding: 6px 8px; border-radius: 10px;
        background: rgba(255,255,255,0.14); color:#fff;
        font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        flex: 1;
      `;
      return b;
    };

    const maleBtn = mkBtn("Male");
    const femaleBtn = mkBtn("Female");

    header.appendChild(hTitle);
    header.appendChild(xBtn);
    row.appendChild(maleBtn);
    row.appendChild(femaleBtn);

    popup.appendChild(header);
    popup.appendChild(picked);
    popup.appendChild(row);
    document.documentElement.appendChild(popup);

    let ctxText = "";

    function hide() {
      popup.style.display = "none";
      ctxText = "";
    }

    function showAt(x, y, text) {
      ctxText = (text || "").trim();
      if (!ctxText) return;

      picked.textContent = `Selected: ${ctxText}`;

      const w = 240;
      const h = 120;
      const left = clamp(x, 6, window.innerWidth - w);
      const top = clamp(y, 6, window.innerHeight - h);

      popup.style.left = left + "px";
      popup.style.top  = top + "px";
      popup.style.display = "block";
    }

    xBtn.onclick = hide;
    popup.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);

    function upsertDraftLine(line) {
      const d = loadDraft(getNovelKeyFromURL());
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.includes(line)) items.push(line);
      const snippet = items.join("\n");
      saveDraft(getNovelKeyFromURL(), { items, snippet });
      ui.refreshDraftUI?.();
    }

    maleBtn.onclick = () => {
      if (!ctxText) return;
      upsertDraftLine(oneLineCharacterSnippet(ctxText, "male"));
      hide();
    };
    femaleBtn.onclick = () => {
      if (!ctxText) return;
      upsertDraftLine(oneLineCharacterSnippet(ctxText, "female"));
      hide();
    };

    // ----- LONG PRESS target: WTR term spans
    function findTermSpanFromTarget(target) {
      return target?.closest?.("span.text-patch.system[data-hash]") || null;
    }
    
    // Pointer-based (desktop/most browsers)
    let lpTimer = null;
    let lpSpan = null;
    let lpStartX = 0;
    let lpStartY = 0;
    
    function clearLP() {
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = null;
      lpSpan = null;
    }
    
    document.addEventListener("pointerdown", (e) => {
      const sp = findTermSpanFromTarget(e.target);
      if (!sp) return;
    
      clearLP();
      lpSpan = sp;
      lpStartX = e.clientX;
      lpStartY = e.clientY;
    
      lpTimer = setTimeout(() => {
        const txt = (lpSpan?.textContent || "").trim();
        if (!txt) return;
        showAt(lpStartX + 6, lpStartY + 6, txt);
      }, LONGPRESS_MS);
    }, true);
    
    document.addEventListener("pointerup", clearLP, true);
    document.addEventListener("pointercancel", clearLP, true);
    document.addEventListener("pointermove", (e) => {
      if (!lpTimer) return;
      const dx = Math.abs(e.clientX - lpStartX);
      const dy = Math.abs(e.clientY - lpStartY);
      if (dx + dy > 10) clearLP();
    }, true);
    
    // Touch fallback (Firefox Android) — improved
    let tTimer = null;
    let tSpan = null;
    let tStartX = 0;
    let tStartY = 0;
    let tTriggered = false;
    
    function clearTouchLP() {
      if (tTimer) clearTimeout(tTimer);
      tTimer = null;
      tSpan = null;
      tTriggered = false;
    }
    
    document.addEventListener("touchstart", (e) => {
      const touch = e.touches && e.touches[0];
      if (!touch) return;
    
      const sp = findTermSpanFromTarget(e.target);
      if (!sp) return;
    
      clearTouchLP();
      tSpan = sp;
      tStartX = touch.clientX;
      tStartY = touch.clientY;
    
      // Important: passive:false so we *can* preventDefault when the long-press triggers
      tTimer = setTimeout(() => {
        const txt = (tSpan?.textContent || "").trim();
        if (!txt) return;
      
        tTriggered = true;
        showAt(tStartX + 6, tStartY + 6, txt);
      }, LONGPRESS_MS);
    }, { capture: true, passive: false });
    
    document.addEventListener("touchmove", (e) => {
      if (!tTimer) return;
      const touch = e.touches && e.touches[0];
      if (!touch) return;
    
      const dx = Math.abs(touch.clientX - tStartX);
      const dy = Math.abs(touch.clientY - tStartY);
      if (dx + dy > 12) clearTouchLP();
    }, { capture: true, passive: true });
    
    document.addEventListener("touchend", (e) => {
      // If we triggered long-press, block the "ghost" click/select aftermath.
      if (tTriggered) {
        try { e.preventDefault(); } catch {}
        try { e.stopPropagation(); } catch {}
      }
      clearTouchLP();
    }, { capture: true, passive: false });
    
    document.addEventListener("touchcancel", clearTouchLP, { capture: true, passive: true });
    
    // Selection popup still allowed
    document.addEventListener("mouseup", (e) => {
      const sel = window.getSelection?.();
      const s = sel ? String(sel.toString() || "") : "";
      const txt = s.trim();
      if (!txt || txt.length < 2) return;
    
      const root = rootManager?.getRoot() || findContentRoot();
      if (!root || !root.contains(e.target)) return;
    
      showAt(e.clientX + 6, e.clientY + 6, txt);
    }, true);
    
    function isClickInsidePopup(target) {
      return popup.contains(target);
    }
    
    document.addEventListener("pointerdown", (e) => {
      if (popup.style.display !== "block") return;
      if (isClickInsidePopup(e.target)) return;
      hide();
    }, true);
    
    return { hide };
  }

  // ==========================================================
  // Navigation hooks
  // ==========================================================
    function installNextButtonHook(onNav) {
      document.addEventListener("click", (e) => {
        const t = e.target;
        if (!t) return;
    
        // Accept button, link, or role=button containers
        const el =
          t.closest?.("button, a, [role='button']") ||
          t.closest?.("[aria-label]") ||
          null;
    
        if (!el) return;
    
        // Fast-path: rel=next
        if ((el.getAttribute?.("rel") || "").toLowerCase() === "next") {
          setTimeout(() => onNav("next-rel"), 20);
          return;
        }
    
        // Check aria-label/title
        const aria = (el.getAttribute?.("aria-label") || "").toLowerCase();
        const title = (el.getAttribute?.("title") || "").toLowerCase();
        if (aria.includes("next") || title.includes("next")) {
          setTimeout(() => onNav("next-aria"), 20);
          return;
        }
    
        // Check visible text
        const txt = normalizeWeirdSpaces(el.textContent || "").trim().toLowerCase();
        if (txt === "next" || txt.startsWith("next ")) {
          setTimeout(() => onNav("next-text"), 20);
          return;
        }
    
        // Restrict href-based detection to nav/pagination-ish areas OR chapter-looking links
        const href = el.getAttribute?.("href") || "";
        const looksLikeChapterLink = /\/chapter-\d+/i.test(href);
    
        const navish =
          el.closest?.(".pagination, .pager, nav, header, [role='navigation'], .reader-nav, .chapter-nav") ||
          el.matches?.("[rel='next'], [aria-label*='next' i], [title*='next' i]");
    
        if (!navish && !looksLikeChapterLink) return;
    
        if (looksLikeChapterLink) {
          setTimeout(() => onNav("next-href"), 20);
          return;
        }
      }, true);
    }

// function installHistoryHooks(onNav) {
 //   const fire = () => setTimeout(() => onNav("history"), 60);
  //  window.addEventListener("popstate", fire);

 //   const _push = history.pushState;
   // const _rep = history.replaceState;
  //  history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
  //  history.replaceState = function () { const r = _rep.apply(this, arguments); fire(); return r; };

  //  window.addEventListener("pageshow", fire, true);
  //  document.addEventListener("visibilitychange", () => { if (!document.hidden) fire(); }, true);
//  }

    function installHistoryHooksLite(onNav) {
    const fire = (why) => setTimeout(() => onNav(why || "history-lite"), 60);
  
    window.addEventListener("popstate", () => fire("popstate"), true);
    window.addEventListener("pageshow", () => fire("pageshow"), true);
  
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fire("visibility");
    }, true);
  }


  function installChapterBodyObserver(onNav) {
    let lastCb = null;
    let debounce = null;
    let mo = null;

    function attach(cb) {
      if (!cb || cb === lastCb) return;

      // Disconnect previous observer to avoid buildup
      if (mo) {
        try { mo.disconnect(); } catch {}
        mo = null;
      }

      lastCb = cb;

      mo = new MutationObserver(() => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          onNav("chapter-body-mutation");
        }, CHAPTER_OBS_DEBOUNCE_MS);
      });

      mo.observe(cb, { childList: true, subtree: true });
    }

    const t = setInterval(() => {
      const cb = document.querySelector(".chapter-body");
      if (cb && cb !== lastCb) attach(cb);
    }, 800);

    setTimeout(() => {
      clearInterval(t);
    }, 15000);
  }

      function installUrlChangeWatcher(onNav, isEnabled) {
        let lastHref = location.href;
        let lastFireAt = 0;
      
        setInterval(() => {
          if (!isEnabled() || document.hidden) return;
      
          const href = location.href;
          if (href === lastHref) return;
      
          lastHref = href;
      
          const now = Date.now();
          if (now - lastFireAt < 450) return; // throttle
          lastFireAt = now;
      
          onNav("url-change");
        }, 250);
      }

      function installChapterTrackerObserver(onNav, isEnabled) {
      let lastCid = null;
      let mo = null;
      let fireAt = 0;
    
      function getActiveTrackerCid() {
        const tr = document.querySelector(".chapter-tracker.active[data-chapter-no]");
        const no = tr?.getAttribute?.("data-chapter-no");
        return (no && /^\d+$/.test(no)) ? `chapter-${no}` : null;
      }
    
      function arm() {
        const host =
          document.querySelector(".chapter-infinite-reader") ||
          document.querySelector(".chapter-tracker")?.parentElement ||
          document.body;
    
        if (mo) {
          try { mo.disconnect(); } catch {}
          mo = null;
        }
    
        mo = new MutationObserver(() => {
          if (!isEnabled() || document.hidden) return;
    
          const cid = getActiveTrackerCid();
          if (!cid) return;
    
          // First seed
          if (!lastCid) { lastCid = cid; return; }
    
          // If Next changed the active tracker, this is our “navigation”
          if (cid !== lastCid) {
            lastCid = cid;

            const now = Date.now();
            if (now - fireAt < 250) return;   // throttle
            fireAt = now;
            
            onNav("tracker-active-changed");
          }
        });
    
        // Watch for class flips (active) and chapter-no changes / node swaps
        mo.observe(host, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class", "data-chapter-no", "id"]
        });
    
        // Seed initial
        lastCid = getActiveTrackerCid() || lastCid;
      }
    
      arm();
    
      // In case the reader remounts, re-arm once after a short delay
      setTimeout(arm, 1200);
    }

      function installActiveContentObserver(getRoot, onDirty, isEnabled) {
      let mo = null;
      let lastRoot = null;
      let t = null;
    
      const arm = () => {
        if (!isEnabled() || document.hidden) return;
    
        const root = rootManager?.getRoot() || findContentRoot();
        if (!root || root === lastRoot) return;
    
        // swap observer to new root
        if (mo) { try { mo.disconnect(); } catch {} }
        lastRoot = root;
    
        mo = new MutationObserver(() => {
          if (!isEnabled() || document.hidden) return;
          if (t) return;
          t = setTimeout(() => { t = null; onDirty("active-root-mutation"); }, 220);
        });
    
        // React tends to replace nodes (childList) and also text (characterData)
        mo.observe(root, { subtree: true, childList: true, characterData: true });
      };
    
      // re-arm periodically (root can change without being removed cleanly)
      const tick = setInterval(arm, 600);
      setTimeout(() => clearInterval(tick), 25000);
    
      // also arm immediately
      arm();
    
      return {
        rearm: arm,
        disconnect: () => { if (mo) { try { mo.disconnect(); } catch {} mo = null; } }
      };
    }

      function installInfiniteReaderAppendObserver(onNav, isEnabled) {
      let mo = null;
    
      function arm() {
        const host = document.querySelector(".chapter-infinite-reader");
        if (!host) return false;
    
        if (mo) { try { mo.disconnect(); } catch {} }
    
        mo = new MutationObserver((muts) => {
          if (!isEnabled() || document.hidden) return;
    
          for (const m of muts) {
            for (const n of (m.addedNodes || [])) {
              if (!(n instanceof Element)) continue;
    
              // new chapter content arrived
              if (n.matches?.(".chapter-body") || n.querySelector?.(".chapter-body")) {
                onNav("infinite-append");
                return;
              }
            }
          }
        });
    
        mo.observe(host, { childList: true, subtree: true });
        return true;
      }
    
      // try now, and retry once if the reader mounts later
      if (!arm()) setTimeout(arm, 1200);
    
      return { disconnect: () => { if (mo) { try { mo.disconnect(); } catch {} } } };
    }
  
  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
     ui.syncPillVisibility?.();
        window.__wtrpf_ui = ui;
    if (!ui.isEnabled()) return;

    ui.refreshDraftUI?.();

    if (!GLOSSARY_URL || /\?token=GHSAT/i.test(GLOSSARY_URL)) {
      ui.setGlossaryOk(false);
      return;
    }

    let glossary;
    try {
      glossary = await loadGlossaryJSON(GLOSSARY_URL);
      if (!glossary || typeof glossary !== "object") throw new Error("bad glossary");
    } catch {
      ui.setGlossaryOk(false);
      return;
    }

    const key = pickKey(glossary);
    const cfg = glossary[key] || {};

    const upgrades = cfg.upgrades || {};
    const U = {
      anchoredFixes: upgrades.anchoredFixes !== false,
      verbBasedWindow: !!upgrades.verbBasedWindow,
      passiveVoice: !!upgrades.passiveVoice,
      dialogueSpeaker: !!upgrades.dialogueSpeaker,
      roleHeuristicCarry: !!upgrades.roleHeuristicCarry,
      onlyChangeIfWrong: !!upgrades.onlyChangeIfWrong,
      termMemoryAssist: !!upgrades.termMemoryAssist,
      enforcePinnedTermsOnPlainText: !!upgrades.enforcePinnedTermsOnPlainText
    };

    const characters = {
      ...(glossary.default?.characters || {}),
      ...(cfg.characters || {})
    };
    const entries = Object.entries(characters);
    if (!entries.length) { ui.setGlossaryOk(false); return; }
    ui.setGlossaryOk(true);

    const cfgTerms = cfg.terms || {};
    const novelKey = key === "default" ? getNovelKeyFromURL() : key;
    const chapterStateKey = CHAPTER_STATE_KEY_PREFIX + novelKey;

    installAddPopup({ ui });

    const mode = String(cfg.mode || "paragraph").toLowerCase();
    const primaryCharacter = cfg.primaryCharacter || null;
    const forceGender = String(cfg.forceGender || "").toLowerCase();
    const carryParagraphs = Number.isFinite(+cfg.carryParagraphs)
      ? Math.max(0, Math.min(5, +cfg.carryParagraphs))
      : DEFAULT_CARRY_PARAGRAPHS;

    function installChapterBodyReplaceWatcher(onNav) {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
    
            // If the new subtree contains chapter-body, trigger a sweep.
            if (n.matches?.(".chapter-body") || n.querySelector?.(".chapter-body")) {
              onNav("chapter-body-replaced");
              return;
            }
          }
        }
      });
    
      // Observe only direct structural changes; NOT characterData.
      mo.observe(document.body, { childList: true, subtree: true });
    }

    
    function loadChapterState() {
      try { return JSON.parse(sessionStorage.getItem(chapterStateKey) || "{}"); }
      catch { return {}; }
    }
    function saveChapterState(st) {
      sessionStorage.setItem(chapterStateKey, JSON.stringify(st || {}));
    }

    function getChapterLastChanged(st, chapterId) {
      return Number(st?.lastByChapter?.[chapterId] || 0);
    }

    function setChapterLastChanged(st, chapterId, val) {
      if (!st.lastByChapter) st.lastByChapter = {};
      st.lastByChapter[chapterId] = val;
    }

    function computeGenderForText(text) {
    if (forceGender === "male" || forceGender === "female") return forceGender;
  
    const t = String(text || "");
    
    const tL = t.toLowerCase();
    if (primaryCharacter && tL.includes(String(primaryCharacter).toLowerCase()) && characters[primaryCharacter]) {
      const g0 = String(characters[primaryCharacter].gender || "").toLowerCase();
      if (g0 === "female" || g0 === "male") return g0;
    }

    // NEW: scored detection (more robust than includes)
    const scored = scoreGenderInText(t, entries);
    if (scored) return scored;
  
    if (U.passiveVoice) {
      const gAgent = detectPassiveAgentGender(t, entries);
      if (gAgent) return gAgent;
    }
  
    if (U.dialogueSpeaker) {
      const gSpeaker = detectDialogueSpeakerGender(t, entries);
      if (gSpeaker) return gSpeaker;
    }
  
    for (const [name, info] of entries) {
    const g = String(info.gender || "").toLowerCase();
    if (g !== "female" && g !== "male") continue;
  
    const all = [name, ...(Array.isArray(info.aliases) ? info.aliases : [])]
      .filter(Boolean)
      .sort((a,b) => String(b).length - String(a).length);
  
    for (const n of all) {
      const rx = wordBoundaryRegex(n);
      if (rx && rx.test(t)) return g;
    }
  }

    return null;
  }

    function updateDetectedCharactersUI(root) {
      const cid = getChapterId(root);
      const sig = chapterSignature(root, cid);
    
      const cached = getCharCache(cid);
      if (cached && cached.sig && sig && cached.sig === sig) {
        ui.setCharacters(cached.detected || [], { fromCache: true });
        return;
      }
    
      const detected = detectCharactersOnPage(root, entries);
      setCharCache(cid, sig, detected);
    
      ui.setCharacters(detected || [], { fromCache: false });
    }

    let lastActorGender = null;
    let lastActorTTL = 0;

    let lastChapterId = null;
    let lastSig = "";
    let running = false;
    let lastRunAt = 0;

    let navSweepTimer = null;
    function stopNavSweep() {
      if (navSweepTimer) clearInterval(navSweepTimer);
      navSweepTimer = null;
    }

  /* =========================
   Character detection cache
   ========================= */
    const _charDetectCache = new Map(); // key: chapterId -> { sig, detected }
    
    // helper
    function getCharCache(chapterId) {
      return _charDetectCache.get(String(chapterId || "unknown")) || null;
    }
    function setCharCache(chapterId, sig, detected) {
      _charDetectCache.set(String(chapterId || "unknown"), {
        sig: String(sig || ""),
        detected: Array.isArray(detected) ? detected : []
      });
    }

    function rootPatchedFor(root, chapterId) {
      return root?.dataset?.wtrpfPatchedChapter === String(chapterId);
    }
    function markRootPatched(root, chapterId) {
      if (!root || !root.dataset) return;
      root.dataset.wtrpfPatchedChapter = String(chapterId);
    }

    function blockIsPatched(b) {
      return b?.dataset?.wtrpfPatched === "1";
    }
    function markBlockPatched(b) {
      if (!b || !b.dataset) return;
      b.dataset.wtrpfPatched = "1";
    }

    // RUN FUNCTION
/* ==========================================================
   REWRITE 2: run()
   - Fix: accept {forcedRoot, forcedChapterId} params (no global run._forcedRoot)
   - Fix: running guard only blocks non-force runs
   - Fix: correct marker clearing selectors (dataset → data-wtrpf-patched*, etc.)
   - Fix: include chapterId in signature gating / appliedSig logic
   ========================================================== */

    // helper: clear patch markers correctly
    function clearPatchMarkers(root) {
      try {
        if (!root) return;
    
        // root marker
        if (root.dataset) {
          delete root.dataset.wtrpfPatchedChapter;
          delete root.dataset.wtrpfSwept;
          delete root.dataset.wtrpfQueued;
        }
    
        // block markers
        const blocks = root.querySelectorAll?.("p, blockquote, li") || [];
        blocks.forEach(el => {
          if (el?.dataset) delete el.dataset.wtrpfPatched;
        });
      } catch {}
    }

function run({ forceFull = false, forcedRoot = null, forcedChapterId = null } = {}) {
  console.log("[WTRPF] run() enter forceFull=", forceFull, "href=", location.href);

  if (!ui.isEnabled()) return;
  if (document.hidden) return;

  // Single-flight always: even forceFull won't run concurrently.
  // forceFull only bypasses cooldown/signature gates; pending runs are handled by requestRun + _pendingForced.
  if (running) return;

  const now = Date.now();
  if (!forceFull && (now - lastRunAt < SELF_MUTATION_COOLDOWN_MS)) return;

  const root = forcedRoot || (rootManager?.getRoot?.() || findContentRoot());
  if (!root) return;

  // If this run is targeting an infinite body, clear its queued marker
  if (root?.dataset?.wtrpfQueued === "1") {
    delete root.dataset.wtrpfQueued;
  }

  const urlCid = getUrlChapterId();
  const domCid = getDomChapterId(root);

  run._lastHref = run._lastHref || location.href;
  if (location.href !== run._lastHref) {
    run._lastHref = location.href;
    run._domGraceStart = 0;
  }

  // During SPA nav, URL often changes before DOM.
  // Non-forceFull: wait briefly for DOM. forceFull: still require contentReady.
  const DOM_GRACE_MS = 1200;
  run._domGraceStart = run._domGraceStart || 0;

  const mismatch =
    (urlCid !== "unknown" && domCid !== "unknown" && domCid !== urlCid) ||
    (urlCid !== "unknown" && domCid === "unknown");

  if (mismatch) {
    if (!run._domGraceStart) run._domGraceStart = Date.now();

    if (!forceFull && (Date.now() - run._domGraceStart < DOM_GRACE_MS)) return;

    // forceFull still must not patch old content
    if (!contentReady(root)) return;

    const sigNow = chapterSignature(root, (domCid !== "unknown" ? domCid : urlCid));

    // If DOM still shows previous chapter and it's already stable, don't waste a run
    if (domCid !== "unknown" && urlCid !== "unknown" && domCid !== urlCid) {
      const appliedDom = getAppliedSig(novelKey, domCid);
      if (appliedDom && sigNow && sigNow === appliedDom) return;
    }

    const appliedUrl = getAppliedSig(novelKey, urlCid);
    if (appliedUrl && sigNow && sigNow === appliedUrl) {
      run._domGraceStart = 0;
      return;
    }
  }
  run._domGraceStart = 0;

  const chapterId = (forcedChapterId && forcedChapterId !== "unknown")
    ? forcedChapterId
    : ((domCid !== "unknown") ? domCid : urlCid);

  let pronounEdits = 0;

  function paragraphSeemsSingleGender(text, gender) {
      const s = normalizeWeirdSpaces(String(text || ""));
      const m = countMatches(RX_PRONOUN_MALE, s);
      const f = countMatches(RX_PRONOUN_FEMALE, s);
    
      // If paragraph has both genders’ pronouns, be conservative
      if (m > 0 && f > 0) {
        // allow if strongly skewed toward the target gender
        if (gender === "male") return m >= (f * 3);
        return f >= (m * 3);
      }
      return true;
    }

  if (!contentReady(root)) return;

  // Signature gate: only skip if same as last applied in this session (unless forceFull)
  const sigBefore = chapterSignature(root, chapterId);
  if (!forceFull && sigBefore && sigBefore === lastSig) return;

  running = true;
  try {
    // New chapter boundary
    if (chapterId !== lastChapterId) {
      lastChapterId = chapterId;
      localStorage.setItem(UI_KEY_MIN, "1");
      ui.setMinimized(true);

      lastActorGender = null;
      lastActorTTL = 0;

      // React can reuse DOM nodes; clear markers on boundary
      clearPatchMarkers(root);
    }

    // If forceFull, clear per-node markers to reprocess
    if (forceFull) clearPatchMarkers(root);

    // If root is a chapter body, clear infinite-mode flags too
    if (root?.classList?.contains("chapter-body") && root?.dataset) {
      delete root.dataset.wtrpfSwept;
      delete root.dataset.wtrpfQueued;
    }

    // UI: show last known count for this chapter until we compute a new one
    const st0 = loadChapterState();
    const lastChanged = getChapterLastChanged(st0, chapterId);
    ui.setChanged(lastChanged > 0 ? lastChanged : 0);

    // Apply term patches (if enabled)
    if (U.termMemoryAssist || Object.keys(cfgTerms).length) {
      const mem = loadTermMemory(novelKey);
      applyTermPatches(root, cfgTerms, mem, U);
    }

    updateDetectedCharactersUI(root);

    // Resolve mode
    let usedMode = mode;
    let chapterGender = null;

    if (mode === "chapter") {
      if (forceGender === "male" || forceGender === "female") {
        chapterGender = forceGender;
      } else if (primaryCharacter && characters[primaryCharacter]) {
        const g = String(characters[primaryCharacter].gender || "").toLowerCase();
        if (g === "female" || g === "male") chapterGender = g;
      }
      if (!chapterGender) usedMode = "paragraph";
    }

    // Decide which blocks to process
    const alreadyPatched = rootPatchedFor(root, chapterId);
    const doFullPass = forceFull || !alreadyPatched;

    const blocksAll = getTextBlocks(root);
    const blocks = doFullPass ? blocksAll : blocksAll.filter(b => !blockIsPatched(b));
    if (!blocks.length) return;

    let lastGender = null;
    let carryLeft = 0;

    for (const b of blocks) {
      const bt = (b.innerText || "").trim();
      if (!bt) { markBlockPatched(b); continue; }

      if (isSceneBreak(bt)) {
        lastGender = null;
        carryLeft = 0;
        lastActorGender = null;
        lastActorTTL = 0;
        markBlockPatched(b);
        continue;
      }

      // Anchored fixes first
      if (U.anchoredFixes) {
        pronounEdits += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, entries, U));
      }

      let g = null;
      let hadDirectMatch = false;

      if (usedMode === "chapter") {
        g = chapterGender;
        hadDirectMatch = true;
      } else {
        const computed = computeGenderForText(bt); // (see snippet below to make it case-insensitive)
        if (computed) {
          g = computed;
          hadDirectMatch = true;

          if (U.roleHeuristicCarry && RX_ATTACK_CUES.test(bt)) {
            lastActorGender = computed;
            lastActorTTL = 2;
          }
        } else {
          if (lastGender && carryLeft > 0 && (startsWithPronoun(bt) || pronounAppearsEarly(bt, EARLY_PRONOUN_WINDOW))) {
            g = lastGender;
            carryLeft--;
          }

          if (!g && U.roleHeuristicCarry && lastActorGender && lastActorTTL > 0) {
            if ((startsWithPronoun(bt) || pronounAppearsEarly(bt, EARLY_PRONOUN_WINDOW)) && RX_ATTACK_CUES.test(bt)) {
              g = lastActorGender;
              lastActorTTL--;
            }
          }
        }
      }

      // Global pass within this block
      if (g) {
        const dir = (g === "female") ? "toFemale" : "toMale";

        let doFull = true;
        if (U.onlyChangeIfWrong) doFull = conservativeShouldApply(bt, g);
        
        // NEW: extra safety in mixed paragraphs
        if (doFull && !paragraphSeemsSingleGender(bt, g)) doFull = false;

        if (doFull) {
          pronounEdits += replaceInTextNodes(b, (txt) => {
            if (!paragraphSeemsSingleGender(txt, g)) return { text: txt, changed: 0 };
            return replacePronounsSmart(txt, dir);
          });
        }

        if (usedMode !== "chapter" && hadDirectMatch) {
          lastGender = g;
          carryLeft = carryParagraphs;
        }
      }

      markBlockPatched(b);
    }

    if (doFullPass) markRootPatched(root, chapterId);

    // Avoid inflating counts if already equals applied signature
    if (pronounEdits > 0) {
      const sigNow = chapterSignature(root, chapterId);
      const applied = getAppliedSig(novelKey, chapterId);
      if (applied && sigNow === applied) pronounEdits = 0;
    }

    // Persist counts
    const st = loadChapterState();
    const prev = getChapterLastChanged(st, chapterId);

    if (pronounEdits > 0) {
      setChapterLastChanged(st, chapterId, pronounEdits);
      ui.setChanged(pronounEdits);
    } else if (prev > 0) {
      ui.setChanged(prev);
    } else {
      ui.setChanged(0);
    }

    // Record signature AFTER applying
    const sigAfter = chapterSignature(root, chapterId);
    if (sigAfter) {
      setAppliedSig(novelKey, chapterId, sigAfter);
      lastSig = sigAfter;
    } else {
      lastSig = sigBefore;
    }

    saveChapterState(st);
  } finally {
    running = false;
    lastRunAt = Date.now();
  }

  // NEW: if a forced body was queued while we were busy, run it now
  try { drainPendingForced(); } catch {}
}

    /* =========================
   C) NEW: Single debounced scheduler (upgrade #1)
   Put this inside Main (async IIFE) after you define run()
   and before you install hooks.
   ========================= */
    const RUN_DEBOUNCE_MS = 140;
    
    let _runTimer = null;
    let _pendingRun = null; // { forceFull, forcedRoot, forcedChapterId, reason, ts }
    
    function requestRun(reason, opts = {}) {
      if (!ui.isEnabled() || document.hidden) return;

      // NEW: never schedule runs when not on a chapter reading page
      // (prevents wasted work on TOC/description pages)
      if (!isChapterReadingPage()) {
        ui.syncPillVisibility?.();
        return;
      }
    
      const req = {
        forceFull: !!opts.forceFull,
        forcedRoot: opts.forcedRoot || null,
        forcedChapterId: opts.forcedChapterId || null,
        reason: String(reason || "request"),
        ts: Date.now()
      };
    
      // Latest wins; forceFull is "sticky" (once requested, keep it true)
      if (_pendingRun) {
        req.forceFull = req.forceFull || _pendingRun.forceFull;
        if (!req.forcedRoot && _pendingRun.forcedRoot) req.forcedRoot = _pendingRun.forcedRoot;
        if (!req.forcedChapterId && _pendingRun.forcedChapterId) req.forcedChapterId = _pendingRun.forcedChapterId;
      }
      _pendingRun = req;

      if (_runTimer) return;
      _runTimer = setTimeout(() => {
        _runTimer = null;
        const r = _pendingRun;
        _pendingRun = null;
        if (!r) return;
    
        // IMPORTANT: run() already guards single-flight; this just coalesces triggers
        console.log("[WTRPF] requestRun→run:", r.reason, "forceFull=", r.forceFull);
        run({
          forceFull: r.forceFull,
          forcedRoot: r.forcedRoot,
          forcedChapterId: r.forcedChapterId
        });
      }, RUN_DEBOUNCE_MS);
    }

      /* ==========================================================
       DROP-IN SNIPPET A: drain pending forced run
       Place near the end of run() finally OR in your monitor tick.
       This ensures sweep requests aren’t lost when a run was busy.
       ========================================================== */
    
    function drainPendingForced() {
      if (!_pendingForced || running) return;
    
      const { root, cid } = _pendingForced;
      if (!root || !cid) { _pendingForced = null; return; }
    
      // Only attempt if still in DOM + ready
      if (!document.contains(root) || !contentReady(root)) return;
    
      _pendingForced = null;
      run({ forceFull: true, forcedRoot: root, forcedChapterId: cid });
    }

/* ==========================================================
   REWRITE 1: sweepInfiniteBodies()
   - Fix: don’t mark swept unless we actually applied / stabilized
   - Fix: avoid forcedRoot globals; pass forcedRoot/forcedChapterId into run()
   - Fix: don’t lose a chapter if run is busy; queue for later
   ========================================================== */
    let _pendingForced = null; // { root: Element, cid: string, tries: number }
    
    function sweepInfiniteBodies() {
      const host = document.querySelector(".chapter-infinite-reader");
      if (!host) return;
    
      const bodies = Array.from(host.querySelectorAll(".chapter-body"))
        .filter(b => (b.innerText || "").trim().length > 200);
    
      for (const body of bodies) {
        if (!body) continue;
    
        // If we already declared this body stable, skip
        if (body.dataset.wtrpfSwept === "1") continue;
    
        const cid = getChapterIdForBody(body);
        if (!cid || cid === "unknown") continue;
        if (!contentReady(body)) continue;
    
        const sigNow = chapterSignature(body, cid);
        const applied = getAppliedSig(novelKey, cid);
    
        // If it’s already applied & stable, mark swept and clear queued
        if (applied && sigNow && sigNow === applied) {
          body.dataset.wtrpfSwept = "1";
          clearBodyQueued(body);
          continue;
        }
    
        // If we already queued it, don't spam requestRun every tick
        if (bodyIsQueued(body)) continue;
    
        // If busy, queue ONE pending forced run (latest wins) and mark queued
        if (running) {
          _pendingForced = { root: body, cid, tries: 0 };
          markBodyQueued(body);
          continue;
        }
    
        // Queue a forced run (debounced). Mark queued to prevent re-queue spam.
        markBodyQueued(body);
        requestRun("infinite-sweep", { forceFull: true, forcedRoot: body, forcedChapterId: cid });
      }
    }

    function startChapterMonitor() {
      let startedAt = Date.now();
    
      setInterval(() => {
        const inInfinite = !!document.querySelector(".chapter-infinite-reader");
        if (inInfinite) {
          sweepInfiniteBodies();
        }

        if (!ui.isEnabled()) return;
        if (document.hidden) return;
        if (running) return;

        drainPendingForced();

        // In infinite mode, the sweeper + pending forced runs handle updates per-baody.
        // Avoid "global forceFull" runs that may hit the wrong root.
        
        if (inInfinite) return;

        const root = rootManager?.getRoot() || findContentRoot();
        if (!contentReady(root)) return;
    
        const cid = getChapterId(root);
        const sigNow = chapterSignature(root, cid);
        if (!cid || !sigNow) return;
    
        const applied = getAppliedSig(novelKey, cid);
    
        // If we never applied to this chapter yet OR React overwrote after we applied, re-run.
        if (!applied || sigNow !== applied) {
          requestRun("monitor-force", { forceFull: true });
          return;
        }
    
        // Optional warmup light passes right after load/nav
        if (Date.now() - startedAt < CHAPTER_MONITOR_WARMUP_MS) {
          requestRun("monitor-light", { forceFull: false });
        }
      }, CHAPTER_MONITOR_MS);
    }

      // Nav sweep (A) — hardened so we ONLY apply once URL+DOM agree AND content is ready
      function startNavSweep(reason = "nav", epoch = navEpoch) {
        stopNavSweep();
      
        const startAt = Date.now();
        let stableHits = 0;
        let lastSeenChapterId = null;
        let sawNewContent = false;
      
        const FALLBACK_AFTER_MS = 1600;
      
        navSweepTimer = setInterval(() => {
          if (epoch !== navEpoch) { stopNavSweep(); return; } // newer nav happened
          if (!ui.isEnabled() || document.hidden) { stopNavSweep(); return; }
          if (Date.now() - startAt > NAV_SWEEP_MS) { stopNavSweep(); return; }
      
          const root = rootManager?.getRoot() || findContentRoot();
          ui.syncPillVisibility?.();
          if (!root || root === document.body) return;
          if (!contentReady(root)) { stableHits = 0; return; }
      
          const urlCid = getUrlChapterId();
          const domCid = getDomChapterId(root);
      
          const now = Date.now();
          const canFallback = (now - startAt) >= FALLBACK_AFTER_MS;
      
          let cid = null;
          if (urlCid !== "unknown" && domCid !== "unknown" && urlCid === domCid) {
            cid = urlCid;
          } else if (canFallback && urlCid !== "unknown") {
            cid = urlCid;
          } else if (domCid !== "unknown" && canFallback) {
            // IMPORTANT: allow DOM-only progress when URL doesn't change
            cid = domCid;
          } else {
            stableHits = 0;
            return;
          }
      
          const sigNow = chapterSignature(root, cid);
          if (!sigNow) { stableHits = 0; return; }
      
          // Don't "stabilize" on the old chapter before React swaps.
          if (!sawNewContent) {
            if (sigNow !== preNavSig || cid !== preNavCid) {
              sawNewContent = true;
            } else {
              stableHits = 0;
              return;
            }
          }
      
          if (cid !== lastSeenChapterId) {
            lastSeenChapterId = cid;
            stableHits = 0;
            localStorage.setItem(UI_KEY_MIN, "1");
            ui.setMinimized(true);
          }
      
          const applied = getAppliedSig(novelKey, cid);
      
          if (!applied || sigNow !== applied) {
            requestRun("nav-sweep", { forceFull: true });
            stableHits = 0;
            return;
          }
      
          stableHits++;
          if (stableHits >= 2) stopNavSweep();
        }, NAV_POLL_MS);
      }

      // ==========================================================
      // Hooks (B) — simplify: NO early forced runs; sweep decides when it's safe
      // ==========================================================
       let preNavSig = "";
      let preNavCid = "";
      let navEpoch = 0;
   
        const onNav = (why) => {
          console.log("[WTRPF] onNav fired:", why, "href=", location.href);
        
          localStorage.setItem(UI_KEY_MIN, "1");
          ui.setMinimized(true);
          ui.syncPillVisibility?.();
          ui.refreshDraftUI?.(); // NEW: load draft for the current novel immediately
        
          // Reset session gates
          lastSig = "";
          lastChapterId = null;
        
          // Capture "before nav" identity so sweep won't stabilize on old chapter
          const root0 = rootManager?.getRoot?.() || findContentRoot();
          preNavCid = root0 ? getChapterId(root0) : "";
          preNavSig = root0 ? chapterSignature(root0) : "";
          navEpoch++;
        
          rootManager.resolve();
          startNavSweep(String(why || "nav"), navEpoch); // startNavSweep will requestRun when safe
        };

        // ==========================================================
        // Route watcher: hide pill immediately when leaving chapter pages (SPA-safe)
        // - Calls syncPillVisibility() right away on ANY route change
        // - Does NOT call run() or onNav() (so it's cheap / safe)
        // ==========================================================
        function installRouteWatcher({ ui, rootManager, stopNavSweep }) {
          let lastHref = location.href;
          let syncBurstTimer = null;
        
          const doSync = (why) => {
            try { rootManager?.resolve?.(); } catch {}
            try { ui?.syncPillVisibility?.(); } catch {}
        
            // If we're NOT on a chapter page, stop any sweep and hard-hide pill
            // (syncPillVisibility already hides, this is just extra safety)
            try {
              if (typeof stopNavSweep === "function" && !isChapterReadingPage()) {
                stopNavSweep();
              }
            } catch {}
          };
        
          // Run a small burst of syncs so we catch "URL changed but DOM not swapped yet"
          const syncBurst = (why) => {
            if (syncBurstTimer) clearTimeout(syncBurstTimer);
        
            // Immediate + retries
            doSync(why + ":t0");
            setTimeout(() => doSync(why + ":t150"), 150);
            setTimeout(() => doSync(why + ":t400"), 400);
            setTimeout(() => doSync(why + ":t900"), 900);
        
            // Optional: one final delayed sync
            syncBurstTimer = setTimeout(() => doSync(why + ":t1600"), 1600);
          };
        
          window.addEventListener("popstate", () => syncBurst("popstate"), true);
          window.addEventListener("hashchange", () => syncBurst("hashchange"), true);
        
          const _push = history.pushState;
          const _rep  = history.replaceState;
        
          function wrapped(fn, why) {
            return function () {
              const r = fn.apply(this, arguments);
              setTimeout(() => syncBurst(why), 0);
              return r;
            };
          }
        
          history.pushState = wrapped(_push, "pushState");
          history.replaceState = wrapped(_rep, "replaceState");
        
          setInterval(() => {
            const href = location.href;
            if (href === lastHref) return;
            lastHref = href;
            syncBurst("href-poll");
          }, 250);
        
          document.addEventListener("click", () => setTimeout(() => syncBurst("click"), 60), true);
        
          syncBurst("init");
        }

        // Keep your nav-nudge:
        setTimeout(() => startNavSweep("nav-nudge"), 900);
      
      /* =========================
         F) Mode-aware wiring (upgrade #4)
         Replace your hook install section with this.
         (Keeps your hooks but avoids redundant observers per mode.)
         ========================= */

    let _hooksWired = false;
    let _hookMode = null; // "infinite" or "single"

    function isInfiniteModeNow() {
      return !!document.querySelector(".chapter-infinite-reader");
    }

    function wireHooksModeAware() {
      const infinite = isInfiniteModeNow();
      const mode = infinite ? "infinite" : "single";
    
      // If we already installed hooks, DO NOT install again.
      // Just detect if mode changed and nudge the sweep.
      if (_hooksWired) {
        if (_hookMode !== mode) {
          _hookMode = mode;
          // Mode changed after mount (single <-> infinite): re-resolve root + run a nav sweep.
          rootManager.resolve();
          onNav("mode-changed");
        } else {
          // Mode same: just refresh root + do a mild sweep in case the reader mounted late.
          rootManager.resolve();
          startNavSweep("late-mount-nudge", navEpoch);
        }
        return;
      }
    
      _hooksWired = true;
      _hookMode = mode;
    
      // Always helpful across modes
      installNextButtonHook((why) => onNav(why));
      installHistoryHooksLite((why) => onNav(why));
      installChapterTrackerObserver((why) => onNav(why), ui.isEnabled);
    
      // URL watcher mainly for single-chapter
      if (!infinite) {
        installUrlChangeWatcher((why) => onNav(why), ui.isEnabled);
    
        installActiveContentObserver(
          () => (rootManager?.getRoot?.() || findContentRoot()),
          (why) => {
            const root = rootManager?.getRoot?.() || findContentRoot();
            if (!root || !contentReady(root)) return;
    
            const cid = getChapterId(root);
            const sigNow = chapterSignature(root);
            if (!cid || !sigNow) return;
    
            const applied = getAppliedSig(novelKey, cid);
            if (!applied || sigNow !== applied) {
              requestRun("active-root-overwrite", { forceFull: true });
            }
          },
          ui.isEnabled
        );
      } else {
        installInfiniteReaderAppendObserver((why) => {
          onNav(why);
          setTimeout(() => sweepInfiniteBodies(), 80);
        }, ui.isEnabled);
      }
    }
 
      // Call once at startup:
      wireHooksModeAware();

    // Install route watcher once (SPA: hide pill immediately when leaving chapter pages)
      installRouteWatcher({ ui, rootManager, stopNavSweep });
      
      // And re-evaluate once shortly after load (reader can mount late):
      setTimeout(() => wireHooksModeAware(), 1600);


    // React overwrite catcher: if the active chapter root mutates after we applied,
      // rerun full pass (debounced). This is the missing piece for single-chapter Next.
   //   installActiveContentObserver(
     //   () => (rootManager?.getRoot?.() || findContentRoot()),
      //  (why) => {
          // Only re-run if the current DOM diverges from what we recorded as applied
       //   const root = rootManager?.getRoot?.() || findContentRoot();
       //   if (!root || !contentReady(root)) return;
      
       //   const cid = getChapterId(root);
        //  const sigNow = chapterSignature(root);
        //  if (!cid || !sigNow) return;
      
        //  const applied = getAppliedSig(novelKey, cid);
        //  if (!applied || sigNow !== applied) {
        //    run({ forceFull: true });
        //  }
       // },
     //   ui.isEnabled
    //  );

      // Initial run
      requestRun("initial", { forceFull: true });
      
      // Start watchdog
      startChapterMonitor();
      

  })();
})();
