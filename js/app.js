/* ============================================================
   Steno — app logic: notes, tabs, autosave, find, save-as, UI
   Depends on: js/highlighter.js (window.StenoHighlight)
   ============================================================ */
(() => {
"use strict";
/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const app=$("app"), editor=$("editor"), hl=$("hl"), gutter=$("gutter"), shell=$("shell"), tabsEl=$("tabs");
const LS_NOTES = "steno.notes.v1", LS_UI = "steno.ui.v1";
const FONTMAP = {mono:'"IBM Plex Mono",ui-monospace,monospace', serif:'"Lora",Georgia,serif', sans:'"Public Sans",system-ui,sans-serif'};
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* ---------- state ---------- */
let notes = [], activeId = null;
let ui = {theme:"paper", font:"mono", size:16, wrap:true, numbers:false, cs:false};
let saveTimer = null, lastLineCount = -1, typing = false, typeTimer = null, hlPending = false;

function persist(){ try{ localStorage.setItem(LS_NOTES, JSON.stringify({notes: notes.map(n => { const {handle, ...rest} = n; return rest; }), activeId})) }catch(e){} }
function persistUI(){ try{ localStorage.setItem(LS_UI, JSON.stringify(ui)) }catch(e){} }
function load(){
  try{ const d = JSON.parse(localStorage.getItem(LS_NOTES)); if(d && Array.isArray(d.notes)){ notes = d.notes; activeId = d.activeId; } }catch(e){}
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
function toast(msg, type=""){
  const t = document.createElement("div"); t.className = "toast " + type; t.textContent = msg;
  $("toasts").appendChild(t); requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, 2400);
}

/* ---------- save indicator ---------- */
function setSave(state){
  $("saveDot").classList.toggle("saving", state === "saving");
  const tx = $("saveTxt"); tx.textContent = state === "saving" ? "Saving…" : "Saved";
  if(state === "saved"){ tx.classList.add("saved-flash"); setTimeout(() => tx.classList.remove("saved-flash"), 900); }
}
function scheduleSave(){ setSave("saving"); clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
  const n = getActive();
  persist();
  if(n && n.handle){
    commitCurrent();
    try{
      if(await writeHandle(n)){
        n.lastSavedContent = n.content; n.savedToDisk = true;
        updateDirty(n); persist();
        setSave("saved");
        $("saveTxt").textContent = "Saved · " + (n.fileName || "file");
        return;
      }
    }catch(e){ /* fall through to local save state */ }
  }
  setSave("saved");
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
    t.className = "tab" + (n.id === activeId ? " active" : "") + (isDirty(n) ? " dirty" : ""); t.dataset.id = n.id; t.draggable = true;
    t.title = `${n.title} · ${(n.content||"").length.toLocaleString()} chars`;
    t.innerHTML = `<span class="t-title">${esc(n.title||"Untitled")}</span>
      <button class="t-x" title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    t.addEventListener("click", e => { if(!e.target.closest(".t-x")) switchNote(n.id); });
    t.querySelector(".t-x").addEventListener("click", e => { e.stopPropagation(); requestClose(n.id); });
    t.addEventListener("dblclick", e => { if(!e.target.closest(".t-x")) startRename(t, n); });
    t.addEventListener("dragstart", e => { t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", n.id); });
    t.addEventListener("dragend", () => { t.classList.remove("dragging"); clearDropMarks(); });
    t.addEventListener("dragover", e => { e.preventDefault(); clearDropMarks();
      const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width/2 ? "drop-l" : "drop-r"); });
    t.addEventListener("drop", e => { e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain"); if(!fromId || fromId === n.id) return;
      const r = t.getBoundingClientRect(), before = e.clientX < r.left + r.width/2;
      const fi = notes.findIndex(x => x.id === fromId); const [moved] = notes.splice(fi, 1);
      let ti = notes.findIndex(x => x.id === n.id); if(!before) ti += 1; notes.splice(ti, 0, moved);
      clearDropMarks(); renderTabs(); persist(); });
    frag.appendChild(t);
  });
  tabsEl.appendChild(frag);
  const act = tabsEl.querySelector(".tab.active"); if(act) act.scrollIntoView({inline:"nearest", block:"nearest"});
}
function clearDropMarks(){ tabsEl.querySelectorAll(".drop-l,.drop-r").forEach(x => x.classList.remove("drop-l","drop-r")); }
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
function closeNote(id){
  const i = notes.findIndex(n => n.id === id); if(i < 0) return;
  const wasActive = id === activeId;
  notes.splice(i, 1);
  HDB.del(id);
  if(wasActive){ activeId = notes.length ? notes[Math.min(i, notes.length-1)].id : null; loadEditor(); }
  renderTabs(); persist(); reindexMemory();
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
  lastLineCount = -1; updateGutter(); updateStatus(); updateHighlight();
}

/* ---------- gutter & status ---------- */
function updateGutter(){
  if(!getActive()){ gutter.innerHTML = ""; lastLineCount = 0; return; }
  const count = editor.value.split("\n").length;
  gutter.classList.toggle("off", !(ui.numbers && !ui.wrap));
  if(count !== lastLineCount){
    lastLineCount = count; let h = "";
    for(let i = 1; i <= count; i++) h += `<div class="gn">${i}</div>`;
    gutter.innerHTML = h;
    const gw = (String(count).length + 2.4) + "ch";
    gutter.style.width = gw; gutter.style.setProperty("--gw", gw);
    markCurLine();
  }
}
function markCurLine(){
  const pos = editor.selectionStart || 0;
  const line = editor.value.slice(0, pos).split("\n").length;
  gutter.querySelectorAll(".gn.cur").forEach(x => x.classList.remove("cur"));
  const el = gutter.children[line-1]; if(el) el.classList.add("cur");
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
  commitCurrent(); updateGutter(); updateStatus(); requestHL(); scheduleSave();
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
function zoom(d){ ui.size = Math.min(40, Math.max(11, ui.size + d)); applyFont(); updateGutter(); persistUI(); }
editor.addEventListener("wheel", e => { if(e.ctrlKey || e.metaKey){ e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); } }, {passive:false});
$("szPlus").onclick = () => zoom(1); $("szMinus").onclick = () => zoom(-1);
$("fontSel").onchange = e => { ui.font = e.target.value; applyFont(); updateGutter(); persistUI(); };

/* ---------- toggles ---------- */
function applyLayout(){
  editor.classList.toggle("wrap", ui.wrap);
  hl.classList.toggle("wrap", ui.wrap);
  $("wrapTog").classList.toggle("on", ui.wrap);
  $("numTog").classList.toggle("on", ui.numbers);
  updateGutter();
}
$("wrapTog").onclick = () => { ui.wrap = !ui.wrap; applyLayout(); persistUI();
  if(ui.wrap && ui.numbers) toast("Line numbers pause while text is wrapped"); };
$("numTog").onclick = () => { ui.numbers = !ui.numbers; applyLayout(); persistUI();
  if(ui.numbers && ui.wrap){ ui.wrap = false; applyLayout(); toast("Wrap turned off so numbers line up"); } };
$("caseTog").onclick = () => { ui.cs = !ui.cs; $("caseTog").classList.toggle("on", ui.cs); persistUI(); refreshFindCount(); };
$("langSel").onchange = e => { const n = getActive(); if(!n) return; n.lang = e.target.value; persist(); updateHighlight(); };

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
  {label:"Download current note as .txt", run:download},
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
  url: {re: /https?:\/\/[^\s<>"')\]]+/gi, label:"URL"},
  email:{re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label:"Email"},
  api:  {re: /(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?:\/[^\s<>"')\]]+|https?:\/\/[^\s<>"')\]]+)|(?:\/api\/|\/v\d+\/)[^\s<>"')\]]*/gi, label:"API"},
  code: {re: /`[^`]+`|```[\s\S]*?```/g, label:"Code"},
  hash: {re: /#[\w\u00C0-\u024F-]+/g, label:"Tag"},
  at:   {re: /@[\w\u00C0-\u024F-]+/g, label:"Mention"}
};
function extractEntities(text){
  const out = [];
  for(const [type, {re, label}] of Object.entries(ENTITIES)){
    const seen = new Set();
    for(const m of (text||"").matchAll(re)){
      const v = m[0].slice(0, 120);
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
  const out = {text:[], filters:{}, since:null, until:null, raw:q};
  let s = q;
  const stops = new Set(["a","an","the","i","me","my","mine","you","your","it","its","this","that","these","those","is","am","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","of","in","on","at","to","for","with","from","by","about","into","onto","up","down","out","off","over","under","again","further","then","once","here","there","when","where","why","how","all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","now","what","which","who","whom","whose","note","noted"]);
  const dateRe = /\b(?:since|after|from|before|until)\b[^,;]{0,60}/gi;
  for(const m of (q.matchAll ? q.matchAll(dateRe) : [])){
    const phrase = m[0].toLowerCase();
    const ts = relativeDateMs(phrase.replace(/^(since|after|from|before|until)\s+/i,""));
    if(ts !== null){
      if(/\b(since|after|from)\b/.test(phrase)) out.since = Math.max(out.since||0, ts);
      if(/\b(before|until)\b/.test(phrase)) out.until = out.until ? Math.min(out.until, ts) : ts;
      s = s.replace(m[0], " ");
    }
  }
  const rel = relativeDateMs(s);
  if(rel !== null && out.since === null && out.until === null){ out.since = rel; out.until = Date.now(); s = s.replace(/\b\d+\s+(day|week|month|year)s?\s+ago\b|today|yesterday|last\s+(week|month|year)\b/gi, " "); }
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
  {icon:"```", label:"Code", q:"code:"}
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
    if(palOv.classList.contains("open")) return closePalette();
    if($("helpOv").classList.contains("open")) return closeHelp();
    if(findbar.classList.contains("open")) return closeFindBar();
    if(document.body.classList.contains("zen")) return setZen(false);
    return;
  }
  if(mod && k === "k"){ e.preventDefault(); palOv.classList.contains("open") ? closePalette() : openPalette(); return; }
  if(mod && k === "m"){ e.preventDefault(); memOv.classList.contains("open") ? closeMemory() : openMemory(); return; }
  if(mod && k === "f"){ e.preventDefault(); openFind(false); return; }
  if(mod && k === "h"){ e.preventDefault(); openFind(true); return; }
  if(mod && e.shiftKey && k === "s"){ e.preventDefault(); openSaveAs(); return; }
  if(mod && k === "s"){ e.preventDefault(); commitCurrent(); persist(); setSave("saved");
    const n = getActive();
    if(n && (n.handle || n.fileName)){ saveLinked(n).then(ok => { if(ok) toast(`Saved to ${n.fileName}`,"ok"); }); }
    else toast("All changes saved locally","ok");
    return; }
  if(mod && (k === "=" || k === "+")){ e.preventDefault(); zoom(1); return; }
  if(mod && k === "-"){ e.preventDefault(); zoom(-1); return; }
  if(mod && k === "0"){ e.preventDefault(); ui.size = 16; applyFont(); updateGutter(); persistUI(); return; }
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