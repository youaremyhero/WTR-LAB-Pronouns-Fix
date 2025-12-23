// ==UserScript==
// @name         WTR-LAB PF Test
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      1.2.2
// @description  Fixes Firefox Android Next navigation reliability + long-press popup reliability. Force runs bypass cooldown/signature gating. Adds touch long-press fallback. Keeps all UI/UX + New Character (JSON) section + small popup + Male/Female only.
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
    "https://raw.githubusercontent.com/youaremyhero/WTR-LAB-Pronouns-Fix/main/glossary.template.json";

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

  const DRAFT_KEY = "wtrpf_draft_v1";
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
    const el = root?.closest?.("[data-chapter-id]") || root?.querySelector?.("[data-chapter-id]");
    const id = el?.getAttribute?.("data-chapter-id");
    return id || "unknown";
  }
  // cheap 32-bit hash (fast enough for innerText)
  function hash32(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

    function chapterSignature(root) {
      if (!root) return "";
      const domCid = getDomChapterId(root);
    
      // Only hash actual reading blocks to avoid reruns from injected UI bits.
      const blocks = getTextBlocks(root);
      const joined = blocks
        .map(b => normalizeWeirdSpaces((b.textContent || "").trim()))
        .filter(Boolean)
        .join("\n");
    
      if (!joined) return `${domCid}|len:0|h:0`;
      return `${domCid}|len:${joined.length}|h:${hash32(joined)}`;
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
  // Draft helpers
  // ==========================================================
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{"items":[],"snippet":""}'); }
    catch { return { items: [], snippet: "" }; }
  }
  function saveDraft(d) { localStorage.setItem(DRAFT_KEY, JSON.stringify(d || { items: [], snippet: "" })); }

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
    const cb = document.querySelector(".chapter-body");
    if (cb) return cb;

    const likely = document.querySelector("[data-chapter-id]")?.closest?.(".chapter-body, .chapter, main, article");
    if (likely) return likely;

    const candidates = Array.from(document.querySelectorAll("article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section"));
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

  // ==========================================================
  // Character detection
  // ==========================================================
  function detectCharactersOnPage(root, entries) {
    const hay = (root?.innerText || "").toLowerCase();
    const detected = [];
    for (const [name, info] of entries) {
      const nameLower = String(name || "").toLowerCase();
      if (nameLower && hay.includes(nameLower)) { detected.push([name, info]); continue; }
      const aliases = Array.isArray(info.aliases) ? info.aliases : [];
      for (const a of aliases) {
        const aLower = String(a || "").toLowerCase();
        if (aLower && hay.includes(aLower)) { detected.push([name, info]); break; }
      }
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
    catch { savedPos = {}; localStorage.removeItem(UI_KEY_POS); };
    const enabledInit = localStorage.getItem(UI_KEY_ON);
    if (enabledInit !== "0" && enabledInit !== "1") localStorage.setItem(UI_KEY_ON, "1");

    function enabled() { return localStorage.getItem(UI_KEY_ON) !== "0"; }
    function setEnabled(v) { localStorage.setItem(UI_KEY_ON, v ? "1" : "0"); }

    let charactersCount = 0;
    let charactersList3 = "";
    let changedTotal = 0;
    let glossaryOk = true;

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
    `;
    document.documentElement.appendChild(style);

    function applyPos(el) {
      // minimized pill top-left by default
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

    const summary = document.createElement("div");
    summary.style.cssText = `white-space: pre-line; opacity: .95; margin-top:8px;`;

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
    onboard.textContent =
      "Tips:\n" +
      "• Long-press a WTR term (span) to open Add menu.\n" +
      "• Choose Male/Female to add a one-line JSON snippet to Draft.\n" +
      "• Draft persists; Copy JSON copies the snippet.\n" +
      "• Pronoun fixes rerun automatically when you go Next.";

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px; background: rgba(255,255,255,0.12); margin:10px 0;`;

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

    function refreshToggleUI() {
      const on = enabled();
      toggleBtn.textContent = on ? "ON" : "OFF";
      toggleBtn.style.background = on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)";
      pillText.textContent = `PF (${on ? "ON" : "OFF"})`;
    }

    function refreshSummary() {
      if (!glossaryOk) {
        summary.textContent = "Glossary error";
        return;
      }
      const line1 = `• Characters: ${charactersCount}` + (charactersList3 ? ` • ${charactersList3}` : "");
      const line2 = `• Changed: ${changedTotal}`;
      summary.textContent = `${line1}\n${line2}`;
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
      pill.style.display = min ? "block" : "none";
    }

    minBtn.onclick = () => setMin(true);
    pillExpandBtn.onclick = () => setMin(false);
    pillText.onclick = () => setMin(false);

    sectionToggle.onclick = () => {
      draftSectionOpen = !draftSectionOpen;
      const d = loadDraft();
      setDraftUI(d?.snippet || "", (d?.items || []).length);
      clampToViewport(box);
    };

    controls.appendChild(toggleBtn);
    controls.appendChild(helpBtn);
    controls.appendChild(minBtn);

    topRow.appendChild(title);
    topRow.appendChild(controls);

    sectionHeader.appendChild(sectionTitle);
    sectionHeader.appendChild(sectionToggle);

    box.appendChild(topRow);
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
      const d = loadDraft();
      const txt = d?.snippet || "";
      if (!txt) return;
      await writeClipboard(txt);
    };

    clearBtn.onclick = () => {
      if (clearBtn.disabled) return;
      saveDraft({ items: [], snippet: "" });
      setDraftUI("", 0);
    };

    return {
      isEnabled: () => enabled(),
      setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshSummary(); },
      setCharacters: (detectedEntries) => {
        charactersCount = detectedEntries.length;
        const base = detectedEntries.length ? detectedEntries : [];
        const names = base.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
          const g = String(info.gender || "").toLowerCase();
          const label = (g === "female" || g === "male") ? g : "unknown";
          return `${name} (${label})`;
        });
        charactersList3 = names.join(", ") + (base.length > MAX_NAMES_SHOWN ? " …" : "");
        refreshSummary();
      },
      setChanged: (val) => {
        changedTotal = clamp(Number(val) || 0, 0, 999999);
        refreshSummary();
      },
      setMinimized: (min) => setMin(!!min),
      setDraftUI,
      refreshDraftUI: () => {
        const d = loadDraft();
        setDraftUI(d?.snippet || "", (d?.items || []).length);
      }
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
      const d = loadDraft();
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.includes(line)) items.push(line);
      const snippet = items.join("\n");
      saveDraft({ items, snippet });
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
    
        // We are intentionally taking over the gesture now.
        tTriggered = true;
        try { e.preventDefault(); } catch {}
        try { e.stopPropagation(); } catch {}
    
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
    
      const root = findContentRoot();
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

  // URL+DOM route observer” that cannot miss SPA transitions
