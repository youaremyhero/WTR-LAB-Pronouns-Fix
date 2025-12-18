// ==UserScript==
// @name         WTR PF
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.3
// @description  Fix mixed gender pronouns in WTR-LAB machine translations using a shared JSON glossary. Movable UI + minimise pill + ON/OFF toggle + auto-update on chapter navigation. Adds: Add Character/Add Term menu (WTR term only OR selection), draft->copy JSON snippets, term patches (pinned + memory), accurate Changed counter (counts actual pronoun edits) + stable per-chapter signature, improved chapter navigation reliability, and basic schema validation.
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

  // Term memory cap (basic safety against storage bloat)
  const TERM_MEM_MAX_KEYS = 300;

  // Cache
  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v1";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000;

  // Persistent UI state
  const UI_KEY_MIN = "wtrpf_ui_min_v1";
  const UI_KEY_POS = "wtrpf_ui_pos_v1";
  const UI_KEY_ON  = "wtrpf_enabled_v1";

  // Draft + term memory (PERSIST even when user clicks Copy/Clear draft)
  const DRAFT_KEY = "wtrpf_draft_v1";               // draft output only
  const TERM_MEM_KEY_PREFIX = "wtrpf_term_mem_v1:"; // per-novel term memory
  const CHAPTER_STATE_KEY_PREFIX = "wtrpf_chapter_state_v1:"; // per-novel chapter state in sessionStorage

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

  // ==========================================================
  // Smart pronoun replacement (COUNTED)
  // returns { text, changed } where changed ~ number of pronoun tokens changed
  // ==========================================================
  function replacePronounsSmart(text, direction /* "toMale" | "toFemale" */) {
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

    // Split/hyphenated reflexives
    if (direction === "toFemale") {
      rep(/\bhim[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "herself"));
    } else {
      rep(/\bher[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "himself"));
    }

    // Sentence-start fixes
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

    // General replacements
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

  // ==========================================================
  // Upgrade helpers
  // ==========================================================
  function getSentenceEndIndex(s, start, maxExtra = 320) {
    const limit = Math.min(s.length, start + maxExtra);
    for (let i = start; i < limit; i++) {
      const ch = s[i];
      if (ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === "\n") return i + 1;
    }
    return Math.min(s.length, start + maxExtra);
  }

  // "onlyChangeIfWrong": apply if ANY wrong pronoun exists in region
  function conservativeShouldApply(region, gender /* male|female */) {
    const maleCount = countMatches(RX_PRONOUN_MALE, region);
    const femCount  = countMatches(RX_PRONOUN_FEMALE, region);
    if (gender === "male") return femCount > 0;
    return maleCount > 0;
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
    const allSame = found.every(x => x === found[0]);
    return allSame ? found[0] : null;
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

  // ==========================================================
  // Anchored local fixes
  // ==========================================================
  function applyAnchoredFixes(text, entries, opts) {
    let changed = 0;
    let s = normalizeWeirdSpaces(text);

    const {
      verbBasedWindow = false,
      passiveVoice = false,
      onlyChangeIfWrong = false
    } = opts;

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
        const re = new RegExp(String.raw`\b${nEsc}\b`, "g"); // case-sensitive
        let m;

        while ((m = re.exec(s)) !== null) {
          const start = m.index;

          const baseEnd = verbBasedWindow
            ? getSentenceEndIndex(s, start + n.length, 360)
            : Math.min(s.length, start + n.length + LOCAL_ANCHOR_WINDOW);

          let end = baseEnd;
          if (strictPossessive) end = Math.min(s.length, Math.max(end, start + n.length + 220));

          const region = s.slice(start, end);

          if (onlyChangeIfWrong && !conservativeShouldApply(region, gender)) {
            continue;
          }

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
        // simple cap: drop oldest-ish by key order (best-effort)
        const excess = keys.length - TERM_MEM_MAX_KEYS;
        for (let i = 0; i < excess; i++) delete mem[keys[i]];
      }
    } catch {}
    localStorage.setItem(termMemKey(novelKey), JSON.stringify(mem || {}));
  }

  function applyTermPatches(root, cfgTerms, mem, opts) {
    const enforcePlainText = !!opts?.enforcePinnedTermsOnPlainText;
    const map = Object.assign({}, cfgTerms || {}, mem || {}); // mem overrides cfg

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
  // UI
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
    let draftCount = 0;

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
      if (savedPos.left != null) {
        el.style.left = savedPos.left + "px";
        el.style.right = "auto";
      } else {
        el.style.right = "12px";
        el.style.left = "auto";
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
        clampToViewport(el);
      };

      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }

    // Panel
    const box = document.createElement("div");
    box.style.cssText = `
      position: fixed; z-index: 2147483647;
      background: rgba(0,0,0,0.50);
      color: #fff;
      border-radius: 12px;
      padding: 10px 12px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      max-width: min(520px, 90vw);
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
    btnRow.style.cssText = `display:flex; gap:8px; margin-top:8px;`;

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

    // Minimised pill (narrower)
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
      max-width: 260px;
      overflow: hidden;
    `;

    const pillRow = document.createElement("div");
    pillRow.style.cssText = `display:flex; align-items:center; gap:8px; min-width: 0;`;

    const pillText = document.createElement("div");
    pillText.style.cssText = `padding: 1px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width:0; max-width: 180px;`;

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
      draftCount = count || 0;
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

    function syncPos(fromEl, toEl) {
      const r = fromEl.getBoundingClientRect();
      toEl.style.top = r.top + "px";
      toEl.style.left = r.left + "px";
      toEl.style.right = "auto";
      clampToViewport(toEl);
    }

    function setMin(min) {
      localStorage.setItem(UI_KEY_MIN, min ? "1" : "0");
      box.style.display = min ? "none" : "block";
      pill.style.display = min ? "block" : "none";
      if (min) syncPos(box, pill);
      else syncPos(pill, box);
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

    if (localStorage.getItem(UI_KEY_MIN) !== "0") setMin(true);

    window.addEventListener("resize", () => {
      clampToViewport(localStorage.getItem(UI_KEY_MIN) === "1" ? pill : box);
    });

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

    return {
      isEnabled: () => enabled(),
      setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshSummary(); },
      setCharacters: (entries) => {
        charactersCount = entries.length;
        const names = entries.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
          const g = String(info.gender || "").toLowerCase();
          const label = (g === "female" || g === "male") ? g : "unknown";
          return `${name} (${label})`;
        });
        charactersList3 = names.join(", ") + (entries.length > MAX_NAMES_SHOWN ? " …" : "");
        refreshSummary();
      },
      setChanged: (val) => {
        changedTotal = clamp(Number(val) || 0, 0, 999999);
        refreshSummary();
      },
      refreshUI: refreshToggleUI,
      setMinimized: (min) => setMin(!!min),
      setDraftUI
    };
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
  function findContentRoot() {
    const cb = document.querySelector(".chapter-body.menu-target[data-chapter-id]");
    if (cb) return cb;

    const candidates = Array.from(document.querySelectorAll(
      "article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section"
    ));
    let best = null, bestScore = 0;
    for (const el of candidates) {
      const pCount = el.querySelectorAll("p").length;
      const textLen = (el.innerText || "").trim().length;
      const score = (pCount * 1200) + textLen;
      if (score > bestScore && textLen > 800) { bestScore = score; best = el; }
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

  // ==========================================================
  // Glossary helpers
  // ==========================================================
  function pickKey(glossary) {
    const url = location.href;
    const keys = Object.keys(glossary || {}).filter(k => k !== "default");
    const matches = keys.filter(k => url.includes(k)).sort((a, b) => b.length - a.length);
    return matches[0] || "default";
  }

  function directionFromGender(g) {
    return g === "female" ? "toFemale" : "toMale";
  }

  // Accurate node replacement counting
  function replaceInTextNodes(blockEl, fnReplace /* (text)=>{text,changed} */) {
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
      const delta = Number(out.changed || 0);

      if (after !== before) {
        node.nodeValue = after;
        changed += delta > 0 ? delta : 1;
      }
    }
    return changed;
  }

  function detectCharactersOnPage(root, entries) {
    const hay = (root?.innerText || "").toLowerCase();
    const detected = [];
    for (const [name, info] of entries) {
      const nameLower = String(name || "").toLowerCase();
      const aliases = Array.isArray(info.aliases) ? info.aliases : [];

      let hit = false;
      if (nameLower && hay.includes(nameLower)) hit = true;

      if (!hit) {
        for (const a of aliases) {
          const aLower = String(a || "").toLowerCase();
          if (aLower && hay.includes(aLower)) { hit = true; break; }
        }
      }
      if (hit) detected.push([name, info]);
    }
    return detected;
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
  // Draft helpers (output only)
  // ==========================================================
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{"items":[],"snippet":""}'); }
    catch { return { items: [], snippet: "" }; }
  }
  function saveDraft(d) { localStorage.setItem(DRAFT_KEY, JSON.stringify(d || { items: [], snippet: "" })); }

  function oneLineCharacterSnippet(name, gender, aliases) {
    const obj = { gender: String(gender || "unknown") };
    if (Array.isArray(aliases) && aliases.length) obj.aliases = aliases;
    const inner = JSON.stringify(obj);
    return `"${name}": ${inner},`;
  }

  // ==========================================================
  // Add Character / Add Term menu
  // ==========================================================
  function installAddMenu({ ui, novelKey }) {
    const menu = document.createElement("div");
    menu.style.cssText = `
      position: fixed; z-index: 2147483647;
      display:none;
      background: rgba(0,0,0,0.76);
      color:#fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 10px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      backdrop-filter: blur(6px);
      min-width: 220px;
      user-select: none;
    `;

    const header = document.createElement("div");
    header.style.cssText = `display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:8px;`;

    const title = document.createElement("div");
    title.textContent = "PronounsFix";
    title.style.cssText = `font-weight:700; opacity:.95;`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:26px; height:26px; border-radius:9px;
      background:rgba(255,255,255,0.10); color:#fff;
      font-size:14px; line-height:26px; padding:0;
    `;

    const picked = document.createElement("div");
    picked.style.cssText = `opacity:.92; margin-bottom:10px; white-space: nowrap; overflow:hidden; text-overflow: ellipsis;`;
    picked.textContent = "";

    const row1 = document.createElement("div");
    row1.style.cssText = `display:flex; gap:8px;`;

    const addCharBtn = document.createElement("button");
    addCharBtn.type = "button";
    addCharBtn.textContent = "Add Character";
    addCharBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.16); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      flex: 1;
    `;

    const addTermBtn = document.createElement("button");
    addTermBtn.type = "button";
    addTermBtn.textContent = "Add Term";
    addTermBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.10); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      flex: 1;
    `;

    const step = document.createElement("div");
    step.style.cssText = `margin-top:10px; display:none; border-top:1px solid rgba(255,255,255,0.12); padding-top:10px;`;

    const stepTitle = document.createElement("div");
    stepTitle.style.cssText = `font-weight:700; margin-bottom:8px;`;
    stepTitle.textContent = "";

    const stepBody = document.createElement("div");
    stepBody.style.cssText = `display:flex; gap:8px; flex-wrap: wrap;`;

    const ghostBtn = (label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = `
        appearance:none; border:0; cursor:pointer;
        padding: 7px 10px; border-radius: 10px;
        background: rgba(255,255,255,0.12); color:#fff;
        font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      `;
      return b;
    };

    let ctx = null; // { text, span?, hash? }
    let lastSpan = null;

    function hide() {
      menu.style.display = "none";
      step.style.display = "none";
      ctx = null;
      if (lastSpan) lastSpan.classList.remove("wtrpf-added-term");
      lastSpan = null;
    }

    function showAt(x, y, context) {
      ctx = context;
      picked.textContent = context?.text ? `Selected: ${context.text}` : "Selected: (none)";
      step.style.display = "none";
      menu.style.left = clamp(x, 6, window.innerWidth - 240) + "px";
      menu.style.top  = clamp(y, 6, window.innerHeight - 120) + "px";
      menu.style.display = "block";
    }

    closeBtn.onclick = hide;
    menu.addEventListener("pointerdown", (e) => e.stopPropagation());

    function upsertDraftLine(line) {
      const d = loadDraft();
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.includes(line)) items.push(line);
      const snippet = items.join("\n");
      saveDraft({ items, snippet });
      ui.setDraftUI(snippet, items.length);
    }

    addCharBtn.onclick = () => {
      if (!ctx?.text) return;
      const name = ctx.text.trim();
      if (!name) return;

      stepTitle.textContent = "Select Gender";
      stepBody.innerHTML = "";
      const male = ghostBtn("Male");
      const female = ghostBtn("Female");

      male.onclick = () => { upsertDraftLine(oneLineCharacterSnippet(name, "male")); hide(); };
      female.onclick = () => { upsertDraftLine(oneLineCharacterSnippet(name, "female")); hide(); };

      stepBody.appendChild(male);
      stepBody.appendChild(female);
      step.style.display = "block";
    };

    addTermBtn.onclick = () => {
      if (!ctx?.text) return;

      stepTitle.textContent = "Pin Term";
      stepBody.innerHTML = "";

      const pin = ghostBtn("Pin (save preferred)");
      const cancel = ghostBtn("Cancel");

      pin.onclick = () => {
        const mem = loadTermMemory(novelKey);

        if (ctx.hash) {
          mem[ctx.hash] = { preferred: ctx.text, pinned: true, aliases: [] };
        } else {
          const pseudo = "plain:" + ctx.text;
          mem[pseudo] = { preferred: ctx.text, pinned: true, aliases: [] };
        }

        saveTermMemory(novelKey, mem);

        if (ctx.span) {
          ctx.span.classList.add("wtrpf-added-term");
          lastSpan = ctx.span;
        }
        hide();
      };

      cancel.onclick = hide;
      stepBody.appendChild(pin);
      stepBody.appendChild(cancel);
      step.style.display = "block";
    };

    row1.appendChild(addCharBtn);
    row1.appendChild(addTermBtn);

    header.appendChild(title);
    header.appendChild(closeBtn);
    menu.appendChild(header);
    menu.appendChild(picked);
    menu.appendChild(row1);
    step.appendChild(stepTitle);
    step.appendChild(stepBody);
    menu.appendChild(step);

    document.documentElement.appendChild(menu);

    document.addEventListener("click", (e) => {
      const sp = e.target && e.target.closest && e.target.closest("span.text-patch.system[data-hash]");
      if (!sp) return;
      const txt = (sp.textContent || "").trim();
      const hash = sp.getAttribute("data-hash") || "";
      if (!txt) return;
      showAt(e.clientX + 8, e.clientY + 8, { text: txt, span: sp, hash });
    }, true);

    document.addEventListener("mouseup", (e) => {
      const sel = window.getSelection && window.getSelection();
      const s = sel ? String(sel.toString() || "") : "";
      const txt = s.trim();
      if (!txt || txt.length < 2) return;

      const root = findContentRoot();
      if (!root || !root.contains(e.target)) return;

      showAt(e.clientX + 8, e.clientY + 8, { text: txt });
    }, true);

    document.addEventListener("scroll", () => hide(), true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);

    return { hide };
  }

  // ==========================================================
  // SPA / navigation hooks
  // ==========================================================
  function installNavHooks(onNav) {
    const fire = () => setTimeout(onNav, 80);

    window.addEventListener("popstate", fire);

    const _push = history.pushState;
    const _rep  = history.replaceState;
    history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
    history.replaceState = function () { const r = _rep.apply(this, arguments); fire(); return r; };

    const mo = new MutationObserver(() => fire());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================================
  // Basic schema validation (security / robustness)
  // ==========================================================
  function validateGlossary(glossary) {
    if (!glossary || typeof glossary !== "object") return false;
    // allow empty but must be object
    return true;
  }

  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
    ui.refreshUI();
    if (!ui.isEnabled()) return;

    const initialDraft = loadDraft();
    ui.setDraftUI(initialDraft?.snippet || "", (initialDraft?.items || []).length);

    if (!GLOSSARY_URL || /\?token=GHSAT/i.test(GLOSSARY_URL)) {
      ui.setGlossaryOk(false);
      return;
    }

    let glossary;
    try {
      glossary = await loadGlossaryJSON(GLOSSARY_URL);
      if (!validateGlossary(glossary)) throw new Error("bad glossary");
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

    if (!entries.length) {
      ui.setGlossaryOk(false);
      return;
    }
    ui.setGlossaryOk(true);

    const cfgTerms = cfg.terms || {};

    const novelKey = key === "default" ? getNovelKeyFromURL() : key;
    const chapterStateKey = CHAPTER_STATE_KEY_PREFIX + novelKey;

    installAddMenu({ ui, novelKey });

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

    function makeSignature(root) {
      const t = (root.innerText || "").trim();
      const head = t.slice(0, 240);
      const tail = t.slice(Math.max(0, t.length - 240));
      return `${t.length}|${head}|${tail}`;
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

    function updateDetectedCharactersUI(root) {
      const detected = detectCharactersOnPage(root, entries);
      ui.setCharacters(detected.length ? detected : entries);
    }

    function run() {
      if (!ui.isEnabled()) return;
      if (document.hidden) return; // performance

      const root = findContentRoot();
      const chapterId = getChapterId(root);

      if (chapterId !== lastChapterId) {
        lastChapterId = chapterId;
        localStorage.setItem(UI_KEY_MIN, "1");
        ui.setMinimized(true);
        lastSigForSkip = "";
        lastActorGender = null;
        lastActorTTL = 0;
      }

      const sig = makeSignature(root);
      const compositeSig = `${chapterId}|${sig}`;
      if (compositeSig === lastSigForSkip) return;
      lastSigForSkip = compositeSig;

      const st = loadChapterState();
      const keySig = compositeSig;
      if (st[keySig] && Number.isFinite(st[keySig].changed)) {
        ui.setChanged(st[keySig].changed);
      } else {
        ui.setChanged(0);
      }

      // Term patches first
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
        const raw = (b.innerText || "");
        const bt = raw.trim();
        if (!bt) continue;

        if (isSceneBreak(bt)) {
          lastGender = null;
          carryLeft = 0;
          lastActorGender = null;
          lastActorTTL = 0;
          continue;
        }

        // 1) Anchored local fixes (counted)
        if (U.anchoredFixes) {
          pronounEdits += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, entries, U));
        }

        // 2) Determine paragraph gender
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
            // Early-pronoun fallback (helps paragraphs that begin with He/She etc.)
            if (startsWithPronoun(bt)) {
              g = lastGender || lastActorGender || null;
            }

            // carry
            if (!g && lastGender && carryLeft > 0 && (startsWithPronoun(bt) || pronounAppearsEarly(bt, EARLY_PRONOUN_WINDOW))) {
              g = lastGender;
              carryLeft--;
            }

            // role heuristic carry
            if (!g && U.roleHeuristicCarry && lastActorGender && lastActorTTL > 0) {
              if ((startsWithPronoun(bt) || pronounAppearsEarly(bt, EARLY_PRONOUN_WINDOW)) && RX_ATTACK_CUES.test(bt)) {
                g = lastActorGender;
                lastActorTTL--;
              }
            }
          }
        }

        if (g) {
          const dir = directionFromGender(g);

          let doFull = true;
          if (U.onlyChangeIfWrong) {
            doFull = conservativeShouldApply(bt, g);
          }

          if (doFull) {
            pronounEdits += replaceInTextNodes(b, (txt) => replacePronounsSmart(txt, dir));
          }

          if (usedMode !== "chapter" && hadDirectMatch) {
            lastGender = g;
            carryLeft = carryParagraphs;
          }
        }
      }

      const finalChanged = pronounEdits;

      const st2 = loadChapterState();
      st2[keySig] = { changed: finalChanged, ts: Date.now() };
      saveChapterState(st2);

      ui.setChanged(finalChanged);
    }

    run();

    let timer = null;
    const obs = new MutationObserver(() => {
      if (!ui.isEnabled()) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(); }, 180);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    installNavHooks(() => {
      localStorage.setItem(UI_KEY_MIN, "1");
      ui.setMinimized(true);
      lastSigForSkip = "";
      run();
    });
  })();
})();
