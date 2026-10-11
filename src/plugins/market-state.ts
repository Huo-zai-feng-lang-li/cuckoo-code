/**
 * 插件市场本地状态（收藏 / 备注 / 分组）
 *
 * 存 ~/.cuckoo/plugin-market-state.json（与配置 plugin-market.json 分开：
 * 那个是 token/自动更新的"设置"，这个是用户对插件的主观标记）。
 *
 * 对齐 dsh-market：收藏、分组、备注都是**纯本地**，不影响插件本身。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getUserDir } from './paths.js';

export interface MarketState {
  /** 收藏的插件 id（owner/repo） */
  favorites: string[];
  /** 插件 id → 自己的备注（替换作者简介） */
  notes: Record<string, string>;
  /** 分组名 → 插件 id 列表 */
  groups: Record<string, string[]>;
}

const EMPTY: MarketState = { favorites: [], notes: {}, groups: {} };

function stateFile(): string {
  return path.join(getUserDir(), 'plugin-market-state.json');
}

/** 读状态（损坏则返回空，绝不抛错） */
export function readMarketState(): MarketState {
  try {
    const file = stateFile();
    if (!fs.existsSync(file)) return { favorites: [], notes: {}, groups: {} };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { favorites: [], notes: {}, groups: {} };
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((x: any) => typeof x === 'string') : [],
      notes: (raw.notes && typeof raw.notes === 'object') ? raw.notes : {},
      groups: (raw.groups && typeof raw.groups === 'object') ? raw.groups : {},
    };
  } catch {
    return { favorites: [], notes: {}, groups: {} };
  }
}

/** 写状态（合并式：只覆盖传入字段） */
export function writeMarketState(patch: Partial<MarketState>): boolean {
  try {
    const cur = readMarketState();
    const next: MarketState = {
      favorites: Array.isArray(patch.favorites) ? patch.favorites : cur.favorites,
      notes: patch.notes && typeof patch.notes === 'object' ? patch.notes : cur.notes,
      groups: patch.groups && typeof patch.groups === 'object' ? patch.groups : cur.groups,
    };
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 切换收藏（返回切换后的状态） */
export function toggleFavorite(id: string): boolean {
  if (!id) return false;
  const cur = readMarketState();
  const has = cur.favorites.includes(id);
  const next = has ? cur.favorites.filter((x) => x !== id) : cur.favorites.concat([id]);
  writeMarketState({ favorites: next });
  return !has;
}

/** 设/清备注（空串 = 删除） */
export function setNote(id: string, text: string): boolean {
  if (!id) return false;
  const cur = readMarketState();
  const notes = Object.assign({}, cur.notes);
  const t = String(text || '').trim();
  if (t) notes[id] = t.slice(0, 500);
  else delete notes[id];
  return writeMarketState({ notes });
}

/** 设分组（插件 id → 组名；空组名 = 移出分组） */
export function setGroup(id: string, group: string): boolean {
  if (!id) return false;
  const cur = readMarketState();
  const groups: Record<string, string[]> = {};
  // 先从所有组里移除
  for (const [g, list] of Object.entries(cur.groups)) {
    const filtered = (Array.isArray(list) ? list : []).filter((x) => x !== id);
    if (filtered.length) groups[g] = filtered;
  }
  const g = String(group || '').trim();
  if (g) {
    groups[g] = (groups[g] || []).concat([id]);
  }
  return writeMarketState({ groups });
}
