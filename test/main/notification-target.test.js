import { test } from 'vitest';
import assert from 'node:assert';
import * as windowState from '../../src/app/window.js';

function fakeWindow({ destroyed = false, minimized = false } = {}) {
  const calls = [];
  return {
    calls,
    id: Math.random(),
    on: () => {},
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    flashFrame: (value) => calls.push(['flashFrame', value]),
  };
}

test('focuses the notification source window and clears taskbar flashing', () => {
  const win = fakeWindow({ minimized: true });

  const focused = windowState.focusWindow(win);

  assert.strictEqual(focused, true);
  assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus', ['flashFrame', false]]);
});

test('falls back to the existing profile window, then creates it when source is gone', () => {
  const replacement = fakeWindow();
  windowState.addWindow(replacement, 'profile-2', 'deepseek', {});
  const focused = windowState.focusWindowByProfileId('profile-2');

  assert.strictEqual(focused, true);
  assert.deepStrictEqual(replacement.calls, ['show', 'focus', ['flashFrame', false]]);
  windowState.removeWindow(replacement.id);
});

test('creates a profile window when no existing target can be focused', () => {
  const opened = fakeWindow();
  windowState.setProfileWindowCreator((profileId) => {
    assert.strictEqual(profileId, 'profile-3');
    windowState.addWindow(opened, profileId, 'deepseek', {});
  });
  const focused = windowState.focusWindowByProfileId('profile-3');

  assert.strictEqual(focused, true);
  assert.deepStrictEqual(opened.calls, ['show', 'focus', ['flashFrame', false]]);
  windowState.removeWindow(opened.id);
  windowState.setProfileWindowCreator(null);
});
