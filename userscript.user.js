// ==UserScript==
// @name         WTR PF Test
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.6
// @description  WTR-LAB Pronouns Fix — keeps v4.9.4 stable base + adds: URL chapter fallback, safe Next-button hook + post-nav sweep (no refresh), smaller closable add popup, onboarding ?, New Character (JSON) toggle.
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

  // Term memory cap (basic storage safety)
  const TERM_MEM_MAX_KEYS = 300;

  // Cache
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

  // Prevent "Changed" being overwritten by self-triggered reruns
  const SELF_MUTATION_COOLDOWN_MS = 450;

  // Navigation sweep (helps Firefox Android where content lands late)
  const NAV_SWEEP_MS = 2800;
  const NAV_SWEEP_INTERVAL_MS = 160;

  // Long press for add popup (mobile-first)
  const LONGPRESS_MS = 380;
  const LONGPRESS_MOVE_PX = 10;

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
    return `"${name}": ${JSON.stringify(obj)},`;
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

    const isMobile = window.innerWidth <= 480;

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

    // onboarding "?"
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

    // Help section (hidden until ? clicked)
    const helpWrap = document.createElement("div");
    helpWrap.style.cssText = `display:none; margin-top:10px; opacity:.95;`;

    const helpText = document.createElement("div");
    helpText.style.cssText = `
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.06);
      border-radius: 10px;
      padding: 8px 10px;
      line-height: 1.35;
    `;
    helpText.textContent =
      "Quick help:\n" +
      "• Long-press a WTR term (highlighted/patch span) to add Character or pin Term.\n" +
      "• Use “New Character (JSON)” to collect one-line snippets to paste into glossary.json.\n" +
      "• The pill minimises automatically on chapter navigation.";

    helpWrap.appendChild(helpText);

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px; background: rgba(255,255,255,0.12); margin:10px 0;`;

    // New Character (JSON) header (click to show/hide draft tools)
    const draftToggleRow = document.createElement("div");
    draftToggleRow.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;

    const draftToggleBtn = document.createElement("button");
    draftToggleBtn.type = "button";
    draftToggleBtn.textContent = "New Character (JSON)";
    draftToggleBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 6px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.14); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      flex: 1;
      text-align: left;
    `;

    // Optional "Export Tool" stub (safe: just reuses copy)
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "Export Tool";
    exportBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 6px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.08); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      flex: 0 0 auto;
    `;

    const innerDivider = document.createElement("div");
    innerDivider.style.cssText = `height:1px; background: rgba(255,255,255,0.10); margin:10px 0; display:none;`;

    // Draft tools (hidden until New Character (JSON) opened AND draft exists)
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

    let draftPanelOpen = false;
    let exportPanelOpen = false;

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

    function applyDraftVisibility(hasDraft, snippet, count) {
      // New Character panel controls visibility of inner divider + draft tools.
      innerDivider.style.display = draftPanelOpen ? "block" : "none";

      draftCountRow.textContent = `Draft: ${count || 0}`;

      if (!draftPanelOpen) {
        draftWrap.style.display = "none";
        btnRow.style.display = "none";
        return;
      }

      // Draft box itself only appears if draft exists (your earlier rule)
      if (hasDraft && snippet) {
        draftWrap.style.display = "block";
        draftBox.value = snippet;
      } else {
        draftWrap.style.display = "none";
        draftBox.value = "";
      }

      // Copy/Clear ONLY when New Character panel open
      btnRow.style.display = "flex";
    }

    function setDraftUI(snippet, count) {
      const hasDraft = (count || 0) > 0;
      applyDraftVisibility(hasDraft, snippet || "", count || 0);
    }

    toggleBtn.onclick = () => {
      setEnabled(!enabled());
      refreshToggleUI();
      setTimeout(() => location.reload(), 150);
    };

    helpBtn.onclick = () => {
      helpWrap.style.display = (helpWrap.style.display === "none") ? "block" : "none";
    };

    draftToggleBtn.onclick = () => {
      draftPanelOpen = !draftPanelOpen;
      const d = loadDraft();
      setDraftUI(d?.snippet || "", (d?.items || []).length);
    };

    exportBtn.onclick = async () => {
      // Safe “export”: copies the current draft snippet if present.
      // (No term memory clearing option — per your instruction.)
      exportPanelOpen = !exportPanelOpen;
      // For now, treat export as “copy draft” (minimal + safe).
      if (exportPanelOpen) {
        const d = loadDraft();
        const txt = d?.snippet || "";
        if (txt) await writeClipboard(txt);
      }
      exportPanelOpen = false;
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
    controls.appendChild(helpBtn);
    controls.appendChild(minBtn);

    topRow.appendChild(title);
    topRow.appendChild(controls);

    draftToggleRow.appendChild(draftToggleBtn);
    draftToggleRow.appendChild(exportBtn);

    draftWrap.appendChild(draftLabel);
    draftWrap.appendChild(draftBox);

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(clearBtn);

    box.appendChild(topRow);
    box.appendChild(summary);
    box.appendChild(helpWrap);
    box.appendChild(divider);

    box.appendChild(draftToggleRow);
    box.appendChild(innerDivider);
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

    // Minimised by default (your requirement)
    if (localStorage.getItem(UI_KEY_MIN) !== "0") setMin(true);

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

    // Initialize draft UI (panel closed by default)
    const d0 = loadDraft();
    setDraftUI(d0?.snippet || "", (d0?.items || []).length);

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
      setDraftUI
    };
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
  function findContentRoot() {
    // Best known container (from your inspector)
    const cb = document.querySelector(".chapter-body.menu-target[data-chapter-id]") ||
               document.querySelector(".chapter-body.menu-target") ||
               document.querySelector(".chapter-body");

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

  function getChapterIdFromURL() {
    const m = location.pathname.match(/\/chapter-(\d+)\b/i);
    return m ? `url:${m[1]}` : null;
  }

  function getChapterId(root) {
    const el = root?.closest?.("[data-chapter-id]") || root?.querySelector?.("[data-chapter-id]");
    const id = el?.getAttribute?.("data-chapter-id");
    return id || getChapterIdFromURL() || "unknown";
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
    // WTR lines are typically p.pr-line-text / p.pr-line-array
    const blocks = Array.from(root.querySelectorAll("p.pr-line-text, p.pr-line-array, p, blockquote, li"));
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
  // Node replacement counting (robust)
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
  // Signature (skip only identical content)
  // ==========================================================
  function makeSignature(root) {
    const t = (root.innerText || "").trim();
    const head = t.slice(0, 240);
    const tail = t.slice(Math.max(0, t.length - 240));
    return `${t.length}|${head}|${tail}`;
  }

  // ==========================================================
  // Add popup (small, closable, Male/Female only)
  // Long-press on WTR term span: span.text-patch.system[data-hash]
  // ==========================================================
  function installAddPopup({ ui, novelKey }) {
    const popup = document.createElement("div");
    popup.style.cssText = `
      position: fixed; z-index: 2147483647;
      display:none;
      background: rgba(0,0,0,0.82);
      color:#fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      padding: 8px;
      font: 12px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 22px rgba(0,0,0,.28);
      backdrop-filter: blur(6px);
      max-width: min(240px, 72vw);
      user-select: none;
    `;

    const head = document.createElement("div");
    head.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;

    const cap = document.createElement("div");
    cap.textContent = "Add";
    cap.style.cssText = `font-weight:700; opacity:.95;`;

    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.textContent = "✕";
    xBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:24px; height:24px; border-radius:8px;
      background:rgba(255,255,255,0.10); color:#fff;
      font-size:13px; line-height:24px; padding:0;
      flex: 0 0 auto;
    `;

    const picked = document.createElement("div");
    picked.style.cssText = `margin-top:6px; opacity:.92; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;

    const row = document.createElement("div");
    row.style.cssText = `display:flex; gap:6px; margin-top:8px;`;

    const btn = (label, strong=false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = `
        appearance:none; border:0; cursor:pointer;
        padding: 6px 8px;
        border-radius: 9px;
        background: ${strong ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.10)"};
        color:#fff;
        font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        flex: 1;
      `;
      return b;
    };

    const addCharBtn = btn("Character", true);
    const addTermBtn = btn("Term");

    const step = document.createElement("div");
    step.style.cssText = `display:none; margin-top:8px; border-top:1px solid rgba(255,255,255,0.10); padding-top:8px;`;

    const stepTitle = document.createElement("div");
    stepTitle.style.cssText = `font-weight:700; margin-bottom:6px;`;
    const stepRow = document.createElement("div");
    stepRow.style.cssText = `display:flex; gap:6px;`;

    const maleBtn = btn("Male", true);
    maleBtn.style.padding = "6px 6px";
    const femaleBtn = btn("Female", true);
    femaleBtn.style.padding = "6px 6px";

    stepRow.appendChild(maleBtn);
    stepRow.appendChild(femaleBtn);

    step.appendChild(stepTitle);
    step.appendChild(stepRow);

    head.appendChild(cap);
    head.appendChild(xBtn);

    row.appendChild(addCharBtn);
    row.appendChild(addTermBtn);

    popup.appendChild(head);
    popup.appendChild(picked);
    popup.appendChild(row);
    popup.appendChild(step);

    document.documentElement.appendChild(popup);

    let ctx = null; // { text, span, hash, x, y }

    function hide() {
      popup.style.display = "none";
      step.style.display = "none";
      ctx = null;
    }

    function showAt(x, y, context) {
      ctx = context;
      picked.textContent = context?.text ? context.text : "(none)";
      step.style.display = "none";
      const w = 240;
      const h = 120;
      popup.style.left = clamp(x, 6, window.innerWidth - w - 6) + "px";
      popup.style.top  = clamp(y, 6, window.innerHeight - h - 6) + "px";
      popup.style.display = "block";
    }

    xBtn.onclick = hide;
    popup.addEventListener("pointerdown", (e) => e.stopPropagation(), true);

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
      stepTitle.textContent = "Select Gender";
      step.style.display = "block";
    };

    maleBtn.onclick = () => {
      if (!ctx?.text) return;
      upsertDraftLine(oneLineCharacterSnippet(ctx.text.trim(), "male"));
      hide();
    };
    femaleBtn.onclick = () => {
      if (!ctx?.text) return;
      upsertDraftLine(oneLineCharacterSnippet(ctx.text.trim(), "female"));
      hide();
    };

    addTermBtn.onclick = () => {
      if (!ctx?.hash || !ctx?.text) return;
      const mem = loadTermMemory(novelKey);
      mem[ctx.hash] = { preferred: ctx.text, pinned: true, aliases: [] };
      saveTermMemory(novelKey, mem);
      if (ctx.span) ctx.span.classList.add("wtrpf-added-term");
      hide();
    };

    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
    document.addEventListener("pointerdown", (e) => {
      if (popup.style.display === "none") return;
      if (!popup.contains(e.target)) hide();
    }, true);

    // Long-press handler on WTR term spans (mobile-first)
    let lpTimer = null;
    let startX = 0, startY = 0;
    let activeSpan = null;

    function clearLP() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      activeSpan = null;
    }

    document.addEventListener("pointerdown", (e) => {
      const sp = e.target && e.target.closest && e.target.closest("span.text-patch.system[data-hash]");
      if (!sp) return;

      // Allow normal tap navigation/select; only show after long press
      startX = e.clientX;
      startY = e.clientY;
      activeSpan = sp;

      clearLP();
      activeSpan = sp;

      lpTimer = setTimeout(() => {
        if (!activeSpan) return;
        const txt = (activeSpan.textContent || "").trim();
        const hash = activeSpan.getAttribute("data-hash") || "";
        if (!txt || !hash) return;
        showAt(startX + 6, startY + 6, { text: txt, span: activeSpan, hash });
      }, LONGPRESS_MS);
    }, true);

    document.addEventListener("pointermove", (e) => {
      if (!lpTimer) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > LONGPRESS_MOVE_PX || dy > LONGPRESS_MOVE_PX) clearLP();
    }, true);

    document.addEventListener("pointerup", clearLP, true);
    document.addEventListener("pointercancel", clearLP, true);
  }

  // ==========================================================
  // Navigation hooks
  // ==========================================================
  function installNavHooks(onNav) {
    const fire = () => setTimeout(onNav, 80);
    window.addEventListener("popstate", fire);

    const _push = history.pushState;
    const _rep  = history.replaceState;
    history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
    history.replaceState = function () { const r = _rep.apply(this, arguments); fire(); return r; };

    // keep very light; actual heavy work is inside run() with cooldowns
    const mo = new MutationObserver(() => fire());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Safe click hook for Next navigation (NO noisy || true)
  function installNextClickHook(onNext) {
    document.addEventListener("click", (e) => {
      const a = e.target?.closest?.("a");
      const btn = e.target?.closest?.("button");
      const el = a || btn;
      if (!el) return;

      const txt = ((el.innerText || el.textContent || "") + "").trim().toLowerCase();
      const aria = ((el.getAttribute && (el.getAttribute("aria-label") || "")) || "").toLowerCase();
      const rel = ((a && a.getAttribute && (a.getAttribute("rel") || "")) || "").toLowerCase();
      const href = (a && a.href) ? String(a.href) : "";

      const looksNextRel = rel.includes("next");
      const looksNextAria = aria.includes("next");
      const looksNextText = /\bnext\b/.test(txt) || txt === "›" || txt === ">" || txt === "→";
      const looksChapterHref = /\/chapter-\d+\b/i.test(href);

      if (looksNextRel || looksNextAria || (looksNextText && looksChapterHref) || looksChapterHref) {
        onNext();
      }
    }, true);
  }

  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
    if (!ui.isEnabled()) return;

    const initialDraft = loadDraft();
    ui.setDraftUI?.(initialDraft?.snippet || "", (initialDraft?.items || []).length);

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

    // Add popup (small, long-press)
    installAddPopup({ ui, novelKey });

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

    function contentReady(root) {
      if (!root) return false;
      const blocks = getTextBlocks(root);
      const textLen = (root.innerText || "").trim().length;
      return blocks.length >= 6 && textLen >= 450;
    }

    function updateDetectedCharactersUI(root) {
      const detected = detectCharactersOnPage(root, entries);
      if (detected.length) {
        ui.setCharacters(detected);
      } else {
        // fallback: show first few configured (keeps UI stable)
        ui.setCharacters(entries.slice(0, Math.min(entries.length, MAX_NAMES_SHOWN)));
      }
    }

    function run({ force = false } = {}) {
      if (!ui.isEnabled()) return;
      if (document.hidden) return;
      if (running) return;

      const now = Date.now();
      if (!force && (now - lastRunAt < SELF_MUTATION_COOLDOWN_MS)) return;

      const root = findContentRoot();
      const chapterId = getChapterId(root);

      if (!processedOnce && !contentReady(root)) return;
      processedOnce = true;

      running = true;
      try {
        // If chapter changed: minimize by default
        if (chapterId !== lastChapterId) {
          lastChapterId = chapterId;
          localStorage.setItem(UI_KEY_MIN, "1");
          ui.setMinimized(true);
          lastSigForSkip = "";
          lastActorGender = null;
          lastActorTTL = 0;
        }

        const sigBefore = makeSignature(root);
        const compositeSig = `${chapterId}|${sigBefore}`;
        if (!force && compositeSig === lastSigForSkip) return;
        lastSigForSkip = compositeSig;

        // Restore last known changed for this chapter (prevents flicker to 0)
        const st0 = loadChapterState();
        const lastChanged = getChapterLastChanged(st0, chapterId);
        ui.setChanged(lastChanged > 0 ? lastChanged : 0);

        // Term patches first
        if (U.termMemoryAssist || Object.keys(cfgTerms).length) {
          const mem = loadTermMemory(novelKey);
          applyTermPatches(root, cfgTerms, mem, U);
        }

        updateDetectedCharactersUI(root);

        // Determine chapter mode
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

          // anchored fixes
          if (U.anchoredFixes) {
            pronounEdits += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, entries, U));
          }

          // gender selection
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

            if (doFull) {
              pronounEdits += replaceInTextNodes(b, (txt) => replacePronounsSmart(txt, dir));
            }

            if (usedMode !== "chapter" && hadDirectMatch) {
              lastGender = g;
              carryLeft = carryParagraphs;
            }
          }
        }

        // Prevent "0 overwrite" during reruns
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

        saveChapterState(st);

      } finally {
        running = false;
        lastRunAt = Date.now();
      }
    }

    // Initial run
    run({ force: true });

    // Mobile boot retry window (avoid “needs refresh” on initial load)
    const bootStart = Date.now();
    const bootTimer = setInterval(() => {
      if (processedOnce) { clearInterval(bootTimer); return; }
      if (Date.now() - bootStart > 9000) { clearInterval(bootTimer); return; }
      run({ force: true });
    }, 260);

    // Mutation observer debounce
    let timer = null;
    const obs = new MutationObserver(() => {
      if (!ui.isEnabled()) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; run({ force: false }); }, 220);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // SPA navigation hooks (safe)
    installNavHooks(() => {
      localStorage.setItem(UI_KEY_MIN, "1");
      ui.setMinimized(true);
      lastSigForSkip = "";
      processedOnce = false;
      run({ force: true });
    });

    // Post-navigation sweep (key for Firefox Android Next button)
    let sweepTimer = null;
    function startSweep() {
      if (sweepTimer) clearInterval(sweepTimer);
      const start = Date.now();
      const beforeUrl = location.href;

      // reset skip so we don't incorrectly skip a fresh chapter
      lastSigForSkip = "";
      processedOnce = false;

      sweepTimer = setInterval(() => {
        if (Date.now() - start > NAV_SWEEP_MS) {
          clearInterval(sweepTimer);
          sweepTimer = null;
          return;
        }
        // If url changed, force at least one processing cycle
        const urlChanged = location.href !== beforeUrl;
        run({ force: urlChanged });
      }, NAV_SWEEP_INTERVAL_MS);
    }

    // Safe Next click hook (corrected; no noisy || true)
    installNextClickHook(() => {
      // minimize on nav as per requirement
      localStorage.setItem(UI_KEY_MIN, "1");
      ui.setMinimized(true);
      startSweep();
    });
  })();
})();
