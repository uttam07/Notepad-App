/* ============================================================
   Steno — syntax highlighting engine
   Standalone: no DOM dependencies. Exposes window.StenoHighlight
     .render(text, lang) -> HTML string
     .detect(text)       -> language id
   Languages: html, css, js, json, md, plain
   ============================================================ */
(function (global) {
"use strict";

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;

/* ---------- rule sets (order matters: first match wins) ---------- */
const cssRules = [
  {type:"com",  re:/\/\*[\s\S]*?(?:\*\/|$)/y},
  {type:"str",  re:/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y},
  {type:"at",   re:/@[\w-]+/y},
  {type:"key",  re:/!important\b/y},
  {type:"color",re:new RegExp(HEX_RE.source,"y")},
  {type:"color",re:/\b(?:rgba?|hsla?)\(\s*[\d\s.,%\/-]*\)?/y},
  {type:"num",  re:/-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|svh|dvh|%|s|ms|deg|turn|fr|ch|ex|pt)?/y,
                guard:c=>!/[\w-]/.test(c)},
  {type:"prop", re:/[a-zA-Z-]+(?=\s*:)/y},
  {type:"sel",  re:/[.#][\w-]+/y},
  {type:"pun",  re:/[{}();:,>~+*]/y},
];
const jsRules = [
  {type:"com", re:/\/\/[^\n]*/y},
  {type:"com", re:/\/\*[\s\S]*?(?:\*\/|$)/y},
  {type:"str", re:/`(?:\\[\s\S]|[^`\\])*`?/y},
  {type:"str", re:/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y},
  {type:"key", re:/\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/y},
  {type:"lit", re:/\b(?:true|false|null|undefined|NaN|Infinity)\b/y},
  {type:"num", re:/\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y,
               guard:c=>!/[\w$.]/.test(c)},
  {type:"fn",  re:/[A-Za-z_$][\w$]*(?=\s*\()/y},
  {type:"pun", re:/=>|[+\-*/%=<>!&|?:^~.,;(){}\[\]]/y},
];
const jsonRules = [
  {type:"attr",re:/"(?:\\.|[^"\\])*"(?=\s*:)/y},
  {type:"str", re:/"(?:\\.|[^"\\])*"?/y},
  {type:"lit", re:/\b(?:true|false|null)\b/y},
  {type:"num", re:/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, guard:c=>!/[\w$.]/.test(c)},
  {type:"pun", re:/[{}\[\]:,]/y},
];
const mdRules = [
  {type:"key", re:/^#{1,6}[^\n]*/my},
  {type:"com", re:/^```[\s\S]*?(?:```|$)/y},
  {type:"pun", re:/^>[^\n]*/my},
  {type:"lit", re:/\*\*[^*\n]+\*\*/y},
  {type:"str", re:/`[^`\n]+`/y},
  {type:"fn",  re:/\[[^\]\n]*\]\([^)\n]*\)/y},
  {type:"attr",re:/^[-*+] /my},
  {type:"color",re:new RegExp(HEX_RE.source,"y"), guard:c=>!/[\w]/.test(c)},
];
const plainRules = [
  {type:"color",re:new RegExp(HEX_RE.source,"y"), guard:c=>!/[\w]/.test(c)},
];
const tagRules = [
  {type:"str", re:/"[^"]*"?|'[^']*'?/y},
  {type:"tag", re:/[a-zA-Z][\w:-]*/y},
  {type:"attr",re:/[^\s=\/>"']+/y},
  {type:"pun", re:/<\/?|\/?>|=/y},
];

/* ---------- scanners ---------- */
function scanRules(text, rules, emit){
  let i = 0, plainStart = 0; const n = text.length;
  while(i < n){
    const prev = i ? text[i-1] : "";
    let matched = false;
    for(const r of rules){
      if(r.guard && !r.guard(prev)) continue;
      r.re.lastIndex = i;
      const m = r.re.exec(text);
      if(m && m[0]){
        if(i > plainStart) emit("plain", text.slice(plainStart, i));
        emit(r.type, m[0]);
        i += m[0].length; plainStart = i; matched = true; break;
      }
    }
    if(!matched) i++;
  }
  if(plainStart < n) emit("plain", text.slice(plainStart, n));
}
function scanCSS(text, emit){
  let depth = 0;
  scanRules(text, cssRules, (type, str) => {
    if(type === "pun"){ if(str === "{") depth++; else if(str === "}") depth = Math.max(0, depth-1); }
    if(type === "prop" && depth === 0) type = "sel";
    emit(type, str);
  });
}
function findTagEnd(text, start){
  let j = start + 1, q = "";
  while(j < text.length){
    const c = text[j];
    if(q){ if(c === q) q = ""; }
    else if(c === '"' || c === "'") q = c;
    else if(c === ">") return j + 1;
    j++;
  }
  return text.length;
}
function scanHTML(text, emit){
  let i = 0, container = ""; const n = text.length;
  const emitChunk = chunk => {
    if(!chunk) return;
    if(container === "style") scanCSS(chunk, emit);
    else if(container === "script") scanRules(chunk, jsRules, emit);
    else emit("plain", chunk);
  };
  while(i < n){
    const lt = text.indexOf("<", i);
    if(lt === -1){ emitChunk(text.slice(i)); return; }
    if(lt > i) emitChunk(text.slice(i, lt));
    i = lt;
    if(text.startsWith("<!--", i)){
      let end = text.indexOf("-->", i + 4); end = end === -1 ? n : end + 3;
      emit("com", text.slice(i, end)); i = end; continue;
    }
    if(text.startsWith("<!", i)){
      let end = text.indexOf(">", i); end = end === -1 ? n : end + 1;
      emit("key", text.slice(i, end)); i = end; continue;
    }
    const gt = findTagEnd(text, i);
    const tagText = text.slice(i, gt);
    scanRules(tagText, tagRules, emit);
    const nameM = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(tagText);
    const name = nameM ? nameM[1].toLowerCase() : "";
    if(tagText[1] === "/"){ if(name === container) container = ""; }
    else if(name === "style" || name === "script") container = name;
    i = gt;
  }
}

/* ---------- output ---------- */
function makeEmit(out){
  return (type, str) => {
    if(!str) return;
    const s = esc(str);
    if(type === "plain"){ out.push(s); return; }
    if(type === "color"){
      out.push('<span class="tk-color"><i class="sw" style="background:' + str.trim() + '"></i>' + s + "</span>");
      return;
    }
    if(type === "str"){
      const hm = str.match(/^["'](#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4}))["']$/);
      if(hm){ out.push('<span class="tk-str"><i class="sw" style="background:' + hm[1] + '"></i>' + s + "</span>"); return; }
    }
    out.push('<span class="tk-' + type + '">' + s + "</span>");
  };
}
function render(text, lang){
  if(text.length > 160000) lang = "plain";
  const out = [], emit = makeEmit(out);
  if(lang === "html") scanHTML(text, emit);
  else if(lang === "css") scanCSS(text, emit);
  else if(lang === "js") scanRules(text, jsRules, emit);
  else if(lang === "json") scanRules(text, jsonRules, emit);
  else if(lang === "md") scanRules(text, mdRules, emit);
  else scanRules(text, plainRules, emit);
  return out.join("");
}
function detect(t){
  const s = t.slice(0, 4000);
  if(!s.trim()) return "plain";
  if(/^\s*[{\[]/.test(s) && /["']\s*:/.test(s)) return "json";
  if(/<!doctype\s+html|<\/?[a-z][^>]*>/i.test(s)) return "html";
  if(/\b(const|let|var|function|=>|document\.|console\.|import |export |return )\b/.test(s)) return "js";
  if(/(^|\n)\s*[\w.#:\-\[\]="' *,>+~()]*\{[^}]*:[^}]*\}/.test(s) || /(^|\n)\s*[-\w]+\s*:\s*[^;{}]+;/.test(s)) return "css";
  if(/^\s*#{1,6} /m.test(s)) return "md";
  return "plain";
}

global.StenoHighlight = { render, detect };
})(window);