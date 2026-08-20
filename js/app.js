/* ============================================================
   Steno — app logic: notes, tabs, autosave, find, save-as, UI
   Depends on: js/highlighter.js (window.StenoHighlight)
   ============================================================ */
(() => {
"use strict";
/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const app=$("app"), editor=$("editor"), hl=$("hl"), gutter=$("gutter"), shell=$("shell"), tabsEl=$("tabs"), tagSuggestions=$("tagSuggestions");
const LS_NOTES = "steno.notes.v1", LS_UI = "steno.ui.v1";
const FONTMAP = {mono:'"IBM Plex Mono",ui-monospace,monospace', serif:'"Lora",Georgia,serif', sans:'"Public Sans",system-ui,sans-serif'};
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* ---------- state ---------- */
let notes = [], activeId = null, trash = [];
let ui = {theme:"paper", font:"mono", size:16, wrap:true, numbers:false, cs:false};
let saveTimer = null, lastLineCount = -1, typing = false, typeTimer = null, hlPending = false;

let saveBlocked = false;
function persist(){
  try{
    localStorage.setItem(LS_NOTES, JSON.stringify({notes: notes.map(n => { const {handle, _tags, ...rest} = n; return rest; }), activeId, trash}));
    if(saveBlocked){ saveBlocked = false; setSave("saved"); toast("Storage recovered — saving again","ok"); }
    return true;
  }catch(e){
    if(!saveBlocked){ saveBlocked = true; setSave("error"); onStorageFull(); }
    return false;
  }
}
function persistUI(){ try{ localStorage.setItem(LS_UI, JSON.stringify(ui)) }catch(e){} }
function load(){
  try{ const d = JSON.parse(localStorage.getItem(LS_NOTES)); if(d && Array.isArray(d.notes)){ notes = d.notes; notes.forEach(n => { delete n._tags; }); activeId = d.activeId; if(Array.isArray(d.trash)) trash = d.trash; sortPinned(); } }catch(e){}
  try{ const u = JSON.parse(localStorage.getItem(LS_UI)); if(u) ui = {...ui, ...u}; }catch(e){}
}
const getNote = id => notes.find(n => n.id === id);
const getActive = () => getNote(activeId);
const isDirty = n => !!n && (n.content||"").length > 0 && (!n.savedToDisk || n.content !== n.lastSavedContent);
function updateDirty(n){
  const el = n && tabsEl.querySelector(`.tab[data-id="${n.id}"]`);
  if(el) el.classList.toggle("dirty", isDirty(n));
}

/* ---------- toasts ---------- */
function toast(msg, type="", action){
  const t = document.createElement("div"); t.className = "toast " + type;
  const span = document.createElement("span"); span.textContent = msg; t.appendChild(span);
  let life = 2400;
  if(action){
    life = 7000;
    const b = document.createElement("button");
    b.className = "toast-act"; b.textContent = action.label;
    b.onclick = () => { t.remove(); action.run(); };
    t.appendChild(b);
  }
  $("toasts").appendChild(t); requestAnimationFrame(() => t.classList.add("in"));
  t.style.setProperty("--tlife", life + "ms");
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, life);
  return t;
}

/* ---------- save indicator ---------- */
function setSave(state){
  $("saveDot").classList.toggle("saving", state === "saving");
  $("saveDot").classList.toggle("failed", state === "error");
  const tx = $("saveTxt");
  tx.classList.toggle("failed", state === "error");
  tx.textContent = state === "saving" ? "Saving…" : state === "error" ? "Not saved — storage full" : "Saved";
  if(state === "saved"){ tx.classList.add("saved-flash"); setTimeout(() => tx.classList.remove("saved-flash"), 900); }
}
function onStorageFull(){
  toast("Storage is full — your notes are NOT being saved. Export a backup now.", "warn",
    {label:"Export backup", run: exportBackup});
}
function scheduleSave(){ setSave("saving"); clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
  const n = getActive();
  const okLocal = persist();
  if(n && n.handle){
    commitCurrent();
    try{
      if(await writeHandle(n)){
        n.lastSavedContent = n.content; n.savedToDisk = true;
        updateDirty(n); persist();
        if(!saveBlocked){ setSave("saved"); $("saveTxt").textContent = "Saved · " + (n.fileName || "file"); }
        return;
      }
    }catch(e){ /* fall through to local save state */ }
  }
  if(okLocal) setSave("saved");
}, 550); }

/* ---------- highlighting bridge ---------- */
function effectiveLang(){
  const n = getActive(); if(!n) return "plain";
  if(n.lang && n.lang !== "auto") return n.lang;
  return StenoHighlight.detect(editor.value);
}
function updateHighlight(){
  const n = getActive();
  if(!n){ hl.innerHTML = ""; $("statLang").textContent = "—"; return; }
  const lang = effectiveLang();
  hl.innerHTML = StenoHighlight.render(editor.value, lang) + "\n";
  hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft;
  $("statLang").textContent = lang.toUpperCase();
}
function requestHL(){ if(hlPending) return; hlPending = true; requestAnimationFrame(() => { hlPending = false; updateHighlight(); }); }