//    function installRouteObserver(onNav) {
//    let lastHref = location.href;
//    let lastFire = 0;
  
  //  const fire = (why) => {
   //   const now = Date.now();
   //   if (now - lastFire < 250) return; // debounce
  //    lastFire = now;
  //    onNav(why);
  //  };
  
    // 1) MutationObserver on BODY subtree (SPA content swaps)
//    const mo = new MutationObserver(() => {
 //     const href = location.href;
  //    if (href !== lastHref) {
     //   lastHref = href;
      //  fire("mo-href-change");
     //   return;
     // }
  
      // Even if href didn't change, reader content often re-renders
      // so still fire lightly (nav sweep will decide whether to run)
   //   fire("mo-dom-change");
  //  });
  //  mo.observe(document.body, { childList: true, subtree: true });
  
    // 2) Also patch history (some sites update URL without DOM mutations immediately)
   // const _push = history.pushState;
   // const _rep = history.replaceState;
   // history.pushState = function () { const r = _push.apply(this, arguments); fire("pushState"); return r; };
  //  history.replaceState = function () { const r = _rep.apply(this, arguments); fire("replaceState"); return r; };
  //  window.addEventListener("popstate", () => fire("popstate"), true);
  
    // 3) Immediate invoke
   // fire("route-init");
