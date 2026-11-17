'use strict';
/**
 * 手机端 PWA（src/remote/pwa/app.js）宠物/延迟状态接线守卫测试。
 *
 * 背景：app.js 是 1800 行的内联 IIFE，没有模块边界，跑真实 DOM 成本极高。
 * 本次修复的两个触点都在"事件分发 → 调用已有函数"这一层：
 *   - tool phase='sending'（工具跑完的 6~16s 拟人化延迟）→ 宠物 waiting
 *   - send-pause（30~75s 随机长暂停）→ 宠物 pausing + 执行条文案
 * 曾因两处都没接，手机端宠物在延迟期间一直停在 working。这里钉住关键约束，
 * 防止未来重构时静默回退（断言风格与 test/ui/harness-page.test.js 一致）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC_PATH = path.join(import.meta.dirname, '..', '..', 'src', 'remote', 'pwa', 'app.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('手机端延迟状态接线', () => {
  it('脚本语法可解析', () => {
    expect(() => new vm.Script(src, { filename: 'pwa-app.js' })).not.toThrow();
  });

  it('工具回传延迟窗口切到宠物 waiting', () => {
    const idx = src.indexOf('function onToolEvent');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf('\n  function ', idx + 10));
    const sendingIdx = body.indexOf("phase === 'sending'");
    expect(sendingIdx).toBeGreaterThan(0);
    const sendingBranch = body.slice(sendingIdx);
    expect(sendingBranch).toContain("petEvent('waiting')");
  });

  it('分发随机长暂停事件并驱动宠物 pausing', () => {
    expect(src).toContain("case 'send-pause'");
    const idx = src.indexOf("case 'send-pause'");
    const body = src.slice(idx, src.indexOf('\n      case ', idx + 10));
    expect(body).toContain("petEvent('pausing')");
    // 长暂停最长 75s，必须停掉 45s 硬超时的 send tick，否则中途会被强制收尾
    expect(body).toContain('stopSendTick()');
  });

  it('暂停收尾必须先过窗口过滤（防跨窗口误伤）', () => {
    // active=false 会把 B 正在跑的 sendTick 与执行条一起清掉 ——
    // 若不过滤，A 的暂停结束会误伤 B 窗口正在显示的「延迟发送 Ns…」。
    // 「切走再切回 A」的僵尸态由 selectProfile → resetView() 兜底。
    const idx = src.indexOf("case 'send-pause'");
    const body = src.slice(idx, src.indexOf('\n      case ', idx + 10));
    const guardIdx = body.indexOf('if (!msg.active)');
    const filterIdx = body.indexOf('if (!isMyProfile(msg.profileId)) break;');
    expect(guardIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeLessThan(guardIdx);
  });

  it('暂停收尾与 ai-stop 同款（清表 + 隐藏 + 复位按钮）', () => {
    const idx = src.indexOf("case 'send-pause'");
    const body = src.slice(idx, src.indexOf('\n      case ', idx + 10));
    const off = body.slice(body.indexOf('if (!msg.active)'));
    // 四件套缺一，手机端会停在「停止按钮常驻、发送按钮隐藏、无执行条」的错位
    for (const fn of ['stopSendTick()', 'stopToolTick()', 'hideExec()', 'setExecuting(false)']) {
      expect(off).toContain(fn);
    }
  });
});