/* ---------- tabs ---------- */
function autoTitle(n){
  if(n.custom) return;
  const line = (n.content||"").split("\n").map(s => s.replace(/^#+\s*/,"").replace(/<[^>]*>/g,"").trim()).find(Boolean) || "";
  const t = line.length > 26 ? line.slice(0,26) + "…" : line;
  if(t !== n.title){ n.title = t || "Untitled"; const el = tabsEl.querySelector(`.tab[data-id="${n.id}"] .t-title`); if(el) el.textContent = n.title; }
}
function renderTabs(){
  tabsEl.querySelectorAll(".tab").forEach(t => t.remove());
  const frag = document.createDocumentFragment();
  notes.forEach(n => {
    const t = document.createElement("div");
    t.className = "tab" + (n.id === activeId ? " active" : "") + (isDirty(n) ? " dirty" : "") + (n.pinned ? " pinned" : ""); t.dataset.id = n.id; t.draggable = true;
    t.title = `${n.title} · ${(n.content||"").length.toLocaleString()} chars`;
    t.innerHTML = `<button class="t-pin" title="${n.pinned ? "Unpin this note" : "Pin this note"}" aria-pressed="${!!n.pinned}"><svg viewBox="0 0 24 24"><path d="M9 3.5h6M10.5 3.5v6l-3 4.5h9l-3-4.5v-6M12 14v6.5"/></svg></button>
      <span class="t-title">${esc(n.title||"Untitled")}</span>
      <button class="t-x" title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    t.addEventListener("click", e => { if(!e.target.closest(".t-x") && !e.target.closest(".t-pin")) switchNote(n.id); });
    t.querySelector(".t-x").addEventListener("click", e => { e.stopPropagation(); requestClose(n.id); });
    t.querySelector(".t-pin").addEventListener("click", e => { e.stopPropagation(); togglePin(n); });
    t.addEventListener("dblclick", e => { if(!e.target.closest(".t-x") && !e.target.closest(".t-pin")) startRename(t, n); });
    t.addEventListener("dragstart", e => { t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", n.id); });
    t.addEventListener("dragend", () => { t.classList.remove("dragging"); clearDropMarks(); });
    t.addEventListener("dragover", e => { e.preventDefault(); clearDropMarks();
      const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width/2 ? "drop-l" : "drop-r"); });
    t.addEventListener("drop", e => { e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain"); if(!fromId || fromId === n.id) return;
      const r = t.getBoundingClientRect(), before = e.clientX < r.left + r.width/2;
      const fi = notes.findIndex(x => x.id === fromId); const [moved] = notes.splice(fi, 1);
      let ti = notes.findIndex(x => x.id === n.id); if(!before) ti += 1; notes.splice(ti, 0, moved);
      sortPinned();
      clearDropMarks(); renderTabs(); persist(); });
    frag.appendChild(t);
  });
  tabsEl.appendChild(frag);
  const act = tabsEl.querySelector(".tab.active"); if(act) act.scrollIntoView({inline:"nearest", block:"nearest"});
}
function clearDropMarks(){ tabsEl.querySelectorAll(".drop-l,.drop-r").forEach(x => x.classList.remove("drop-l","drop-r")); }
function sortPinned(){
  const pinned = notes.filter(x => x.pinned), rest = notes.filter(x => !x.pinned);
  if(pinned.length && pinned.length < notes.length){ notes.length = 0; notes.push(...pinned, ...rest); }
}
function togglePin(n){
  n.pinned = !n.pinned;
  sortPinned();
  renderTabs(); persist();
}
function startRename(tabEl, n){
  const span = tabEl.querySelector(".t-title"); if(!span) return;
  const inp = document.createElement("input"); inp.className = "t-edit"; inp.value = n.title || ""; inp.maxLength = 60;
  span.replaceWith(inp); inp.focus(); inp.select();
  const commit = () => { const v = inp.value.trim(); n.title = v || "Untitled"; n.custom = !!v; renderTabs(); persist(); };
  inp.addEventListener("keydown", e => { if(e.key === "Enter") inp.blur(); if(e.key === "Escape"){ inp.value = n.title; inp.blur(); } e.stopPropagation(); });
  inp.addEventListener("blur", commit);
  inp.addEventListener("click", e => e.stopPropagation());
}

/* ---------- note lifecycle ---------- */
function commitCurrent(){
  const n = getActive(); if(!n) return;
  if(n.content !== editor.value){ n.content = editor.value; n.updated = Date.now(); autoTitle(n); updateDirty(n); n._tags = null; }
}
function newNote(opts = {}){
  finishTyping(); commitCurrent();
  const n = {id:uid(), title:opts.title||"", custom:!!opts.title, content:opts.content||"", lang:opts.lang||"auto", updated:Date.now()};
  if(!n.title) n.title = "Untitled";
  notes.push(n); activeId = n.id; renderTabs(); loadEditor(); persist(); reindexMemory(); editor.focus();
  if(!opts.silent) toast("Fresh page ready","ok");
  return n;
}
const TRASH_MAX = 20, TRASH_CHARS = 250000;
function trimTrash(){
  if(trash.length > TRASH_MAX) trash.length = TRASH_MAX;
  let total = 0;
  for(let i = 0; i < trash.length; i++){
    total += (trash[i].content || "").length;
    if(total > TRASH_CHARS){ trash.length = Math.max(1, i); break; }
  }
}
function closeNote(id, opts = {}){
  const i = notes.findIndex(n => n.id === id); if(i < 0) return;
  const n = notes[i], wasActive = id === activeId;
  if(!opts.noTrash){
    const {handle, _tags, ...copy} = n;
    trash.unshift({...copy, deletedAt: Date.now(), index: i});
    trimTrash();
  }
  notes.splice(i, 1);
  HDB.del(id);
  if(wasActive){ activeId = notes.length ? notes[Math.min(i, notes.length-1)].id : null; loadEditor(); }
  renderTabs(); persist(); reindexMemory();
  if(!opts.silent && !opts.noTrash){
    toast(`Closed “${n.title || "Untitled"}”`, "", {label:"Undo", run: () => restoreNote(n.id)});
  }
}
function restoreNote(id){
  const ti = id ? trash.findIndex(t => t.id === id) : 0;
  if(ti < 0 || !trash.length) return toast("Nothing to restore","warn");
  const [t] = trash.splice(ti, 1);
  const {deletedAt, index, ...note} = t;
  if(notes.some(n => n.id === note.id)) note.id = uid();
  notes.splice(Math.min(index ?? notes.length, notes.length), 0, note);
  sortPinned();
  activeId = note.id;
  renderTabs(); loadEditor(); persist(); reindexMemory();
  toast(`Restored “${note.title || "Untitled"}”`, "ok");
}

/* ---------- close confirmation ---------- */
const confirmOv = $("confirmOv");
let pendingClose = null;
function requestClose(id){
  const n = getNote(id);
  if(n && isDirty(n)){
    pendingClose = id;
    const name = n.fileName || n.title || "Untitled";
    $("confirmMsg").innerHTML = `Do you want to save <b>${esc(name)}</b> before closing? Your changes will be lost if you don't.`;
    confirmOv.classList.add("open");
  } else closeNote(id);
}
function closeConfirm(){ confirmOv.classList.remove("open"); pendingClose = null; editor.focus(); }
$("cfCancel").onclick = closeConfirm;
$("cfNo").onclick = () => { const id = pendingClose; closeConfirm(); closeNote(id); };
$("cfYes").onclick = async () => {
  const n = getNote(pendingClose); const id = pendingClose;
  if(!n){ closeConfirm(); return; }
  if(n.id !== activeId) switchNote(n.id);
  let ok;
  if(window.showSaveFilePicker || n.handle) ok = await saveLinked(n);
  else{ download(); ok = true; }
  if(ok){ closeConfirm(); closeNote(id); }
};
confirmOv.addEventListener("click", e => { if(e.target === confirmOv) closeConfirm(); });
function switchNote(id){
  if(id === activeId && !typing) return;
  finishTyping(); commitCurrent(); activeId = id; renderTabs(); loadEditor(); persist();
}
function loadEditor(){
  const n = getActive();
  shell.classList.toggle("no-notes", !n);
  editor.value = n ? n.content || "" : "";
  $("langSel").value = n ? (n.lang || "auto") : "auto";
  lastLineCount = -1; gutterSig = ""; updateGutter(); updateStatus(); updateHighlight();
  renderTagBar(); refreshHintCount();
}

/* ---------- gutter & status ---------- */
/* Measures how many visual rows each logical line occupies once wrapped.
   Uses a hidden mirror sized exactly like the editor's content box. */
let gutterMirror = null;
function measureRows(lines){
  if(!gutterMirror){
    gutterMirror = document.createElement("div");
    gutterMirror.setAttribute("aria-hidden", "true");
    gutterMirror.style.cssText = "position:absolute;top:0;left:-99999px;visibility:hidden;pointer-events:none";
    document.body.appendChild(gutterMirror);
  }
  const cs = getComputedStyle(editor);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.65);
  const width = editor.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if(!(width > 0)) return {heights: lines.map(() => lh), lh};
  const m = gutterMirror;
  m.style.width = width + "px";
  m.style.font = cs.font;
  m.style.lineHeight = cs.lineHeight;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.wordSpacing = cs.wordSpacing;
  m.style.tabSize = cs.tabSize;
  m.style.whiteSpace = "pre-wrap";
  m.style.overflowWrap = "break-word";
  const frag = document.createDocumentFragment();
  lines.forEach(l => { const d = document.createElement("div"); d.textContent = l === "" ? " " : l; frag.appendChild(d); });
  m.textContent = ""; m.appendChild(frag);
  /* exact rendered offsets — avoids sub-pixel drift from stacking rounded heights */
  const tops = [];
  for(let i = 0; i < m.children.length; i++) tops.push(m.children[i].offsetTop);
  const total = m.scrollHeight;
  m.textContent = "";
  return {tops, total, lh};
}
let gutterPending = false, gutterSig = "";
function updateGutter(){
  if(!getActive()){ gutter.innerHTML = ""; gutterSig = ""; lastLineCount = 0; return; }
  gutter.classList.toggle("off", !ui.numbers);
  if(!ui.numbers) return;
  if(gutterPending) return;
  gutterPending = true;
  requestAnimationFrame(() => { gutterPending = false; buildGutter(); });
}
function buildGutter(){
  if(!getActive() || !ui.numbers) return;
  const lines = editor.value.split("\n"), count = lines.length;
  let tops = null, total = 0, lh = 0;
  if(ui.wrap){ const m = measureRows(lines); tops = m.tops; total = m.total; lh = m.lh; }
  const sig = (ui.wrap ? "w" : "n") + count + "|" + editor.clientWidth + "|" + lh + "|" +
    (tops ? tops.join(",") : "");
  if(sig === gutterSig) return;
  gutterSig = sig; lastLineCount = count;
  let h = "";
  if(tops){
    for(let i = 0; i < count; i++) h += `<div class="gn" style="top:${tops[i]}px">${i+1}</div>`;
    gutter.innerHTML = `<div class="gn-layer" style="height:${total}px">${h}</div>`;
  }else{
    for(let i = 0; i < count; i++) h += `<div class="gn">${i+1}</div>`;
    gutter.innerHTML = h;
  }
  const gw = (String(count).length + 2.4) + "ch";
  gutter.style.width = gw; gutter.style.setProperty("--gw", gw);
  gutter.scrollTop = editor.scrollTop;
  markCurLine();
}
function markCurLine(){
  const pos = editor.selectionStart || 0;
  const line = editor.value.slice(0, pos).split("\n").length;
  const gns = gutter.querySelectorAll(".gn");
  gutter.querySelectorAll(".gn.cur").forEach(x => x.classList.remove("cur"));
  const el = gns[line-1]; if(el) el.classList.add("cur");
}
function updateStatus(){
  const v = editor.value, pos = editor.selectionStart || 0, sel = editor.selectionEnd || 0;
  const before = v.slice(0, pos);
  const line = before.split("\n").length, col = pos - before.lastIndexOf("\n");
  $("statPos").textContent = `Ln ${line.toLocaleString()}, Col ${col.toLocaleString()}`;
  const words = (v.match(/\S+/g) || []).length;
  $("statWords").textContent = words.toLocaleString();
  $("statChars").textContent = v.length.toLocaleString();
  $("statRead").textContent = words === 0 ? "— read" : words < 160 ? "~<1 min read" : `~${Math.ceil(words/200)} min read`;
  const sw = $("statSelWrap");
  if(sel > pos){ sw.style.display = ""; $("statSel").textContent = (sel-pos).toLocaleString(); } else sw.style.display = "none";
  $("statZoom").textContent = Math.round(ui.size/16*100) + "%";
  $("statNotes").textContent = notes.length;
  markCurLine();
}
editor.addEventListener("scroll", () => {
  hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
});

/* ---------- editor input ---------- */
editor.addEventListener("input", () => {
  if(typing) return;
  commitCurrent(); updateGutter(); updateStatus(); requestHL(); scheduleSave(); scheduleTagBar(); scheduleHints();
});
editor.addEventListener("keydown", e => {
  if(e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey){
    e.preventDefault();
    editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
});
["keyup","click","focus"].forEach(ev => editor.addEventListener(ev, updateStatus));
document.addEventListener("selectionchange", () => { if(document.activeElement === editor) updateStatus(); });

/* ---------- font / zoom ---------- */
function applyFont(){
  const fam = FONTMAP[ui.font] || FONTMAP.mono, sz = ui.size + "px";
  editor.style.fontFamily = fam; editor.style.fontSize = sz;
  hl.style.fontFamily = fam; hl.style.fontSize = sz;
  gutter.style.fontSize = sz;
  $("szVal").textContent = ui.size;
  $("statZoom").textContent = Math.round(ui.size/16*100) + "%";
}
function zoom(d){ ui.size = Math.min(40, Math.max(11, ui.size + d)); applyFont(); gutterSig = ""; updateGutter(); persistUI(); }
editor.addEventListener("wheel", e => { if(e.ctrlKey || e.metaKey){ e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); } }, {passive:false});
$("szPlus").onclick = () => zoom(1); $("szMinus").onclick = () => zoom(-1);
$("fontSel").onchange = e => { ui.font = e.target.value; applyFont(); gutterSig = ""; updateGutter(); persistUI(); };
window.addEventListener("resize", () => { gutterSig = ""; updateGutter(); });

/* ---------- toggles ---------- */
function applyLayout(){
  editor.classList.toggle("wrap", ui.wrap);
  hl.classList.toggle("wrap", ui.wrap);
  $("wrapTog").classList.toggle("on", ui.wrap);
  $("numTog").classList.toggle("on", ui.numbers);
  updateGutter();
}
$("wrapTog").onclick = () => { ui.wrap = !ui.wrap; gutterSig = ""; applyLayout(); persistUI(); };
$("numTog").onclick = () => { ui.numbers = !ui.numbers; gutterSig = ""; applyLayout(); persistUI(); };
$("caseTog").onclick = () => { ui.cs = !ui.cs; $("caseTog").classList.toggle("on", ui.cs); persistUI(); refreshFindCount(); };
$("langSel").onchange = e => { const n = getActive(); if(!n) return; n.lang = e.target.value; persist(); updateHighlight(); renderTagBar(); refreshHintCount(); };

/* ---------- theme ---------- */
const WV2 = !!(window.chrome && chrome.webview && chrome.webview.postMessage);
function applyTheme(){
  document.body.dataset.theme = ui.theme;
  $("icMoon").style.display = ui.theme === "paper" ? "" : "none";
  $("icSun").style.display = ui.theme === "night" ? "" : "none";
  if(WV2) chrome.webview.postMessage("theme:" + ui.theme);
}
$("themeBtn").onclick = () => { ui.theme = ui.theme === "paper" ? "night" : "paper"; applyTheme(); persistUI();
  toast(ui.theme === "paper" ? "Paper surface" : "Night surface", "ok"); };

/* ---------- find & replace ---------- */
const findbar = $("findbar"), findInput = $("findInput"), repInput = $("repInput");
function openFind(replace){
  findbar.classList.add("open");
  $("replaceRow").hidden = !replace;
  $("findTog").classList.add("on");
  setTimeout(() => findInput.focus(), 120);
  refreshFindCount();
}
function closeFindBar(){ findbar.classList.remove("open"); $("findTog").classList.remove("on"); editor.focus(); }
$("findTog").onclick = () => findbar.classList.contains("open") ? closeFindBar() : openFind(false);
$("closeFind").onclick = closeFindBar;
const q2 = s => ui.cs ? s : s.toLowerCase();
function matches(){
  const q = findInput.value; if(!q) return [];
  const hay = q2(editor.value), nq = q2(q), out = []; let i = 0;
  while((i = hay.indexOf(nq, i)) !== -1){ out.push(i); i += nq.length || 1; }
  return out;
}
function refreshFindCount(){
  const q = findInput.value, c = $("fbCount");
  if(!q){ c.textContent = ""; return; }
  const m = matches();
  c.textContent = m.length ? `${Math.max(m.findIndex(x => x === editor.selectionStart) + 1, 1)}/${m.length}` : `0/${m.length}`;
}
function doFind(dir){
  const q = findInput.value; if(!q){ findInput.focus(); return; }
  const hay = q2(editor.value), nq = q2(q);
  const s = editor.selectionStart, en = editor.selectionEnd;
  const hasSel = en - s === q.length && q2(editor.value.slice(s, en)) === nq;
  let idx = dir > 0 ? hay.indexOf(nq, hasSel ? en : s + 1) : hay.lastIndexOf(nq, hasSel ? s - 1 : s - (nq.length || 1));
  if(idx === -1) idx = dir > 0 ? hay.indexOf(nq, 0) : hay.lastIndexOf(nq, hay.length);
  if(idx === -1){ toast("No matches","warn"); $("fbCount").textContent = "0/0"; return; }
  editor.focus(); editor.setSelectionRange(idx, idx + q.length);
  const lh = ui.size * 1.65, line = editor.value.slice(0, idx).split("\n").length - 1;
  editor.scrollTop = Math.max(0, line * lh - editor.clientHeight / 2);
  refreshFindCount();
}
$("nextBtn").onclick = () => doFind(1); $("prevBtn").onclick = () => doFind(-1);
findInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); doFind(e.shiftKey ? -1 : 1); } if(e.key === "Escape") closeFindBar(); });
findInput.addEventListener("input", refreshFindCount);
repInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); repOne(); } if(e.key === "Escape") closeFindBar(); });
function repOne(){
  const q = findInput.value; if(!q) return;
  const s = editor.selectionStart, en = editor.selectionEnd;
  if(en > s && q2(editor.value.slice(s, en)) === q2(q)){
    editor.setRangeText(repInput.value, s, en, "end");
    editor.dispatchEvent(new Event("input"));
  }
  doFind(1);
}
$("repOne").onclick = repOne;
$("repAll").onclick = () => {
  const q = findInput.value; if(!q) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ui.cs ? "g" : "gi");
  const count = (editor.value.match(re) || []).length;
  if(!count){ toast("Nothing to replace","warn"); return; }
  editor.value = editor.value.replace(re, repInput.value);
  editor.dispatchEvent(new Event("input"));
  refreshFindCount(); toast(`Replaced ${count} occurrence${count > 1 ? "s" : ""}`, "ok");
};

