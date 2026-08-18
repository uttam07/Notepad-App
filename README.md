# Steno — quiet notepad

A zero-install, browser-only notepad with tabs, autosave, find/replace,
syntax highlighting (HTML/CSS/JS/JSON/Markdown), live color chips,
focus mode, command palette, and **Smart Memory** — ask your notes
anything, e.g. "What was the API endpoint I noted three months ago?".

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
Start Menu, opens in its own window, and works fully offline.

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