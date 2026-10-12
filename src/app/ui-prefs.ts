/**
 * UI 偏好（主进程直存，不依赖 AI 页面 localStorage）。
 * 存储：<userDir>/ui-prefs.json（CUCKOO_HOME 可覆盖）。
 *
 * 目前：
 *   - harnessZoom：纯净模式缩放（0.8 ~ 1.6，默认 1.0）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface UiPrefs {
  harnessZoom: number;
}

const DEFAULTS: UiPrefs = { harnessZoom: 1.0 };
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.6;

function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getPrefsFile(): string {
  return path.join(getUserDir(), 'ui-prefs.json');
}

function clampZoom(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return DEFAULTS.harnessZoom;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(n * 100) / 100));
}

function readPrefs(): UiPrefs {
  try {
    const raw = fs.readFileSync(getPrefsFile(), 'utf-8');
    const o = JSON.parse(raw);
    return { harnessZoom: clampZoom(o && o.harnessZoom) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function writePrefs(patch: Partial<UiPrefs>): UiPrefs {
  const cur = readPrefs();
  const next: UiPrefs = { ...cur };
  if (patch.harnessZoom !== undefined) next.harnessZoom = clampZoom(patch.harnessZoom);
  try {
    fs.mkdirSync(getUserDir(), { recursive: true });
    fs.writeFileSync(getPrefsFile(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('[UIPrefs] 写入失败:', err.message);
  }
  return next;
}

export { readPrefs, writePrefs, MIN_ZOOM, MAX_ZOOM };