/* ---------- focus mode ---------- */
function setZen(on){ document.body.classList.toggle("zen", on); $("zenTog").classList.toggle("on", on); if(on) editor.focus(); }
$("zenTog").onclick = () => setZen(!document.body.classList.contains("zen"));
$("exitZen").onclick = () => setZen(false);

/* ---------- command palette ---------- */
const palOv = $("palOv"), palInput = $("palInput"), palList = $("palList");
let palItems = [], palSel = 0;
const CMDS = [
  {label:"New note", key:"Ctrl Alt N", run:() => newNote()},
  {label:"Smart Memory", key:"Ctrl M", run:openMemory},
  {label:"Note insights — summary, tags & writing hints", key:"Ctrl I", run:openInsights},
  {label:"Pin / unpin current note", run:() => { const n = getActive(); if(n){ togglePin(n); toast(n.pinned ? "Pinned" : "Unpinned","ok"); } }},
  {label:"Copy summary of current note", run:copySummary},
  {label:"Find forgotten notes", run:() => { openMemory(); memInput.value = "forgotten"; buildMemory(memInput.value); }},
  {label:"Download current note as .txt", run:download},
  {label:"Export all notes — backup .json", run:exportBackup},
  {label:"Export all notes as Markdown", run:exportMarkdown},
  {label:"Import notes from a backup…", run:importBackup},
  {label:"Restore last closed note", key:"Ctrl ⇧ T", run:() => restoreNote()},
  {label:"Save As… (name, format, location)", key:"Ctrl Shift S", run:openSaveAs},
  {label:"Copy current note to clipboard", run:copyNote},
  {label:"Toggle paper / night theme", run:() => $("themeBtn").click()},
  {label:"Toggle word wrap", run:() => $("wrapTog").click()},
  {label:"Toggle line numbers", run:() => $("numTog").click()},
  {label:"Toggle focus mode", run:() => $("zenTog").click()},
  {label:"Find & replace", key:"Ctrl F", run:() => openFind(true)},
  {label:"Show shortcuts", key:"?", run:openHelp},
  {label:"Delete current note", danger:true, run:() => { if(activeId) requestClose(activeId); }},
];
function openPalette(){
  finishTyping(); palOv.classList.add("open"); palInput.value = ""; buildPalette("");
  setTimeout(() => palInput.focus(), 80);
}
function closePalette(){ palOv.classList.remove("open"); editor.focus(); }
$("palTog").onclick = openPalette;
palOv.addEventListener("click", e => { if(e.target === palOv) closePalette(); });
function buildPalette(query){
  const q = query.trim().toLowerCase();
  palItems = []; let html = "";
  const cmds = CMDS.filter(c => !q || c.label.toLowerCase().includes(q));
  if(cmds.length){ html += `<div class="pal-group">Commands</div>`;
    cmds.forEach(c => { palItems.push(c);
      html += `<div class="pal-item${c.danger ? " danger" : ""}" data-i="${palItems.length-1}">${esc(c.label)}${c.key ? `<span class="pi-key">${c.key}</span>` : ""}</div>`; }); }
  const ns = notes.filter(n => !q || (n.title||"").toLowerCase().includes(q) || (n.content||"").toLowerCase().includes(q));
  if(ns.length){ html += `<div class="pal-group">Notes</div>`;
    ns.forEach(n => { const it = {run:() => switchNote(n.id)}; palItems.push(it);
      html += `<div class="pal-item" data-i="${palItems.length-1}">📄 ${esc(n.title||"Untitled")}<span class="pi-key">${(n.content||"").length.toLocaleString()} ch</span></div>`; }); }
  if(!palItems.length) html = `<div class="pal-item" style="cursor:default;color:var(--chrome-mut)">No matches — nice try.</div>`;
  palList.innerHTML = html; palSel = 0; paintPalSel();
  palList.querySelectorAll(".pal-item[data-i]").forEach(el => {
    el.addEventListener("click", () => { closePalette(); palItems[+el.dataset.i].run(); });
    el.addEventListener("mousemove", () => { palSel = +el.dataset.i; paintPalSel(); });
  });
}
function paintPalSel(){ palList.querySelectorAll(".pal-item[data-i]").forEach(el => el.classList.toggle("sel", +el.dataset.i === palSel)); }
palInput.addEventListener("input", () => buildPalette(palInput.value));
palInput.addEventListener("keydown", e => {
  if(e.key === "ArrowDown"){ e.preventDefault(); palSel = Math.min(palItems.length-1, palSel+1); paintPalSel(); }
  else if(e.key === "ArrowUp"){ e.preventDefault(); palSel = Math.max(0, palSel-1); paintPalSel(); }
  else if(e.key === "Enter"){ e.preventDefault(); if(palItems[palSel]){ closePalette(); palItems[palSel].run(); } }
  else if(e.key === "Escape") closePalette();
});

