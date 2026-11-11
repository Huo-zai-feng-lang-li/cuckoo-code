import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

async function settingsPage() {
  vi.resetModules();
  const changes = {};
  const elements = Object.fromEntries(['pause-chance', 'pause-min', 'pause-max', 'reset'].map((id) => [
    'st-' + id,
    { value: '0', addEventListener: (event, fn) => { changes[id + ':' + event] = fn; } },
  ]));
  const requests = [];
  let resets = 0;
  const persisted = {};
  vi.stubGlobal('window', {
    addEventListener() {},
    shellAPI: {
      async resetSettings() {
        resets++;
        for (const key of Object.keys(persisted)) delete persisted[key];
        return { success: true };
      },
      saveSettings(data) {
        return new Promise((resolve) => requests.push({
          data,
          complete() { Object.assign(persisted, data); resolve({ success: true }); },
        }));
      },
    },
  });
  vi.stubGlobal('document', {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  });
  vi.stubGlobal('localStorage', { getItem: () => null });
  await import('../../src/ui/shell/scripts/pages/settings.js');
  const change = (key, value) => {
    elements['st-' + key].value = value;
    changes[key + ':change']();
  };
  return { change, requests, persisted, reset: () => changes['reset:click'](), resetCount: () => resets };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('暂停概率在保存期间再次修改，最终保存最新值且不提交无关字段', async () => {
  const { change, requests, persisted } = await settingsPage();
  change('pause-chance', '0.2');
  change('pause-chance', '0.8');
  requests[0].complete();
  await flush();
  expect(requests.map((r) => r.data)).toEqual([{ pauseChance: 0.2 }, { pauseChance: 0.8 }]);
  requests[1].complete();
  await flush();
  expect(persisted).toEqual({ pauseChance: 0.8 });
});

test('保存等待期间改另一个暂停字段，按增量接续保存', async () => {
  const { change, requests, persisted } = await settingsPage();
  change('pause-min', '12.5');
  change('pause-max', '80');
  requests[0].complete();
  await flush();
  expect(requests.map((r) => r.data)).toEqual([{ pauseMin: 12.5 }, { pauseMax: 80 }]);
  requests[1].complete();
  await flush();
  expect(persisted).toEqual({ pauseMin: 12.5, pauseMax: 80 });
});

test('恢复默认等待在途保存落盘，避免旧请求在重置之后写回', async () => {
  const { change, requests, persisted, reset, resetCount } = await settingsPage();
  change('pause-chance', '0.9');
  const resetting = reset();
  await flush();
  expect(resetCount()).toBe(0);
  requests[0].complete();
  await resetting;
  expect(resetCount()).toBe(1);
  expect(persisted).toEqual({});
});
