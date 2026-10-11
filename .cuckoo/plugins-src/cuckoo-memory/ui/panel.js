/**
 * 记忆 —— 独立 ui 插件
 * 数据通道：shellAPI.listMemories / addMemory / saveMemories / deleteMemory
 * （与 AI 的 remember 工具共享同一份数据，改完 AI 下轮就能看到）
 */
export const name = 'cuckoo-memory';

const CSS = [
  '.ckm2-wrap{padding:12px}',
  '.ckm2-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
  '.ckm2-title{font-size:15px;font-weight:700;letter-spacing:-.02em;color:var(--ck-text);flex:1}',
  '.ckm2-sub{font-size:11px;color:var(--ck-text-dim);margin-bottom:10px}',
  '.ckm2-list{display:flex;flex-direction:column;gap:2px}',
  '.ckm2-item{padding:9px 10px;border-radius:8px;cursor:default;display:flex;gap:8px;align-items:flex-start}',
  '.ckm2-item:hover{background:var(--ck-surface-hover)}',
  '.ckm2-text{flex:1;font-size:12.5px;color:var(--ck-text);line-height:1.55;word-break:break-word}',
  '.ckm2-acts{display:flex;gap:2px;flex-shrink:0;opacity:0;transition:opacity .12s}',
  '.ckm2-item:hover .ckm2-acts{opacity:1}',
  '.ckm2-icon{width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--ck-text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center}',
  '.ckm2-icon:hover{background:var(--ck-surface);color:var(--ck-text)}',
  '.ckm2-icon.danger:hover{color:var(--ck-danger,#e5484d)}',
  '.ckm2-icon svg{width:13px;height:13px}',
  '.ckm2-btn{font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:6px;border:1px solid var(--ck-border-strong);background:transparent;color:var(--ck-text);cursor:pointer}',
  '.ckm2-btn:hover{background:var(--ck-hover-bg)}',
  '.ckm2-btn.pri{background:var(--ck-primary,#4d6bfe);border-color:transparent;color:#fff}',
  '.ckm2-empty{text-align:center;color:var(--ck-text-dim);font-size:12px;padding:28px 0;line-height:1.7}',
].join('');

const RUNNER = '(function(){' +
  'function g(id){return document.getElementById(id)}' +
  'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}' +
  'var mems=[];' +
  'function render(){' +
    'var el=g("ckm2-list");if(!el)return;' +
    'if(!mems.length){el.innerHTML="<div class=\"ckm2-empty\">还没有记忆<br>点上方新建，或让 AI 用 remember 工具记</div>";return}' +
    'el.innerHTML=mems.map(function(m){' +
      'return "<div class=\"ckm2-item\" data-id=\""+esc(m.id)+"\">"+' +
        '"<span class=\"ckm2-text\">"+esc(m.text)+"</span>"+' +
        '"<div class=\"ckm2-acts\">"+' +
          '"<button class=\"ckm2-icon\" data-edit=\""+esc(m.id)+"\" title=\"编辑\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z\"/></svg></button>"+' +
          '"<button class=\"ckm2-icon danger\" data-del=\""+esc(m.id)+"\" title=\"删除\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/><path d=\"M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\"/></svg></button>"+' +
        '"</div></div>"' +
    '}).join("");' +
    'var sub=g("ckm2-sub");if(sub)sub.textContent=mems.length+" 条记忆 · 跨会话保留";' +
    'el.querySelectorAll("[data-edit]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();doEdit(b.getAttribute("data-edit"))})});' +
    'el.querySelectorAll("[data-del]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();doDel(b.getAttribute("data-del"))})});' +
  '}' +
  'function load(){' +
    'if(!window.shellAPI||!window.shellAPI.listMemories)return;' +
    'window.shellAPI.listMemories().then(function(r){mems=(r&&r.success&&r.memories)?r.memories:[];render()}).catch(function(){})' +
  '}' +
  'function doAdd(){' +
    'var t=prompt("新建记忆（如：用户偏好用中文回复）");if(t===null)return;' +
    't=t.trim();if(!t)return;' +
    'window.shellAPI.addMemory(t).then(load)' +
  '}' +
  'function doEdit(id){' +
    'var m=mems.filter(function(x){return x.id===id})[0];if(!m)return;' +
    'var t=prompt("编辑记忆",m.text);if(t===null)return;' +
    't=t.trim();if(!t)return;' +
    'mems=mems.map(function(x){return x.id===m.id?Object.assign({},x,{text:t}):x});' +
    'window.shellAPI.saveMemories(mems).then(load)' +
  '}' +
  'function doDel(id){' +
    'if(!confirm("确定删除这条记忆？"))return;' +
    'window.shellAPI.deleteMemory(id).then(load)' +
  '}' +
  'window.__ckm2Add=doAdd;window.__ckm2Load=load;' +
  'load();' +
  'if(!window.__ckm2Timer)window.__ckm2Timer=setInterval(load,8000);' +
'})()';

const HTML = [
  '<div class="ckm2-wrap">',
  '  <div class="ckm2-head">',
  '    <span class="ckm2-title">记忆</span>',
  '    <button class="ckm2-btn pri" onclick="window.__ckm2Add&&window.__ckm2Add()">新建</button>',
  '    <button class="ckm2-btn" onclick="window.__ckm2Load&&window.__ckm2Load()">刷新</button>',
  '  </div>',
  '  <div class="ckm2-sub" id="ckm2-sub">加载中…</div>',
  '  <div class="ckm2-list" id="ckm2-list"><div class="ckm2-empty">加载中…</div></div>',
  '  <img src="x" style="width:0;height:0;position:absolute;opacity:0" onerror="' + RUNNER.replace(/"/g, '&quot;') + '">',
  '</div>',
].join('');

export function apply(ctx) {
  try {
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addStyle === 'function') ctx.ui.shell.addStyle(CSS);
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addSidebarPanel === 'function') {
      ctx.ui.shell.addSidebarPanel({ id: 'cuckoo-memory', title: '记忆', html: HTML })
        .then(function () { ctx.log('记忆面板已挂载'); })
        .catch(function (e) { ctx.log('挂载失败: ' + (e && e.message)); });
    }
  } catch (e) { ctx.log('出错: ' + (e && e.message)); }
}
