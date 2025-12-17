// ==UserScript==
// @name         WTR PF
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.1
// @description  Fix mixed gender pronouns in WTR-LAB machine translations using a shared JSON glossary. Movable UI + minimise pill + ON/OFF toggle + auto-refresh + stable per-chapter Changed counter (persists across refresh). Draft Add Character/Term + persistent TermMemory + Term patches (hash-based). Faster + per-chapter detected characters. Optional upgrades (anchored fixes, verb-based window, passive voice, dialogue speaker tracking, role carry heuristic, conservative-only-if-wrong mode, strict possessives, mixed pronoun normalization).
// @match        *://wtr-lab.com/en/novel/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wtr-lab.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
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

  // UI
  const MAX_NAMES_SHOWN = 3;

  // Cache
  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v3";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v3";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000;

  // Persistent UI state
  const UI_KEY_MIN = "wtrpf_ui_min_v3";
  const UI_KEY_POS = "wtrpf_ui_pos_v3";
  const UI_KEY_ON  = "wtrpf_enabled_v3";

  // Draft + term memory (Tampermonkey persistent storage)
  const DRAFT_KEY = "wtrpf_draft_v1";
  const TERM_MEM_KEY = "wtrpf_term_memory_v1";

  // Stable Changed counter (persist per chapter, never decreases)
  const CHANGED_CACHE_KEY = "wtrpf_changed_cache_v1"; // localStorage map: { chapterId: number }

  // ==========================================================
  // Utilities
  // ==========================================================
  const SENT_PREFIX = String.raw`(^|[\r\n]+|[.!?…]\s+)(["'“‘(\[]\s*)?`;
  const LETTER = String.raw`\p{L}`;

  const RX_PRONOUN_MALE = /\b(he|him|his|himself)\b/gi;
  const RX_PRONOUN_FEMALE = /\b(she|her|hers|herself)\b/gi;
  const RX_ANY_PRONOUN = /\b(he|him|his|himself|she|her|hers|herself)\b/i;

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

  function hasAnyWrongPronoun(region, gender) {
    const maleCount = countMatches(RX_PRONOUN_MALE, region);
    const femCount  = countMatches(RX_PRONOUN_FEMALE, region);
    if (gender === "male") return femCount > 0;
    return maleCount > 0;
  }

  // ==========================================================
  // Smart pronoun replacement
  // ==========================================================
  function replacePronounsSmart(text, direction /* "toMale" | "toFemale" */) {
    text = normalizeWeirdSpaces(text);

    if (direction === "toFemale") {
      text = text.replace(/\bhim[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "herself"));
    } else {
      text = text.replace(/\bher[\s\u00A0\u2009\u202F-]*self\b/giu, (m) => caseLike(m, "himself"));
    }

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

  function conservativeShouldApply(region, gender) {
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

  function applyAnchoredFixes(text, activeEntries, opts) {
    let changed = 0;
    let s = normalizeWeirdSpaces(text);

    const {
      verbBasedWindow = false,
      passiveVoice = false,
      onlyChangeIfWrong = false
    } = opts;

    for (const [name, info] of activeEntries) {
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
            const gAgent = detectPassiveAgentGender(region, activeEntries);
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
  // Term patches
  // ==========================================================
  function loadTermMemory() {
    try { return GM_getValue(TERM_MEM_KEY, {}) || {}; } catch { return {}; }
  }
  function saveTermMemory(mem) {
    try { GM_setValue(TERM_MEM_KEY, mem || {}); } catch {}
  }

  function applyTermPatches(root, cfg, termMem) {
    const defaults = (cfg && cfg.termPatches && typeof cfg.termPatches === "object") ? cfg.termPatches : {};
    const spans = root.querySelectorAll("span.text-patch.system[data-hash]");
    let changed = 0;

    spans.forEach(sp => {
      const hash = sp.getAttribute("data-hash") || "";
      if (!hash) return;

      const preferred = (termMem[hash] && termMem[hash].preferred) || defaults[hash];
      if (!preferred) return;

      const before = sp.textContent || "";
      if (before !== preferred) {
        sp.textContent = preferred;
        changed++;
      }
    });

    return changed;
  }

  // ==========================================================
  // Changed counter cache
  // ==========================================================
  function getChapterId(root) {
    // Best: WTR chapter container carries data-chapter-id
    const el = root && root.querySelector ? root.querySelector("[data-chapter-id]") : null;
    const id = el ? (el.getAttribute("data-chapter-id") || "").trim() : "";
    if (id) return `ch:${id}`;
    // Fallback: URL path
    return `url:${location.pathname}${location.search}`;
  }

  function readChangedCache() {
    try { return JSON.parse(localStorage.getItem(CHANGED_CACHE_KEY) || "{}") || {}; }
    catch { return {}; }
  }
  function writeChangedCache(map) {
    try { localStorage.setItem(CHANGED_CACHE_KEY, JSON.stringify(map || {})); } catch {}
  }
  function getChangedForChapter(chId) {
    const m = readChangedCache();
    return Number(m[chId] || 0) || 0;
  }
  function addChangedForChapter(chId, delta) {
    if (!Number.isFinite(delta) || delta <= 0) return getChangedForChapter(chId);
    const m = readChangedCache();
    const prev = Number(m[chId] || 0) || 0;
    const next = prev + delta; // never decreases
    m[chId] = next;
    writeChangedCache(m);
    return next;
  }

  // ==========================================================
  // Draft helpers
  // ==========================================================
  function loadDraft() { try { return GM_getValue(DRAFT_KEY, {}) || {}; } catch { return {}; } }
  function saveDraft(d) { try { GM_setValue(DRAFT_KEY, d || {}); } catch {} }

  function formatDraftForCopy(draftObj) {
    const keys = Object.keys(draftObj || {}).sort((a, b) => a.localeCompare(b));
    return keys.map(k => {
      const v = draftObj[k] || {};
      const gender = v.gender || "unknown";
      const aliases = Array.isArray(v.aliases) ? v.aliases : [];
      const aliasPart = aliases.length ? `, "aliases": ${JSON.stringify(aliases)}` : `, "aliases": []`;
      return `"${k}": { "gender": "${gender}"${aliasPart} },`;
    }).join("\n");
  }

  // ==========================================================
  // UI (no refresh/reset button; auto-minimise on chapter change)
  // ==========================================================
  function makeUI() {
    const savedPos = JSON.parse(localStorage.getItem(UI_KEY_POS) || "{}");
    const enabledInit = localStorage.getItem(UI_KEY_ON);
    if (enabledInit !== "0" && enabledInit !== "1") localStorage.setItem(UI_KEY_ON, "1");

    function enabled() { return localStorage.getItem(UI_KEY_ON) !== "0"; }
    function setEnabled(v) { localStorage.setItem(UI_KEY_ON, v ? "1" : "0"); }

    let detectedCount = 0;
    let detectedList3 = "";
    let changedTotal = 0;
    let glossaryOk = true;

    let draft = loadDraft();
    let termMem = loadTermMemory();

    let currentChapterId = "";
    let lastChapterIdSeen = "";

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

    const box = document.createElement("div");
    box.style.cssText = `
      position: fixed; z-index: 2147483647;
      background: rgba(0,0,0,0.50);
      color: #fff;
      border-radius: 12px;
      padding: 10px 12px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      max-width: min(460px, 86vw);
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

    const infoTop = document.createElement("div");
    infoTop.style.cssText = `white-space: pre-line; opacity: .95;`;

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px; background:rgba(255,255,255,0.16); margin:8px 0;`;

    const draftWrap = document.createElement("div");
    draftWrap.style.cssText = `display:none;`;

    const draftButtons = document.createElement("div");
    draftButtons.style.cssText = `display:flex; gap:8px; align-items:center; margin-bottom:8px;`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy JSON";

    const clearDraftBtn = document.createElement("button");
    clearDraftBtn.type = "button";
    clearDraftBtn.textContent = "Clear Draft";

    const btnStyle = `
      appearance:none; border:0; cursor:pointer;
      padding:6px 10px; border-radius:10px;
      background:rgba(255,255,255,0.14); color:#fff;
      font:12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;
    copyBtn.style.cssText = btnStyle;
    clearDraftBtn.style.cssText = btnStyle;

    const draftBox = document.createElement("textarea");
    draftBox.readOnly = true;
    draftBox.spellcheck = false;
    draftBox.style.cssText = `
      width:100%;
      min-height: 86px;
      max-height: 220px;
      resize: vertical;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      outline:none;
    `;

    const draftCount = document.createElement("div");
    draftCount.style.cssText = `opacity:.8; margin-top:6px; font-size:11px;`;

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

    function refreshDraftUI() {
      const keys = Object.keys(draft || {});
      const hasDraft = keys.length > 0;
      draftWrap.style.display = hasDraft ? "block" : "none";
      if (hasDraft) {
        draftBox.value = formatDraftForCopy(draft);
        draftCount.textContent = `Draft count: ${keys.length}`;
      }
    }

    function refreshInfoTop() {
      if (!glossaryOk) {
        infoTop.textContent = "Glossary error";
        return;
      }
      const line1 = `• Characters (this chapter): ${detectedCount}` + (detectedList3 ? ` • ${detectedList3}` : "");
      const line2 = `• Changed (this chapter): ${changedTotal}`;
      infoTop.textContent = `${line1}\n${line2}`;
    }

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

    // remove refresh/reset button: only ON/OFF + minimise
    toggleBtn.onclick = () => {
      setEnabled(!enabled());
      refreshToggleUI();
      setTimeout(() => location.reload(), 120);
    };

    minBtn.onclick = () => setMin(true);
    pillExpandBtn.onclick = () => setMin(false);
    pillText.onclick = () => setMin(false);

    copyBtn.onclick = async () => {
      const txt = draftBox.value || "";
      try {
        await navigator.clipboard.writeText(txt);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy JSON"), 900);
      } catch {
        draftBox.focus();
        draftBox.select();
        document.execCommand("copy");
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy JSON"), 900);
      }
    };

    clearDraftBtn.onclick = () => {
      draft = {};
      saveDraft(draft);
      refreshDraftUI();
    };

    applyPos(box);
    applyPos(pill);
    enableDrag(box, true);
    enableDrag(pill, true);

    controls.appendChild(toggleBtn);
    controls.appendChild(minBtn);

    topRow.appendChild(title);
    topRow.appendChild(controls);

    draftButtons.appendChild(copyBtn);
    draftButtons.appendChild(clearDraftBtn);

    draftWrap.appendChild(draftButtons);
    draftWrap.appendChild(draftBox);
    draftWrap.appendChild(draftCount);

    box.appendChild(topRow);
    box.appendChild(infoTop);
    box.appendChild(divider);
    box.appendChild(draftWrap);

    pillRow.appendChild(pillText);
    pillRow.appendChild(pillExpandBtn);
    pill.appendChild(pillRow);

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(pill);

    refreshToggleUI();
    refreshInfoTop();
    refreshDraftUI();

    // keep existing state on first load
    if (localStorage.getItem(UI_KEY_MIN) === "1") setMin(true);

    window.addEventListener("resize", () => {
      clampToViewport(localStorage.getItem(UI_KEY_MIN) === "1" ? pill : box);
    });

    // ------------------------------
    // Add Character / Add Term popover
    // ------------------------------
    const pop = document.createElement("div");
    pop.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      display: none;
      min-width: 220px;
      max-width: min(360px, 88vw);
      padding: 10px 10px;
      border-radius: 12px;
      background: rgba(0,0,0,0.78);
      color: #fff;
      box-shadow: 0 10px 28px rgba(0,0,0,.35);
      backdrop-filter: blur(8px);
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const popTitle = document.createElement("div");
    popTitle.style.cssText = `font-weight:600; margin-bottom:6px;`;

    const popSub = document.createElement("div");
    popSub.style.cssText = `opacity:.85; margin-bottom:10px; word-break: break-word;`;

    const popRow = document.createElement("div");
    popRow.style.cssText = `display:flex; gap:8px; flex-wrap: wrap;`;

    const btnAddChar = document.createElement("button");
    btnAddChar.textContent = "Add Character";
    const btnAddTerm = document.createElement("button");
    btnAddTerm.textContent = "Add Term";
    const btnClose = document.createElement("button");
    btnClose.textContent = "Close";

    [btnAddChar, btnAddTerm, btnClose].forEach(b => b.style.cssText = btnStyle);

    const rowGender = document.createElement("div");
    rowGender.style.cssText = `display:none; margin-top:10px; gap:8px;`;
    const btnMale = document.createElement("button");
    btnMale.textContent = "Male";
    const btnFemale = document.createElement("button");
    btnFemale.textContent = "Female";
    [btnMale, btnFemale].forEach(b => b.style.cssText = btnStyle);

    const rowPin = document.createElement("div");
    rowPin.style.cssText = `display:none; margin-top:10px;`;
    const pinLabel = document.createElement("div");
    pinLabel.style.cssText = `opacity:.9; margin-bottom:6px;`;
    pinLabel.textContent = "Pinned display text:";
    const pinInput = document.createElement("input");
    pinInput.type = "text";
    pinInput.style.cssText = `
      width:100%;
      padding:8px 10px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.06);
      color:#fff;
      outline:none;
      font:12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;
    const pinSave = document.createElement("button");
    pinSave.textContent = "Save Pin";
    pinSave.style.cssText = btnStyle;
    pinSave.style.marginTop = "8px";

    popRow.appendChild(btnAddChar);
    popRow.appendChild(btnAddTerm);
    popRow.appendChild(btnClose);

    rowGender.appendChild(btnMale);
    rowGender.appendChild(btnFemale);

    rowPin.appendChild(pinLabel);
    rowPin.appendChild(pinInput);
    rowPin.appendChild(pinSave);

    pop.appendChild(popTitle);
    pop.appendChild(popSub);
    pop.appendChild(popRow);
    pop.appendChild(rowGender);
    pop.appendChild(rowPin);

    document.documentElement.appendChild(pop);

    let pending = { type: null, text: "", hash: "", fromSpan: false };

    function hidePop() {
      pop.style.display = "none";
      rowGender.style.display = "none";
      rowPin.style.display = "none";
      pending = { type: null, text: "", hash: "", fromSpan: false };
    }

    function showPop(x, y, header, text, hash, fromSpan) {
      pending = { type: null, text: text || "", hash: hash || "", fromSpan: !!fromSpan };
      popTitle.textContent = header || "Add";
      popSub.textContent = text || "";
      rowGender.style.display = "none";
      rowPin.style.display = "none";

      pop.style.left = Math.min(x, window.innerWidth - 12) + "px";
      pop.style.top  = Math.min(y, window.innerHeight - 12) + "px";
      pop.style.display = "block";

      const r = pop.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - r.width - 8);
      const top  = Math.min(r.top, window.innerHeight - r.height - 8);
      pop.style.left = Math.max(8, left) + "px";
      pop.style.top  = Math.max(8, top) + "px";
    }

    btnClose.onclick = hidePop;

    btnAddChar.onclick = () => {
      pending.type = "character";
      rowPin.style.display = "none";
      rowGender.style.display = "flex";
      popTitle.textContent = "Add Character → Select Gender";
    };

    btnAddTerm.onclick = () => {
      pending.type = "term";
      rowGender.style.display = "none";
      rowPin.style.display = "block";
      popTitle.textContent = "Add Term → Pin display text";
      pinInput.value = pending.text || "";
    };

    function addDraftCharacter(name, gender) {
      if (!name) return;
      if (!draft[name]) draft[name] = { gender, aliases: [] };
      else draft[name].gender = gender;
      saveDraft(draft);
      refreshDraftUI();
      highlightAddedInChapter(name);
    }

    btnMale.onclick = () => addDraftCharacter(pending.text, "male");
    btnFemale.onclick = () => addDraftCharacter(pending.text, "female");

    pinSave.onclick = () => {
      const hash = pending.hash;
      const preferred = (pinInput.value || "").trim();
      if (!hash || !preferred) return;

      termMem = loadTermMemory();
      termMem[hash] = termMem[hash] || {};
      termMem[hash].preferred = preferred;
      termMem[hash].updatedAt = Date.now();
      saveTermMemory(termMem);

      try {
        const root = findContentRoot();
        applyTermPatches(root, currentCfgRef || {}, termMem);
      } catch {}

      hidePop();
    };

    document.addEventListener("click", (ev) => {
      if (ev.target && (box.contains(ev.target) || pill.contains(ev.target) || pop.contains(ev.target))) return;

      const sel = window.getSelection();
      const selectedText = (sel && String(sel.toString() || "").trim()) || "";

      const span = ev.target && ev.target.closest ? ev.target.closest("span.text-patch.system[data-hash]") : null;

      if (!span && !selectedText) return;

      if (span) {
        const text = (span.textContent || "").trim();
        const hash = span.getAttribute("data-hash") || "";
        if (!text) return;
        showPop(ev.clientX + 10, ev.clientY + 10, "Add (WTR term)", text, hash, true);
        return;
      }

      showPop(ev.clientX + 10, ev.clientY + 10, "Add (selection)", selectedText, "", false);
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hidePop();
    });

    GM_addStyle(`
      .wtrpf-added-term-highlight {
        text-shadow: 0 0 8px rgba(255,255,255,0.28);
        text-decoration: underline;
        text-decoration-color: rgba(255,255,255,0.35);
        text-underline-offset: 2px;
      }
    `);

    function highlightAddedInChapter(name) {
      try {
        const root = findContentRoot();
        const spans = root.querySelectorAll("span.text-patch.system");
        spans.forEach(sp => {
          const t = (sp.textContent || "").trim();
          if (t === name) sp.classList.add("wtrpf-added-term-highlight");
        });
      } catch {}
    }

    function forceMinimiseNow() {
      localStorage.setItem(UI_KEY_MIN, "1");
      setMin(true);
    }

    // Exposed hooks
    return {
      isEnabled: () => enabled(),
      setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshInfoTop(); },

      // chapter + changed (stable)
      setChapterId: (id) => {
        currentChapterId = id || "";
        changedTotal = currentChapterId ? getChangedForChapter(currentChapterId) : 0;
        refreshInfoTop();

        // Auto-minimise when chapter changes
        if (currentChapterId && lastChapterIdSeen && currentChapterId !== lastChapterIdSeen) {
          forceMinimiseNow();
        }
        if (currentChapterId) lastChapterIdSeen = currentChapterId;
      },
      addChangedForCurrentChapter: (delta) => {
        if (!currentChapterId) return;
        changedTotal = addChangedForChapter(currentChapterId, delta);
        refreshInfoTop();
      },

      setDetectedCharacters: (entries) => {
        detectedCount = entries.length;
        const names = entries.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
          const g = String(info.gender || "").toLowerCase();
          const label = (g === "female" || g === "male") ? g : "unknown";
          return `${name} (${label})`;
        });
        detectedList3 = names.join(", ") + (entries.length > MAX_NAMES_SHOWN ? " …" : "");
        refreshInfoTop();
      },

      refreshUI: refreshToggleUI,

      // drafts + term memory
      getDraft: () => (draft = loadDraft(), draft),
      getTermMem: () => (termMem = loadTermMemory(), termMem),
      setTermMem: (m) => { termMem = m || {}; saveTermMemory(termMem); },
    };
  }

  // ==========================================================
  // Content targeting
  // ==========================================================
  function findContentRoot() {
    const candidates = Array.from(document.querySelectorAll(
      ".chapter-body, article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section"
    ));
    let best = null, bestScore = 0;
    for (const el of candidates) {
      const pCount = el.querySelectorAll("p").length;
      const textLen = (el.innerText || "").trim().length;
      const score = (pCount * 1400) + textLen;
      if (score > bestScore && textLen > 600) { bestScore = score; best = el; }
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

      if (!RX_ANY_PRONOUN.test(before)) continue;

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
  // Per-chapter detection (accurate)
  // ==========================================================
  function buildLookup(entries) {
    const map = new Map();
    for (const [name, info] of entries) {
      const key = String(name || "").toLowerCase();
      if (key) map.set(key, [name, info]);
      const aliases = Array.isArray(info.aliases) ? info.aliases : [];
      for (const a of aliases) {
        const ak = String(a || "").toLowerCase();
        if (ak && !map.has(ak)) map.set(ak, [name, info]);
      }
    }
    return map;
  }

  function detectCharactersThisChapter(root, entries) {
    const lookup = buildLookup(entries);
    const detectedMap = new Map();

    const spans = root.querySelectorAll("span.text-patch.system");
    spans.forEach(sp => {
      const t = (sp.textContent || "").trim().toLowerCase();
      if (!t) return;
      const found = lookup.get(t);
      if (found) detectedMap.set(found[0], found);
    });

    const hay = (root.innerText || "").toLowerCase();
    for (const [name, info] of entries) {
      const n = String(name || "").toLowerCase();
      if (n && hay.includes(n)) detectedMap.set(name, [name, info]);
      else {
        const aliases = Array.isArray(info.aliases) ? info.aliases : [];
        for (const a of aliases) {
          const ak = String(a || "").toLowerCase();
          if (ak && hay.includes(ak)) { detectedMap.set(name, [name, info]); break; }
        }
      }
    }

    return Array.from(detectedMap.values());
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

  // Keep cfg available for pin-save immediate apply
  let currentCfgRef = null;

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
    currentCfgRef = cfg;

    const upgrades = cfg.upgrades || {};
    const U = {
      anchoredFixes: upgrades.anchoredFixes !== false,
      verbBasedWindow: !!upgrades.verbBasedWindow,
      passiveVoice: !!upgrades.passiveVoice,
      dialogueSpeaker: !!upgrades.dialogueSpeaker,
      roleHeuristicCarry: !!upgrades.roleHeuristicCarry,

      // IMPORTANT: use "hasAnyWrongPronoun" gating (more accurate than dominance-only)
      onlyChangeIfWrong: !!upgrades.onlyChangeIfWrong,

      mixedPronounNormalize: !!upgrades.mixedPronounNormalize,
      termPatches: upgrades.termPatches !== false,
    };

    const characters = {
      ...(glossary.default?.characters || {}),
      ...(cfg.characters || {})
    };
    const entriesAll = Object.entries(characters);

    if (!entriesAll.length) {
      ui.setGlossaryOk(false);
      return;
    }
    ui.setGlossaryOk(true);

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

    // Case-insensitive matching to prevent later-chapter failures
    function computeGenderForText(text, activeEntries) {
      const t = normalizeWeirdSpaces(text);
      const tLower = t.toLowerCase();

      if (forceGender === "male" || forceGender === "female") return forceGender;

      if (primaryCharacter && characters[primaryCharacter]) {
        const pLower = String(primaryCharacter).toLowerCase();
        if (tLower.includes(pLower)) {
          const g0 = String(characters[primaryCharacter].gender || "").toLowerCase();
          if (g0 === "female" || g0 === "male") return g0;
        }
      }

      if (U.passiveVoice) {
        const gAgent = detectPassiveAgentGender(t, activeEntries);
        if (gAgent) return gAgent;
      }

      if (U.dialogueSpeaker) {
        const gSpeaker = detectDialogueSpeakerGender(t, activeEntries);
        if (gSpeaker) return gSpeaker;
      }

      for (const [name, info] of activeEntries) {
        const nLower = String(name || "").toLowerCase();
        if (nLower && tLower.includes(nLower)) {
          const g = String(info.gender || "").toLowerCase();
          if (g === "female" || g === "male") return g;
        }
        const aliases = Array.isArray(info.aliases) ? info.aliases : [];
        for (const a of aliases) {
          const aLower = String(a || "").toLowerCase();
          if (aLower && tLower.includes(aLower)) {
            const g = String(info.gender || "").toLowerCase();
            if (g === "female" || g === "male") return g;
          }
        }
      }

      return null;
    }

    function getActiveEntriesForBlockText(btLower) {
      const active = [];
      for (const [name, info] of entriesAll) {
        const nLower = String(name || "").toLowerCase();
        if (nLower && btLower.includes(nLower)) { active.push([name, info]); continue; }
        const aliases = Array.isArray(info.aliases) ? info.aliases : [];
        for (const a of aliases) {
          const aLower = String(a || "").toLowerCase();
          if (aLower && btLower.includes(aLower)) { active.push([name, info]); break; }
        }
      }
      return active;
    }

    let lastActorGender = null;
    let lastActorTTL = 0;

    function run() {
      if (!ui.isEnabled()) return;

      const root = findContentRoot();

      // Chapter ID + stable changed count + auto-minimise on chapter change
      const chapterId = getChapterId(root);
      ui.setChapterId(chapterId);

      const sig = makeSignature(root);
      if (sig === lastSig) return;
      lastSig = sig;

      // Update detected characters per chapter
      const detected = detectCharactersThisChapter(root, entriesAll);
      ui.setDetectedCharacters(detected.length ? detected : entriesAll);

      // Term patches
      let termChanged = 0;
      if (U.termPatches) {
        const termMem = ui.getTermMem();
        termChanged = applyTermPatches(root, cfg, termMem);
      }

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

        if (!RX_ANY_PRONOUN.test(bt)) continue;

        const btLower = normalizeWeirdSpaces(bt).toLowerCase();
        const activeEntries = getActiveEntriesForBlockText(btLower);

        // 1) Anchored local fixes (active only)
        if (U.anchoredFixes && activeEntries.length) {
          changedThisRun += replaceInTextNodes(b, (txt) => applyAnchoredFixes(txt, activeEntries, U));
        }

        // 2) Determine direction
        let g = null;
        let hadDirectMatch = false;

        if (usedMode === "chapter") {
          g = chapterGender;
          hadDirectMatch = true;
        } else {
          if (activeEntries.length) {
            const computed = computeGenderForText(bt, activeEntries);
            if (computed) {
              g = computed;
              hadDirectMatch = true;

              if (U.roleHeuristicCarry && RX_ATTACK_CUES.test(bt)) {
                lastActorGender = computed;
                lastActorTTL = 2;
              }
            }
          }

          if (!g) {
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

        // 3) Full pass
        if (g) {
          const dir = directionFromGender(g);

          let doFull = true;
          if (U.onlyChangeIfWrong) {
            doFull = hasAnyWrongPronoun(bt, g);
          }

          if (doFull) {
            changedThisRun += replaceInTextNodes(b, (txt) => ({ text: replacePronounsSmart(txt, dir), changed: 0 }));
          }

          if (usedMode !== "chapter" && hadDirectMatch) {
            lastGender = g;
            carryLeft = carryParagraphs;
          }
        } else if (U.mixedPronounNormalize) {
          const maleCount = countMatches(RX_PRONOUN_MALE, bt);
          const femCount  = countMatches(RX_PRONOUN_FEMALE, bt);
          if (maleCount > 0 && femCount > 0) {
            const dir = (maleCount >= femCount) ? "toMale" : "toFemale";
            changedThisRun += replaceInTextNodes(b, (txt) => ({ text: replacePronounsSmart(txt, dir), changed: 0 }));
          }
        }
      }

      // Stable Changed count per chapter: never decreases on refresh
      ui.addChangedForCurrentChapter(changedThisRun + termChanged);
    }

    run();

    let timer = null;
    const obs = new MutationObserver(() => {
      if (!ui.isEnabled()) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(); }, 450);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  })();
})();
