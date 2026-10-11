/**
 * 工作快照 —— 独立 ui 插件
 * 数据通道：shellAPI.listSnapshots / createSnapshot / restoreSnapshot / deleteSnapshot
 */
export const name = 'cuckoo-snapshot';

const CSS = [
  '.cks-wrap{padding:12px}',
  '.cks-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
  '.cks-title{font-size:15px;font-weight:700;letter-spacing:-.02em;color:var(--ck-text);flex:1}',
  '.cks-sub{font-size:11px;color:var(--ck-text-dim);margin-bottom:10px}',
  '.cks-list{display:flex;flex-direction:column;gap:3px}',
  '.cks-item{padding:9px 10px;border-radius:8px;display:flex;gap:8px;align-items:center}',
  '.cks-item:hover{background:var(--ck-surface-hover)}',
  '.cks-main{flex:1;min-width:0}',
  '.cks-name{font-size:12.5px;font-weight:600;color:var(--ck-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.cks-meta{font-size:10.5px;color:var(--ck-text-dim);margin-top:2px;font-variant-numeric:tabular-nums}',
  '.cks-acts{display:flex;gap:2px;flex-shrink:0;opacity:0;transition:opacity .12s}',
  '.cks-item:hover .cks-acts{opacity:1}',
  '.cks-icon{width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--ck-text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center}',
  '.cks-icon:hover{background:var(--ck-surface);color:var(--ck-text)}',
  '.cks-icon.danger:hover{color:var(--ck-danger,#e5484d)}',
  '.cks-icon svg{width:13px;height:13px}',
  '.cks-btn{font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:6px;border:1px solid var(--ck-border-strong);background:transparent;color:var(--ck-text);cursor:pointer}',
  '.cks-btn:hover{background:var(--ck-hover-bg)}',
  '.cks-btn.pri{background:var(--ck-primary,#4d6bfe);border-color:transparent;color:#fff}',
  '.cks-empty{text-align:center;color:var(--ck-text-dim);font-size:12px;padding:28px 0;line-height:1.7}',
].join('');

const RUNNER = '(function(){' +
  'function g(id){return document.getElementById(id)}' +
  'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}' +
  'function fmtSize(b){if(!b)return "0 B";if(b<1024)return b+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";return (b/1048576).toFixed(1)+" MB"}' +
  'function fmtTime(ts){try{return new Date(ts).toLocaleString("zh-CN")}catch(e){return ""}}' +
  'var snaps=[];var curDir=null;' +
  'function render(){' +
    'var el=g("cks-list");if(!el)return;' +
    'if(!snaps.length){el.innerHTML="<div class=\"cks-empty\">暂无快照<br>点上方创建，或让 AI 用 createSnapshot 工具</div>";return}' +
    'el.innerHTML=snaps.map(function(s){' +
      'return "<div class=\"cks-item\" data-id=\""+esc(s.id)+"\">"+' +
        '"<div class=\"cks-main\"><div class=\"cks-name\">"+esc(s.name)+"</div>"+' +
        '"<div class=\"cks-meta\">"+s.fileCount+" 个文件 · "+fmtSize(s.totalBytes)+" · "+fmtTime(s.createdAt)+"</div></div>"+' +
        '"<div class=\"cks-acts\">"+' +
          '"<button class=\"cks-icon\" data-restore=\""+esc(s.id)+"\" title=\"恢复\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/><path d=\"M3 3v5h5\"/></svg></button>"+' +
          '"<button class=\"cks-icon danger\" data-del=\""+esc(s.id)+"\" title=\"删除\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/><path d=\"M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\"/></svg></button>"+' +
        '"</div></div>"' +
    '}).join("");' +
    'var sub=g("cks-sub");if(sub)sub.textContent=snaps.length+" 个快照"+(curDir?(" · "+curDir.split(/[\\/]/).pop()):"");' +
    'el.querySelectorAll("[data-restore]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();doRestore(b.getAttribute("data-restore"))})});' +
    'el.querySelectorAll("[data-del]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();doDel(b.getAttribute("data-del"))})});' +
  '}' +
  'function load(){' +
    'if(!window.shellAPI||!window.shellAPI.listSnapshots)return;' +
    'var p=(window.shellAPI.getProjectDir?window.shellAPI.getProjectDir():Promise.resolve({})).then(function(pr){curDir=(pr&&pr.dir)?pr.dir:null;return window.shellAPI.listSnapshots(curDir||undefined)})' +
      '.then(function(r){snaps=(r&&r.success&&r.snapshots)?r.snapshots:[];render()}).catch(function(){})' +
  '}' +
  'function doCreate(){' +
    'if(!curDir){alert("请先选择项目目录");return}' +
    'var n=prompt("创建快照","快照-"+new Date().toLocaleString("zh-CN"));if(n===null)return;' +
    'n=n.trim();if(!n)return;' +
    'window.shellAPI.createSnapshot(curDir,n).then(function(r){if(r&&!r.success)alert("创建失败："+(r.error||""));load()})' +
  '}' +
  'function doRestore(id){' +
    'var s=snaps.filter(function(x){return x.id===id})[0];' +
    'if(!confirm("确定把快照「"+(s?s.name:"")+"」恢复到项目目录？将覆盖同名文件。"))return;' +
    'window.shellAPI.restoreSnapshot(id).then(function(){alert("已恢复");load()})' +
  '}' +
  'function doDel(id){' +
    'if(!confirm("确定删除该快照？"))return;' +
    'window.shellAPI.deleteSnapshot(id).then(load)' +
  '}' +
  'window.__cksCreate=doCreate;window.__cksLoad=load;' +
  'load();' +
  'if(!window.__cksTimer)window.__cksTimer=setInterval(load,8000);' +
'})()';

const HTML = [
  '<div class="cks-wrap">',
  '  <div class="cks-head">',
  '    <span class="cks-title">工作快照</span>',
  '    <button class="cks-btn pri" onclick="window.__cksCreate&&window.__cksCreate()">创建</button>',
  '    <button class="cks-btn" onclick="window.__cksLoad&&window.__cksLoad()">刷新</button>',
  '  </div>',
  '  <div class="cks-sub" id="cks-sub">加载中…</div>',
  '  <div class="cks-list" id="cks-list"><div class="cks-empty">加载中…</div></div>',
  '  <img src="x" style="width:0;height:0;position:absolute;opacity:0" onerror="' + RUNNER.replace(/"/g, '&quot;') + '">',
  '</div>',
].join('');

export function apply(ctx) {
  try {
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addStyle === 'function') ctx.ui.shell.addStyle(CSS);
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addSidebarPanel === 'function') {
      ctx.ui.shell.addSidebarPanel({ id: 'cuckoo-snapshot', title: '工作快照', html: HTML })
        .then(function () { ctx.log('快照面板已挂载'); })
        .catch(function (e) { ctx.log('挂载失败: ' + (e && e.message)); });
    }
  } catch (e) { ctx.log('出错: ' + (e && e.message)); }
}
