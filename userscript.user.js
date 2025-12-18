// ==UserScript==
// @name         WTR-LAB PF Test
// @namespace    https://github.com/youaremyhero/WTR-LAB-Pronouns-Fix
// @version      4.9.5
// @description  Fix gender pronouns in WTR-LAB translations using a shared glossary. Mobile-first UI, reliable counters, SPA-safe, Add Character/Term with long-press.
// @match        *://wtr-lab.com/en/novel/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";
  if (!location.hostname.endsWith("wtr-lab.com")) return;

  /* ============================
     CONFIG
  ============================ */

  const GLOSSARY_URL =
    "https://raw.githubusercontent.com/youaremyhero/WTR-LAB-Pronouns-Fix/main/glossary.template.json";

  const CACHE_KEY = "wtrpf_glossary_cache_v1";
  const CACHE_TS  = "wtrpf_glossary_cache_ts_v1";
  const CACHE_TTL = 10 * 60 * 1000;

  const UI_KEY_ON   = "wtrpf_enabled_v1";
  const UI_MODE_KEY = "wtrpf_ui_mode_v1";
  const UI_HELP_KEY = "wtrpf_ui_help_v1";

  const DRAFT_KEY = "wtrpf_draft_v1";
  const TERM_MEM_PREFIX = "wtrpf_term_mem_v1:";

  const RX_MALE   = /\b(he|him|his|himself)\b/gi;
  const RX_FEMALE = /\b(she|her|hers|herself)\b/gi;

  /* ============================
     UTIL
  ============================ */

  function normalize(s) {
    return String(s || "").replace(/\u00A0|\u2009|\u202F/g, " ");
  }

  function count(rx, text) {
    rx.lastIndex = 0;
    const m = text.match(rx);
    return m ? m.length : 0;
  }

  function caseLike(src, target) {
    if (!src) return target;
    if (src.toUpperCase() === src) return target.toUpperCase();
    if (src[0] === src[0].toUpperCase())
      return target[0].toUpperCase() + target.slice(1);
    return target.toLowerCase();
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  /* ============================
     PRONOUN ENGINE
  ============================ */

  function replacePronounsSmart(text, direction) {
    let changed = 0;
    let s = normalize(text);

    function rep(rx, to) {
      s = s.replace(rx, m => {
        changed++;
        return caseLike(m, to);
      });
    }

    if (direction === "toFemale") {
      rep(/\bhe\b/gi, "she");
      rep(/\bhimself\b/gi, "herself");
      rep(/\bhim\b/gi, "her");
      rep(/\bhis\b(?=\s+\p{L})/giu, "her");
      rep(/\bhis\b/gi, "hers");
    } else {
      rep(/\bshe\b/gi, "he");
      rep(/\bherself\b/gi, "himself");
      rep(/\bher\b(?=\s+\p{L})/giu, "his");
      rep(/\bher\b/gi, "him");
      rep(/\bhers\b/gi, "his");
    }

    return { text: s, changed };
  }

  function shouldApply(region, gender) {
    const m = count(RX_MALE, region);
    const f = count(RX_FEMALE, region);
    return gender === "female" ? m > 0 : f > 0;
  }

  /* ============================
     CONTENT DETECTION
  ============================ */

  function findContentRoot() {
    return (
      document.querySelector(".chapter-body[data-chapter-id]") ||
      document.querySelector(".chapter-body") ||
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function getBlocks(root) {
    return [...root.querySelectorAll("p, li, blockquote")]
      .filter(b => (b.innerText || "").trim().length > 20);
  }

  /* ============================
     GLOSSARY
  ============================ */

  function loadGlossary() {
    return new Promise((resolve, reject) => {
      const cached = localStorage.getItem(CACHE_KEY);
      const ts = +localStorage.getItem(CACHE_TS);
      if (cached && Date.now() - ts < CACHE_TTL) {
        try { return resolve(JSON.parse(cached)); } catch {}
      }

      GM_xmlhttpRequest({
        method: "GET",
        url: GLOSSARY_URL,
        onload(r) {
          try {
            const j = JSON.parse(r.responseText);
            localStorage.setItem(CACHE_KEY, r.responseText);
            localStorage.setItem(CACHE_TS, Date.now());
            resolve(j);
          } catch { reject(); }
        },
        onerror: reject
      });
    });
  }

  function pickNovelKey(glossary) {
    const u = location.href;
    return Object.keys(glossary).find(k => u.includes(k)) || "default";
  }

  /* ============================
     DRAFT + TERM MEMORY
  ============================ */

  function loadDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY)) || { items: [], snippet: "" };
    } catch {
      return { items: [], snippet: "" };
    }
  }

  function saveDraft(d) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  }

  function termKey(novelKey) {
    return TERM_MEM_PREFIX + novelKey;
  }

  function loadTermMemory(novelKey) {
    try {
      return JSON.parse(localStorage.getItem(termKey(novelKey)) || "{}");
    } catch {
      return {};
    }
  }

  function clearTermMemory(novelKey) {
    localStorage.removeItem(termKey(novelKey));
  }

  /* ============================
     UI (MOBILE-FIRST)
  ============================ */

  function btn(label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `
      border:0;
      border-radius:999px;
      background:rgba(255,255,255,.14);
      color:#fff;
      padding:4px 10px;
      font-size:12px;
    `;
    return b;
  }

  function ghostBtn(label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `
      border:0;
      border-radius:10px;
      background:rgba(255,255,255,.14);
      color:#fff;
      padding:8px;
      font-size:12px;
      width:100%;
      margin-top:6px;
    `;
    return b;
  }

  function makeUI(novelKey) {
    const mode = localStorage.getItem(UI_MODE_KEY) || "none";
    const helpOpen = localStorage.getItem(UI_HELP_KEY) === "1";

    const box = document.createElement("div");
    box.style.cssText = `
      position:fixed;
      bottom:12px;
      left:12px;
      width:92vw;
      max-width:420px;
      background:rgba(0,0,0,.55);
      color:#fff;
      border-radius:14px;
      padding:12px;
      font:13px system-ui;
      z-index:2147483647;
      backdrop-filter:blur(6px);
    `;

    const top = document.createElement("div");
    top.style.cssText = "display:flex;justify-content:space-between;align-items:center";

    const title = document.createElement("div");
    title.textContent = "PronounsFix";

    const ctrls = document.createElement("div");
    ctrls.style.cssText = "display:flex;gap:6px";

    const onBtn = btn("ON");
    const helpBtn = btn("?");
    const minBtn = btn("–");

    ctrls.append(onBtn, helpBtn, minBtn);
    top.append(title, ctrls);
    box.appendChild(top);

    const help = document.createElement("div");
    help.style.cssText = `display:${helpOpen ? "block" : "none"};margin-top:8px;font-size:12px`;
    help.innerHTML = `
      <b>How to use</b><br>
      • Long-press a highlighted term → Add Character / Term<br>
      • Or select text → Add Character<br>
      • Draft snippets appear below<br>
      • Term memory is saved per novel
    `;
    box.appendChild(help);

    helpBtn.onclick = () => {
      const v = help.style.display === "none";
      help.style.display = v ? "block" : "none";
      localStorage.setItem(UI_HELP_KEY, v ? "1" : "0");
    };

    const addHdr = ghostBtn("Add New Character");
    const exportHdr = ghostBtn("Export Tools");

    box.append(addHdr, exportHdr);

    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;background:rgba(255,255,255,.2);margin:8px 0;display:none";
    box.appendChild(divider);

    const addWrap = document.createElement("div");
    addWrap.style.display = "none";

    const draftBox = document.createElement("textarea");
    draftBox.readOnly = true;
    draftBox.style.cssText = `
      width:100%;
      min-height:70px;
      background:rgba(255,255,255,.08);
      color:#fff;
      border-radius:10px;
      padding:8px;
      font:12px ui-monospace;
    `;

    const copyBtn = ghostBtn("Copy JSON");
    const clearBtn = ghostBtn("Clear Draft");

    addWrap.append(draftBox, copyBtn, clearBtn);
    box.appendChild(addWrap);

    const exportWrap = document.createElement("div");
    exportWrap.style.display = "none";

    const copyDraftBtn = ghostBtn("Copy Draft JSON");
    const copyTermBtn  = ghostBtn("Copy Term Memory");
    const clearTermBtn = ghostBtn("Clear Term Memory");

    exportWrap.append(copyDraftBtn, copyTermBtn, clearTermBtn);
    box.appendChild(exportWrap);

    function setMode(m) {
      localStorage.setItem(UI_MODE_KEY, m);
      divider.style.display = m === "none" ? "none" : "block";
      addWrap.style.display = m === "add" ? "block" : "none";
      exportWrap.style.display = m === "export" ? "block" : "none";
    }

    addHdr.onclick = () => setMode("add");
    exportHdr.onclick = () => setMode("export");

    setMode(mode);

    document.body.appendChild(box);

    return {
      setChanged(n) {
        title.textContent = `PronounsFix • Changed ${n}`;
      },
      setDraft(snippet) {
        draftBox.value = snippet || "";
      },
      bindExport() {
        copyDraftBtn.onclick = () => {
          const d = loadDraft();
          if (d.snippet) copyToClipboard(d.snippet);
        };
        copyTermBtn.onclick = () => {
          const mem = loadTermMemory(novelKey);
          copyToClipboard(JSON.stringify(mem, null, 2));
        };
        clearTermBtn.onclick = () => {
          if (confirm("Clear term memory for this novel?")) {
            clearTermMemory(novelKey);
          }
        };
        copyBtn.onclick = () => {
          const d = loadDraft();
          if (d.snippet) copyToClipboard(d.snippet);
        };
        clearBtn.onclick = () => {
          saveDraft({ items: [], snippet: "" });
          draftBox.value = "";
        };
      }
    };
  }

  /* ============================
     ADD MENU (LONG PRESS)
  ============================ */

  function installLongPress(showMenu) {
    let timer = null;

    document.addEventListener("pointerdown", e => {
      const sp = e.target.closest?.("span.text-patch.system[data-hash]");
      if (!sp) return;
      timer = setTimeout(() => {
        const txt = sp.textContent.trim();
        if (!txt) return;
        showMenu({
          text: txt,
          hash: sp.getAttribute("data-hash"),
          x: e.clientX,
          y: e.clientY
        });
      }, 420);
    }, true);

    document.addEventListener("pointerup", () => {
      if (timer) clearTimeout(timer);
      timer = null;
    }, true);
  }

  /* ============================
     MAIN
  ============================ */

  (async () => {
    const glossary = await loadGlossary();
    const novelKey = pickNovelKey(glossary);
    const cfg = glossary[novelKey] || {};
    const characters = cfg.characters || {};

    const ui = makeUI(novelKey);
    ui.bindExport();

    function run() {
      const root = findContentRoot();
      let changed = 0;

      for (const b of getBlocks(root)) {
        const txt = b.innerText;
        for (const [name, info] of Object.entries(characters)) {
          if (!txt.includes(name)) continue;
          if (!info.gender) continue;
          if (!shouldApply(txt, info.gender)) continue;
          const out = replacePronounsSmart(txt, info.gender === "female" ? "toFemale" : "toMale");
          if (out.changed) {
            b.innerText = out.text;
            changed += out.changed;
          }
        }
      }

      ui.setChanged(changed);
    }

    run();

    new MutationObserver(() => {
      if (!document.hidden) run();
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener("popstate", run);

    installLongPress(ctx => {
      const d = loadDraft();
      const line = `"${ctx.text}": { "gender": "unknown" },`;
      if (!d.items.includes(line)) {
        d.items.push(line);
        d.snippet = d.items.join("\n");
        saveDraft(d);
        ui.setDraft(d.snippet);
      }
    });
  })();
})();
