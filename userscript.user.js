// ==UserScript==
// @name         WTR PF
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.0
// @description  Fix mixed gender pronouns in WTR-LAB machine translations using a shared JSON glossary. Movable UI + minimise pill + ON/OFF toggle + auto-refresh + stable Changed counter. Adds optional upgrades (anchored fixes, verb-based window, passive voice, dialogue speaker tracking, role carry heuristic, conservative-only-if-wrong mode, strict possessives). Adds "Quick Add Draft" to capture new character names from chapter text and copy JSON snippet for glossary.json.
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

  // Default anchor window if verbBasedWindow disabled
  const LOCAL_ANCHOR_WINDOW = 160;

  // UI
  const MAX_NAMES_SHOWN = 3;

  // Cache
  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v1";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000;

  // Persistent UI state
  const UI_KEY_MIN = "wtrpf_ui_min_v1";
  const UI_KEY_POS = "wtrpf_ui_pos_v1";
  const UI_KEY_ON  = "wtrpf_enabled_v1";

  // ==========================================================
  // Quick Add Draft (NEW)
  // ==========================================================
  // Stores user-added characters locally, per novel (so drafts don't mix across novels).
  // Users can later "Copy JSON" (character-details-only) to paste into their glossary.json.
  const DRAFT_KEY_PREFIX = "wtrpf_draft_chars_v1:";

  function getDraftKey() {
    // Stable-ish per novel: use /en/novel/{id}/
    const m = location.pathname.match(/\/en\/novel\/(\d+)\//i);
    const id = m ? m[1] : "unknown";
    return `${DRAFT_KEY_PREFIX}${id}`;
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(getDraftKey());
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : {};
    } catch {
      return {};
    }
  }

  function saveDraft(obj) {
    try { localStorage.setItem(getDraftKey(), JSON.stringify(obj)); } catch {}
  }

  function clearDraft() {
    try { localStorage.removeItem(getDraftKey()); } catch {}
  }

  function normalizeNameCandidate(s) {
    let t = String(s || "");
    t = t.replace(/\s+/g, " ").trim();
    // Strip wrapping quotes/brackets/punctuation
    t = t.replace(/^["'“‘(\[]+/, "").replace(/["'”’)\].,;:!?]+$/, "").trim();
    // Reject too short/long
    if (t.length < 2 || t.length > 60) return "";
    // Reject if it's only pronouns
    if (/^(he|him|his|himself|she|her|hers|herself)$/i.test(t)) return "";
    // Reject if contains newline
    if (t.includes("\n")) return "";
    return t;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }
  }

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

  // ==========================================================
  // Smart pronoun replacement
  // ==========================================================
  function replacePronounsSmart(text, direction /* "toMale" | "toFemale" */) {
    text = normalizeWeirdSpaces(text);

    // Split/hyphenated reflexives
    if (direction === "toFemale") {
      text = text.replace(/\bhim[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "herself"));
    } else {
      text = text.replace(/\bher[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "himself"));
    }

    // Sentence-start fixes
    if (direction === "toMale") {
      text = text.replace(new RegExp(SENT_PREFIX + `(she)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "He")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(herself)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Himself")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(hers)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "His")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(her)\\b(?=\\s+${LETTER})`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "His")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(her)\\b(?!\\s+${LETTER})`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Him")}`);
    } else {
      text = text.replace(new RegExp(SENT_PREFIX + `(he)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "She")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(himself)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Herself")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(him)\\b`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Her")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(his)\\b(?=\\s+${LETTER})`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Her")}`);
      text = text.replace(new RegExp(SENT_PREFIX + `(his)\\b(?!\\s+${LETTER})`, "giu"),
        (m, p1, p2, w) => `${p1}${p2 || ""}${caseLike(w, "Hers")}`);
    }

    // General replacements
    if (direction === "toMale") {
      text = text.replace(/\bshe\b/giu, (m) => caseLike(m, "he"));
      text = text.replace(/\bherself\b/giu, (m) => caseLike(m, "himself"));
      text = text.replace(/\bhers\b/giu, (m) => caseLike(m, "his"));
      text = text.replace(new RegExp(String.raw`\bher\b(?=\s+${LETTER})`, "giu"), (m) => caseLike(m, "his"));
      text = text.replace(/\bher\b/giu, (m) => caseLike(m, "him"));
    } else {
      text = text.replace(/\bhe\b/giu, (m) => caseLike(m, "she"));
      text = text.replace(/\bhimself\b/giu, (m) => caseLike(m, "herself"));
      text = text.replace(/\bhim\b/giu, (m) => caseLike(m, "her"));
      text = text.replace(new RegExp(String.raw`\bhis\b(?=\s+${LETTER})`, "giu"), (m) => caseLike(m, "her"));
      text = text.replace(/\bhis\b/giu, (m) => caseLike(m, "hers"));
    }

    return text;
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

  function conservativeShouldApply(region, gender /* male|female */) {
    const maleCount = countMatches(RX_PRONOUN_MALE, region);
    const femCount  = countMatches(RX_PRONOUN_FEMALE, region);
    if (gender === "male") return femCount > maleCount;
    return maleCount > femCount;
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
  // Upgrade: Anchored local fixes
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

          let after = replacePronounsSmart(region, dir);

          if (passiveVoice) {
            const gAgent = detectPassiveAgentGender(region, entries);
            if (gAgent) {
              const d2 = (gAgent === "female") ? "toFemale" : "toMale";
              after = replacePronounsSmart(after, d2);
            }
          }

          if (after !== region) {
            s = s.slice(0, start) + after + s.slice(end);
            changed++;
            re.lastIndex = start + after.length;
          }
        }
      }
    }

    return { text: s, changed };
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
  function findContentRoot() {
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
      const after = (out && typeof out === "object") ? out.text : before;
      const delta = (out && typeof out === "object") ? (out.changed || 0) : 0;

      if (after !== before) {
        node.nodeValue = after;
        changed += Math.max(1, delta || 1);
      } else if (delta) {
        changed += delta;
      }
    }
    return changed;
  }

  // ==========================================================
  // Character detection on current chapter/page
  // ==========================================================
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
  // Quick Add Draft UI helpers (NEW)
  // ==========================================================
  function buildDraftJSONSnippet(draftObj) {
    // OUTPUT MUST BE character-details-only:
    // {
    //   "Name": { "gender": "male", "aliases": [] }
    // }
    const out = {};
    const keys = Object.keys(draftObj || {}).sort((a, b) => a.localeCompare(b));
    for (const name of keys) {
      const v = draftObj[name] || {};
      const gender = (String(v.gender || "").toLowerCase() === "female") ? "female" : "male";
      const aliases = Array.isArray(v.aliases) ? v.aliases.filter(Boolean) : [];
      out[name] = { gender, aliases };
    }
    return JSON.stringify(out, null, 2);
  }

  function makeQuickAddPopover() {
    const pop = document.createElement("div");
    pop.style.cssText = `
      position: fixed; z-index: 2147483647;
      display:none;
      background: rgba(0,0,0,0.78);
      color:#fff;
      border-radius: 12px;
      padding: 8px;
      box-shadow: 0 12px 30px rgba(0,0,0,.28);
      backdrop-filter: blur(6px);
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      user-select: none;
    `;

    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;";

    const label = document.createElement("div");
    label.style.cssText = "font-weight:600; opacity:.95; max-width: 360px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    label.textContent = "Add character";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close";
    close.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:24px; height:24px; border-radius:8px;
      background:rgba(255,255,255,0.10); color:#fff;
      font-size:16px; line-height:24px; padding:0;
    `;

    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex; gap:8px; align-items:center;";

    const btnMale = document.createElement("button");
    btnMale.type = "button";
    btnMale.textContent = "Male";
    btnMale.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding:6px 10px; border-radius:999px;
      background:rgba(255,255,255,0.14); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const btnFemale = document.createElement("button");
    btnFemale.type = "button";
    btnFemale.textContent = "Female";
    btnFemale.style.cssText = btnMale.style.cssText;

    row1.appendChild(label);
    row1.appendChild(close);
    row2.appendChild(btnMale);
    row2.appendChild(btnFemale);

    pop.appendChild(row1);
    pop.appendChild(row2);

    document.documentElement.appendChild(pop);

    let currentName = "";
    let onPick = null;

    function hide() {
      pop.style.display = "none";
      currentName = "";
      onPick = null;
    }

    function showAt(x, y, name, cb) {
      currentName = name;
      onPick = cb;
      label.textContent = `Add: ${name}`;
      pop.style.left = Math.max(6, Math.min(x, window.innerWidth - 240)) + "px";
      pop.style.top  = Math.max(6, Math.min(y, window.innerHeight - 80)) + "px";
      pop.style.display = "block";
    }

    close.onclick = hide;
    btnMale.onclick = () => { if (onPick) onPick(currentName, "male"); hide(); };
    btnFemale.onclick = () => { if (onPick) onPick(currentName, "female"); hide(); };

    // Click outside closes
    document.addEventListener("mousedown", (e) => {
      if (pop.style.display !== "block") return;
      if (!pop.contains(e.target)) hide();
    }, true);

    return { showAt, hide };
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

    // Draft state (NEW)
    let draftCount = 0;

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

      /* ============================
         EDIT HERE: Expanded opacity
         - Reduce opacity by ~20%
         ============================ */
      background: rgba(0,0,0,0.50);

      color: #fff;
      border-radius: 12px;
      padding: 10px 12px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);

      /* ============================
         EDIT HERE: Expanded width cap
         ============================ */
      max-width: min(480px, 86vw);
      height: auto;

      backdrop-filter: blur(6px);
      user-select: none;
      touch-action: none;
    `;

    const topRow = document.createElement("div");
    topRow.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;`;

    const title = document.createElement("div");
    title.textContent = "PronounsFix";
    title.style.cssText = `font-weight: 600;`;

    const controls = document.createElement("div");
    controls.style.cssText = `display:flex; gap:8px; align-items:center; flex-wrap: wrap; justify-content:flex-end;`;

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 6px 10px; border-radius: 999px;
      background: rgba(255,255,255,0.12); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset Changed";
    resetBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:26px; height:26px; border-radius:9px;
      background:rgba(255,255,255,0.12); color:#fff;
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

    // Draft buttons (NEW)
    const copyDraftBtn = document.createElement("button");
    copyDraftBtn.type = "button";
    copyDraftBtn.textContent = "Copy JSON";
    copyDraftBtn.title = "Copy character-details-only JSON for glossary.json";
    copyDraftBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 6px 10px; border-radius: 999px;
      background: rgba(255,255,255,0.12); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const clearDraftBtn = document.createElement("button");
    clearDraftBtn.type = "button";
    clearDraftBtn.textContent = "Clear";
    clearDraftBtn.title = "Clear Draft";
    clearDraftBtn.style.cssText = copyDraftBtn.style.cssText;

    const bullets = document.createElement("div");
    bullets.style.cssText = `white-space: pre-line; opacity: .95;`;

    // Minimised pill container
    const pill = document.createElement("div");
    pill.style.cssText = `
      display:none; position: fixed; z-index: 2147483647;

      /* ============================
         EDIT HERE: Minimised opacity
         - Reduce opacity by ~40%
         ============================ */
      background: rgba(0,0,0,0.37);

      color:#fff;
      border-radius: 999px;

      /* ============================
         EDIT HERE: Minimised size
         ============================ */
      padding: 4px 6px;
      font: 11px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;

      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      backdrop-filter: blur(6px);
      user-select: none;
      touch-action: none;

      max-width: min(420px, 84vw);
    `;

    const pillRow = document.createElement("div");
    pillRow.style.cssText = `display:flex; align-items:center; gap:8px;`;

    const pillText = document.createElement("div");
    pillText.style.cssText = `padding: 1px 4px; white-space: nowrap;`;

    const pillExpandBtn = document.createElement("button");
    pillExpandBtn.type = "button";
    pillExpandBtn.textContent = "+";
    pillExpandBtn.title = "Expand";
    pillExpandBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:22px; height:22px; border-radius:8px;
      background:rgba(255,255,255,0.10); color:#fff;
      font-size:14px; line-height:22px; padding:0;
    `;

    function refreshToggleUI() {
      const on = enabled();
      toggleBtn.textContent = on ? "ON" : "OFF";
      toggleBtn.style.background = on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)";
      pillText.textContent = `PF (${on ? "ON" : "OFF"})`;
    }

    function refreshPanelBullets() {
      if (!glossaryOk) {
        bullets.textContent = "Glossary error";
        return;
      }
      const line1 = `• Characters: ${charactersCount}` + (charactersList3 ? ` • ${charactersList3}` : "");
      const line2 = `• Changed: ${changedTotal}`;
      const line3 = `• Draft: ${draftCount} (select a name in chapter text → pick Male/Female)`;
      bullets.textContent = `${line1}\n${line2}\n${line3}`;
    }

    toggleBtn.onclick = () => {
      setEnabled(!enabled());
      refreshToggleUI();
      setTimeout(() => location.reload(), 150);
    };

    resetBtn.onclick = () => {
      changedTotal = 0;
      refreshPanelBullets();
    };

    copyDraftBtn.onclick = async () => {
      const draft = loadDraft();
      const snippet = buildDraftJSONSnippet(draft);
      const ok = await copyToClipboard(snippet);
      if (ok) {
        copyDraftBtn.textContent = "Copied!";
        setTimeout(() => (copyDraftBtn.textContent = "Copy JSON"), 900);
      }
    };

    clearDraftBtn.onclick = () => {
      clearDraft();
      draftCount = 0;
      refreshPanelBullets();
      clearDraftBtn.textContent = "Cleared!";
      setTimeout(() => (clearDraftBtn.textContent = "Clear"), 900);
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

    applyPos(box);
    applyPos(pill);
    enableDrag(box, true);
    enableDrag(pill, true);

    controls.appendChild(toggleBtn);
    controls.appendChild(resetBtn);
    controls.appendChild(copyDraftBtn);
    controls.appendChild(clearDraftBtn);
    controls.appendChild(minBtn);

    topRow.appendChild(title);
    topRow.appendChild(controls);

    box.appendChild(topRow);
    box.appendChild(bullets);

    pillRow.appendChild(pillText);
    pillRow.appendChild(pillExpandBtn);
    pill.appendChild(pillRow);

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(pill);

    // Init counts (draft)
    draftCount = Object.keys(loadDraft()).length;

    refreshToggleUI();
    refreshPanelBullets();

    if (localStorage.getItem(UI_KEY_MIN) === "1") setMin(true);

    window.addEventListener("resize", () => {
      clampToViewport(localStorage.getItem(UI_KEY_MIN) === "1" ? pill : box);
    });

    return {
      isEnabled: () => enabled(),
      setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshPanelBullets(); },
      setCharacters: (entries) => {
        charactersCount = entries.length;
        const names = entries.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
          const g = String(info.gender || "").toLowerCase();
          const label = (g === "female" || g === "male") ? g : "unknown";
          return `${name} (${label})`;
        });
        charactersList3 = names.join(", ") + (entries.length > MAX_NAMES_SHOWN ? " …" : "");
        refreshPanelBullets();
      },
      addChanged: (delta) => {
        if (Number.isFinite(delta) && delta > 0) changedTotal += delta;
        refreshPanelBullets();
      },
      bumpDraftCount: () => {
        draftCount = Object.keys(loadDraft()).length;
        refreshPanelBullets();
      },
      refreshUI: refreshToggleUI
    };
  }

  // ==========================================================
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
    ui.refreshUI();
    if (!ui.isEnabled()) return;

    if (!GLOSSARY_URL || /\?token=GHSAT/i.test(GLOSSARY_URL)) {
      ui.setGlossaryOk(false);
      return;
    }

    let glossary;
    try {
      glossary = await loadGlossaryJSON(GLOSSARY_URL);
    } catch {
      ui.setGlossaryOk(false);
      return;
    }

    const key = pickKey(glossary);
    const cfg = glossary[key] || {};

    const upgrades = cfg.upgrades || {};
    const U = {
      anchoredFixes: upgrades.anchoredFixes !== false, // default true
      verbBasedWindow: !!upgrades.verbBasedWindow,
      passiveVoice: !!upgrades.passiveVoice,
      dialogueSpeaker: !!upgrades.dialogueSpeaker,
      roleHeuristicCarry: !!upgrades.roleHeuristicCarry,
      onlyChangeIfWrong: !!upgrades.onlyChangeIfWrong,

      // NEW: enable Quick Add Draft (default true unless explicitly disabled)
      quickAddDraft: upgrades.quickAddDraft !== false
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

    // Detect only characters that actually appear in this chapter/page
    const rootForDetect = findContentRoot();
    const detectedEntries = detectCharactersOnPage(rootForDetect, entries);
    ui.setCharacters(detectedEntries.length ? detectedEntries : entries);

    // ==========================================================
    // Quick Add Draft: selection → popover (NEW)
    // ==========================================================
    const pop = makeQuickAddPopover();

    function selectionWithinContent(sel, root) {
      if (!sel || sel.rangeCount === 0) return false;
      const r = sel.getRangeAt(0);
      const node = r.commonAncestorContainer;
      const el = (node && node.nodeType === 1) ? node : node?.parentElement;
      if (!el) return false;
      if (isSkippable(el)) return false;
      return root && root.contains(el);
    }

    function isExistingCharacter(name) {
      const n = String(name || "");
      if (!n) return false;
      for (const [k, info] of entries) {
        if (k === n) return true;
        const aliases = Array.isArray(info.aliases) ? info.aliases : [];
        if (aliases.includes(n)) return true;
      }
      return false;
    }

    function addDraft(name, gender) {
      const nm = normalizeNameCandidate(name);
      if (!nm) return;

      // If already in glossary, ignore (draft is for "not yet in glossary")
      if (isExistingCharacter(nm)) return;

      const draft = loadDraft();
      if (!draft[nm]) draft[nm] = { gender, aliases: [] };
      else draft[nm].gender = gender;

      // Ensure aliases array exists
      if (!Array.isArray(draft[nm].aliases)) draft[nm].aliases = [];

      saveDraft(draft);
      ui.bumpDraftCount();
    }

    if (U.quickAddDraft) {
      document.addEventListener("mouseup", (e) => {
        const root = findContentRoot();
        const sel = window.getSelection();
        if (!selectionWithinContent(sel, root)) return;

        const txt = sel.toString();
        const nm = normalizeNameCandidate(txt);
        if (!nm) return;

        // Don't pop if selection is already in glossary
        if (isExistingCharacter(nm)) return;

        // Show popover near cursor
        pop.showAt(e.clientX + 8, e.clientY + 10, nm, (pickedName, g) => {
          addDraft(pickedName, g);
        });
      }, true);
    }

    // ==========================================================
    // Pronoun engine (your existing flow)
    // ==========================================================
    const mode = String(cfg.mode || "paragraph").toLowerCase();
    const primaryCharacter = cfg.primaryCharacter || null;
    const forceGender = String(cfg.forceGender || "").toLowerCase();
    const carryParagraphs = Number.isFinite(+cfg.carryParagraphs)
      ? Math.max(0, Math.min(5, +cfg.carryParagraphs))
      : DEFAULT_CARRY_PARAGRAPHS;

    let lastSig = "";
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

    // Role heuristic carry state
    let lastActorGender = null;
    let lastActorTTL = 0;

    function run() {
      if (!ui.isEnabled()) return;

      const root = findContentRoot();
      const sig = makeSignature(root);
      if (sig === lastSig) return;
      lastSig = sig;

      const blocks = getTextBlocks(root);

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

      let lastGender = null;
      let carryLeft = 0;

      let changedThisRun = 0;

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

        // 1) Anchored local fixes (handles mixed-character paragraphs)
        if (U.anchoredFixes) {
          changedThisRun += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, entries, U));
        }

        // 2) Determine paragraph direction for fallback pass
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
          const dir = directionFromGender(g);

          let doFull = true;
          if (U.onlyChangeIfWrong) doFull = conservativeShouldApply(bt, g);

          if (doFull) {
            changedThisRun += replaceInTextNodes(b, (txt) => ({ text: replacePronounsSmart(txt, dir), changed: 0 }));
          }

          if (usedMode !== "chapter" && hadDirectMatch) {
            lastGender = g;
            carryLeft = carryParagraphs;
          }
        }
      }

      ui.addChanged(changedThisRun);
    }

    run();

    let timer = null;
    const obs = new MutationObserver(() => {
      if (!ui.isEnabled()) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(); }, 600);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  })();
})();
