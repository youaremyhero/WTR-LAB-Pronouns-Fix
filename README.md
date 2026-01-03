# WTR-LAB Pronouns Fix

WTR-LAB Pronouns Fix is a Tampermonkey userscript that reduces mixed-up pronouns
(he / she / him / her / his / hers) in WTR-LAB web novels.
It works by applying user-defined gender rules from a small JSON glossary and rewriting text locally in your browser while you read.

## Features
- ✅ Works on: `https://wtr-lab.com/en/novel/...`
- ✅️ Supports
  - Single page reader (most relaible)
  - Infinite reader mode (more prone to errors)
  - Switching reader modes automatically triggers re-processing
- ✅ Uses a public `glossary.json` (GitHub Raw or public Gist Raw) hosted by user
- ✅️ Works for ***multiple** WTR Lab novels (`glossary.json` can contain multiple novels)
- ✅ Movable floating UI, minimise to a pill, ON/OFF toggle
- ✅ Paragraph-level matching (reduces collateral changes)
- ✅ Context carry-over across short paragraphs (fixes “name in previous paragraph → pronoun in next paragraph”)
- ✅ Smart capitalization (sentence start, newlines, quotes)
- ✅ Grammar aware fixes:
  - `his book` → `her book`
  - `the book is his` → `the book is hers`
  - `her book` → `his book`
  - `I saw her.` → `I saw him.`
- ✅ Robust reflexives: `himself`, `him self`, `him-self` → `herself` (and vice versa)

---

## Install (Desktop/ Mobile Firefox)
1. Install the **Tampermonkey** browser extension.

### Supported browsers
- Desktop:  Chrome/ Edge/ Firefox
- Android: Firefox for Android or Kiwi Browser
  
  > ❌️ iOS browsers are not supported (userscripts are not allowed).

2. Install the Script from [**Greasy Fork** (Recommended)](https://greasyfork.org/en/scripts/559092-wtr-lab-pronouns-fix)
3. Open the script’s Greasy Fork page
4. Click Install this script
5. Tampermonkey will install it automatically
  
- You will receive automatic updates
- You do not need to copy, fork, or manage the script yourself

---

## Create Your Own Glossary (Required) 

Each user must host their own glossary file.
This is intentional and allows full customisation per novel.
> 💡 You do not need to fork or duplicate the script repository.

### Option A: GitHub Repository (Recommended)
1. Create a public GitHub repository
2. Add a file named: `glossary.json`
3. **Copy the contents of `glossary.template.json` into it**
4. Commit the file
   
### Option B: Public GitHub Gist
1. Create a public Gist
2. Name the file `glossary.json`
3. **Paste the template content and save**

---

## Set the Glossary URL (One-Time Setup)
1. Open your **glossary.json**
2. Click **Raw**
3. **Copy the raw URL**
Example:
> https://raw.githubusercontent.com/<user>/<repo>/main/glossary.json
4. Open **Tampermonkey**
5. **Edit** WTR-LAB Pronouns Fix
6. **Find** this line near the top:
```const GLOSSARY_URL =
  "https://raw.githubusercontent.com/youaremyhero/WTR-LAB-Pronouns-Fix/main/glossary.template.json";
```
7. **Replace it with your own raw glossary URL**
8. **Save** the script
>⚠️ **Important**
-  Do not use URLs containing `?token=GHSAT...`
-  Token URLs are temporary and will fail

**This is the only edit you need to make.**
You will still receive script updates automatically from Greasy Fork.

---

## Start Reading
1. Ensure that extension is enabled
2. Open a chapter page on wtr-lab.com
3. Refresh the page
4. The Pronouns Fix UI will appear (minimised by default)

---
   
## Using the UI
The floating panel shows:
- Detected characters
- Number of pronoun changes applied
- A Draft (JSON) helper section

---

### Adding New Characters (Optional)
1. Long-press (or select) a character name in the text
2. Choose Male or Female
3. A JSON snippet appears in the Draft box
4. Copy it into your glossary.json if you want to keep it

You can also choose to amend your `glossary.json` directly on Github, ensuring that the format is preserved.

---

## Safety & expectations

- All changes happen locally in your browser
- No data is sent anywhere
- No tracking or analytics
- Logic is heuristic-based, not AI
- Multi-POV or dialogue
