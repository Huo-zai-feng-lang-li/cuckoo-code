'use strict';
/**
 * 宠物情绪句节流守卫（src/ui/pets/pet.js）。
 *
 * 背景：随机长暂停（pausing）只在进入时触发一次，暂停期间没有定时器反复调换句。
 * 旧实现的 4s 节流不区分情绪组：若进入走神前 4s 内刚换过 waiting/working 句，
 * 走神句会被节流吞掉，整段 30~75s 暂停期间宠物一直停在上一句。
 * 修复方向：记录上次情绪组，跨组切换立即换句；只有同组重复调用才保留 4s 防抖。
 *
 * 注：pet.js 是浏览器 IIFE（依赖 document/Image/RAF），Node 环境无法实例化，
 * 行为正确性靠真机 CDP 对照验证；这里用源码守卫钉住分组节流的结构不被改回。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PET_JS = path.join(import.meta.dirname, '../../src/ui/pets/pet.js');
const src = fs.readFileSync(PET_JS, 'utf8');

test('pet.js 语法可解析', () => {
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'pet.js' }));
});

test('跨情绪组切换立即换句：4s 节流只在同组重复时生效', () => {
  assert.ok(/var lastMoodGroup/.test(src), '应记录上次情绪分组');

  const throttleIdx = src.indexOf('t - lastMoodAt < 4000');
  assert.ok(throttleIdx > 0, '应保留同组 4s 防抖节流');

  // 节流条件必须先判断"组是否变化"：跨组（如 waiting → pausing）不得被时间窗吞掉
  const condBody = src.slice(Math.max(0, throttleIdx - 160), throttleIdx + 40);
  assert.ok(/groupChanged|group !== lastMoodGroup/.test(condBody),
    '节流判定应先比较情绪组是否变化，跨组切换绕过节流');

  // 换句后必须同步刷新记录的分组
  const updateIdx = src.indexOf('lastMoodGroup = group');
  assert.ok(updateIdx > 0, '换句后应刷新记录的情绪分组');
});
