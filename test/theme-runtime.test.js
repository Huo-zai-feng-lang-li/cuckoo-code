import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/plugins/runtime/events.js';
import { ThemeRuntime } from '../src/plugins/runtime/theme-runtime.js';

describe('ThemeRuntime', () => {
  it('refreshes a system preference when the OS scheme changes', () => {
    let scheme = 'light';
    const runtime = new ThemeRuntime(new EventBus(), () => scheme);

    expect(runtime.getTheme().active.id).toBe('light');
    scheme = 'dark';
    runtime.refresh();

    expect(runtime.getTheme().preference).toBe('system');
    expect(runtime.getTheme().active.id).toBe('dark');
  });

  it('keeps an explicit preference independent of the OS', () => {
    let scheme = 'light';
    const runtime = new ThemeRuntime(new EventBus(), () => scheme);

    runtime.setTheme('dark');
    scheme = 'light';
    runtime.refresh();

    expect(runtime.getTheme().preference).toBe('dark');
    expect(runtime.getTheme().active.id).toBe('dark');
  });
});
