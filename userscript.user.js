// ==UserScript==
// @name         WTR PF
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.0
// @description  Fix mixed gender pronouns in WTR-LAB machine translations using a shared JSON glossary. Movable UI + minimise pill + ON/OFF toggle + auto-refresh + stable Changed counter. Adds optional upgrades (anchored fixes, verb-based window, passive voice, dialogue speaker tracking, role carry heuristic, conservative-only-if-wrong mode, strict possessives). NEW: TermMemory Assist (Add Character/Add Term from WTR terms or highlighted selection, pin preferred terms across chapters, copy-ready JSON lines, persists until Copy/Clear).
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
  // TermMemory (NEW)
  // ==========================================================
  const TERM_MEM_KEY = "wtrpf_term_memory_v1";
  const TERM_MEM_META_KEY = "wtrpf_term_memory_meta_v1"; // small meta; safe to delete

  // NOTE: If user clears browser data / site data (incl. Local Storage), TermMemory is lost.
  // Clearing “cache” alone sometimes doesn’t remove Local Storage, but “Clear site data” usually does.

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

  function nowISO() {
    try { return new Date().toISOString(); } catch { return String(Date.now()); }
  }

  function safeJSONParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  // ==========================================================
  // TermMemory store
  // ==========================================================
  function loadTermMemory() {
    const raw = localStorage.getItem(TERM_MEM_KEY);
    const data = safeJSONParse(raw, null);
    if (!data || typeof data !== "object") {
      return { items: {} };
    }
    if (!data.items || typeof data.items !== "object") data.items = {};
    return data;
  }

  function saveTermMemory(mem) {
    localStorage.setItem(TERM_MEM_KEY, JSON.stringify(mem));
    localStorage.setItem(TERM_MEM_META_KEY, JSON.stringify({ updatedAt: nowISO() }));
  }

  function termKeyFrom(hash, text) {
    if (hash) return `hash:${hash}`;
    const t = String(text || "").trim();
    return `text:${t.toLowerCase()}`;
  }

  // ==========================================================
  // Smart pronoun replacement (existing engine)
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
      "article, main, .content, .chapter, .chapter-content, .reader, .novel, .novel-content, section, .chapter-body"
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
    ".menu",".navbar",".nav",".btn",".button",
    ".mini-term-editor" // avoid interacting with WTR editor directly
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
  // TreeWalker text node replacer
  // ==========================================================
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
  // Character detection on current chapter/page (existing)
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
  // Term detection: WTR terms (NEW)
  // ==========================================================
  function collectWtrTerms(root) {
    // Returns Map hash -> text (preferred as currently displayed)
    const map = new Map();
    if (!root) return map;
    const nodes = root.querySelectorAll(".text-patch.system[data-hash]");
    nodes.forEach(el => {
      const h = el.getAttribute("data-hash") || "";
      const t = (el.textContent || "").trim();
      if (h && t) map.set(h, t);
    });
    return map;
  }

  // ==========================================================
  // Consistency enforcement: pinned terms (NEW)
  // ==========================================================
  function enforcePinnedTerms(root, mem, stats) {
    if (!root || !mem || !mem.items) return;

    // 1) Hash-based: update .text-patch by hash (most reliable)
    const wtrMap = collectWtrTerms(root);
    for (const [k, item] of Object.entries(mem.items)) {
      if (!item || !item.pinned) continue;
      if (!k.startsWith("hash:")) continue;

      const hash = k.slice("hash:".length);
      const preferred = String(item.preferred || "").trim();
      if (!hash || !preferred) continue;

      // If WTR term exists in this chapter, force its display text
      // (also collects variants passively)
      const current = wtrMap.get(hash);
      if (current && current !== preferred) {
        const els = root.querySelectorAll(`.text-patch.system[data-hash="${CSS.escape(hash)}"]`);
        els.forEach(el => {
          if ((el.textContent || "").trim() !== preferred) {
            el.textContent = preferred;
            stats.termEdits++;
          }
        });
      }
    }

    // 2) Plain-text fallback: replace known variants -> preferred for pinned entries
    // Conservative: only for pinned; uses variants list.
    const pinned = Object.values(mem.items).filter(it => it && it.pinned && it.preferred);
    if (!pinned.length) return;

    const blocks = getTextBlocks(root);
    for (const b of blocks) {
      replaceInTextNodes(b, (txt) => {
        let s = txt;
        for (const it of pinned) {
          const preferred = String(it.preferred || "").trim();
          if (!preferred) continue;

          const variants = Array.isArray(it.variants) ? it.variants : [];
          for (const v of variants) {
            const vv = String(v || "").trim();
            if (!vv || vv === preferred) continue;

            // Very short variants are risky; skip unless explicitly long or multi-word
            const riskyShort = vv.length <= 3 && !/\s/.test(vv);
            if (riskyShort) continue;

            // Word-boundary if "wordy", else simple replace
            if (/^[\p{L}\p{N}_'-]+$/u.test(vv)) {
              const re = new RegExp(String.raw`\b${escapeRegExp(vv)}\b`, "g");
              s = s.replace(re, preferred);
            } else {
              // phrase variant
              s = s.split(vv).join(preferred);
            }
          }
        }
        return { text: s, changed: 0 };
      });
    }
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
  // UI + TermMemory Assist (NEW)
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

    // TermMemory UI state
    let draftCount = 0;
    let draftLines = "";
    const sessionHighlights = new Set(); // keys added during this chapter session (for visual emphasis)

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
         - Reduced opacity by ~20%
         ============================ */
      background: rgba(0,0,0,0.50);

      color: #fff;
      border-radius: 12px;
      padding: 10px 12px;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 28px rgba(0,0,0,.25);

      /* ============================
         EDIT HERE: Expanded width cap
         - Slightly narrower than before
         - Height auto (grows with content)
         ============================ */
      max-width: min(460px, 86vw);
      height: auto;

      backdrop-filter: blur(6px);
      user-select: none;
      touch-action: none;
    `;

    // Minimised pill container
    const pill = document.createElement("div");
    pill.style.cssText = `
      display:none; position: fixed; z-index: 2147483647;

      /* ============================
         EDIT HERE: Minimised opacity
         - Reduced opacity by ~40%
         ============================ */
      background: rgba(0,0,0,0.37);

      color:#fff;
      border-radius: 999px;

      /* ============================
         EDIT HERE: Minimised size
         - Smaller padding + font
         ============================ */
      padding: 4px 6px;
      font: 11px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;

      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      backdrop-filter: blur(6px);
      user-select: none;
      touch-action: none;

      /* Slightly narrower cap */
      max-width: min(380px, 84vw);
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

    // --- Layout requested: info row -> divider -> copy/clear -> draft count
    const info = document.createElement("div");
    info.style.cssText = `white-space: pre-line; opacity: .95; margin-bottom: 8px;`;

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px; background: rgba(255,255,255,0.14); margin: 8px 0;`;

    const draftLabel = document.createElement("div");
    draftLabel.textContent = "Draft (copy to update glossary.json later):";
    draftLabel.style.cssText = `font-weight:600; font-size:12px; margin: 4px 0 6px;`;

    const draftBox = document.createElement("textarea");
    draftBox.readOnly = true;
    draftBox.spellcheck = false;
    draftBox.style.cssText = `
      width: 100%;
      min-height: 78px;
      max-height: 200px;
      resize: vertical;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      outline: none;
    `;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = `display:flex; gap:8px; align-items:center; margin-top: 8px;`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy JSON";
    copyBtn.title = "Copy draft lines and clear (per your preference)";
    copyBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.14); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Clear draft (TermMemory)";
    clearBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.10); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const draftCountEl = document.createElement("div");
    draftCountEl.style.cssText = `opacity:.85; margin-top: 8px;`;
    draftCountEl.textContent = "Drafted: 0";

    // Min pill row
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

    // Modal (Add Character / Add Term)
    const modal = document.createElement("div");
    modal.style.cssText = `
      display:none; position: fixed; z-index: 2147483647;
      right: 12px; top: 64px;
      max-width: min(420px, 90vw);
      background: rgba(0,0,0,0.72);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 14px;
      box-shadow: 0 18px 40px rgba(0,0,0,.35);
      padding: 10px 12px;
      backdrop-filter: blur(8px);
      user-select: none;
      touch-action: none;
    `;

    const modalTitle = document.createElement("div");
    modalTitle.style.cssText = `font-weight:700; margin-bottom:6px;`;
    modalTitle.textContent = "Add to PronounsFix";

    const modalSub = document.createElement("div");
    modalSub.style.cssText = `opacity:.9; margin-bottom:10px; word-break: break-word;`;

    const modalStep = document.createElement("div");
    modalStep.style.cssText = `display:flex; flex-direction:column; gap:10px;`;

    // Step 1 buttons
    const step1 = document.createElement("div");
    step1.style.cssText = `display:flex; gap:8px; flex-wrap:wrap;`;

    const addCharBtn = document.createElement("button");
    addCharBtn.type = "button";
    addCharBtn.textContent = "Add Character";
    addCharBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 8px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.16); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const addTermBtn = document.createElement("button");
    addTermBtn.type = "button";
    addTermBtn.textContent = "Add Term";
    addTermBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 8px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.10); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    // Step 2 (dynamic)
    const step2 = document.createElement("div");
    step2.style.cssText = `display:none; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 10px;`;

    const nameRow = document.createElement("div");
    nameRow.style.cssText = `display:flex; flex-direction:column; gap:6px;`;

    const nameLabel = document.createElement("div");
    nameLabel.style.cssText = `font-weight:600;`;
    nameLabel.textContent = "Preferred name / term";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    nameInput.style.cssText = `
      width:100%;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.06);
      color: #fff;
      outline: none;
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const toggleRow = document.createElement("div");
    toggleRow.style.cssText = `display:flex; align-items:center; gap:10px; flex-wrap:wrap;`;

    const pinWrap = document.createElement("label");
    pinWrap.style.cssText = `display:flex; align-items:center; gap:8px; cursor:pointer; opacity:.95;`;

    const pinCb = document.createElement("input");
    pinCb.type = "checkbox";
    pinCb.checked = true;

    const pinText = document.createElement("span");
    pinText.textContent = "Pin term (enforce across chapters)";

    pinWrap.appendChild(pinCb);
    pinWrap.appendChild(pinText);

    const genderRow = document.createElement("div");
    genderRow.style.cssText = `display:none; align-items:center; gap:8px; flex-wrap:wrap;`;

    const genderLabel = document.createElement("div");
    genderLabel.style.cssText = `font-weight:600; margin-right:4px;`;
    genderLabel.textContent = "Select gender:";

    const gMale = document.createElement("button");
    gMale.type = "button";
    gMale.textContent = "Male";
    gMale.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.14); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const gFemale = document.createElement("button");
    gFemale.type = "button";
    gFemale.textContent = "Female";
    gFemale.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.14); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const gUnknown = document.createElement("button");
    gUnknown.type = "button";
    gUnknown.textContent = "Unknown";
    gUnknown.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 7px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.08); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const actionRow = document.createElement("div");
    actionRow.style.cssText = `display:flex; gap:8px; margin-top: 10px;`;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 8px 10px; border-radius: 10px;
      background: rgba(76,175,80,0.18); color:#fff;
      border: 1px solid rgba(76,175,80,0.28);
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      appearance:none; border:0; cursor:pointer;
      padding: 8px 10px; border-radius: 10px;
      background: rgba(255,255,255,0.10); color:#fff;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    `;

    // Modal assembly
    step1.appendChild(addCharBtn);
    step1.appendChild(addTermBtn);

    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);

    genderRow.appendChild(genderLabel);
    genderRow.appendChild(gMale);
    genderRow.appendChild(gFemale);
    genderRow.appendChild(gUnknown);

    toggleRow.appendChild(pinWrap);

    actionRow.appendChild(saveBtn);
    actionRow.appendChild(cancelBtn);

    step2.appendChild(nameRow);
    step2.appendChild(genderRow);
    step2.appendChild(toggleRow);
    step2.appendChild(actionRow);

    modalStep.appendChild(step1);
    modalStep.appendChild(step2);

    modal.appendChild(modalTitle);
    modal.appendChild(modalSub);
    modal.appendChild(modalStep);

    function refreshToggleUI() {
      const on = enabled();
      toggleBtn.textContent = on ? "ON" : "OFF";
      toggleBtn.style.background = on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)";
      pillText.textContent = `PF (${on ? "ON" : "OFF"})`;
    }

    function refreshInfo() {
      if (!glossaryOk) {
        info.textContent = "Glossary error";
        return;
      }
      const line1 = `• Characters: ${charactersCount}` + (charactersList3 ? ` • ${charactersList3}` : "");
      const line2 = `• Changed: ${changedTotal}`;
      info.textContent = `${line1}\n${line2}`;
    }

    function renderDraftFromMemory() {
      const mem = loadTermMemory();
      const items = mem.items || {};

      // Copy output format (your requested “easy paste” lines):
      // "Li Zhi": { "gender": "male" },
      // Keep characters-only here, since glossary characters live under "characters".
      const charLines = [];
      let count = 0;

      for (const it of Object.values(items)) {
        if (!it || it.type !== "character") continue;
        const name = String(it.preferred || "").trim();
        if (!name) continue;

        const g = String(it.gender || "unknown").toLowerCase();
        if (g === "male" || g === "female") {
          charLines.push(`"${name}": { "gender": "${g}" },`);
        } else {
          // If unknown, still output (optional). You can delete later.
          charLines.push(`"${name}": { "gender": "unknown" },`);
        }
        count++;
      }

      draftCount = count;
      draftLines = charLines.join("\n");
      draftBox.value = draftLines;
      draftCountEl.textContent = `Drafted: ${draftCount}`;
    }

    async function copyDraftAndClear() {
      const text = (draftBox.value || "").trim();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for stricter pages
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }

      // Per your preference: keep until Copy or Clear -> Copy clears as well
      clearTermMemory();
    }

    function clearTermMemory() {
      saveTermMemory({ items: {} });
      renderDraftFromMemory();
    }

    toggleBtn.onclick = () => {
      setEnabled(!enabled());
      refreshToggleUI();
      setTimeout(() => location.reload(), 150);
    };

    resetBtn.onclick = () => {
      changedTotal = 0;
      refreshInfo();
    };

    copyBtn.onclick = () => { copyDraftAndClear(); };
    clearBtn.onclick = () => { clearTermMemory(); };

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
      modal.style.display = "none";
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

    // Expanded layout
    box.appendChild(topRow);
    box.appendChild(info);
    box.appendChild(divider);
    box.appendChild(draftLabel);
    box.appendChild(draftBox);
    box.appendChild(btnRow);
    box.appendChild(draftCountEl);

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(clearBtn);

    // Min pill
    pillRow.appendChild(pillText);
    pillRow.appendChild(pillExpandBtn);
    pill.appendChild(pillRow);

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(pill);
    document.documentElement.appendChild(modal);

    refreshToggleUI();
    refreshInfo();
    renderDraftFromMemory();

    if (localStorage.getItem(UI_KEY_MIN) === "1") setMin(true);

    window.addEventListener("resize", () => {
      clampToViewport(localStorage.getItem(UI_KEY_MIN) === "1" ? pill : box);
    });

    // ------------------------------
    // TermMemory Assist: modal logic
    // ------------------------------
    const modalState = {
      source: null,   // { hash, rawText, kind: "wtrTerm"|"selection" }
      mode: null,     // "character"|"term"
      gender: "unknown"
    };

    function openModal(source) {
      // Only open when expanded (keeps UX cleaner)
      if (localStorage.getItem(UI_KEY_MIN) === "1") setMin(false);

      modalState.source = source;
      modalState.mode = null;
      modalState.gender = "unknown";

      // Step 1 visible, step 2 hidden
      step2.style.display = "none";
      addCharBtn.disabled = false;
      addTermBtn.disabled = false;

      // Default input is the selected/term text, but user can expand it (e.g. Energetic -> full name)
      const raw = String(source?.rawText || "").trim();
      nameInput.value = raw;

      // Position modal near main box
      try {
        const r = box.getBoundingClientRect();
        modal.style.left = (r.left) + "px";
        modal.style.top = (r.bottom + 8) + "px";
        modal.style.right = "auto";
      } catch {}

      modalSub.textContent = raw ? `Selected: ${raw}` : "Selected: (empty)";
      modal.style.display = "block";
      clampToViewport(modal);
    }

    function closeModal() {
      modal.style.display = "none";
      modalState.source = null;
      modalState.mode = null;
      modalState.gender = "unknown";
    }

    function setMode(mode) {
      modalState.mode = mode;
      step2.style.display = "block";

      // Character mode shows gender, Term mode hides it
      if (mode === "character") {
        genderRow.style.display = "flex";
        pinCb.checked = true; // recommended default ON for character names consistency
      } else {
        genderRow.style.display = "none";
        pinCb.checked = true; // still useful for equipment/skills
      }
    }

    addCharBtn.onclick = () => setMode("character");
    addTermBtn.onclick = () => setMode("term");

    function pickGender(g) {
      modalState.gender = g;
      // Small visual feedback
      const on = "rgba(255,255,255,0.22)";
      const off = "rgba(255,255,255,0.14)";
      gMale.style.background = (g === "male") ? on : off;
      gFemale.style.background = (g === "female") ? on : off;
      gUnknown.style.background = (g === "unknown") ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)";
    }

    gMale.onclick = () => pickGender("male");
    gFemale.onclick = () => pickGender("female");
    gUnknown.onclick = () => pickGender("unknown");

    cancelBtn.onclick = () => closeModal();

    function highlightCurrentChapterKey(key) {
      sessionHighlights.add(key);

      const root = findContentRoot();
      if (!root) return;

      if (key.startsWith("hash:")) {
        const hash = key.slice("hash:".length);
        const els = root.querySelectorAll(`.text-patch.system[data-hash="${CSS.escape(hash)}"]`);
        els.forEach(el => {
          el.style.textShadow = "0 0 10px rgba(76,175,80,0.55)";
          el.style.outline = "1px solid rgba(76,175,80,0.40)";
          el.style.borderRadius = "6px";
          el.style.padding = "0 2px";
        });
      }
      // Note: for plain-text selections (no hash), we keep it conservative and do not wrap text nodes.
      // It avoids breaking WTR DOM / line structures.
    }

    function addToTermMemory({ type, hash, rawText, preferred, gender, pinned }) {
      const mem = loadTermMemory();
      const items = mem.items || {};
      mem.items = items;

      const key = termKeyFrom(hash, rawText);
      const pref = String(preferred || rawText || "").trim();
      if (!pref) return null;

      const existing = items[key] || null;

      // Build/merge
      const out = {
        type: type,
        gender: type === "character" ? String(gender || "unknown").toLowerCase() : undefined,
        preferred: pref,
        pinned: !!pinned,
        variants: [],
        createdAt: existing?.createdAt || nowISO(),
        updatedAt: nowISO(),
        hash: hash || existing?.hash || undefined
      };

      // Variants: always include the raw text if different
      const vset = new Set(Array.isArray(existing?.variants) ? existing.variants : []);
      const raw = String(rawText || "").trim();
      if (raw && raw !== pref) vset.add(raw);

      // If existing preferred differs, keep old preferred as variant
      if (existing?.preferred && existing.preferred !== pref) vset.add(existing.preferred);

      out.variants = Array.from(vset).filter(Boolean).slice(0, 60);

      items[key] = out;
      saveTermMemory(mem);

      highlightCurrentChapterKey(key);
      renderDraftFromMemory();
      return out;
    }

    saveBtn.onclick = () => {
      if (!modalState.source) return;

      const preferred = String(nameInput.value || "").trim();
      if (!preferred) return;

      const type = modalState.mode;
      if (type !== "character" && type !== "term") return;

      const src = modalState.source;
      addToTermMemory({
        type,
        hash: src.hash || null,
        rawText: src.rawText || "",
        preferred,
        gender: modalState.gender || "unknown",
        pinned: !!pinCb.checked
      });

      closeModal();
    };

    // Public hooks for main loop
    return {
      // existing hooks
      isEnabled: () => enabled(),
      setGlossaryOk: (ok) => { glossaryOk = !!ok; refreshInfo(); },
      setCharacters: (entries) => {
        charactersCount = entries.length;
        const names = entries.slice(0, MAX_NAMES_SHOWN).map(([name, info]) => {
          const g = String(info.gender || "").toLowerCase();
          const label = (g === "female" || g === "male") ? g : "unknown";
          return `${name} (${label})`;
        });
        charactersList3 = names.join(", ") + (entries.length > MAX_NAMES_SHOWN ? " …" : "");
        refreshInfo();
      },
      addChanged: (delta) => {
        if (Number.isFinite(delta) && delta > 0) changedTotal += delta;
        refreshInfo();
      },
      refreshUI: refreshToggleUI,

      // NEW hooks
      openTermModal: openModal,
      closeTermModal: closeModal,
      renderDraft: renderDraftFromMemory
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

      // NEW optional upgrades (defaults ON for consistency; set false per novel if needed)
      termMemoryAssist: upgrades.termMemoryAssist !== false,
      enforcePinnedTermsOnPlainText: upgrades.enforcePinnedTermsOnPlainText !== false
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

    // ------------------------------
    // TermMemory Assist triggers (NEW)
    // ------------------------------
    function selectionWithinRoot(root) {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0) return null;
      const text = String(sel.toString() || "").trim();
      if (!text) return null;

      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el = container.nodeType === 1 ? container : container.parentElement;
      if (!el) return null;
      if (!root.contains(el)) return null;
      if (isSkippable(el)) return null;
      return text;
    }

    function attachTermMemoryHandlers() {
      if (!U.termMemoryAssist) return;

      document.addEventListener("click", (e) => {
        // Only show when:
        // 1) clicking a WTR-identified term (.text-patch.system[data-hash])
        // OR
        // 2) user has highlighted selection (mouseup+click on content)
        const root = findContentRoot();
        if (!root) return;
        if (!root.contains(e.target)) return;
        if (isSkippable(e.target)) return;

        const termEl = e.target.closest?.(".text-patch.system[data-hash]");
        if (termEl) {
          const hash = termEl.getAttribute("data-hash") || "";
          const rawText = (termEl.textContent || "").trim();
          if (rawText) {
            ui.openTermModal({ kind: "wtrTerm", hash, rawText });
          }
          return;
        }

        const selText = selectionWithinRoot(root);
        if (selText) {
          // Only open for “real” highlights (avoid 1-char noise)
          if (selText.trim().length >= 2) {
            ui.openTermModal({ kind: "selection", hash: null, rawText: selText });
          }
        }
      }, true);
    }

    attachTermMemoryHandlers();

    function run() {
      if (!ui.isEnabled()) return;

      const root = findContentRoot();
      const sig = makeSignature(root);
      if (sig === lastSig) return;
      lastSig = sig;

      // Always update “detected characters” chapter-by-chapter (fixes your stale count issue)
      const detectedEntries = detectCharactersOnPage(root, entries);
      ui.setCharacters(detectedEntries.length ? detectedEntries : entries);

      // Enforce pinned terms / consistency before pronoun logic
      const memStats = { termEdits: 0 };
      if (U.enforcePinnedTermsOnPlainText) {
        const mem = loadTermMemory();
        enforcePinnedTerms(root, mem, memStats);
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
          if (U.onlyChangeIfWrong) {
            doFull = conservativeShouldApply(bt, g);
          }

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
      ui.renderDraft(); // keep the draft UI synced (in case user opened other tab / etc)
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