/* ---------- smart memory ---------- */
const memOv = $("memOv"), memInput = $("memInput"), memList = $("memList"), memChips = $("memChips");
let memItems = [], memSel = 0;
const ENTITIES = {
  url: {re: /https?:\/\/[^\s<>"')\]]+/gi, label:"URL", clean: v => v.replace(/[.,;:!?]+$/, "")},
  email:{re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label:"Email"},
  api:  {re: /(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?:\/[^\s<>"')\]]+|https?:\/\/[^\s<>"')\]]+)|(?:\/api\/|\/v\d+\/)[^\s<>"')\]]*/gi, label:"API"},
  code: {re: /`[^`]+`|```[\s\S]*?```/g, label:"Code"},
  hash: {re: /#[\w\u00C0-\u024F-]+/g, label:"Tag", skip: v => /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || /^#\d+$/.test(v)},
  at:   {re: /@[\w\u00C0-\u024F-]+/g, label:"Mention"}
};
function extractEntities(text){
  const out = [];
  for(const [type, {re, label, skip, clean}] of Object.entries(ENTITIES)){
    const seen = new Set();
    for(const m of (text||"").matchAll(re)){
      let v = m[0].slice(0, 120);
      if(clean) v = clean(v);
      if(!v || (skip && skip(v))) continue;
      const key = type + "|" + v.toLowerCase();
      if(!seen.has(key)){ seen.add(key); out.push({type, label, value:v, index:m.index}); }
    }
  }
  return out;
}
function noteTags(n){ return (n._tags ||= extractEntities(n.content||"")); }
function reindexMemory(){ notes.forEach(noteTags); }
function relativeDateMs(q){
  const now = Date.now(), day = 86400000;
  const s = q.toLowerCase();
  if(/\btoday\b/.test(s)) return now - day;
  if(/\byesterday\b/.test(s)) return now - day*2;
  if(/\blast week\b/.test(s)) return now - day*8;
  if(/\blast month\b/.test(s)) return now - day*32;
  if(/\blast year\b/.test(s)) return now - day*366;
  const m = s.match(/(\d+)\s+(day|week|month|year)s?\s+ago/);
  if(m){
    const n = parseInt(m[1],10), unit = {day:1, week:7, month:30.44, year:365.25}[m[2]];
    if(unit) return now - n*unit*day;
  }
  return null;
}
function parseQuery(q){
  const out = {text:[], filters:{}, since:null, until:null, near:null, forgotten:false, raw:q};
  let s = q;
  const stops = new Set(["a","an","the","i","me","my","mine","you","your","it","its","this","that","these","those","is","am","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","of","in","on","at","to","for","with","from","by","about","into","onto","up","down","out","off","over","under","again","further","then","once","here","there","when","where","why","how","all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","now","what","which","who","whom","whose","note","noted"]);
  const dateRe = /\b(?:since|after|from|before|until)\b[^,;]{0,60}/gi;
  if(/\bforgot(ten)?\b|\bold notes?\b|\bstale\b/i.test(s)){ out.forgotten = true; s = s.replace(/\bforgot(ten)?\b|\bold notes?\b|\bstale\b/gi, " "); }
  for(const m of (q.matchAll ? q.matchAll(dateRe) : [])){    const phrase = m[0].toLowerCase();
    const ts = relativeDateMs(phrase.replace(/^(since|after|from|before|until)\s+/i,""));
    if(ts !== null){
      if(/\b(since|after|from)\b/.test(phrase)) out.since = Math.max(out.since||0, ts);
      if(/\b(before|until)\b/.test(phrase)) out.until = out.until ? Math.min(out.until, ts) : ts;
      s = s.replace(m[0], " ");
    }
  }
  const rel = relativeDateMs(s);
  /* A bare "3 months ago" means "around then", not "since then" — rank by
     proximity instead of hard-filtering, so a slightly older note still wins. */
  if(rel !== null && out.since === null && out.until === null){ out.near = rel; s = s.replace(/\b\d+\s+(day|week|month|year)s?\s+ago\b|today|yesterday|last\s+(week|month|year)\b/gi, " "); }
  const ft = /\b(url|email|api|code|tag|mention):\s*/gi;
  s = s.replace(ft, (m, p1) => { out.filters.type = p1.toLowerCase(); return " "; });
  const syns = {email:"email",mail:"email","e-mail":"email",url:"url",link:"url",website:"url",api:"api",endpoint:"api",code:"code",snippet:"code",tag:"tag",hashtag:"tag",mention:"mention",person:"mention",people:"mention"};
  out.text = s.trim().split(/\s+/).filter(w => {
    if(!w) return false;
    const low = w.toLowerCase();
    if(stops.has(low)) return false;
    if(syns[low] && !out.filters.type){ out.filters.type = syns[low]; return false; }
    return true;
  });
  return out;
}
function excerpt(text, terms, maxLen=160){
  const low = text.toLowerCase();
  let best = 0, bestScore = -1;
  if(terms.length){
    terms.forEach(t => {
      let i = 0; const tl = t.length;
      while((i = low.indexOf(t, i)) !== -1){
        const score = tl*3 - Math.abs(i - low.length/2)/1000;
        if(score > bestScore){ bestScore = score; best = Math.max(0, i - 40); }
        i += tl;
      }
    });
  }
  let slice = text.slice(best, best + maxLen);
  if(best > 0) slice = "…" + slice.trimStart();
  if(best + maxLen < text.length) slice = slice.trimEnd() + "…";
  let html = esc(slice);
  if(terms.length){
    const pattern = new RegExp("(" + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|") + ")", "gi");
    html = html.replace(pattern, "<b>$1</b>");
  }
  return html;
}
function scoreNote(n, q){
  const tags = noteTags(n), text = (n.content||"").toLowerCase(), title = (n.title||"").toLowerCase();
  let score = 0, matches = [];
  if(q.since !== null && n.updated < q.since) return 0;
  if(q.until !== null && n.updated > q.until) return 0;
  if(q.forgotten){
    const ageDays = (Date.now() - n.updated) / 86400000;
    if(ageDays < 14 || n.pinned) return 0;
    score += Math.min(ageDays, 400) / 20;
  }
  if(q.filters.type){
    const want = q.filters.type === "tag" ? "hash" : q.filters.type === "mention" ? "at" : q.filters.type;
    const hits = tags.filter(t => t.type === want);
    if(!hits.length) return 0;
    score += hits.length * 4;
    matches = hits.map(h => h.value);
  }
  q.text.forEach(t => {
    const tl = t.length; if(!tl) return;
    let tc = 0;
    if(title === t) tc += 20; else if(title.includes(t)) tc += 10;
    let idx = 0; while((idx = text.indexOf(t, idx)) !== -1){ tc += 3; idx += tl; }
    tags.forEach(tag => { if(tag.value.toLowerCase().includes(t)) tc += 5; });
    if(tc) score += tc;
    matches.push(t);
  });
  if(!q.filters.type && !q.text.length && (q.since !== null || q.until !== null)) score = 1;
  if(q.near !== null){
    const offDays = Math.abs(n.updated - q.near) / 86400000;
    score += 14 / (1 + offDays/14);
  }
  return score > 0 ? {note:n, score, terms:[...new Set(matches.filter(Boolean).map(x => x.toLowerCase()))]} : null;
}
function searchMemory(query){
  const q = parseQuery(query);
  const results = notes.map(n => scoreNote(n, q)).filter(Boolean)
    .sort((a,b) => b.score - a.score || b.note.updated - a.note.updated);
  return {q, results};
}
const MEM_CHIP_PROMPTS = [
  {icon:"🔗", label:"Links", q:"url:"},
  {icon:"✉️", label:"Emails", q:"email:"},
  {icon:"⚡", label:"APIs", q:"api:"},
  {icon:"📝", label:"Recent", q:"since last week"},
  {icon:"#️⃣", label:"Hashtags", q:"tag:"},
  {icon:"```", label:"Code", q:"code:"},
  {icon:"🕰️", label:"Forgotten", q:"forgotten"}
];
function renderChips(){
  memChips.innerHTML = MEM_CHIP_PROMPTS.map(p =>
    `<button class="mem-chip" data-q="${esc(p.q)}" title="${esc(p.label)}"><span>${p.icon}</span> ${esc(p.label)}</button>`
  ).join("");
  memChips.querySelectorAll(".mem-chip").forEach(b => b.onclick = () => { memInput.value = b.dataset.q; buildMemory(memInput.value); memInput.focus(); });
}
function formatDate(ts){
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if(sameDay) return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? {month:"short", day:"numeric"} : {year:"numeric", month:"short", day:"numeric"});
}
function buildMemory(query){
  const trimmed = query.trim();
  let {q, results} = searchMemory(query);
  if(!trimmed) results = notes.slice().sort((a,b) => b.updated - a.updated).map(n => ({note:n, score:0, terms:[]}));
  memItems = results;
  if(!results.length){
    memList.innerHTML = `<div class="mem-empty"><strong>No memories found</strong>Try a different phrase, like "API from last month" or "url:"</div>`;
    memSel = 0; return;
  }
  let html = "";
  results.forEach((r,i) => {
    const n = r.note, tags = noteTags(n).slice(0,6);
    html += `<div class="mem-item" data-i="${i}">
      <div class="mem-top"><span class="mem-title">${esc(n.title||"Untitled")}</span><span class="mem-date">${formatDate(n.updated)}</span></div>
      <div class="mem-excerpt">${excerpt(n.content||"", r.terms)}</div>
      ${tags.length ? `<div class="mem-tags">${tags.map(t => `<span class="mem-tag ${esc(t.type)}">${esc(t.label)} · ${esc(t.value.length > 32 ? t.value.slice(0,32)+"…" : t.value)}</span>`).join("")}</div>` : ""}
    </div>`;
  });
  memList.innerHTML = html; memSel = 0; paintMemSel();
  memList.querySelectorAll(".mem-item").forEach(el => {
    el.addEventListener("click", () => { openMemoryResult(memItems[+el.dataset.i].note); });
    el.addEventListener("mousemove", () => { memSel = +el.dataset.i; paintMemSel(); });
  });
}
function paintMemSel(){ memList.querySelectorAll(".mem-item").forEach(el => el.classList.toggle("sel", +el.dataset.i === memSel)); }
function openMemoryResult(n){
  closeMemory(); switchNote(n.id);
  const q = memInput.value.trim().toLowerCase();
  if(q){
    const term = parseQuery(q).text[0] || (q.includes(":") ? "" : q);
    if(term){
      const text = editor.value.toLowerCase(), t = term.toLowerCase();
      const i = text.indexOf(t); if(i >= 0){ editor.focus(); editor.setSelectionRange(i, i + t.length); }
    }
  }
}
function openMemory(){ finishTyping(); memOv.classList.add("open"); renderChips(); buildMemory(memInput.value); setTimeout(() => memInput.focus(), 80); }
function closeMemory(){ memOv.classList.remove("open"); editor.focus(); }
$("memBtn").onclick = openMemory;
memOv.addEventListener("click", e => { if(e.target === memOv) closeMemory(); });
memInput.addEventListener("input", () => buildMemory(memInput.value));
memInput.addEventListener("keydown", e => {
  if(e.key === "ArrowDown"){ e.preventDefault(); memSel = Math.min(memItems.length-1, memSel+1); paintMemSel(); memList.children[memSel]?.scrollIntoView({block:"nearest"}); }
  else if(e.key === "ArrowUp"){ e.preventDefault(); memSel = Math.max(0, memSel-1); paintMemSel(); memList.children[memSel]?.scrollIntoView({block:"nearest"}); }
  else if(e.key === "Enter"){ e.preventDefault(); if(memItems[memSel]) openMemoryResult(memItems[memSel].note); }
  else if(e.key === "Escape") closeMemory();
});

