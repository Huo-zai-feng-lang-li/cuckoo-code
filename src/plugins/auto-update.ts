/**
 * 插件自动更新（纯逻辑，不依赖 electron）
 *
 * 判定"有新版本"：curated 目录里的 version > 已安装记录的 version。
 * 目录每日由 GitHub Actions 同步（见 cuckoo-plugin-market 仓库）。
 *
 * 配置存在 plugin-market.json（与 GitHub token 同一文件）：
 *   { "autoUpdate": true, "checkIntervalHours": 24 }
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMarketConfigFile } from './paths.js';

export interface AutoUpdateConfig {
  autoUpdate: boolean;
  checkIntervalHours: number;
  lastCheckAt: string;
}

const DEFAULTS: AutoUpdateConfig = { autoUpdate: false, checkIntervalHours: 24, lastCheckAt: '' };

/** 读配置（缺字段用默认值，损坏则全默认） */
export function readAutoUpdateConfig(): AutoUpdateConfig {
  try {
    const file = getMarketConfigFile();
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      autoUpdate: raw.autoUpdate === true,
      checkIntervalHours: Number(raw.checkIntervalHours) > 0 ? Number(raw.checkIntervalHours) : DEFAULTS.checkIntervalHours,
      lastCheckAt: typeof raw.lastCheckAt === 'string' ? raw.lastCheckAt : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 写配置（合并已有字段，保留 token 等） */
export function writeAutoUpdateConfig(patch: Partial<AutoUpdateConfig>): boolean {
  try {
    const file = getMarketConfigFile();
    let table: any = {};
    try { if (fs.existsSync(file)) table = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { table = {}; }
    if (!table || typeof table !== 'object') table = {};
    Object.assign(table, patch || {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(table, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 一条可更新的插件 */
export interface UpdateInfo {
  /** owner/repo */
  repo: string;
  /** 插件 id（目录名） */
  id: string;
  name: string;
  currentVersion: string;
  newVersion: string;
  branch: string;
  url: string;
}

/**
 * 对比 curated 目录与已安装清单，找出可更新的插件。
 * @param catalog curated 目录条目（plugins.json 的 plugins 数组）
 * @param installed repo → { id, name, version } 映射（buildInstalledMap 产出）
 */
export function findOutdated(
  catalog: any[],
  installed: Record<string, { id: string; name: string; version: string; installedAt: string }>
): UpdateInfo[] {
  const out: UpdateInfo[] = [];
  if (!Array.isArray(catalog)) return out;
  for (const it of catalog) {
    if (!it || typeof it.id !== 'string') continue;
    const inst = installed[it.id];
    if (!inst) continue; // 未安装
    if (it.archived) continue; // 归档仓库不自动更新
    const cur = String(inst.version || '').trim();
    const next = String(it.version || '').trim();
    if (!next) continue; // 目录没版本信息，无法判定
    if (isNewer(next, cur)) {
      out.push({
        repo: it.id,
        id: inst.id,
        name: it.name || inst.name || inst.id,
        currentVersion: cur,
        newVersion: next,
        branch: it.defaultBranch || 'main',
        url: it.url || ('https://github.com/' + it.id),
      });
    }
  }
  return out;
}

/** 语义化版本比较：a 比 b 新返回 true（非数字段当 0） */
export function isNewer(a: string, b: string): boolean {
  if (!a) return false;
  if (!b) return true; // 已安装没记录版本 → 视为可更新
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** 距上次检查是否已超过间隔 */
export function isCheckDue(cfg: AutoUpdateConfig, now: number = Date.now()): boolean {
  if (!cfg.lastCheckAt) return true;
  const last = Date.parse(cfg.lastCheckAt);
  if (!Number.isFinite(last)) return true;
  const hours = (now - last) / 3600000;
  return hours >= cfg.checkIntervalHours;
}
