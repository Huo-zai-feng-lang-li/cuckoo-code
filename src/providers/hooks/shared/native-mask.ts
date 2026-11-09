/**
 * 把包装过的函数伪装成原生函数（需求 100）。
 *
 * 为什么需要：hook 会替换 window.fetch 与 XMLHttpRequest.prototype.open/send/setRequestHeader。
 * 站点的反自动化检测只要一行 `window.fetch.toString()` 就能看到源码，直接识破。
 * 原生函数无 prototype、没有自有 toString，且 length 为固定值。
 * 本模块同时通过闭包 WeakMap 对接 Function.prototype.toString，
 * 使得 fn.toString() 与 Function.prototype.toString.call(fn) 均完美返回 [native code]。
 *
 * 构建期被 esbuild 内联进各平台 hook（见 scripts/build-hooks.mjs），运行时无外部依赖。
 */

/**
 * @param fn 被包装后的函数（会就地修改其 toString / name / length 并移除 prototype）
 * @param name 伪装成的方法名；缺省取 fn.name
 * @param nativeLength 原生函数的 length（arity），用于对齐；缺省不改
 * @returns 原函数（便于链式使用）
 */
var nativeStringMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
var isToStringPatched = false;
var isPatchingLock = false;

function ensureToStringPatched(): void {
  if (isToStringPatched || !nativeStringMap || isPatchingLock) return;
  isPatchingLock = true;
  try {
    var origToString = Function.prototype.toString;
    var patchedToString = function (this: any) {
      if (nativeStringMap && nativeStringMap.has(this)) {
        return nativeStringMap.get(this);
      }
      return origToString.apply(this, arguments as any);
    };
    try { Object.defineProperty(patchedToString, 'name', { value: 'toString', configurable: true }); } catch (_) {}
    try { delete (patchedToString as any).prototype; } catch (_) {}
    Function.prototype.toString = patchedToString;
    nativeStringMap.set(patchedToString, 'function toString() { [native code] }');
    isToStringPatched = true;
  } catch (_) {} finally {
    isPatchingLock = false;
  }
}

function maskAsNative(fn: any, name?: string, nativeLength?: number): any {
  if (typeof fn !== 'function') return fn;
  var fname = name || fn.name || '';
  ensureToStringPatched();
  try {
    delete fn.prototype;
  } catch (_) { /* ignore */ }
  try {
    Object.defineProperty(fn, 'name', { value: fname, configurable: true });
  } catch (e) { /* ignore */ }
  if (typeof nativeLength === 'number' && nativeLength >= 0) {
    try {
      Object.defineProperty(fn, 'length', { value: nativeLength, configurable: true });
    } catch (e) { /* ignore */ }
  }
  var nativeStr = 'function ' + fname + '() { [native code] }';
  if (nativeStringMap) {
    try {
      nativeStringMap.set(fn, nativeStr);
    } catch (_) {}
  }
  try {
    Object.defineProperty(fn, 'toString', {
      value: function () {
        return nativeStr;
      },
      configurable: true,
      writable: true,
    });
  } catch (e) { /* ignore */ }
  return fn;
}

export { maskAsNative };