/* ---------- note insights: tags, summary, writing hints ---------- */
const insOv = $("insOv"), insBody = $("insBody"), insSub = $("insSub");
const STOP_WORDS = new Set(("a about above after again against all am an and any are aren as at be because been before being below "+
  "between both but by can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has "+
  "hasn have haven having he her here hers herself him himself his how i if in into is isn it its itself just let me more most must "+
  "mustn my myself no nor not now of off on once only or other ought our ours ourselves out over own same shan she should shouldn so "+
  "some such than that the their theirs them themselves then there these they this those through to too under until up very was wasn "+
  "we were weren what when where which while who whom why will with won would wouldn you your yours yourself yourselves also get got "+
  "make made use used using need needs one two three new like via per etc within upon shall may might able still even much many lot "+
  "thing things way ways add added adds set sets put puts see seen going go goes done doesn't isn't it's don't didn't we're they're").split(" "));
const TYPOS = {teh:"the", adn:"and", nad:"and", recieve:"receive", recieved:"received", seperate:"separate", seperated:"separated",
  occured:"occurred", occuring:"occurring", occurence:"occurrence", definately:"definitely", adress:"address", wich:"which",
  thier:"their", alot:"a lot", becuase:"because", untill:"until", sucessful:"successful", succesful:"successful", calender:"calendar",
  enviroment:"environment", neccessary:"necessary", necesary:"necessary", occassion:"occasion", publically:"publicly",
  tommorow:"tomorrow", tomorow:"tomorrow", wierd:"weird", accomodate:"accommodate", arguement:"argument", begining:"beginning",
  beleive:"believe", buisness:"business", comming:"coming", dissapoint:"disappoint", embarass:"embarrass", existance:"existence",
  familar:"familiar", foriegn:"foreign", goverment:"government", gaurd:"guard", harrass:"harass", independant:"independent",
  intrest:"interest", knowlege:"knowledge", liason:"liaison", maintenence:"maintenance", peice:"piece", personel:"personnel",
  posession:"possession", prefered:"preferred", refered:"referred", releif:"relief", rythm:"rhythm", similiar:"similar",
  speach:"speech", supercede:"supersede", threshhold:"threshold", truely:"truly", vaccum:"vacuum", writting:"writing",
  responce:"response", langauge:"language", lenght:"length", strenght:"strength", widht:"width", heigth:"height",
  greatful:"grateful", noticable:"noticeable", persue:"pursue", refrence:"reference", relevent:"relevant", suprise:"surprise"};

