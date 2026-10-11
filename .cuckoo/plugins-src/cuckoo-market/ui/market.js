/**
 * 插件市场 —— 独立 ui 插件版（阶段 E）
 *
 * 与 shell 内建市场页的区别：
 *  - 本插件通过 ctx.ui.shell.addSidebarPanel 挂自己的侧边栏图标 + 面板
 *  - 面板内联 handler 走 window.shellAPI.pluginHostCall 拿数据（不依赖 shell 页逻辑）
 *  - 可独立装卸/热重载，不绑定 Cuckoo 版本
 *
 * 当前为第一版：列表 + 安装 + 刷新。
 * 搜索/分类/详情 后续迭代（先把"市场是插件"这条架构打通）。
 */
export const name = 'cuckoo-market';

const CATALOG_URLS = [
  'https://cdn.jsdelivr.net/gh/8555uuy/cuckoo-plugin-market@main/plugins.json',
  'https://raw.githubusercontent.com/8555uuy/cuckoo-plugin-market/main/plugins.json',
];

const CSS = [
  '.ckm-wrap{padding:12px}',
  '.ckm-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
  '.ckm-title{font-size:15px;font-weight:700;letter-spacing:-.02em;color:var(--ck-text);flex:1}',
  '.ckm-sub{font-size:11px;color:var(--ck-text-dim);margin-bottom:10px}',
  '.ckm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}',
  '.ckm-card{border:1px solid var(--ck-border);border-radius:10px;overflow:hidden;background:var(--ck-bg);cursor:pointer;display:flex;flex-direction:column}',
  '.ckm-card:hover{border-color:var(--ck-border-strong)}',
  '.ckm-cover{width:100%;height:110px;object-fit:cover;background:var(--ck-surface);border-bottom:1px solid var(--ck-border)}',
  '.ckm-body{padding:10px 11px 11px;display:flex;flex-direction:column;gap:5px;flex:1}',
  '.ckm-name{font-size:13px;font-weight:650;color:var(--ck-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ckm-desc{font-size:11.5px;color:var(--ck-text-2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.ckm-meta{font-size:10.5px;color:var(--ck-text-dim);margin-top:auto;display:flex;gap:6px}',
  '.ckm-empty{text-align:center;color:var(--ck-text-dim);font-size:12px;padding:30px 0}',
  '.ckm-btn{font-family:inherit;font-size:11px;font-weight:600;padding:5px 10px;border-radius:6px;border:1px solid var(--ck-border-strong);background:transparent;color:var(--ck-text);cursor:pointer}',
  '.ckm-btn:hover{background:var(--ck-hover-bg)}',
  '.ckm-btn:disabled{opacity:.45;cursor:not-allowed}',
  '.ckm-upload{margin-top:12px;padding:9px 11px;border:1px dashed var(--ck-border-strong);border-radius:9px;font-size:11.5px;color:var(--ck-text-2);display:flex;align-items:center;gap:8px}',
].join('');