//  }


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
    document.addEventListener("visibilitychange", () => { if (!document.hidden) fire(); }, true);
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

  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
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

      if (primaryCharacter && text.includes(primaryCharacter) && characters[primaryCharacter]) {
        const g0 = String(characters[primaryCharacter].gender || "").toLowerCase();
        if (g0 === "female" || g0 === "male") return g0;
      }

      if (U.passiveVoice) {
        const gAgent = detectPassiveAgentGender(text, entries);
        if (gAgent) return gAgent;
      }

      if (U.dialogueSpeaker) {
        const gSpeaker = detectDialogueSpeakerGender(text, entries);
        if (gSpeaker) return gSpeaker;
      }

      for (const [name, info] of entries) {
        const aliases = Array.isArray(info.aliases) ? info.aliases : [];
        if (text.includes(name)) {
          const g = String(info.gender || "").toLowerCase();
          if (g === "female" || g === "male") return g;
        }
        for (const a of aliases) {
          if (a && text.includes(a)) {
            const g = String(info.gender || "").toLowerCase();
            if (g === "female" || g === "male") return g;
          }
        }
      }
      return null;
    }

    function updateDetectedCharactersUI(root) {
      const detected = detectCharactersOnPage(root, entries);
      if (detected.length) ui.setCharacters(detected);
      else ui.setCharacters(entries.slice(0, Math.min(entries.length, MAX_NAMES_SHOWN)));
    }

    let lastActorGender = null;
    let lastActorTTL = 0;

    let lastChapterId = null;
    let lastSig = "";
    let running = false;
    let lastRunAt = 0;

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

   // ✅ KEY FIX: forceFull bypasses cooldown + signature skip
    function run({ forceFull = false } = {}) {
      if (!ui.isEnabled()) return;
      if (document.hidden) return;
      if (running) return;
    
      const now = Date.now();
      if (!forceFull && (now - lastRunAt < SELF_MUTATION_COOLDOWN_MS)) return;
    
      const root = findContentRoot();
      if (!root) return;
    
      const urlCid = getUrlChapterId();
      const domCid = getDomChapterId(root);
    
      // During SPA nav, URL often changes before DOM.
      // Give DOM a short grace window to catch up; after that, fall back to URL.
      // IMPORTANT: forceFull should bypass grace, because onNav relies on it.
      const DOM_GRACE_MS = 1200;
      run._domGraceStart = run._domGraceStart || 0;
      
      const mismatch =
        (urlCid !== "unknown" && domCid !== "unknown" && domCid !== urlCid) ||
        (urlCid !== "unknown" && domCid === "unknown");
      
      if (mismatch && !forceFull) {
        run._domGraceStart = run._domGraceStart || Date.now();
        if (Date.now() - run._domGraceStart < DOM_GRACE_MS) return;
      }
      run._domGraceStart = 0;

      const chapterId = (domCid !== "unknown") ? domCid : urlCid;
    
      // MUST be function-scoped (used after try/finally)
      let pronounEdits = 0;
    
      // Optional: on forceFull, clear per-node patch markers so we reprocess everything
      if (forceFull && root?.querySelectorAll) {
        try {
          // You mark patched blocks via dataset.wtrpfPatched = "1"
          // So clear those (not data-wtrpf-patched which you never set)
          root.querySelectorAll("[data-wtrpf-patched], [data-wtrpf-patched-chapter], [data-wtrpf-patchedchapter], [data-wtrpf-patchedChapter]").forEach(el => {
            if (el?.dataset) {
              delete el.dataset.wtrpfPatched;
              delete el.dataset.wtrpfPatchedChapter;
            }
          });
      
          // Most importantly: clear the markers you *do* set
          root.querySelectorAll("[data-wtrpf-patched='1']").forEach(el => {
            if (el?.dataset) delete el.dataset.wtrpfPatched;
          });
      
          // Also clear root marker
          if (root?.dataset) delete root.dataset.wtrpfPatchedChapter;
        } catch {}
      }

      if (!contentReady(root)) return;
    
      // Signature gate: only skip if same as last applied in this session (unless forceFull)
      const sigBefore = chapterSignature(root);
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
    
          // If React reuses DOM nodes between chapters, clear old patch markers
          try {
            if (root?.dataset) {
              delete root.dataset.wtrpfPatched;
              delete root.dataset.wtrpfPatchedChapter;
            }
            root?.querySelectorAll?.("[data-wtrpf-patched], [data-wtrpf-patched-chapter]").forEach(el => {
              if (el?.dataset) {
                delete el.dataset.wtrpfPatched;
                delete el.dataset.wtrpfPatchedChapter;
              }
            });
          } catch {}
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
    
          // Anchored fixes first (local window after names)
          if (U.anchoredFixes) {
            pronounEdits += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, entries, U));
          }
    
          let g = null;
          let hadDirectMatch = false;
    
          if (usedMode === "chapter") {
            g = chapterGender;
            hadDirectMatch = true;
          } else {
            const computed = computeGenderForText(bt);
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
    
            if (doFull) {
              pronounEdits += replaceInTextNodes(b, (txt) => replacePronounsSmart(txt, dir));
            }
    
            if (usedMode !== "chapter" && hadDirectMatch) {
              lastGender = g;
              carryLeft = carryParagraphs;
            }
          }
    
          markBlockPatched(b);
        }
    
        if (doFullPass) markRootPatched(root, chapterId);

        // If DOM already equals the applied signature, treat as no-op to avoid inflating counts
        if (pronounEdits > 0) {
          const sigNow = chapterSignature(root);
          const applied = getAppliedSig(novelKey, chapterId);
          if (applied && sigNow === applied) {
            pronounEdits = 0;
          }
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
    
        // Record what the chapter looks like AFTER we apply changes.
        // If React overwrites later, signature will diverge and we can re-apply.
        const sigAfter = chapterSignature(root);
        if (sigAfter) {
          setAppliedSig(novelKey, chapterId, sigAfter);
          lastSig = sigAfter; // session gate uses post-edit signature
        } else {
          lastSig = sigBefore;
        }
    
        saveChapterState(st);
      } finally {
        running = false;
        lastRunAt = Date.now();
      }
    
    }
    
    function startChapterMonitor() {
      let startedAt = Date.now();
    
      setInterval(() => {
        if (!ui.isEnabled()) return;
        if (document.hidden) return;
        if (running) return;
    
        const root = findContentRoot();
        if (!contentReady(root)) return;
    
        const cid = getChapterId(root);
        const sigNow = chapterSignature(root);
        if (!cid || !sigNow) return;
    
        const applied = getAppliedSig(novelKey, cid);
    
        // If we never applied to this chapter yet OR React overwrote after we applied, re-run.
        if (!applied || sigNow !== applied) {
          run({ forceFull: true });
          return;
        }
    
        // Optional warmup light passes right after load/nav
        if (Date.now() - startedAt < CHAPTER_MONITOR_WARMUP_MS) {
          run({ forceFull: false });
        }
      }, CHAPTER_MONITOR_MS);
    }

    // Nav sweep (A)
    function startNavSweep(reason = "nav") {
      stopNavSweep();
    
      const startAt = Date.now();
      let stableHits = 0;
      let lastSeenChapterId = null;
    
      navSweepTimer = setInterval(() => {
        if (!ui.isEnabled() || document.hidden) {
          stopNavSweep();
          return;
        }
    
        // hard stop
        if (Date.now() - startAt > NAV_SWEEP_MS) {
          stopNavSweep();
          return;
        }
    
        const root = findContentRoot();
        if (!root || root === document.body) return;
        if (!contentReady(root)) return; // keep waiting
    
        // ✅ CRITICAL: URL/DOM mismatch guard (prevents stopping on old chapter)
        const urlCid = getUrlChapterId();
        const domCid = getDomChapterId(root);
    
        // If URL already moved but DOM hasn’t caught up yet, keep sweeping.
        // Do NOT let stableHits reach the stop condition.
        if (urlCid !== "unknown" && domCid !== "unknown" && urlCid !== domCid) {
          stableHits = 0;
          return;
        }
        if (urlCid !== "unknown" && domCid === "unknown") {
          stableHits = 0;
          return;
        }
    
        const cid = getChapterId(root);
        const sigNow = chapterSignature(root);
        if (!cid || !sigNow) return;
    
        // if chapter changed during sweep, reset stability counter
        if (cid !== lastSeenChapterId) {
          lastSeenChapterId = cid;
          stableHits = 0;
    
          // minimise on nav (kept behavior)
          localStorage.setItem(UI_KEY_MIN, "1");
          ui.setMinimized(true);
        }
    
        const applied = getAppliedSig(novelKey, cid);
    
        // If not yet applied (or React overwrote), force re-apply now
        if (!applied || sigNow !== applied) {
          run({ forceFull: true });
          stableHits = 0;
          return;
        }
    
        // Already applied; require a couple consecutive confirmations before stopping
        stableHits++;
        if (stableHits >= 2) stopNavSweep();
      }, NAV_POLL_MS);
    }

    // ==========================================================
    // Hooks (B)
    // ==========================================================
    const onNav = (why) => {
      localStorage.setItem(UI_KEY_MIN, "1");
      ui.setMinimized(true);
    
      // Run a couple of forced attempts quickly (covers Firefox Android timing weirdness)
      setTimeout(() => run({ forceFull: true }), 60);
      setTimeout(() => run({ forceFull: true }), 260);
      setTimeout(() => run({ forceFull: true }), 620);
    
      // Keep your sweep as a backstop
      startNavSweep(String(why || "nav"));
    };

    installNextButtonHook(onNav);
    installHistoryHooks(onNav);
    installChapterBodyObserver(onNav);
    installChapterBodyReplaceWatcher(onNav);
    installUrlChangeWatcher(onNav, ui.isEnabled);

    // Initial run
    run({ forceFull: true });

    // Start watchdog
    startChapterMonitor();

    // Light observer for late paragraph insertions on the initial root only (debounced)
    const root0 = findContentRoot();
    if (root0 && root0 !== document.body) {
      let incrTimer = null;
      const mo = new MutationObserver(() => {
        if (!ui.isEnabled()) return;
        if (incrTimer) return;
        incrTimer = setTimeout(() => {
          incrTimer = null;
          run({ forceFull: false });
        }, 260);
      });
      mo.observe(root0, { childList: true, subtree: true });

    }
  })();
})();