/* blanks out code, markup, URLs and emails (keeping indices) so hints don't fire inside them */
function maskNoise(text){
  return text.replace(/```[\s\S]*?```|`[^`\n]*`|<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->|&[a-zA-Z#][\w]{1,10};|https?:\/\/[^\s]+|[^\s@]+@[^\s@]+\.[^\s@]+/g,
    m => " ".repeat(m.length));
}
/* prose analysis only makes sense for plain text / markdown notes */
function isProseNote(){ const l = effectiveLang(); return l === "plain" || l === "md" || l === "markdown"; }
function wordFreq(text){
  const freq = new Map();
  for(const m of text.toLowerCase().matchAll(/[a-z\u00C0-\u024F][a-z\u00C0-\u024F'-]{2,}/g)){
    const w = m[0].replace(/^'+|'+$/g, "");
    if(w.length < 3 || STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w)||0) + 1);
  }
  return freq;
}
function suggestTags(text, limit = 5){
  const body = maskNoise(text||"");
  if(body.trim().length < 40) return [];
  const existing = new Set((text.match(/#[\w\u00C0-\u024F-]+/g)||[]).map(t => t.slice(1).toLowerCase()));
  const firstLine = (body.split("\n").find(l => l.trim()) || "").toLowerCase();
  const scored = [];
  wordFreq(body).forEach((count, w) => {
    if(existing.has(w) || count < 2) return;
    scored.push([w, count * 2 + (firstLine.includes(w) ? 3 : 0) + Math.min(w.length, 10)/10]);
  });
  return scored.sort((a,b) => b[1]-a[1]).slice(0, limit).map(x => x[0]);
}
function summarize(text, max = 3){
  const src = text || "";
  /* mask noise but keep indices aligned, so displayed sentences come from the original */
  const body = maskNoise(src).replace(/^[\s*\->#\d.)]+/gm, m => " ".repeat(m.length));
  const sentences = [];
  const re = /[^.!?\n]+[.!?]*/g;
  for(const m of body.matchAll(re)){
    if(m[0].trim().split(/\s+/).filter(Boolean).length < 4) continue;
    const shown = src.slice(m.index, m.index + m[0].length).trim();
    if(shown) sentences.push({text: shown, masked: m[0], index: m.index});
  }
  if(sentences.length <= max) return sentences.map(s => s.text);
  const freq = wordFreq(body);
  const peak = Math.max(...freq.values(), 1);
  sentences.forEach((s, i) => {
    let score = 0, words = 0;
    for(const m of s.masked.toLowerCase().matchAll(/[a-z\u00C0-\u024F][a-z\u00C0-\u024F'-]{2,}/g)){
      const w = m[0]; if(STOP_WORDS.has(w)) continue;
      score += (freq.get(w)||0)/peak; words++;
    }
    s.score = (words ? score/Math.sqrt(words) : 0) + (i === 0 ? .35 : i < 3 ? .12 : 0);
    s.order = i;
  });
  return sentences.slice().sort((a,b) => b.score-a.score).slice(0, max)
    .sort((a,b) => a.order-b.order).map(s => s.text);
}
function writingHints(text){
  const body = maskNoise(text||""), hints = [];
  for(const m of body.matchAll(/\b([a-zA-Z\u00C0-\u024F']{3,})\b/g)){
    const fix = TYPOS[m[0].toLowerCase()];
    if(fix) hints.push({kind:"spell", index:m.index, length:m[0].length,
      msg:`<code>${esc(m[0])}</code> → <code>${esc(fix)}</code>`});
  }
  for(const m of body.matchAll(/\b(\w+)(\s+)\1\b/gi)){
    hints.push({kind:"style", index:m.index, length:m[0].length,
      msg:`Repeated word <code>${esc(m[1])}</code>`});
  }
  for(const m of body.matchAll(/[a-z0-9)][,;:][^\s,;:]/gi)){
    hints.push({kind:"style", index:m.index+1, length:2, msg:"Missing space after punctuation"});
  }
  for(const m of body.matchAll(/\s+[,.;:!?]/g)){
    hints.push({kind:"style", index:m.index, length:m[0].length, msg:"Space before punctuation"});
  }
  for(const m of body.matchAll(/[^.!?\n]{40,}(?=[.!?\n]|$)/g)){
    const words = m[0].trim().split(/\s+/).length;
    if(words > 34) hints.push({kind:"style", index:m.index, length:Math.min(m[0].length, 60),
      msg:`Long sentence — ${words} words. Consider splitting it.`});
  }
  return hints.sort((a,b) => a.index-b.index).slice(0, 40);
}

/* --- tag suggestion bar above the editor --- */
let tagBarTimer = null;
function renderTagBar(){
  const n = getActive();
  if(!n || typing || !isProseNote()){ tagSuggestions.hidden = true; return; }
  const tags = suggestTags(editor.value, 5);
  if(!tags.length){ tagSuggestions.hidden = true; return; }
  tagSuggestions.hidden = false;
  tagSuggestions.innerHTML = `<span>Suggested tags</span>` +
    tags.map(t => `<button class="tag-suggestion" data-t="${esc(t)}">${esc(t)}</button>`).join("");
  tagSuggestions.querySelectorAll(".tag-suggestion").forEach(b => b.onclick = () => addTag(b.dataset.t));
}
function scheduleTagBar(){ clearTimeout(tagBarTimer); tagBarTimer = setTimeout(renderTagBar, 700); }
let hintTimer = null;
function scheduleHints(){ clearTimeout(hintTimer); hintTimer = setTimeout(refreshHintCount, 900); }
function addTag(tag){
  const v = editor.value, tagText = "#" + tag;
  const lines = v.split("\n");
  let li = -1;
  for(let i = lines.length-1; i >= 0; i--){
    const t = lines[i].trim();
    if(!t) continue;
    if(/^#[\w\u00C0-\u024F-]+(\s+#[\w\u00C0-\u024F-]+)*$/.test(t)) li = i;
    break;
  }
  if(li >= 0) lines[li] = lines[li].replace(/\s*$/, "") + " " + tagText;
  else { if(v.trim()) lines.push("", tagText); else lines[0] = tagText; }
  editor.value = lines.join("\n");
  commitCurrent(); updateGutter(); updateStatus(); requestHL(); scheduleSave(); renderTagBar();
  toast(`Tagged ${tagText}`, "ok");
}

/* --- insights panel --- */
function refreshHintCount(){
  const btn = $("statHints");
  if(!getActive() || typing || !isProseNote() || !editor.value.trim()){ btn.hidden = true; return; }
  const n = writingHints(editor.value).length;
  btn.hidden = n === 0;
  $("statHintsN").textContent = n;
}
function buildInsights(){
  const n = getActive();
  if(!n || !editor.value.trim()){
    insSub.textContent = "Nothing to analyse yet";
    insBody.innerHTML = `<div class="ins-sec"><div class="ins-none">Write a few sentences and Steno will summarise them, suggest tags and flag writing issues — all on this device.</div></div>`;
    return;
  }
  const text = editor.value;
  const words = (text.match(/\S+/g)||[]).length;
  const prose = isProseNote(), lang = effectiveLang();
  const summary = prose ? summarize(text) : [], hints = prose ? writingHints(text) : [], tags = prose ? suggestTags(text, 6) : [];
  const ents = extractEntities(text);
  insSub.textContent = `${n.title||"Untitled"} · ${words.toLocaleString()} words · updated ${formatDate(n.updated)}`;
  let html = `<div class="ins-sec"><div class="ins-lbl">Summary</div>` +
    (!prose ? `<div class="ins-none">Skipped — this note is ${esc(lang.toUpperCase())}, not prose.</div>`
     : summary.length ? `<div class="ins-sum">${summary.map(s => `<p>${esc(s)}</p>`).join("")}</div>`
                      : `<div class="ins-none">Too short to summarise.</div>`) + `</div>`;
  html += `<div class="ins-sec"><div class="ins-lbl">Writing hints</div>` +
    (!prose ? `<div class="ins-none">Skipped for code notes.</div>`
     : hints.length ? hints.map((h,i) => `<div class="ins-hint" data-i="${i}"><span class="ins-kind ${h.kind}">${h.kind}</span><span>${h.msg}</span></div>`).join("")
                    : `<div class="ins-none">Nothing to flag — reads clean.</div>`) + `</div>`;
  html += `<div class="ins-sec"><div class="ins-lbl">Suggested tags</div>` +
    (!prose ? `<div class="ins-none">Skipped for code notes.</div>`
     : tags.length ? `<div class="ins-tags">${tags.map(t => `<button class="tag-suggestion" data-t="${esc(t)}">${esc(t)}</button>`).join("")}</div>`
                   : `<div class="ins-none">No strong keywords yet.</div>`) + `</div>`;
  if(ents.length){
    html += `<div class="ins-sec"><div class="ins-lbl">Detected in this note</div><div class="mem-tags">` +
      ents.slice(0,12).map(t => `<span class="mem-tag ${esc(t.type)}">${esc(t.label)} · ${esc(t.value.length > 34 ? t.value.slice(0,34)+"…" : t.value)}</span>`).join("") +
      `</div></div>`;
  }
  insBody.innerHTML = html;
  insBody.querySelectorAll(".ins-hint").forEach(el => el.onclick = () => {
    const h = hints[+el.dataset.i]; closeInsights();
    editor.focus(); editor.setSelectionRange(h.index, h.index + h.length);
    editor.blur(); editor.focus(); updateStatus();
  });
  insBody.querySelectorAll(".tag-suggestion").forEach(b => b.onclick = () => { addTag(b.dataset.t); buildInsights(); });
}
function openInsights(){ finishTyping(); insOv.classList.add("open"); buildInsights(); }
function closeInsights(){ insOv.classList.remove("open"); }
function copySummary(){
  const n = getActive();
  if(!n || !editor.value.trim()) return toast("Nothing to summarise","warn");
  const lines = summarize(editor.value);
  if(!lines.length) return toast("Note is too short to summarise","warn");
  const out = `${n.title || "Untitled"}\n\n` + lines.map(s => "• " + s).join("\n");
  navigator.clipboard.writeText(out).then(() => toast("Summary copied","ok"), () => toast("Copy failed","warn"));
}
insOv.addEventListener("click", e => { if(e.target === insOv) closeInsights(); });
$("statHints").onclick = openInsights;

/* ---------- help ---------- */
function openHelp(){ $("helpOv").classList.add("open"); }
function closeHelp(){ $("helpOv").classList.remove("open"); }
$("helpBtn").onclick = openHelp;
$("helpOv").addEventListener("click", e => { if(e.target === $("helpOv")) closeHelp(); });

/* ---------- save as ---------- */
const saOv = $("saveAsOv"), saName = $("saName");
let saFmt = "txt";
function openSaveAs(){
  const n = getActive();
  if(!n){ toast("Nothing to save yet","warn"); return; }
  commitCurrent();
  saName.value = (n.title || "untitled").replace(/[\\/:*?"<>|]+/g, "").trim() || "untitled";
  saOv.classList.add("open");
  setTimeout(() => { saName.focus(); saName.select(); }, 80);
}
function closeSaveAs(){ saOv.classList.remove("open"); editor.focus(); }
$("saveAsBtn").onclick = openSaveAs;
$("saCancel").onclick = closeSaveAs;
saOv.addEventListener("click", e => { if(e.target === saOv) closeSaveAs(); });
document.querySelectorAll(".fmt").forEach(b => b.onclick = () => {
  document.querySelectorAll(".fmt").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); saFmt = b.dataset.fmt;
});
function noteBody(n, fmt){
  if(fmt === "html") return "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>" + esc(n.title) + "</title>"
    + "<style>body{font:16px/1.7 Georgia,serif;max-width:70ch;margin:8vh auto;padding:0 20px;white-space:pre-wrap}</style>"
    + "</head><body>" + esc(n.content) + "</body></html>";
  return n.content;
}
async function doSaveAs(){
  const n = getActive(); if(!n) return;
  const base = (saName.value.trim() || "untitled").replace(/[\\/:*?"<>|]+/g, "");
  const fname = base + "." + saFmt;
  const mime = saFmt === "html" ? "text/html" : "text/plain";
  const data = noteBody(n, saFmt);
  try{
    if(window.showSaveFilePicker){
      const handle = await window.showSaveFilePicker({
        suggestedName: fname,
        types: [{description: saFmt.toUpperCase() + " file", accept: {[mime]: ["." + saFmt]}}]
      });
      const w = await handle.createWritable();
      await w.write(data); await w.close();
      toast("Saved " + handle.name, "ok");
    }else{
      const blob = new Blob([data], {type: mime + ";charset=utf-8"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("Exported " + fname, "ok");
    }
    n.savedToDisk = true; n.lastSavedContent = n.content; updateDirty(n); persist();
    if($("saCopy").checked){
      const c = {id:uid(), title:base, custom:true, content:n.content, lang:n.lang||"auto", updated:Date.now()};
      notes.splice(notes.indexOf(n)+1, 0, c);
      activeId = c.id; renderTabs(); loadEditor(); persist();
      toast("Copy kept in Steno","ok");
    }
    closeSaveAs();
  }catch(err){
    if(err && err.name === "AbortError") return;
    toast("Save failed","warn");
  }
}
$("saSave").onclick = doSaveAs;
saName.addEventListener("keydown", e => {
  if(e.key === "Enter"){ e.preventDefault(); doSaveAs(); }
  if(e.key === "Escape") closeSaveAs();
});

/* ---------- linked file save-back ---------- */
/* File handles survive restarts in IndexedDB (they're structured-cloneable). */
const HDB = {
  _p: null,
  db(){ if(!this._p) this._p = new Promise(res => {
    if(!window.indexedDB) return res(null);
    const rq = indexedDB.open("steno-handles", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("h");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  }); return this._p; },
  async put(id, h){ const db = await this.db(); if(!db) return;
    await new Promise(r => { const t = db.transaction("h","readwrite"); t.objectStore("h").put(h, id); t.oncomplete = t.onerror = r; }); },
  async del(id){ const db = await this.db(); if(!db) return;
    await new Promise(r => { const t = db.transaction("h","readwrite"); t.objectStore("h").delete(id); t.oncomplete = t.onerror = r; }); },
  async restoreAll(){
    const db = await this.db(); if(!db) return;
    const [keys, vals] = await new Promise(r => {
      const t = db.transaction("h","readonly"), s = t.objectStore("h");
      const kq = s.getAllKeys(), vq = s.getAll();
      t.oncomplete = () => r([kq.result || [], vq.result || []]); t.onerror = () => r([[], []]);
    });
    notes.forEach(n => {
      const i = keys.indexOf(n.id);
      if(i >= 0 && vals[i] && vals[i].name === n.fileName) n.handle = vals[i];
    });
  }
};
async function writeHandle(n){
  const h = n.handle;
  try{
    if(typeof h.queryPermission === "function"){
      if(await h.queryPermission({mode:"readwrite"}) !== "granted"){
        if(await h.requestPermission({mode:"readwrite"}) !== "granted") return false;
      }
    }
  }catch(e){ /* permission API unavailable — try writing anyway */ }
  const w = await h.createWritable();
  await w.write(n.content); await w.close();
  return true;
}
async function saveLinked(n){
  commitCurrent();
  try{
    if(!n.handle){
      if(!window.showSaveFilePicker) return false;
      n.handle = await window.showSaveFilePicker({ suggestedName: n.fileName || ((n.title || "untitled").replace(/[\\/:*?"<>|]+/g,"").trim() || "untitled") + ".txt" });
      n.fileName = n.handle.name;
      HDB.put(n.id, n.handle);
    }
    if(!await writeHandle(n)){ toast("File write not permitted","warn"); return false; }
    n.lastSavedContent = n.content; n.savedToDisk = true;
    updateDirty(n); persist();
    return true;
  }catch(err){
    if(err && err.name === "AbortError") return false;
    toast("Couldn't write to the file","warn");
    return false;
  }
}

/* ---------- file ops ---------- */
function saveBlob(data, fname, mime = "text/plain"){
  const blob = new Blob([data], {type: mime + ";charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- backup: export / import every note ---------- */
const BACKUP_VERSION = 1;
function exportBackup(){
  commitCurrent();
  if(!notes.length) return toast("No notes to export","warn");
  const payload = {
    app: "steno", version: BACKUP_VERSION, exported: new Date().toISOString(),
    ui, notes: notes.map(n => { const {handle, _tags, ...rest} = n; return rest; })
  };
  const stamp = new Date().toISOString().slice(0,10);
  saveBlob(JSON.stringify(payload, null, 2), `steno-backup-${stamp}.json`, "application/json");
  toast(`Backed up ${notes.length} note${notes.length === 1 ? "" : "s"}`, "ok");
}
function exportMarkdown(){
  commitCurrent();
  if(!notes.length) return toast("No notes to export","warn");
  const body = notes.map(n =>
    `# ${n.title || "Untitled"}\n\n_${new Date(n.updated || Date.now()).toLocaleString()}_\n\n${n.content || ""}`
  ).join("\n\n---\n\n");
  const stamp = new Date().toISOString().slice(0,10);
  saveBlob(body, `steno-notes-${stamp}.md`, "text/markdown");
  toast(`Exported ${notes.length} notes as Markdown`, "ok");
}
function importBackup(){
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if(!f) return;
    let data;
    try{ data = JSON.parse(await f.text()); }
    catch(e){ return toast("That file isn't a valid Steno backup","warn"); }
    const incoming = Array.isArray(data && data.notes) ? data.notes : null;
    if(!incoming) return toast("That file isn't a valid Steno backup","warn");
    commitCurrent();
    const have = new Set(notes.map(n => n.id));
    let added = 0, skipped = 0;
    incoming.forEach(raw => {
      if(!raw || typeof raw.content !== "string") return;
      const n = {
        id: have.has(raw.id) || !raw.id ? uid() : raw.id,
        title: raw.title || "Untitled", custom: !!raw.custom,
        content: raw.content, lang: raw.lang || "auto",
        updated: raw.updated || Date.now(), pinned: !!raw.pinned
      };
      const dupe = notes.some(x => x.title === n.title && x.content === n.content);
      if(dupe){ skipped++; return; }
      have.add(n.id); notes.push(n); added++;
    });
    sortPinned(); renderTabs(); persist(); reindexMemory();
    toast(added ? `Imported ${added} note${added === 1 ? "" : "s"}${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}`
                : "Nothing new to import — all notes already here", added ? "ok" : "");
  };
  inp.click();
}

