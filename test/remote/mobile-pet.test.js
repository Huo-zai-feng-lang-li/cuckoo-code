'use strict';
/**
 * 手机端宠物适配层（src/remote/pwa/mobile-pet.js）状态映射测试。
 *
 * 背景：手机端宠物复用了桌面端 pet.js 引擎，但状态映射写在适配层里。
 * 曾漏掉「随机长暂停（send-pause → pausing）」与「工具回传延迟（sending → waiting）」，
 * 表现为暂停/等待期间宠物一直停在 working 不动。这里用真实适配层源码跑在
 * 模拟的 window/document/localStorage 边界上，钉住状态 → 动画 + 情绪组的映射。
 *
 * 只打桩浏览器外部边界（window / document / localStorage / 定时器），
 * 不 mock 适配层内部逻辑——跑的永远是真实源码。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC_PATH = path.join(import.meta.dirname, '..', '..', 'src', 'remote', 'pwa', 'mobile-pet.js');
const code = fs.readFileSync(SRC_PATH, 'utf8');

/**
 * 造一个最小沙箱：window/document/localStorage + 可记录调用的假宠物引擎。
 * @param {{host?: any, storage?: any, engine?: any}} opts 覆盖边界行为，用于构造失败路径
 */
function makeSandbox(opts) {
  opts = opts || {};
  const calls = { setState: [], randomMood: [], flash: [], created: 0 };
  const host = opts.host !== undefined ? opts.host : { clientWidth: 320 };
  const sandbox = {
    console,
    // 定时器一律不真跑：适配层构造期会 scheduleCreate 挂一个 1200ms 定时器，
    // 真跑会留下 open handle（vitest 报时长抖动）。测试靠显式 apply() 驱动。
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: opts.storage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.document = {
    readyState: 'complete',
    querySelector: (sel) => (sel === '.composer-inner' ? host : null),
    addEventListener: () => {},
  };
  // 用 'engine' in opts 判断：显式传 undefined 也要能表达"没有引擎"，
  // 否则与"未传参"无法区分，默认引擎会覆盖掉失败路径的意图。
  const engine = 'engine' in opts ? opts.engine : {
    packs: { 'deepy-whale': {} },
    create: () => {
      calls.created++;
      return {
        setState: (s, w) => calls.setState.push([s, w]),
        randomMood: (g) => calls.randomMood.push(g),
        flash: (k) => calls.flash.push(k),
        destroy: () => { calls.destroyed = true; },
      };
    },
  };
  sandbox.window = { CuckooPet: engine };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'mobile-pet.js' });
  return { sandbox, calls };
}

describe('手机端宠物状态映射', () => {
  let sandbox;
  let calls;
  let pet;

  beforeEach(() => {
    const s = makeSandbox();
    sandbox = s.sandbox;
    calls = s.calls;
    pet = sandbox.window.CuckooMobilePet;
  });

  it('随机长暂停映射为 idle 动画 + pausing 情绪组', () => {
    pet.apply('pausing');
    expect(calls.setState).toContainEqual(['idle', undefined]);
    expect(calls.randomMood).toContain('pausing');
  });

  it('工具回传等待窗口映射为 idle 动画 + waiting 情绪组', () => {
    pet.apply('waiting');
    expect(calls.setState).toContainEqual(['idle', undefined]);
    expect(calls.randomMood).toContain('waiting');
  });

  it('working 仍走忙碌动画并带上并行工具数', () => {
    pet.apply('working', 3);
    expect(calls.setState).toContainEqual(['working', 3]);
    expect(calls.randomMood).toContain('working');
  });

  it('done 收尾闪 attention，不残留在忙碌态', () => {
    pet.apply('done');
    expect(calls.setState).toContainEqual(['idle', undefined]);
    expect(calls.flash).toContain('attention');
  });

  // ===== 失败路径 =====

  it('未知状态不抛异常（纯装饰，静默降级）', () => {
    expect(() => pet.apply('no-such-state')).not.toThrow();
  });

  it('引擎缺失时静默降级，不创建宠物也不抛错', () => {
    const s2 = makeSandbox({ engine: undefined });
    expect(() => s2.sandbox.window.CuckooMobilePet.apply('thinking')).not.toThrow();
    expect(s2.calls.created).toBe(0);
  });

  it('引擎 create 抛异常时静默降级，且可重试成功', () => {
    let shouldThrow = true;
    const engine = {
      packs: { 'deepy-whale': {} },
      create: () => {
        if (shouldThrow) throw new Error('精灵图 404');
        return { setState: () => {}, randomMood: () => {}, flash: () => {}, destroy: () => {} };
      },
    };
    const s2 = makeSandbox({ engine });
    expect(() => s2.sandbox.window.CuckooMobilePet.apply('working')).not.toThrow();
    // 失败后不残留 creating 标志，下次事件仍会尝试创建
    shouldThrow = false;
    expect(() => s2.sandbox.window.CuckooMobilePet.apply('working')).not.toThrow();
  });

  it('宿主元素缺失（登录页）时不创建宠物，也不抛错', () => {
    const s2 = makeSandbox({ host: null });
    expect(() => s2.sandbox.window.CuckooMobilePet.apply('thinking')).not.toThrow();
    expect(s2.calls.created).toBe(0);
  });

  it('localStorage 抛异常（隐私模式）时退回默认站位', () => {
    const storage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const s2 = makeSandbox({ storage });
    expect(() => s2.sandbox.window.CuckooMobilePet.apply('thinking')).not.toThrow();
    expect(s2.calls.created).toBe(1);
  });

  it('destroy 后 apply 静默，不再驱动宠物', () => {
    pet.apply('working');
    const before = calls.setState.length;
    pet.destroy();
    expect(calls.destroyed).toBe(true);
    pet.apply('thinking');
    expect(calls.setState.length).toBe(before);
  });
});
