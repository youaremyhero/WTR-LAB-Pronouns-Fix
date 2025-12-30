# WTR-LAB Pronouns Fix

A Tampermonkey userscript that reduces mixed-up pronouns (he/she/him/her/his/hers) in WTR-LAB machine-translated web novels by applying user-defined gender rules from a shared JSON glossary.

## Features
- ✅ Works on: `https://wtr-lab.com/en/novel/...`
- ✅ Uses a public `glossary.json` (GitHub Raw or public Gist Raw)
- ✅ Movable floating UI, minimise to a pill, ON/OFF toggle
- ✅ Paragraph-level matching (reduces collateral changes)
- ✅ Context carry-over across short paragraphs (fixes “name in previous paragraph → pronoun in next paragraph”)
- ✅ Smart capitalization (sentence start, newlines, quotes)
- ✅ Better grammar:
  - `his book` → `her book`
  - `the book is his` → `the book is hers`
  - `her book` → `his book`
  - `I saw her.` → `I saw him.`
- ✅ Robust reflexives: `himself`, `him self`, `him-self` → `herself` (and vice versa)

---

## Install (Desktop/ Mobile Firefox)
1. Install **Tampermonkey**
2. Create a new script and paste the contents of `userscript.user.js`
3. Host your glossary publicly (choose one):
   - **Public GitHub repo** containing `glossary.json`
   - **Public GitHub Gist** containing `glossary.json`
4. Copy the **RAW** URL for `glossary.json` and set it in the script:
   ```js
   const GLOSSARY_URL = "https://raw.githubusercontent.com/<user>/<repo>/main/glossary.json";
   ```
   > **IMPORTANT:** Do **not** use token URLs like `...glossary.json?token=GHSAT...`; those are temporary and will fail in automation.
5. Open a WTR-LAB chapter in Firefox and refresh.
6. Configure your glossary using `glossary.template.json` as a starting point.
7. Optional per-novel settings:
   - **carryParagraphs**: how many following paragraphs can inherit the gender from the last paragraph that mentioned the character if the next paragraph starts with a pronoun.
   - **mode**:
     - **paragraph** (recommended): best for dialogue-heavy chapters
     - **chapter**: best for single-POV chapters (combine with `forceGender` or `primaryCharacter`)
   - **forceGender**: `"female"` or `"male"` (use only if the entire novel/chapter is consistent)
---

## Safety & expectations

This script modifies text client-side in your browser only.

It is heuristic-based (best-effort). It can still be wrong in multi-POV scenes.

Use the ON/OFF toggle if a chapter has many speakers or frequent POV switches.