function download(){
  const n = getActive(); if(!n){ toast("Nothing to save yet","warn"); return; }
  commitCurrent();
  const name = (n.title || "untitled").replace(/[^\w\u00C0-\u024F \-]+/g, "").trim().replace(/\s+/g, "-") || "untitled";
  const blob = new Blob([n.content], {type:"text/plain;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name + ".txt"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  n.savedToDisk = true; n.lastSavedContent = n.content; updateDirty(n); persist();
  toast(`Exported ${name}.txt`, "ok");
}
$("dlBtn").onclick = download;
async function copyNote(){
  const n = getActive(); if(!n) return; commitCurrent();
  try{ await navigator.clipboard.writeText(n.content); toast("Copied to clipboard","ok"); }catch(e){ toast("Clipboard blocked","warn"); }
}
function langFromExt(name){
  const e = (name.split(".").pop() || "").toLowerCase();
  return ({html:"html",htm:"html",xml:"html",svg:"html",css:"css",js:"js",mjs:"js",cjs:"js",jsx:"js",ts:"js",tsx:"js",json:"json",md:"md",markdown:"md"})[e] || "auto";
}
$("openBtn").onclick = async () => {
  if(!window.showOpenFilePicker){ $("fileInput").click(); return; }
  try{
    const [h] = await window.showOpenFilePicker({
      multiple: false,
      types: [{description:"Text", accept:{"text/plain":[".txt",".md",".markdown",".html",".htm",".xml",".css",".js",".mjs",".jsx",".ts",".tsx",".json",".csv",".log"]}}]
    });
    const f = await h.getFile();
    const text = await f.text();
    const n = newNote({title: f.name.replace(/\.[^.]+$/, ""), content: text, silent: true, lang: langFromExt(f.name)});
    n.handle = h; n.fileName = f.name; n.savedToDisk = true; n.lastSavedContent = text;
    HDB.put(n.id, h);
    updateDirty(n); persist();
    toast(`Opened ${f.name} — Ctrl S writes back to it`, "ok");
  }catch(e){ /* user cancelled the picker */ }
};
$("fileInput").onchange = e => { const f = e.target.files[0]; if(f) readFile(f); e.target.value = ""; };
function readFile(f){
  const r = new FileReader();
  r.onload = () => {
    newNote({title: f.name.replace(/\.[^.]+$/, ""), content: r.result, silent: true, lang: langFromExt(f.name)});
    persist(); reindexMemory(); toast(`Opened ${f.name}`, "ok");
  };
  r.readAsText(f);
}
let dragDepth = 0;
window.addEventListener("dragenter", e => { if([...e.dataTransfer.types].includes("Files")){ dragDepth++; app.classList.add("dropping"); } });
window.addEventListener("dragleave", () => { if(--dragDepth <= 0){ dragDepth = 0; app.classList.remove("dropping"); } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; app.classList.remove("dropping");
  const f = e.dataTransfer.files[0]; if(f) readFile(f); });

/* ---------- desktop shell (WebView2) window controls ---------- */
if(WV2){
  document.body.classList.add("wv2");
  const post = m => chrome.webview.postMessage(m);
  $("wcMin").onclick = () => post("min");
  $("wcMax").onclick = () => post("max");
  $("wcClose").onclick = () => post("close");
  document.querySelector(".topbar").addEventListener("mousedown", e => {
    if(e.button === 0 && !e.target.closest("button,select,input,a")) post("drag");
  });
}

/* ---------- global keys ---------- */
document.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if(e.key === "Escape"){
    if(saOv.classList.contains("open")) return closeSaveAs();
    if(confirmOv.classList.contains("open")) return closeConfirm();
    if(memOv.classList.contains("open")) return closeMemory();
    if(insOv.classList.contains("open")) return closeInsights();
    if(palOv.classList.contains("open")) return closePalette();
    if($("helpOv").classList.contains("open")) return closeHelp();
    if(findbar.classList.contains("open")) return closeFindBar();
    if(document.body.classList.contains("zen")) return setZen(false);
    return;
  }
  if(mod && k === "k"){ e.preventDefault(); palOv.classList.contains("open") ? closePalette() : openPalette(); return; }
  if(mod && k === "m"){ e.preventDefault(); memOv.classList.contains("open") ? closeMemory() : openMemory(); return; }
  if(mod && k === "i" && !e.shiftKey && !e.altKey){ e.preventDefault(); insOv.classList.contains("open") ? closeInsights() : openInsights(); return; }
  if(mod && k === "f"){ e.preventDefault(); openFind(false); return; }
  if(mod && k === "h"){ e.preventDefault(); openFind(true); return; }
  if(mod && e.shiftKey && k === "s"){ e.preventDefault(); openSaveAs(); return; }
  if(mod && e.shiftKey && k === "t"){ e.preventDefault(); restoreNote(); return; }
  if(mod && k === "s"){ e.preventDefault(); commitCurrent(); persist(); setSave("saved");
    const n = getActive();
    if(n && (n.handle || n.fileName)){ saveLinked(n).then(ok => { if(ok) toast(`Saved to ${n.fileName}`,"ok"); }); }
    else toast("All changes saved locally","ok");
    return; }
  if(mod && (k === "=" || k === "+")){ e.preventDefault(); zoom(1); return; }
  if(mod && k === "-"){ e.preventDefault(); zoom(-1); return; }
  if(mod && k === "0"){ e.preventDefault(); ui.size = 16; applyFont(); gutterSig = ""; updateGutter(); persistUI(); return; }
  if((k === "n" || e.code === "KeyN") && mod && e.altKey){ e.preventDefault(); newNote(); return; }
  if(e.code === "KeyN" && e.altKey && !mod && document.activeElement === editor){ e.preventDefault(); newNote(); return; }
  if(mod && k === "/"){ e.preventDefault(); $("helpOv").classList.contains("open") ? closeHelp() : openHelp(); return; }
  if(e.key === "?" && !mod && document.activeElement !== editor && document.activeElement.tagName !== "INPUT") openHelp();
});

