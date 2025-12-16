// ==UserScript==
// @name         WTR-LAB Pronouns Fix
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.6.5
// @description  Fix mixed gender pronouns in WTR-LAB machine translations using a shared JSON glossary. Movable UI + minimise pill + ON/OFF toggle + auto-refresh + stable Changed counter. Mixed-gender sentence fix. Uses GM_xmlhttpRequest + cache fallback for reliable glossary loading.
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

  // Safety guard
  if (!location.hostname.endsWith("wtr-lab.com")) return;

  // ==========================================================
  // USER SETTINGS
  // ==========================================================
  const GLOSSARY_URL = "https://raw.githubusercontent.com/youaremyhero/wtr-lab-pronouns-fix/main/glossary.templates.json";
  const DEFAULT_CARRY_PARAGRAPHS = 2;
  const EARLY_PRONOUN_WINDOW = 160;

  // Mixed-gender resolver tuning
  const NEAR_NAME_WINDOW = 80;          // characters: if pronoun is within this many chars after a name, assume it refers to that name
  const OBJECT_FALLBACK_WINDOW = 220;   // characters: for him/her fallback logic when no nearby name

  // UI character list settings
  const MAX_NAMES_SHOWN = 3;

  // Glossary cache
  const GLOSSARY_CACHE_KEY = "wtrpf_glossary_cache_v1";
  const GLOSSARY_CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const GLOSSARY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Persistent UI state
  const UI_KEY_MIN = "wtrpf_ui_min_v1";
  const UI_KEY_POS = "wtrpf_ui_pos_v1";
  const UI_KEY_ON  = "wtrpf_enabled_v1"; // "1" or "0"

  // ==========================================================
  // Utilities
  // ==========================================================
  const SENT_PREFIX = String.raw`(^|[\r\n]+|[.!?…]\s+)(["'“‘(\[]\s*)?`;
  const LETTER = String.raw`\p{L}`;

  function caseLike(src, target) {
    if (!src) return target;
    if (src.toUpperCase() === src) return target.toUpperCase();
    if (src[0] === src[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1);
    return target.toLowerCase();
  }

  function normalizeWeirdSpaces(s) {
    return s.replace(/\u00A0|\u2009|\u202F/g, " ");
  }

  function isSceneBreak(t) {
    const s = (t || "").trim();
    return (
      s === "***" || s === "— — —" ||
      /^(\*{3,}|-{3,}|={3,}|_{3,})$/.test(s)
    );
  }

  function startsWithPronoun(t) {
    const s = (t || "").trim();
    return /^["'“‘(\[]?\s*(she|he|her|him|his|hers|herself|himself)\b/i.test(s);
  }

  function pronounAppearsEarly(t, limit = EARLY_PRONOUN_WINDOW) {
    const s = (t || "").trim();
    const head = s.slice(0, limit);
    return /\b(she|he|her|him|his|hers|herself|himself)\b/i.test(head);
  }

  // ==========================================================
  // Pronoun replacement (your existing robust rules)
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
      text = text.replace(new RegExp(String.raw`\bher\b(?=\s+${LETTER})`, "giu"),
        (m) => caseLike(m, "his"));
      text = text.replace(/\bher\b/giu, (m) => caseLike(m, "him"));
    } else {
      text = text.replace(/\bhe\b/giu, (m) => caseLike(m, "she"));
      text = text.replace(/\bhimself\b/giu, (m) => caseLike(m, "herself"));
      text = text.replace(/\bhim\b/giu, (m) => caseLike(m, "her"));
      text = text.replace(new RegExp(String.raw`\bhis\b(?=\s+${LETTER})`, "giu"),
        (m) => caseLike(m, "her"));
      text = text.replace(/\bhis\b/giu, (m) => caseLike(m, "hers"));
    }

    return text;
  }

  // ==========================================================
  // Content targeting (avoid nav/footer/toolbars)
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
  // Glossary helpers + scoring
  // ==========================================================
  function pickKey(glossary) {
    const url = location.href;
    const keys = Object.keys(glossary || {}).filter(k => k !== "default");
    const matches = keys.filter(k => url.includes(k)).sort((a, b) => b.length - a.length);
    return matches[0] || "default";
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let idx = 0, count = 0;
    while (true) {
      idx = haystack.indexOf(needle, idx);
      if (idx === -1) break;
      count++;
      idx += needle.length;
    }
    return count;
  }

  function bestCharacterForText(text, entries, primaryCharacter) {
    let best = null, bestScore = 0;
    for (const [name, info] of entries) {
      const aliases = Array.isArray(info.aliases) ? info.aliases : [];
      const nameCount = countOccurrences(text, name);
      let score = nameCount * (1000 + Math.min(220, name.length * 6));
      for (const a of aliases) {
        const c = countOccurrences(text, a);
        score += c * (300 + Math.min(140, String(a).length * 5));
      }
      if (primaryCharacter && name === primaryCharacter) score += 250;
      if (score > bestScore) { bestScore = score; best = { name, info, score }; }
    }
    return (best && best.score >= 300) ? best : null;
  }

  function directionFromGender(g) {
    return g === "female" ? "toFemale" : "toMale";
  }

  // ==========================================================
  // NEW: Mixed-gender sentence resolver
  // ==========================================================
  function buildMentionIndex(sentence, entries) {
    const mentions = [];
    const lower = sentence.toLowerCase();

    for (const [name, info] of entries) {
      const g = String(info.gender || "").toLowerCase();
      if (g !== "female" && g !== "male") continue;

      const all = [name, ...(Array.isArray(info.aliases) ? info.aliases : [])]
        .filter(Boolean)
        .map(String);

      for (const n of all) {
        const needle = n.toLowerCase();
        let idx = 0;
        while (true) {
          idx = lower.indexOf(needle, idx);
          if (idx === -1) break;
          // crude word-boundary-ish check to reduce false matches
          const before = lower[idx - 1];
          const after = lower[idx + needle.length];
          const okBefore = !before || !/[a-z0-9]/i.test(before);
          const okAfter = !after || !/[a-z0-9]/i.test(after);
          if (okBefore && okAfter) mentions.push({ pos: idx, len: needle.length, gender: g });
          idx += needle.length;
        }
      }
    }

    mentions.sort((a,b) => a.pos - b.pos);
    return mentions;
  }

  function nextNonSpaceChar(text, startIdx) {
    const m = text.slice(startIdx).match(/^\s*([\s\S])/u);
    return m ? m[1] : "";
  }

  function normalizePronounToken(raw, targetGender, nextChar) {
    const w = raw;
    const lw = raw.toLowerCase();

    const nextIsLetter = !!(nextChar && /\p{L}/u.test(nextChar));

    // Decide replacement base (lowercase), then caseLike() to match original
    let repl = null;

    if (targetGender === "female") {
      if (lw === "he") repl = "she";
      else if (lw === "him") repl = "her";
      else if (lw === "his") repl = nextIsLetter ? "her" : "hers";
      else if (lw === "hers") repl = "hers";
      else if (lw === "himself") repl = "herself";
      else if (lw === "herself") repl = "herself";
      else if (lw === "her") {
        // if 'her' followed by a noun and target is female, keep 'her'
        repl = "her";
      }
    } else if (targetGender === "male") {
      if (lw === "she") repl = "he";
      else if (lw === "her") repl = nextIsLetter ? "his" : "him";
      else if (lw === "hers") repl = "his";
      else if (lw === "his") repl = "his";
      else if (lw === "herself") repl = "himself";
      else if (lw === "himself") repl = "himself";
      else if (lw === "him") repl = "him";
      else if (lw === "he") repl = "he";
    }

    if (!repl) return w;
    return caseLike(w, repl);
  }

  function fixMixedGenderSentence(sentence, entries) {
    // Find mentioned genders
    const mentions = buildMentionIndex(sentence, entries);
    const genders = new Set(mentions.map(m => m.gender));
    if (genders.size < 2) return sentence; // not mixed

    // Track "last mentioned gender" while scanning pronouns
    const pronounRe = /\b(he|she|him|her|his|hers|himself|herself)\b/giu;

    let lastMentionIdx = 0;
    let lastMentionGender = null;
    let lastTargetGender = null;

    const out = sentence.replace(pronounRe, (m, _p, offset) => {
      // advance lastGender to last mention before this pronoun
      while (lastMentionIdx < mentions.length && mentions[lastMentionIdx].pos < offset) {
        lastMentionGender = mentions[lastMentionIdx].gender;
        lastMentionIdx++;
      }

      // nearest mention distance (previous mention only)
      const prevMention = (lastMentionIdx > 0) ? mentions[lastMentionIdx - 1] : null;
      const dist = prevMention ? (offset - prevMention.pos) : Infinity;

      const priorContext = lastTargetGender || lastMentionGender;

      // Determine target gender for this pronoun
      let target = null;

      if (prevMention && dist <= NEAR_NAME_WINDOW) {
        // Close to a name => assume refers to that name
        target = prevMention.gender;
      } else {
        const lw = m.toLowerCase();
        const isObjectLike = (lw === "him" || lw === "her" || lw === "himself" || lw === "herself");

        if (isObjectLike && priorContext && genders.size === 2) {
          // For mixed sentences, object pronouns often refer to "the other" participant (opponent/victim)
          target = (priorContext === "female") ? "male" : "female";
        } else if (priorContext) {
          // Otherwise follow the last mentioned character/pronoun
          target = priorContext;
        } else {
          // No mentions at all (shouldn't happen if mixed), leave unchanged
          target = null;
        }
      }

      if (!target) return m;

      lastTargetGender = target;

      // Peek next character to handle her/his possession decision
      const nextChar = nextNonSpaceChar(sentence, offset + m.length) || "";
      return normalizePronounToken(m, target, nextChar);
    });

    return out;
  }

  function fixTextWithSentenceLogic(text, entries, primaryCharacter) {
    let s = normalizeWeirdSpaces(text);

    // Split sentences but keep punctuation with the sentence
    // (This is intentionally simple/fast; web novel text is messy.)
    const parts = s.split(/(?<=[.!?…])\s+/u);

    const fixed = parts.map(sent => {
      const match = bestCharacterForText(sent, entries, primaryCharacter);

      // If sentence clearly belongs to one character gender, use your strong replacer
      if (match) {
        const g = String(match.info.gender || "").toLowerCase();
        if (g === "female" || g === "male") {
          const dir = directionFromGender(g);
          return replacePronounsSmart(sent, dir);
        }
      }

      // Otherwise, only do mixed-gender resolution if it appears mixed
      return fixMixedGenderSentence(sent, entries);
    });

    return fixed.join(" ");
  }

  // ==========================================================
  // Text node walker (UPDATED to use sentence-level logic)
  // ==========================================================
  function replaceInTextNodes(blockEl, entries, primaryCharacter) {
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
      const after = fixTextWithSentenceLogic(before, entries, primaryCharacter);
      if (after !== before) { node.nodeValue = after; changed++; }
    }
    return changed;
  }

  // ==========================================================
  // UI (unchanged from your current version, kept minimal here)
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
      if (savedPos.left != null) { el.style.left = savedPos.left + "px"; el.style.right = "auto"; }
      else { el.style.right = "12px"; el.style.left = "auto"; }
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

      const end = () => { if (!dragging) return; dragging = false; clampToViewport(el); };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }

    const box = document.createElement("div");
    box.style.cssText = `
      position: fixed; z-index: 2147483647;
      background: rgba(0,0,0,0.62); color: #fff;
      border-radius: 12px; padding: 10px 12px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      max-width: min(520px, 88vw);
      backdrop-filter: blur(6px);
      user-select: none; touch-action: none;
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

    const bullets = document.createElement("div");
    bullets.style.cssText = `white-space: pre-line; opacity: .95;`;

    const pill = document.createElement("div");
    pill.style.cssText = `
      display:none; position: fixed; z-index: 2147483647;
      background: rgba(0,0,0,0.62); color:#fff;
      border-radius: 999px;
      padding: 6px 8px;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      backdrop-filter: blur(6px);
      user-select: none; touch-action: none;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      max-width: min(520px, 88vw);
    `;

    const pillRow = document.createElement("div");
    pillRow.style.cssText = `display:flex; align-items:center; gap:8px;`;

    const pillText = document.createElement("div");
    pillText.style.cssText = `padding: 2px 6px; white-space: nowrap;`;

    const pillExpandBtn = document.createElement("button");
    pillExpandBtn.type = "button";
    pillExpandBtn.textContent = "+";
    pillExpandBtn.title = "Expand";
    pillExpandBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      width:26px; height:26px; border-radius:9px;
      background:rgba(255,255,255,0.12); color:#fff;
      font-size:16px; line-height:26px; padding:0;
    `;

    function refreshToggleUI() {
      const on = enabled();
      toggleBtn.textContent = on ? "ON" : "OFF";
      toggleBtn.style.background = on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)";
      pillText.textContent = `PF (${on ? "ON" : "OFF"})`;
    }

    function refreshPanelBullets() {
      if (!glossaryOk) { bullets.textContent = "Glossary error"; return; }
      const line1 = `• Characters: ${charactersCount}` + (charactersList3 ? ` • ${charactersList3}` : "");
      const line2 = `• Changed: ${changedTotal}`;
      bullets.textContent = `${line1}\n${line2}`;
    }

    toggleBtn.onclick = () => { setEnabled(!enabled()); refreshToggleUI(); setTimeout(() => location.reload(), 150); };
    resetBtn.onclick = () => { changedTotal = 0; refreshPanelBullets(); };

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

    refreshToggleUI();
    refreshPanelBullets();

    if (localStorage.getItem(UI_KEY_MIN) === "1") setMin(true);
    window.addEventListener("resize", () => clampToViewport(localStorage.getItem(UI_KEY_MIN) === "1" ? pill : box));

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
      addChanged: (delta) => { if (Number.isFinite(delta) && delta > 0) changedTotal += delta; refreshPanelBullets(); },
      setChanged: (n) => { changedTotal = Number.isFinite(n) ? Math.max(0, n) : 0; refreshPanelBullets(); },
      refreshUI: refreshToggleUI
    };
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
  // Main
  // ==========================================================
  (async () => {
    const ui = makeUI();
    ui.refreshUI();

    if (!ui.isEnabled()) return;

    if (!GLOSSARY_URL || /\?token=GHSAT/i.test(GLOSSARY_URL)) {
      ui.setGlossaryOk(false);
      ui.setChanged(0);
      return;
    }

    let glossary;
    try { glossary = await loadGlossaryJSON(GLOSSARY_URL); }
    catch { ui.setGlossaryOk(false); ui.setChanged(0); return; }

    const key = pickKey(glossary);
    const cfg = glossary[key] || {};
    const characters = { ...(glossary.default?.characters || {}), ...(cfg.characters || {}) };
    const entries = Object.entries(characters);

    if (!entries.length) { ui.setGlossaryOk(false); ui.setChanged(0); return; }

    ui.setGlossaryOk(true);
    ui.setCharacters(entries);

    const mode = String(cfg.mode || "paragraph").toLowerCase(); // kept for compatibility
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
      const match = bestCharacterForText(text, entries, primaryCharacter);
      if (!match) return null;
      const g = String(match.info.gender || "").toLowerCase();
      return (g === "female" || g === "male") ? g : null;
    }

    function run() {
      if (!ui.isEnabled()) return;

      const root = findContentRoot();
      const sig = makeSignature(root);
      if (sig === lastSig) return;
      lastSig = sig;

      const blocks = getTextBlocks(root);

      let lastGender = null;
      let carryLeft = 0;

      let changedThisRun = 0;

      for (const b of blocks) {
        const bt = (b.innerText || "").trim();
        if (!bt) continue;

        if (isSceneBreak(bt)) {
          lastGender = null;
          carryLeft = 0;
          continue;
        }

        // Determine base gender for carry logic (paragraph-level)
        let g = computeGenderForText(bt);
        let hadDirectMatch = !!g;

        if (!g && lastGender && carryLeft > 0 && (startsWithPronoun(bt) || pronounAppearsEarly(bt, EARLY_PRONOUN_WINDOW))) {
          g = lastGender;
          carryLeft--;
        }

        // Apply sentence-level logic regardless of paragraph gender (this is the key change)
        // (If we have a single gender sentence, it will still route through replacePronounsSmart internally.)
        changedThisRun += replaceInTextNodes(b, entries, primaryCharacter);

        if (hadDirectMatch) {
          lastGender = g;
          carryLeft = carryParagraphs;
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
