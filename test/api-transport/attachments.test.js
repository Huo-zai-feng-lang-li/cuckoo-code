'use strict';
/**
 * API 附件物化：历史只存路径，请求前才压缩成 image_url；
 * 绝不把 base64 写进历史/JSONL/localStorage。
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp;
let mod;

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-attach-'));
  process.env.CUCKOO_HOME = tmp;
  mod = await import('../../src/api-transport/attachments.js');
});

afterEach(() => {
  delete process.env.CUCKOO_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

test('图片落盘只保存路径，历史消息里没有 base64', async () => {
  const r = await mod.saveIncomingAttachments('win-a', [
    { name: 'a.png', mime: 'image/png', data: PNG_1PX },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.stored.length, 1);
  assert.ok(fs.existsSync(r.stored[0].path));
  const messages = await mod.materializeMessages([
    { role: 'user', content: '看图', attachments: [r.stored[0]] },
  ]);
  assert.equal(typeof messages[0].content, 'object');
  assert.ok(!JSON.stringify(r.stored[0]).includes(PNG_1PX), '历史引用里不应包含原始 base64');
  assert.ok(messages[0].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')));
});

test('文件选择器给 application/octet-stream 时，data URL 仍按真实图片格式生成', async () => {
  const r = await mod.saveIncomingAttachments('win-a', [
    { name: 'a.png', mime: 'application/octet-stream', data: PNG_1PX },
  ]);
  assert.equal(r.success, true);
  const messages = await mod.materializeMessages([
    { role: 'user', content: '看图', attachments: [r.stored[0]] },
  ]);
  const image = messages[0].content.find((p) => p.type === 'image_url');
  assert.ok(image, '应生成 image_url 块');
  assert.ok(image.image_url.url.startsWith('data:image/png;base64,'), '不能再用 application/octet-stream 当图片 MIME');
});

test('文本附件按文本注入，超过单条上限会截断', async () => {
  const text = 'hello\n'.repeat(4000);
  const r = await mod.saveIncomingAttachments('win-a', [
    { name: 'a.txt', mime: 'text/plain', data: Buffer.from(text).toString('base64') },
  ]);
  assert.equal(r.success, true);
  const messages = await mod.materializeMessages([
    { role: 'user', content: '读附件', attachments: [r.stored[0]] },
  ]);
  const joined = typeof messages[0].content === 'string'
    ? messages[0].content
    : messages[0].content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  assert.ok(joined.includes('hello'));
  assert.ok(joined.includes('已截断'));
});

test('不支持的 PDF 不假装能解析，明确报错', async () => {
  const r = await mod.saveIncomingAttachments('win-a', [
    { name: 'a.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
  ]);
  assert.equal(r.success, false);
  assert.match(r.error, /PDF|不支持/);
});

test('图片张数超过活跃上下文预算时，旧图只保留文字占位', async () => {
  const refs = [];
  for (let i = 0; i < 10; i++) {
    const r = await mod.saveIncomingAttachments('win-a', [
      { name: 'a' + i + '.png', mime: 'image/png', data: PNG_1PX },
    ]);
    refs.push(r.stored[0]);
  }
  const messages = await mod.materializeMessages([
    { role: 'user', content: 'old', attachments: [refs[0]] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'new', attachments: refs.slice(1) },
  ], 4);
  const first = messages[0];
  assert.equal(typeof first.content, 'string');
  assert.ok(first.content.includes('图片已省略'));
  const last = messages[2];
  assert.ok(Array.isArray(last.content));
  const images = last.content.filter((p) => p.type === 'image_url').length;
  assert.equal(images, 4);
});

test('附件 GC：只删除没有任何会话引用的孤儿文件，保留在用附件', async () => {
  const keep = await mod.saveIncomingAttachments('win-a', [
    { name: 'keep.png', mime: 'image/png', data: PNG_1PX },
  ]);
  const orphan = await mod.saveIncomingAttachments('win-a', [
    { name: 'orphan.png', mime: 'image/png', data: PNG_1PX },
  ]);
  assert.ok(fs.existsSync(keep.stored[0].path) && fs.existsSync(orphan.stored[0].path));
  const r = mod.pruneOrphanAttachments('win-a', [keep.stored[0].path]);
  assert.equal(r.removed, 1);
  assert.ok(r.bytes > 0);
  assert.ok(fs.existsSync(keep.stored[0].path), '在用附件必须保留');
  assert.equal(fs.existsSync(orphan.stored[0].path), false, '未被引用的附件应删除');
});

test('附件 GC：minAge 阈值保护刚保存、尚未写入会话快照的附件', async () => {
  const fresh = await mod.saveIncomingAttachments('win-a', [
    { name: 'fresh.png', mime: 'image/png', data: PNG_1PX },
  ]);
  const old = await mod.saveIncomingAttachments('win-a', [
    { name: 'old.png', mime: 'image/png', data: PNG_1PX },
  ]);
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(old.stored[0].path, oldTime, oldTime);
  const r = mod.pruneOrphanAttachments('win-a', [], { minAgeMs: 60 * 60 * 1000 });
  assert.equal(r.removed, 1, '只应删除超过阈值的孤儿');
  assert.ok(fs.existsSync(fresh.stored[0].path), '未过阈值的文件必须保留');
  assert.equal(fs.existsSync(old.stored[0].path), false);
});

test('附件 GC：目录清空后删除空目录', async () => {
  const a = await mod.saveIncomingAttachments('win-empty', [
    { name: 'a.png', mime: 'image/png', data: PNG_1PX },
  ]);
  const r = mod.pruneOrphanAttachments('win-empty', []);
  assert.equal(r.removed, 1);
  assert.equal(fs.existsSync(path.dirname(a.stored[0].path)), false, '空目录应一并回收');
});
