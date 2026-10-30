/**
 * 把包装过的函数伪装成原生函数（需求 100）。
 *
 * 为什么需要：hook 会替换 window.fetch 与 XMLHttpRequest.prototype.open/send/setRequestHeader。
 * 站点的反自动化检测只要一行 `window.fetch.toString()` 就能看到源码，直接识破。
 * 这里把实例上的 toString 覆写成原生形态，并补齐 length —— 原生函数没有自有 toString，
 * 且 length 是固定值（fetch=1、send=0、open=2、setRequestHeader=2），
 * 不补齐的话 `Object.getOwnPropertyNames(window.fetch)` 和 `window.fetch.length` 一行就露馅。
 *
 * 局限（已知残留）：`Function.prototype.toString.call(window.fetch)` 会绕过实例属性，
 * 直接走原生原型方法。防它必须改 Function.prototype.toString 本身，破坏面过大，不做。
 *
 * 构建期被 esbuild 内联进各平台 hook（见 scripts/build-hooks.mjs），运行时无外部依赖。
 */

/**
 * @param fn 被包装后的函数（会就地修改其 toString / name / length）
 * @param name 伪装成的方法名；缺省取 fn.name
 * @param nativeLength 原生函数的 length（arity），用于对齐；缺省不改
 * @returns 原函数（便于链式使用）
 */
function maskAsNative(fn: any, name?: string, nativeLength?: number): any {
  if (typeof fn !== 'function') return fn;
  var fname = name || fn.name || '';
  try {
    Object.defineProperty(fn, 'name', { value: fname, configurable: true });
  } catch (e) { /* ignore */ }
  if (typeof nativeLength === 'number' && nativeLength >= 0) {
    try {
      Object.defineProperty(fn, 'length', { value: nativeLength, configurable: true });
    } catch (e) { /* ignore */ }
  }
  try {
    Object.defineProperty(fn, 'toString', {
      value: function () {
        return 'function ' + fname + '() { [native code] }';
      },
      configurable: true,
      writable: true,
    });
  } catch (e) { /* ignore */ }
  return fn;
}

export { maskAsNative };
