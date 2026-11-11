import { expect, test } from 'vitest';
import vm from 'node:vm';
import { deepseek } from '../../src/providers/deepseek.js';

function readyProbe(cards, name) {
  const card = (text) => ({
    textContent: text, children: [],
    getBoundingClientRect: () => ({ top: 620, width: 200, height: 40 }),
  });
  const document = {
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 700 }) }),
    querySelectorAll: () => cards.map(card),
  };
  return vm.runInNewContext('(' + deepseek.getAttachReadySource().toString() + ')(document, window, fileInfo)', {
    document, window: { innerHeight: 800 }, fileInfo: { name },
  });
}

test('DeepSeek 就绪判据不把旧附件认成本次上传成功', () => {
  expect(readyProbe(['previous.txt'], 'current.txt').ready).toBe(false);
  expect(readyProbe(['previous.txt', 'current.txt'], 'current.txt').ready).toBe(true);
});

test('DeepSeek 文件名匹配支持长文件名及普通附件格式', () => {
  const name = 'long-name-'.repeat(10) + '.pdf';
  expect(readyProbe([name], name).ready).toBe(true);
  expect(readyProbe(['current.txt.bak'], 'current.txt').ready).toBe(false);
});
