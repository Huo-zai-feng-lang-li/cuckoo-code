/**
 * 系统总累计 token 统计（跨窗口，主进程持久化）
 * 各窗口上报自己的"窗口累计 + 今日用量"，主进程按 profileId 存储，
 * 并维护"每日全窗口总量"快照（供柱图展示近 N 天全窗口趋势）。
 * 持久化到 userData/token-stats.json，故窗口关闭后其贡献仍计入。
 *
 * 存储格式（v3）：
 *   {
 *     "<profileId>": { cumulative, today, todayDate, name },
 *     "__daily__":   { "2026-10-13": 12345678, ... }
 *   }
 * 兼容 v1（值为纯数字 = cumulative）、v2（无 __daily__）。
 *
 * ⚠️ 并发安全（勿改成异步）：
 * 本模块的"读-改-写"依赖**同步 IO + 主进程单线程**保证原子性——
 * setWindowUsage 里 readFileSync 到 writeFileSync 之间没有 await，
 * 一次调用不会被其它窗口的 IPC 打断，故多窗口同时上报不会产生数据竞争。
 * 若将来改成 fs.promises（异步），"读"与"写"之间会插入其它调用，
 * 可能导致后者覆盖前者的结果（丢失更新）——届时必须加锁或改原子写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');

/** 每日全窗口快照的特殊键名（非 profileId） */
const DAILY_KEY = '__daily__';

/** 单窗口的统计记录 */
interface WindowStat {
  cumulative: number;
  today: number;
  todayDate: string;
  name: string;
}

/** 对外暴露的窗口用量条目 */
export interface WindowUsage {
  profileId: string;
  name: string;
  cumulative: number;
  today: number;
}

let FILE: string | null = null;
function file(): string {
  if (!FILE) FILE = path.join(app.getPath('userData'), 'token-stats.json');
  return FILE;
}

/** 本地日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC 会差时区） */
function localDateKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/** 读原始对象（含 __daily__） */
function readRaw(): any {
  try {
    const raw = fs.readFileSync(file(), 'utf-8');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (_) {
    return {};
  }
}

function writeRaw(o: any): void {
  try { fs.writeFileSync(file(), JSON.stringify(o, null, 2), 'utf-8'); } catch (_) {}
}

/** 读窗口统计（跳过 __daily__ 等特殊键，兼容 v1 数字格式） */
function read(): Record<string, WindowStat> {
  const o = readRaw();
  const out: Record<string, WindowStat> = {};
  for (const k of Object.keys(o)) {
    if (k.startsWith('__')) continue; // 特殊键（如 __daily__）
    const v: any = o[k];
    if (typeof v === 'number') {
      out[k] = { cumulative: v, today: 0, todayDate: '', name: '' };
    } else if (v && typeof v === 'object') {
      out[k] = {
        cumulative: typeof v.cumulative === 'number' ? v.cumulative : 0,
        today: typeof v.today === 'number' ? v.today : 0,
        todayDate: typeof v.todayDate === 'string' ? v.todayDate : '',
        name: typeof v.name === 'string' ? v.name : '',
      };
    }
  }
  return out;
}

/** 读每日全窗口快照 */
function readDaily(): Record<string, number> {
  const o = readRaw();
  const d = o[DAILY_KEY];
  return (d && typeof d === 'object') ? d : {};
}

/** 今日全窗口累计：所有窗口今日之和（跨天自动归零——todayDate 不是今天则不计） */
export function getTodayTotal(): number {
  const m = read();
  const today = localDateKey();
  let sum = 0;
  for (const k of Object.keys(m)) {
    if (k.startsWith('subagent-')) continue;
    const rec = m[k];
    if (rec && rec.todayDate === today && typeof rec.today === 'number') sum += rec.today;
  }
  return sum;
}

/** 把"今日全窗口总量"快照写入 __daily__[today]（历史天保留） */
function snapshotToday(o: any): void {
  const daily = (o[DAILY_KEY] && typeof o[DAILY_KEY] === 'object') ? o[DAILY_KEY] : {};
  // 直接算今日全窗口（避免再读文件）
  const today = localDateKey();
  let sum = 0;
  for (const k of Object.keys(o)) {
    if (k.startsWith('__') || k.startsWith('subagent-')) continue;
    const v = o[k];
    if (v && typeof v === 'object' && v.todayDate === today && typeof v.today === 'number') sum += v.today;
  }
  daily[today] = sum;
  o[DAILY_KEY] = daily;
}

/**
 * 记录某窗口的用量（累计 + 今日），返回最新系统总累计。
 * 内部"读-改-写"必须保持同步（见文件头并发安全说明），勿插入 await。
 */
export function setWindowUsage(profileId: string, value: { cumulative?: number; today?: number; name?: string }): number {
  if (!profileId) return getTotal();
  const o = readRaw();
  const prev: any = (o[profileId] && typeof o[profileId] === 'object') ? o[profileId] : {};
  const todayKey = localDateKey();
  const today = typeof value.today === 'number' ? value.today : (typeof prev.today === 'number' ? prev.today : 0);
  o[profileId] = {
    cumulative: typeof value.cumulative === 'number' ? value.cumulative : (typeof prev.cumulative === 'number' ? prev.cumulative : 0),
    today,
    todayDate: todayKey,
    name: value.name || (typeof prev.name === 'string' ? prev.name : ''),
  };
  snapshotToday(o); // 同步今日全窗口快照
  writeRaw(o);
  return getTotal();
}

/** 向后兼容：旧调用名（只更新 cumulative，保留今日） */
export function setWindowCumulative(profileId: string, value: number): number {
  return setWindowUsage(profileId, { cumulative: value });
}

/** 系统总累计：所有窗口（含已关闭）之和（忽略子代理遗留键） */
export function getTotal(): number {
  const m = read();
  let sum = 0;
  for (const k of Object.keys(m)) {
    if (k.startsWith('subagent-')) continue;
    sum += (m[k] && typeof m[k].cumulative === 'number' ? m[k].cumulative : 0);
  }
  return sum;
}

/** 取近 N 日全窗口用量（升序，含今天；缺失日补 0） */
export function getRecentDailyTotal(days: number): Array<{ date: string; value: number }> {
  const daily = readDaily();
  // 今日值实时算（__daily__ 快照可能滞后于最新上报）
  const todayKey = localDateKey();
  const liveToday = getTodayTotal();
  const out: Array<{ date: string; value: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = y + '-' + m + '-' + day;
    const v = key === todayKey ? Math.max(liveToday, daily[key] || 0) : (daily[key] || 0);
    out.push({ date: key, value: v });
  }
  return out;
}

/** 取各窗口用量列表（按今日降序） */
export function getWindowUsageList(): WindowUsage[] {
  const m = read();
  const today = localDateKey();
  const out: WindowUsage[] = [];
  for (const k of Object.keys(m)) {
    if (k.startsWith('subagent-')) continue;
    const rec = m[k];
    out.push({
      profileId: k,
      name: rec.name || k,
      cumulative: rec.cumulative || 0,
      today: (rec.todayDate === today ? rec.today : 0),
    });
  }
  out.sort((a, b) => b.today - a.today);
  return out;
}

/** 清理子代理遗留键（启动时调用一次） */
export function cleanupSubagentKeys(): void {
  const o = readRaw();
  let changed = false;
  for (const k of Object.keys(o)) {
    if (k.startsWith('subagent-')) { delete o[k]; changed = true; }
  }
  if (changed) writeRaw(o);
}
