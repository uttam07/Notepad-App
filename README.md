# Steno — quiet notepad

A zero-install, browser-only notepad with tabs, autosave, find/replace,
syntax highlighting (HTML/CSS/JS/JSON/Markdown), live color chips,
focus mode, command palette, and **Smart Memory** — ask your notes
anything, e.g. "What was the API endpoint I noted three months ago?".

Word wrap and line numbers work together: the gutter measures how tall each
logical line renders once wrapped and pins its number to that line's first
visual row, the way a code editor does.

## Run it
Just open `index.html` in any modern browser. No build, no server, no dependencies.

Optional dev server:
    python3 -m http.server 8000    →  http://localhost:8000

## Desktop app (one click)
**Standalone .exe (recommended):** `dist/Steno.exe` — under **1 MB**,
double-click and go. It's a native WebView2 shell (uses the Chromium
engine already built into Windows 10/11), so it runs fast and smooth
with no installs, no server, and full offline support. Notes are stored
in the app's own local data (`%LOCALAPPDATA%\Steno`), separate from the
browser version.

Rebuild it after changing code — no Node.js needed:
    build-exe.bat        # → dist\Steno.exe  (uses the C# compiler built into Windows)

(An 80 MB Electron portable build is also configured for reference:
`npm install && npm run dist` — the WebView2 exe above is the
lightweight default.)

**Launcher:** double-click `Steno.bat` — it opens Steno in its own
chromeless window via Chrome/Edge app mode. Right-click it to
**Pin to Start** or create a desktop shortcut.

**Installable PWA:** serve the folder once (`python -m http.server 8000`),
open http://localhost:8000 in Chrome/Edge, then click the install icon in
the address bar (or ⋮ → "Install Steno…"). After that, Steno lives in your
Start Menu, opens in its own window, and works fully offline. The service
worker serves the app shell network-first, so updates land on the next
launch while cached copies keep it working offline.

## Your data is safe
- **Export a backup** — command palette → *Export all notes — backup .json*.
  Restore any time with *Import notes from a backup…* (duplicates are skipped,
  so re-importing is always safe). There's also *Export all notes as Markdown*
  for a portable, readable copy.
- **Undo a close** — closing a tab shows an **Undo** button, and `Ctrl+Shift+T`
  reopens the last closed note. Steno keeps the last 20 closed notes.
- **Storage warnings** — browsers cap local storage (~5 MB). If it fills up,
  Steno stops pretending: the status bar turns red with *"Not saved — storage
  full"* and a warning offers a one-click backup. It recovers automatically
  once space is freed.

## Smart features
All of these run **entirely on your device** — no AI service, no network calls,
no extra download weight.

- **Smart Memory** (`Ctrl+M`) — ask your notes in plain language
  ("API endpoint from 3 months ago", "email from last month"). Steno indexes
  URLs, emails, API endpoints, code blocks, `#tags` and `@mentions`, and
  understands relative dates. Quick chips cover Links, Emails, APIs, Recent,
  Hashtags, Code and **Forgotten** (notes untouched for 14+ days).
- **Note insights** (`Ctrl+I`) — an extractive **summary** of the current note,
  rule-based **writing hints** (typos, repeated words, punctuation spacing,
  overly long sentences), **suggested tags**, and every entity detected in the
  note. Click any hint to jump straight to it in the editor.
- **Auto tags** — a suggestion bar above the editor proposes `#tags` from the
  note's own keywords. One click appends the tag to the note's tag line.
- **Pinned notes** — hover a tab and click the thumbtack to keep it at the
  front of the tab bar (pinned tabs show a solid pin and a bolder title).
  Pinned notes are never listed as "forgotten".

Writing hints and tag suggestions deliberately ignore text inside code blocks,
inline code, HTML markup, URLs and email addresses — and are skipped entirely
for notes detected as HTML/CSS/JS/JSON.

## Structure
    index.html          markup
    css/style.css       themes, tokens, layout
    js/highlighter.js   syntax engine (standalone, exposes StenoHighlight)
    js/app.js           notes, tabs, autosave, find, save-as, UI

## Shortcuts
| Keys            | Action                |
|-----------------|-----------------------|
| Ctrl+Alt+N      | New note              |
| Ctrl+F / Ctrl+H | Find / Replace        |
| Ctrl+K          | Command palette       |
| Ctrl+M          | Smart Memory          |
| Ctrl+I          | Note insights         |
| Ctrl+Shift+T    | Restore closed note   |
| Ctrl+S          | Confirm save          |
| Ctrl+Shift+S    | Save As…              |
| Ctrl+Plus/Minus | Zoom text             |
| Tab             | Indent                |
| ?               | Help panel            |

Notes persist in localStorage (per browser). Use **Open** to load a file —
it stays linked, and every change is written back to that file automatically
(Ctrl+S forces it). Closing a tab with unsaved content asks first.

## Extend
- Add a language: define a rule set in `js/highlighter.js` and register it
  in `render()` + `detect()`, then add an `<option>` in `index.html`.
- Token colors live in `css/style.css` under `:root` (paper) and `body[data-theme="night"]`.