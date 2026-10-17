/**
 * JsRunner 沙箱 bootstrap 脚本拼装（A-005 抽出）
 *
 * 纯字符串拼装，不碰 vm/进程——主进程调用后把拼好的脚本通过 run 消息发给
 * 独立 worker 进程（js-sandbox-worker.mjs）执行。worker 不 import 任何 src/TS。
 */
import path from 'node:path';
import { TOOL_BOOTSTRAP } from './bootstrap.generated.js';

/**
 * 沙箱初始化脚本：在沙箱上下文内定义 log/projectDir/sleep/setTimeout/__call。
 * 依赖沙箱 globalThis 上预置：__hostBridge / __projectDir / __hostSetTimeout / __hostClearTimeout。
 */
function buildBootstrapScript(): string {
  return [
    "'use strict';",
    "(function () {",
    "  globalThis.__logs = [];",
    "",
    "  function __stringify(value) {",
    "    if (typeof value === 'string') return value;",
    "    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }",
    "  }",
    "",
    "  globalThis.log = function () {",
    "    var parts = [];",
    "    for (var i = 0; i < arguments.length; i++) parts.push(__stringify(arguments[i]));",
    "    globalThis.__logs.push(parts.join(' '));",
    "  };",
    "",
    "  globalThis.projectDir = __projectDir;",
    "",
    "  // 计时器：沙箱原本没有 setTimeout/sleep，AI 常用它们做等待（实现在 worker 进程内）",
    "  globalThis.sleep = function (ms) {",
    "    return new Promise(function (resolve) { __hostSetTimeout(resolve, ms || 0); });",
    "  };",
    "  globalThis.setTimeout = function (fn, ms) {",
    "    var extra = Array.prototype.slice.call(arguments, 2);",
    "    return __hostSetTimeout(function () { fn.apply(null, extra); }, ms || 0);",
    "  };",
    "  globalThis.clearTimeout = function (id) { __hostClearTimeout(id); };",
    "",
    "  async function __call(name, args) {",
    "    var resText = await __hostBridge(name, JSON.stringify(args == null ? {} : args));",
    "    var res;",
    "    try { res = JSON.parse(resText); } catch (e) { throw new Error('工具结果解析失败: ' + e.message); }",
    "    if (!res || res.success !== true) {",
    "      throw new Error((res && res.error) || ('工具 ' + name + ' 执行失败'));",
    "    }",
    "    return res.data;",
    "  }",
    "",
    TOOL_BOOTSTRAP,
    "",
    "  if (!globalThis.projectDir) {",
    "    globalThis.log('[提示] 尚未初始化项目目录，相对路径将基于系统目录解析。可点击覆盖层“初始化项目”。');",
    "  }",
    "})();",
    "",
  ].join('\n');
}

/** 合法 JS 标识符（防注入：插件工具名/参数名来自不可信插件） */
const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 为"运行时动态工具"（插件工具）生成沙箱注入代码。
 * 每个工具生成 globalThis.<name> = async function(...) { return await __call('<name>', {...}) }
 * @returns 注入代码；无动态工具时返回空串
 */
function buildDynamicToolsBootstrap(registry: any): string {
  if (!registry || typeof registry.getDynamicTools !== 'function') return '';
  const tools = registry.getDynamicTools();
  if (!tools || tools.length === 0) return '';
  // 用暴露的 __hostBridge（沙箱 globalThis 上）——不能依赖 BOOTSTRAP IIFE 内的局部 __call
  const lines: string[] = ['(function () {', "'use strict';"];
  for (const tool of tools) {
    const name = tool.name;
    if (!JS_IDENT_RE.test(name)) continue; // 非法标识符，跳过
    const props = Object.keys((tool.parameters && tool.parameters.properties) || {})
      .filter((p) => JS_IDENT_RE.test(p));
    const params = props.join(', ');
    const argsObj = props.map((p) => p + ': ' + p).join(', ');
    lines.push('  globalThis.' + name + ' = async function (' + params + ') {');
    lines.push('    var resText = await globalThis.__hostBridge(' + JSON.stringify(name) + ', JSON.stringify({ ' + argsObj + ' }));');
    lines.push('    var res; try { res = JSON.parse(resText); } catch (e) { throw new Error("工具结果解析失败: " + e.message); }');
    lines.push('    if (!res || res.success !== true) { throw new Error((res && res.error) || "工具 ' + name + ' 执行失败"); }');
    lines.push('    return res.data;');
    lines.push('  };');
  }
  lines.push('})();');
  return lines.join('\n');
}

export { buildBootstrapScript, buildDynamicToolsBootstrap };