/** 壳页面上下文里跑的脚本：拉目录 + 渲染 + 安装（内联 handler 调 shellAPI） */
const RUNNER = '(function(){' +
  'var PID="cuckoo-market";' +
  'var URLS=' + JSON.stringify(CATALOG_URLS) + ';' +
  'function g(id){return document.getElementById(id)}' +
  'function esc(s){return String(s==null?"":s).replace(/[&<>"\"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}' +
  'function card(it){' +
    'var cover=it.cover?("<img class=\"ckm-cover\" src=\""+esc(it.cover)+"\" loading=\"lazy\" onerror=\"this.style.display=\'none\'\">"):"";' +
    'var meta=[];if(it.version)meta.push("v"+esc(it.version));if(it.stars)meta.push("★ "+it.stars);' +
    'return "<div class=\"ckm-card\" data-id=\""+esc(it.id)+"\">"+cover+' +
      '"<div class=\"ckm-body\"><div class=\"ckm-name\">"+esc(it.name||it.id)+"</div>' +
      '"<div class=\"ckm-desc\">"+esc(it.description||"（无简介）")+"</div>' +
      '"<div class=\"ckm-meta\">"+meta.join(" · ")+"</div>' +
      '"<div style=\"margin-top:6px\"><button class=\"ckm-btn\" data-install=\""+esc(it.id)+"\">安装</button></div>' +
      '"</div></div>"' +
  '}' +
  'function render(items,note){' +
    'var el=g("ckm-list");if(!el)return;' +
    'if(!items||!items.length){el.innerHTML="<div class=\"ckm-empty\">"+esc(note||"暂无插件")+"</div>";return}' +
    'el.innerHTML="<div class=\"ckm-grid\">"+items.map(card).join("")+"</div>";' +
    'el.querySelectorAll("[data-install]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();doInstall(b.getAttribute("data-install"),b)})})' +
  '}' +
  'function doInstall(repo,btn){' +
    'if(!window.shellAPI||!window.shellAPI.pluginInstall)return;' +
    'btn.disabled=true;btn.textContent="安装中…";' +
    'var branch="main";' +
    'window.shellAPI.pluginInstall(repo,branch,false).then(function(r){' +
      'btn.disabled=false;' +
      'if(r&&r.success){btn.textContent="已安装";btn.disabled=true}else{btn.textContent="安装";alert("安装失败: "+((r&&r.error)||"未知"))}' +
    '}).catch(function(){btn.disabled=false;btn.textContent="安装"})' +
  '}' +
  'function load(force){' +
    'var el=g("ckm-list");if(el)el.innerHTML="<div class=\"ckm-empty\">加载中…</div>";' +
    'if(!window.shellAPI||!window.shellAPI.pluginMarketCurated){if(el)el.innerHTML="<div class=\"ckm-empty\">接口不可用（需重启 Cuckoo）</div>";return}' +
    'window.shellAPI.pluginMarketCurated({force:!!force}).then(function(r){' +
      'var sub=g("ckm-sub");' +
      'if(r&&r.success&&r.items){' +
        'if(sub)sub.textContent="目录 "+(r.updatedAt||"")+" · "+r.items.length+" 个插件";' +
        'render(r.items)' +
      '}else{render([],(r&&r.error)||"加载失败")}' +
    '}).catch(function(){render([],"加载失败")})' +
  '}' +
  'window.__ckmLoad=load;' +
  'load(false);' +
  'if(!window.__ckmTimer)window.__ckmTimer=setInterval(function(){load(false)},300000);' +
'})()';

const HTML = [
  '<div class="ckm-wrap">',
  '  <div class="ckm-head">',
  '    <span class="ckm-title">插件市场</span>',
  '    <button class="ckm-btn" onclick="window.__ckmLoad&&window.__ckmLoad(true)">刷新</button>',
  '  </div>',
  '  <div class="ckm-sub" id="ckm-sub">加载中…</div>',
  '  <div id="ckm-list"><div class="ckm-empty">加载中…</div></div>',
  '  <div class="ckm-upload">',
  '    <span style="flex:1">想上架你的插件？给仓库打 topic <b>cuckoo-plugin</b></span>',
  '    <button class="ckm-btn" onclick="window.shellAPI&&window.shellAPI.openExternal&&window.shellAPI.openExternal(\'https://github.com/8555uuy/cuckoo-plugin-market\')">说明</button>',
  '  </div>',
  '  <img src="x" style="width:0;height:0;position:absolute;opacity:0" onerror="' + RUNNER.replace(/"/g, '&quot;') + '">',
  '</div>',
].join('');

export function apply(ctx) {
  try {
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addStyle === 'function') {
      ctx.ui.shell.addStyle(CSS);
    }
    if (ctx.ui && ctx.ui.shell && typeof ctx.ui.shell.addSidebarPanel === 'function') {
      ctx.ui.shell.addSidebarPanel({ id: 'cuckoo-market', title: '插件市场', html: HTML })
        .then(function () { ctx.log('插件市场面板已挂载'); })
        .catch(function (e) { ctx.log('挂载失败: ' + (e && e.message)); });
    }
  } catch (e) { ctx.log('出错: ' + (e && e.message)); }
}
