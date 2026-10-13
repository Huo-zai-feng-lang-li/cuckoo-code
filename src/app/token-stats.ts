/**
 * 系统总累计 token 统计（跨窗口，主进程持久化）
 * 各窗口上报自己的"窗口累计 + 今日用量"，主进程按 profileId 存储。
 * 持久化到 userData/token-stats.json，故窗口关闭后其贡献仍计入。
 *
 * 存储格式（v2，带今日维度）：
 *   { "<profileId>": { cumulative, today, todayDate, name } }
 * 兼容 v1（值为纯数字 = cumulative，today 视为 0）。
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

/** 读原始存储（兼容 v1 数字格式，统一归一化为 WindowStat） */
function read(): Record<string, WindowStat> {
  try {
    const raw = fs.readFileSync(file(), 'utf-8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return {};
    const out: Record<string, WindowStat> = {};
    for (const k of Object.keys(o)) {
      const v: any = (o as any)[k];
      if (typeof v === 'number') {
        // v1 旧格式：纯数字 = cumulative
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
  } catch (_) {
    return {};
  }
}

function write(m: Record<string, WindowStat>): void {
  try { fs.writeFileSync(file(), JSON.stringify(m, null, 2), 'utf-8'); } catch (_) {}
}

/**
 * 记录某窗口的用量（累计 + 今日），返回最新系统总累计。
 * 注意：内部"读-改-写"必须保持同步（见文件头并发安全说明），勿插入 await。
 * 不同窗口写的是各自的 profileId 键，键不重叠，天然无冲突。
 */
export function setWindowUsage(profileId: string, value: { cumulative?: number; today?: number; name?: string }): number {
  if (!profileId) return getTotal();
  const m = read();
  const prev = m[profileId] || { cumulative: 0, today: 0, todayDate: '', name: '' };
  const todayKey = localDateKey();
  // 今日值：若上次记录不是今天，则本次的 today 就是"今天的起点"（不叠加）
  const today = typeof value.today === 'number' ? value.today : prev.today;
  m[profileId] = {
    cumulative: typeof value.cumulative === 'number' ? value.cumulative : prev.cumulative,
    today,
    todayDate: todayKey,
    name: value.name || prev.name,
  };
  write(m);
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

/** 取各窗口用量列表（按今日降序），供柱图展示 */
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
  const m = read();
  let changed = false;
  for (const k of Object.keys(m)) {
    if (k.startsWith('subagent-')) { delete m[k]; changed = true; }
  }
  if (changed) write(m);
}
