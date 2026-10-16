/**
 * 底部状态栏「最近使用」的全局存储（跨窗口共享）。
 *
 * 背景：原先存 localStorage（各窗口独立），用户要求全局生效。
 * 现改为存 <userDir>/recent-tools.json（CUCKOO_HOME 可覆盖），改动广播给所有窗口。
 *
 * 数据模型：{ type: 'skill'|'mcp'|'agent'|'snippet', name, ts, payload?, autoSend? }[]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type RecentType = 'skill' | 'mcp' | 'agent' | 'snippet';

export interface RecentItem {
  type: RecentType;
  name: string;
  ts: number;
  payload?: string;
  autoSend?: boolean;
}

const MAX = 5;
const VALID_TYPES = ['skill', 'mcp', 'agent', 'snippet'];

function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getFile(): string {
  return path.join(getUserDir(), 'recent-tools.json');
}

function normItem(raw: any): RecentItem | null {
  if (!raw || typeof raw !== 'object') return null;
  if (VALID_TYPES.indexOf(raw.type) === -1) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const it: RecentItem = { type: raw.type, name: raw.name, ts: typeof raw.ts === 'number' ? raw.ts : Date.now() };
  if (typeof raw.payload === 'string') it.payload = raw.payload;
  if (typeof raw.autoSend === 'boolean') it.autoSend = raw.autoSend;
  return it;
}

function loadRecent(): RecentItem[] {
  try {
    const raw = fs.readFileSync(getFile(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(normItem).filter(Boolean) as RecentItem[];
  } catch (_) {
    return [];
  }
}

function saveRecent(list: RecentItem[]): void {
  try {
    fs.mkdirSync(getUserDir(), { recursive: true });
    fs.writeFileSync(getFile(), JSON.stringify(list.slice(0, MAX), null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('[RecentTools] 写入失败:', err.message);
  }
}

/** 记录一次使用（同类型同名去重后置顶），最多 MAX 条；返回新列表 */
function addRecent(type: RecentType, name: string, extra?: { payload?: string; autoSend?: boolean }): RecentItem[] {
  if (!name) return loadRecent();
  let list = loadRecent().filter((x) => !(x.type === type && x.name === name));
  const item: RecentItem = { type, name, ts: Date.now() };
  if (extra && typeof extra.payload === 'string') item.payload = extra.payload;
  if (extra && typeof extra.autoSend === 'boolean') item.autoSend = extra.autoSend;
  list.unshift(item);
  if (list.length > MAX) list = list.slice(0, MAX);
  saveRecent(list);
  return list;
}

/** 移除某项；返回新列表 */
function removeRecent(type: RecentType, name: string): RecentItem[] {
  if (!name) return loadRecent();
  const list = loadRecent().filter((x) => !(x.type === type && x.name === name));
  saveRecent(list);
  return list;
}

export { loadRecent, addRecent, removeRecent };
