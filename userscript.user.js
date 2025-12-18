// ==UserScript==
// @name         WTR PF Test
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.5-hotfix4
// @description  WTR-LAB Pronouns Fix — adds URL-based navigation sweep (Firefox Android Next button fix) + extra-compact gender picker w/ close.
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

  // Storage safety
  const TERM_MEM_MAX_KEYS = 300;

  // Glossary cache
  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v1";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000;

  // Persistent UI state
  const UI_KEY_MIN = "wtrpf_ui_min_v1";
  const UI_KEY_POS = "wtrpf_ui_pos_v1";
  const UI_KEY_ON  = "wtrpf_enabled_v1";

  // Draft + term memory
  const DRAFT_KEY = "wtrpf_draft_v1";
  const TERM_MEM_KEY_PREFIX = "wtrpf_term_mem_v1:";
  const CHAPTER_STATE_KEY_PREFIX = "wtrpf_chapter_state_v1:";

  // Prevent self-triggered rerun clobbering
  const SELF_MUTATION_COOLDOWN_MS = 450;

  // Long press
  const LONGPRESS_MS = 520;
  const LONGPRESS_MOVE_PX = 12;

  // Navigation sweep — more aggressive for Firefox Android
  const NAV_SWEEP_MS = 6500;     // total sweep duration
  const NAV_SWEEP_TICK = 180;    // retry frequency
  const URL_POLL_MS = 260;       // URL poll frequency (Next button often changes URL reliably)

  // ==========================================================
  // Utilities
  // ==========================================================
  const SENT_PREFIX = String.raw`(^|[\r\n]+|[.!?…]\s+)(["'“‘(\[]\s*)?`;
  const LETTER = String.raw`\p{L}`;

  const RX_PRONOUN_MALE = /\b(he|him|his|himself)\b/gi;
  const RX_PRONOUN_FEMALE = /\b(she|her|hers|herself)\b/gi;

  const RX_ATTACK_CUES = /\b(knife|blade|sword|dagger|stab|stabs|stabbed|slash|slashed|strike|struck|hit|hits|punched|kicked|cut|pierce|pierced|neck|chest)\b/i;

  const RX_CJK = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/;

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

  function urlKey() {
    // ignore hashes and trivial params ordering changes
    return (location.href || "").split("#")[0];
  }

  // ==========================================================
  // Draft helpers — normalize + dedupe
  // ==========================================================
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{"items":[],"snippet":""}'); }
    catch { return { items: [], snippet: "" }; }
  }
  function saveDraft(d) { localStorage.setItem(DRAFT_KEY, JSON.stringify(d || { items: [], snippet: "" })); }

  function extractNameFromDraftLine(line) {
    const m = String(line || "").match(/^\s*"([^"]+)"\s*:/);
    return m ? m[1] : null;
  }

  function normalizeNameForKey(name) {
    let s = String(name || "");
    s = normalizeWeirdSpaces(s);
    s = s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    if (s.length > 80) s = s.slice(0, 80).trim();
    return s;
  }

  function oneLineCharacterSnippet(name, gender) {
    const obj = { gender: String(gender) };
    return `"${name}": ${JSON.stringify(obj)},`;
  }

  function upsertDraftCharacter(nameRaw, gender) {
    const name = normalizeNameForKey(nameRaw);
    if (!name) return { ok: false };

    const d = loadDraft();
    const items = Array.isArray(d.items) ? d.items.slice() : [];

    const seen = new Set();
    for (const it of items) {
      const n = extractNameFromDraftLine(it);
      if (!n) continue;
      seen.add(normalizeNameForKey(n).toLowerCase());
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { ok: true, snippet: (d.snippet || items.join("\n")), count: items.length };
    }

    items.push(oneLineCharacterSnippet(name, gender));
    const snippet = items.join("\n");
    saveDraft({ items, snippet });
    return { ok: true, snippet, count: items.length };
  }

  // ==========================================================
  // Smart pronoun replacement (COUNTED)
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
    const femCount  = countMatches(RX_PRONOUN_FEMALE, region);
    if (gender === "male") return femCount > 0;
    return maleCount > 0;
  }

  // ==========================================================
  // Anchored fixes
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
  // Term memory + patches
  // ==========================================================
  function getNovelKeyFromURL() {
    const m = location.href.match(/wtr-lab\.com\/en\/novel\/(\d+)\//i);
    return m ? `wtr-lab.com/en/novel/${m[1]}/` : "wtr-lab.com/en/novel/";
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
  // UI (minimised by default + compact picker w/ X)
  // ==========================================================
  function makeUI() {
    const savedPos = JSON.parse(localStorage.getItem(UI_KEY_POS) || "{}");
    const enabledInit = localStorage.getItem(UI_KEY_ON);
    if (enabledInit !== "0" && enabledInit !== "1") localStorage.setItem(UI_KEY_ON, "1");

    function enabled() { return localStorage.getItem(UI_KEY_ON) !== "0"; }
    function setEnabled(v) { localStorage.setItem(UI_KEY_ON, v ? "1" : "0"); }

    let charactersCount = 0;
    let charactersList3 = "";
    let changedTotal = 0;
    let glossaryOk = true;

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
        el.setPointerCapture(e.pointerId);
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
        const rect = el.getBoundingClientRect();
        const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
        const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
        const left = Math.min(Math.max(6, rect.left), maxLeft);
        const top = Math.min(Math.max(6, rect.top), maxTop);
        el.style.left = left + "px";
        el.style.top = top + "px";
        el.style.right = "auto";
        localStorage.setItem(UI_KEY_POS, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
      };

      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }

    const isMobile = window.innerWidth <= 480;

    const box = document.createElement("div");
    box.setAttribute("data-wtrpf-ui", "1");
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

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px; background: rgba(255,255,255,0.12); margin:10px 0;`;

    const draftWrap = document.createElement("div");
    draftWrap.style.cssText = `display:none;`;

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
    pill.setAttribute("data-wtrpf-ui", "1");
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
      if (draftCount > 0 && jsonSnippet) {
        draftWrap.style.display = "block";
        draftBox.value = jsonSnippet;
      } else {
        draftWrap.style.display = "none";
        draftBox.value = "";
      }
    }

    toggleBtn.onclick = () => {
      setEnabled(!enabled());
      refreshToggleUI();
      setTimeout(() => location.reload(), 150);
    };

    function setMin(min) {
      localStorage.setItem(UI_KEY_MIN, min ? "1" : "0");
      box.style.display = min ? "none" : "block";
      pill.style.display = min ? "block" : "none";
    }

    minBtn.onclick = () => setMin(true);
    pillExpandBtn.onclick = () => setMin(false);
    pillText.onclick = () => setMin(false);

    controls.appendChild(toggleBtn);
    controls.appendChild(minBtn);

    topRow.appendChild(title);
    topRow.appendChild(controls);

    box.appendChild(topRow);
    box.appendChild(summary);
    box.appendChild(divider);

    draftWrap.appendChild(draftLabel);
    draftWrap.appendChild(draftBox);

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(clearBtn);

    box.appendChild(draftWrap);
    box.appendChild(btnRow);
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

    // Always minimised by default
    setMin(true);

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
      const d = loadDraft();
      const txt = d?.snippet || "";
      if (!txt) return;
      await writeClipboard(txt);
    };

    clearBtn.onclick = () => {
      saveDraft({ items: [], snippet: "" });
      setDraftUI("", 0);
    };

    // EXTRA compact picker (smaller padding + tighter buttons), with X, tap-outside, Esc. Male/Female only.
    function showGenderPicker(name, onPick) {
      const backdrop = document.createElement("div");
      backdrop.setAttribute("data-wtrpf-ui", "1");
      backdrop.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(0,0,0,0);
      `;

      const picker = document.createElement("div");
      picker.setAttribute("data-wtrpf-ui", "1");
      picker.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        top: 58%;
        transform: translate(-50%, -50%);
        background: rgba(0,0,0,0.86);
        color: #fff;
        border-radius: 12px;
        padding: 6px;
        width: min(190px, 52vw);
        box-shadow: 0 12px 30px rgba(0,0,0,.4);
        backdrop-filter: blur(6px);
        font: 12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
      `;

      const header = document.createElement("div");
      header.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:5px;`;

      const t = document.createElement("div");
      const nm = String(name);
      t.textContent = `Add: ${nm.length > 22 ? nm.slice(0, 22) + "…" : nm}`;
      t.style.cssText = `font-weight:600; font-size:12px;`;

      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.title = "Close";
      close.style.cssText = `
        appearance:none; border:0; cursor:pointer;
        width:22px; height:22px; border-radius:10px;
        background: rgba(255,255,255,0.10);
        color:#fff; font-size:18px; line-height:22px;
        padding:0;
      `;

      header.appendChild(t);
      header.appendChild(close);

      const btnWrap = document.createElement("div");
      btnWrap.style.cssText = `display:flex; gap:5px;`;

      const mkBtn = (label) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = `
          flex:1;
          appearance:none; border:0; cursor:pointer;
          padding:5px 6px;
          border-radius:10px;
          background: rgba(255,255,255,0.14);
          color:#fff;
          font-size:12px;
        `;
        return b;
      };

      const maleBtn = mkBtn("Male");
      const femaleBtn = mkBtn("Female");

      const esc = (e) => { if (e.key === "Escape") cleanup(); };
      function cleanup() {
        document.removeEventListener("keydown", esc);
        backdrop.remove();
        picker.remove();
      }

      close.onclick = cleanup;
      backdrop.addEventListener("click", cleanup);
      maleBtn.onclick = () => { cleanup(); onPick("male"); };
      femaleBtn.onclick = () => { cleanup(); onPick("female"); };

      document.addEventListener("keydown", esc);
      picker.appendChild(header);
      btnWrap.append(maleBtn, femaleBtn);
      picker.appendChild(btnWrap);

      document.body.appendChild(backdrop);
      document.body.appendChild(picker);
    }

    function addCharacterFlow(name) {
      const n = normalizeNameForKey(name);
      if (!n) return;
      showGenderPicker(n, (gender) => {
        const res = upsertDraftCharacter(n, gender);
        if (res && res.ok) setDraftUI(res.snippet, res.count);
      });
    }

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
      setMinimized: (min) => {
        const want = !!min;
        box.style.display = want ? "none" : "block";
        pill.style.display = want ? "block" : "none";
        localStorage.setItem(UI_KEY_MIN, want ? "1" : "0");
      },
      setDraftUI,
      addCharacterFlow
    };
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
  function findContentRoot() {
    const cb = document.querySelector(".chapter-body.menu-target[data-chapter-id]");
    if (cb) return cb;

    const likely = document.querySelector("[data-chapter-id]")?.closest?.(".chapter-body, .chapter, main, article");
    if (likely) return likely;

    const candidates = Array.from(document.querySelectorAll("article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section"));
    let best = null, bestScore = 0;
    for (const el of candidates) {
      const pCount = el.querySelectorAll("p").length;
      const textLen = (el.innerText || "").trim().length;
      const score = (pCount * 1200) + textLen;
      if (score > bestScore && textLen > 400) { bestScore = score; best = el; }
    }
    return best || document.body;
  }

  function getChapterId(root) {
    const el = root?.closest?.("[data-chapter-id]") || root?.querySelector?.("[data-chapter-id]");
    const id = el?.getAttribute?.("data-chapter-id");
    return id || "unknown";
  }

  const SKIP_CLOSEST = [
    "header","nav","footer","aside","form",
    "button","input","textarea","select",
    "[role='navigation']",
    ".breadcrumbs",".breadcrumb",".toolbar",".tools",".tool",
    ".pagination",".pager",".share",".social",
    ".menu",".navbar",".nav",".btn",".button"
  ].join(",");

  function isSkippable(el) { return !!(el && el.closest && el.closest(SKIP_CLOSEST)); }

  function getTextBlocks(root) {
    const blocks = Array.from(root.querySelectorAll("p, blockquote, li"));
    return blocks.filter(b => {
      if (isSkippable(b)) return false;
      const t = (b.innerText || "").trim();
      return t.length >= 20;
    });
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
  // Signature for skip (disabled during sweep)
  // ==========================================================
  function makeSignature(root) {
    const t = (root.innerText || "").trim();
    const head = t.slice(0, 240);
    const tail = t.slice(Math.max(0, t.length - 240));
    return `${t.length}|${head}|${tail}`;
  }

  // ==========================================================
  // Long-press multiword phrase expansion (kept)
  // ==========================================================
  function caretRangeAtPoint(x, y) {
    try {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.setEnd(pos.offsetNode, pos.offset);
        return r;
      }
      return null;
    } catch { return null; }
  }

  function paragraphAndIndexFromRange(r) {
    try {
      const n = r?.startContainer;
      const el = n?.nodeType === 1 ? n : n?.parentElement;
      if (!el) return null;
      const p = el.closest("p, li, blockquote");
      if (!p) return null;

      const pre = document.createRange();
      pre.setStart(p, 0);
      pre.setEnd(r.startContainer, r.startOffset);
      const idx = (pre.toString() || "").length;

      const text = normalizeWeirdSpaces(p.innerText || "");
      return { p, text, idx: clamp(idx, 0, text.length) };
    } catch { return null; }
  }

  function isTitleWord(w) {
    if (!w) return false;
    if (RX_CJK.test(w)) return true;
    if (/^[A-Z][a-z]+$/.test(w)) return true;
    if (/^[A-Z]{2,}$/.test(w)) return true;
    if (/^[A-Z][a-z]+(?:-[A-Z][a-z]+)+$/.test(w)) return true;
    return false;
  }

  function tokenizeWithSpans(text) {
    const out = [];
    const rx = /[\p{L}\p{N}_-]+/gu;
    let m;
    while ((m = rx.exec(text)) !== null) out.push({ w: m[0], s: m.index, e: m.index + m[0].length });
    return out;
  }

  function expandToTitlePhrase(text, idx) {
    const toks = tokenizeWithSpans(text);
    if (!toks.length) return "";

    let i = toks.findIndex(t => idx >= t.s && idx <= t.e);
    if (i < 0) {
      let best = 0, bestD = 1e9;
      for (let k = 0; k < toks.length; k++) {
        const d = Math.min(Math.abs(idx - toks[k].s), Math.abs(idx - toks[k].e));
        if (d < bestD) { bestD = d; best = k; }
      }
      i = best;
    }

    let L = i, R = i;
    const MAX_WORDS = 5;

    while (R + 1 < toks.length && (R - L + 1) < MAX_WORDS && isTitleWord(toks[R + 1].w)) R++;
    while (L - 1 >= 0 && (R - L + 1) < MAX_WORDS && isTitleWord(toks[L - 1].w)) L--;

    const slice = text.slice(toks[L].s, toks[R].e);
    const name = normalizeNameForKey(slice);

    const single = normalizeNameForKey(toks[i].w);
    if (!name) return single;
    if (name.length < 2) return single;
    if (name.split(" ").length <= 1) return single;

    return name;
  }

  function wordFromPoint(x, y, root) {
    try {
      const r = caretRangeAtPoint(x, y);
      if (!r) return "";
      const n = r.startContainer;
      if (!n) return "";
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || (root && !root.contains(el))) return "";
      const t = (n.nodeType === 3) ? String(n.nodeValue || "") : "";
      if (!t) return "";
      const i = clamp(r.startOffset || 0, 0, t.length);

      const isWordish = (ch) => /[\p{L}\p{N}_-]/u.test(ch);
      let L = i, R = i;
      while (L > 0 && isWordish(t[L - 1])) L--;
      while (R < t.length && isWordish(t[R])) R++;
      let out = normalizeNameForKey(t.slice(L, R));
      if (out.length < 2) return "";
      if (out.length > 40) out = out.slice(0, 40).trim();
      return out;
    } catch { return ""; }
  }

  function installLongPress(ui) {
    let timer = null;
    let sx = 0, sy = 0;
    let active = false;
    let downTarget = null;

    const clear = () => { if (timer) clearTimeout(timer); timer = null; active = false; downTarget = null; };

    document.addEventListener("pointerdown", (e) => {
      if (!ui.isEnabled?.()) return;
      if (e.button != null && e.button !== 0) return;

      const t = e.target;
      if (t && t.closest && t.closest("[data-wtrpf-ui]")) return;

      active = true;
      downTarget = t;
      sx = e.clientX || 0;
      sy = e.clientY || 0;

      timer = setTimeout(() => {
        timer = null;
        if (!active) return;

        const root = findContentRoot();
        if (!root) return;

        const sp = downTarget && downTarget.closest && downTarget.closest("span.text-patch.system[data-hash]");
        if (sp) {
          const name = normalizeNameForKey(sp.textContent || "");
          if (name) ui.addCharacterFlow(name);
          return;
        }

        const r = caretRangeAtPoint(sx, sy);
        const info = r ? paragraphAndIndexFromRange(r) : null;
        if (info && info.text && info.text.length > 0) {
          const phrase = expandToTitlePhrase(info.text, info.idx);
          if (phrase) { ui.addCharacterFlow(phrase); return; }
        }

        const w = wordFromPoint(sx, sy, root);
        if (w) ui.addCharacterFlow(w);
      }, LONGPRESS_MS);
    }, true);

    document.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dx = (e.clientX || 0) - sx;
      const dy = (e.clientY || 0) - sy;
      if (Math.hypot(dx, dy) > LONGPRESS_MOVE_PX) clear();
    }, true);

    document.addEventListener("pointerup", clear, true);
    document.addEventListener("pointercancel", clear, true);
  }

  // ==========================================================
  // Navigation hooks
  // ==========================================================
  function installNavHooks(onNav) {
    const fire = () => setTimeout(onNav, 50);
    window.addEventListener("popstate", fire);

    const _push = history.pushState;
    const _rep  = history.replaceState;
    history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
    history.replaceState = function () { const r = _rep.apply(this, arguments); fire(); return r; };

    // Some variants do DOM swaps without pushing state — still helps sometimes
    const mo = new MutationObserver(() => fire());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
    if (!ui.isEnabled()) return;

    const initialDraft = loadDraft();
    ui.setDraftUI?.(initialDraft?.snippet || "", (initialDraft?.items || []).length);

    installLongPress(ui);

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

    const mode = String(cfg.mode || "paragraph").toLowerCase();
    const primaryCharacter = cfg.primaryCharacter || null;
    const forceGender = String(cfg.forceGender || "").toLowerCase();
    const carryParagraphs = Number.isFinite(+cfg.carryParagraphs)
      ? Math.max(0, Math.min(5, +cfg.carryParagraphs))
      : DEFAULT_CARRY_PARAGRAPHS;

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

    let lastActorGender = null;
    let lastActorTTL = 0;

    let lastChapterId = null;
    let lastSigForSkip = "";
    let processedOnce = false;

    let running = false;
    let lastRunAt = 0;

    // URL-based navigation detection
    let lastURL = urlKey();

    // Sweep state
    let navSweepUntil = 0;
    let navSweepTimer = null;

    function startNavSweep(reason = "nav") {
      navSweepUntil = Date.now() + NAV_SWEEP_MS;
      // IMPORTANT: wipe signature to avoid accidental "skip" during swaps
      lastSigForSkip = "";
      processedOnce = false;

      if (navSweepTimer) return;
      navSweepTimer = setInterval(() => {
        if (Date.now() > navSweepUntil) {
          clearInterval(navSweepTimer);
          navSweepTimer = null;
          return;
        }
        run(true);
      }, NAV_SWEEP_TICK);
    }

    function contentReady(root) {
      if (!root) return false;
      const blocks = getTextBlocks(root);
      const textLen = (root.innerText || "").trim().length;
      return blocks.length >= 6 && textLen >= 600;
    }

    function updateDetectedCharactersUI(root) {
      const detected = detectCharactersOnPage(root, entries);
      if (detected.length) ui.setCharacters(detected);
      else ui.setCharacters(entries.slice(0, Math.min(entries.length, MAX_NAMES_SHOWN)));
    }

    function run(isSweep = false) {
      if (!ui.isEnabled()) return;
      if (document.hidden) return;
      if (running) return;

      const now = Date.now();
      const cooldown = isSweep ? 140 : SELF_MUTATION_COOLDOWN_MS;
      if (now - lastRunAt < cooldown) return;

      const root = findContentRoot();
      const chapterId = getChapterId(root);

      if (!processedOnce && !contentReady(root)) return;

      running = true;
      try {
        // Reset when chapter changes OR when URL changed (URL is the reliable signal on FF Android)
        const u = urlKey();
        if (u !== lastURL) {
          lastURL = u;
          lastChapterId = null;
          lastActorGender = null;
          lastActorTTL = 0;
          lastSigForSkip = "";
          processedOnce = false;
        }

        if (chapterId !== lastChapterId) {
          lastChapterId = chapterId;
          ui.setMinimized(true);
          lastSigForSkip = "";
          lastActorGender = null;
          lastActorTTL = 0;
          processedOnce = false;
        }

        // Signature skip only when NOT sweeping
        const sigBefore = makeSignature(root);
        const compositeSig = `${lastURL}|${chapterId}|${sigBefore}`;

        if (!isSweep) {
          if (compositeSig === lastSigForSkip) return;
          lastSigForSkip = compositeSig;
        } else {
          // During sweep, allow repeated runs even with identical signature,
          // because FF sometimes "finalizes" text nodes after a short delay.
          lastSigForSkip = compositeSig;
        }

        if (!processedOnce) {
          if (!contentReady(root)) return;
          processedOnce = true;
        }

        const st0 = loadChapterState();
        const lastChanged = getChapterLastChanged(st0, chapterId);
        ui.setChanged(lastChanged > 0 ? lastChanged : 0);

        if (U.termMemoryAssist || Object.keys(cfgTerms).length) {
          const mem = loadTermMemory(novelKey);
          applyTermPatches(root, cfgTerms, mem, U);
        }

        updateDetectedCharactersUI(root);

        let usedMode = mode;
        let chapterGender = null;

        if (mode === "chapter") {
          if (forceGender === "male" || forceGender === "female") chapterGender = forceGender;
          else if (primaryCharacter && characters[primaryCharacter]) {
            const g = String(characters[primaryCharacter].gender || "").toLowerCase();
            if (g === "female" || g === "male") chapterGender = g;
          }
          if (!chapterGender) usedMode = "paragraph";
        }

        const blocks = getTextBlocks(root);
        let lastGender = null;
        let carryLeft = 0;
        let pronounEdits = 0;

        for (const b of blocks) {
          const bt = (b.innerText || "").trim();
          if (!bt) continue;

          if (isSceneBreak(bt)) {
            lastGender = null;
            carryLeft = 0;
            lastActorGender = null;
            lastActorTTL = 0;
            continue;
          }

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

          if (g) {
            const dir = (g === "female") ? "toFemale" : "toMale";
            let doFull = true;
            if (U.onlyChangeIfWrong) doFull = conservativeShouldApply(bt, g);
            if (doFull) pronounEdits += replaceInTextNodes(b, (txt) => replacePronounsSmart(txt, dir));

            if (usedMode !== "chapter" && hadDirectMatch) {
              lastGender = g;
              carryLeft = carryParagraphs;
            }
          }
        }

        const st = loadChapterState();
        const prev = getChapterLastChanged(st, chapterId);

        if (pronounEdits > 0) {
          setChapterLastChanged(st, chapterId, pronounEdits);
          ui.setChanged(pronounEdits);

          // If we made edits during sweep, we can stop early.
          if (isSweep) navSweepUntil = 0;
        } else if (prev > 0) {
          ui.setChanged(prev);
        } else {
          ui.setChanged(0);
        }

        saveChapterState(st);

      } finally {
        running = false;
        lastRunAt = Date.now();
      }
    }

    // Initial run + boot retries
    run(false);
    const bootStart = Date.now();
    const bootTimer = setInterval(() => {
      if (processedOnce) { clearInterval(bootTimer); return; }
      if (Date.now() - bootStart > 9000) { clearInterval(bootTimer); return; }
      run(true);
    }, 250);

    // Mutation observer
    let timer = null;
    const obs = new MutationObserver(() => {
      if (!ui.isEnabled()) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(false); }, 220);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // SPA navigation hooks
    installNavHooks(() => {
      ui.setMinimized(true);
      lastSigForSkip = "";
      processedOnce = false;
      startNavSweep("spa");
      run(true);
    });

    // URL poller — main fix for FF Android Next button
    setInterval(() => {
      const u = urlKey();
      if (u !== lastURL) {
        lastURL = u;
        ui.setMinimized(true);
        lastSigForSkip = "";
        processedOnce = false;
        startNavSweep("url");
        run(true);
      }
    }, URL_POLL_MS);
  })();
})();