/* ---------- buttons ---------- */
$("newBtn").onclick = () => newNote();
$("tabNew").onclick = () => newNote();
$("emptyNew").onclick = () => newNote();

/* ---------- welcome typewriter ---------- */
const WELCOME = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Welcome to Steno</title>

  <style>
    /* Color chips light up as you type */
    body   { color: #26332f; background: #fbf8f1; }
    .brand { color: rgb(255, 176, 46); font-weight: 700; }
  </style>
</head>
<body>

  <!-- Everything autosaves the moment you type.
       Close the tab, come back later — it's all here. -->

  <h1>Welcome to <span class="brand">Steno</span></h1>

  <p>A quiet notepad that speaks code. HTML, CSS, JavaScript,
  JSON and Markdown are highlighted automatically — or pick a
  language from the toolbar.</p>

  <ul>
    <li><b>Ctrl F</b> find &middot; <b>Ctrl H</b> replace</li>
    <li><b>Ctrl K</b> command palette</li>
    <li><b>Ctrl Alt N</b> fresh note &middot; <b>Tab</b> indents</li>
    <li><b>Ctrl S</b> confirm save &middot; <b>Ctrl Shift S</b> save as…</li>
    <li>Double-click a tab to rename it, drag tabs to reorder</li>
    <li>Drop any .txt / .html / .css / .js / .md file onto this window</li>
  </ul>

  <script>
    const skills = ["autosave", "syntax highlighting", "focus mode"];
    skills.forEach(s => console.log("Steno ships with " + s));
  </script>

</body>
</html>`;
function typewriter(text){
  typing = true; editor.value = ""; let i = 0;
  typeTimer = setInterval(() => {
    i += 3; editor.value = text.slice(0, Math.min(i, text.length));
    editor.scrollTop = editor.scrollHeight;
    lastLineCount = -1; updateGutter(); updateStatus(); requestHL();
    if(i >= text.length) finishTyping();
  }, 14);
  const skip = () => { if(typing) finishTyping(); window.removeEventListener("keydown", skip); };
  window.addEventListener("keydown", skip);
}
function finishTyping(){
  if(!typing) return; typing = false; clearInterval(typeTimer);
  const n = getActive(); if(n){ n.content = editor.value; autoTitle(n); renderTabs(); persist(); }
  updateGutter(); updateStatus(); updateHighlight();
  renderTagBar(); refreshHintCount();
}

/* ---------- init ---------- */
load();
$("fontSel").value = ui.font; $("caseTog").classList.toggle("on", ui.cs);
applyTheme(); applyFont(); applyLayout();
if(!notes.length){
  notes.push({id:uid(), title:"Welcome to Steno", custom:true, content:WELCOME, lang:"html", updated:Date.now()});
  activeId = notes[0].id;
}
if(!getActive(activeId)) activeId = notes.length ? notes[0].id : null;
renderTabs(); loadEditor(); persist();
reindexMemory();
HDB.restoreAll().then(() => notes.forEach(updateDirty));
if(notes.length === 1 && notes[0].content === WELCOME) typewriter(WELCOME);
window.addEventListener("beforeunload", () => { commitCurrent(); persist(); });

/* ---------- PWA (only over http/https, e.g. localhost) ---------- */
if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
})();