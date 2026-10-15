/**
 * 远程控制：配置读写（用户级 ~/.cuckoo/remote.json）
 *
 * 存储：{ enabled, port, token }
 * - enabled: 是否启用远程服务
 * - port: 本地监听端口（默认 7799，CF 隧道转发到此）
 * - token: 访问令牌（首次启用自动生成，32 位随机）
 *
 * 可用环境变量 CUCKOO_HOME 覆盖（测试隔离）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface RemoteConfig {
  enabled: boolean;
  port: number;
  token: string;
  /** 外网访问或固定域名（例如 https://remote.example.com），用于生成手机直达链接 */
  publicUrl?: string;
  /** 是否由 Cuckoo Code 内部自动拉起托管 Cloudflare 隧道 */
  tunnelEnabled?: boolean;
  /** Cloudflare Tunnel Token（固定隧道运行凭证，留空则使用临时快速隧道） */
  tunnelToken?: string;
}

function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getConfigFile(): string {
  return path.join(getUserDir(), 'remote.json');
}

/** 生成 32 位随机令牌（hex） */
function genToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function defaultConfig(): RemoteConfig {
  return {
    enabled: false,
    port: 7799,
    token: '',
    publicUrl: '',
    tunnelEnabled: false,
    tunnelToken: '',
  };
}

/** 原子写入配置文件：先写临时文件再 rename（崩溃也不会留半截 JSON） */
function saveConfigFile(cfg: RemoteConfig): boolean {
  try {
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换（同目录 rename）
    return true;
  } catch (err: any) {
    console.error('[Remote] 写入配置失败:', err.message);
    return false;
  }
}

function cleanPublicUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url.replace(/\/+$/, '');
}

/** 读取配置（不存在则自动生成默认配置并持久化；字段清洗；保证幂等性） */
function readConfig(): RemoteConfig {
  const dft = defaultConfig();
  try {
    const file = getConfigFile();
    if (!fs.existsSync(file)) {
      const initCfg = { ...dft, token: genToken() };
      saveConfigFile(initCfg);
      return initCfg;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') {
      const initCfg = { ...dft, token: genToken() };
      saveConfigFile(initCfg);
      return initCfg;
    }
    const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : dft.port;
    const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : genToken();
    const cfg: RemoteConfig = {
      enabled: raw.enabled === true,
      port,
      token,
      publicUrl: cleanPublicUrl(raw.publicUrl),
      tunnelEnabled: raw.tunnelEnabled === true,
      tunnelToken: typeof raw.tunnelToken === 'string' ? raw.tunnelToken.trim() : dft.tunnelToken,
    };
    if (!raw.token) saveConfigFile(cfg);
    return cfg;
  } catch (err: any) {
    console.error('[Remote] 读取配置失败:', err.message);
    // 损坏配置：生成新凭证并写回磁盘修复（避免每次读取都漂移、壳/服务/链接不一致）
    const initCfg = { ...dft, token: genToken() };
    saveConfigFile(initCfg);
    return initCfg;
  }
}

/** 写入配置（部分字段合并） */
function writeConfig(data: any): boolean {
  try {
    const base = readConfig();
    const next: RemoteConfig = {
      enabled: data && typeof data.enabled === 'boolean' ? data.enabled : base.enabled,
      port: data && Number.isInteger(data.port) && data.port > 0 && data.port < 65536 ? data.port : base.port,
      token: data && typeof data.token === 'string' && data.token.length > 0 ? data.token : base.token,
      publicUrl: data && typeof data.publicUrl === 'string' ? cleanPublicUrl(data.publicUrl) : (base.publicUrl || ''),
      tunnelEnabled: data && typeof data.tunnelEnabled === 'boolean' ? data.tunnelEnabled : (base.tunnelEnabled || false),
      tunnelToken: data && typeof data.tunnelToken === 'string' ? data.tunnelToken.trim() : (base.tunnelToken || ''),
    };
    return saveConfigFile(next);
  } catch (err: any) {
    console.error('[Remote] 写入配置失败:', err.message);
    return false;
  }
}

/** 重新生成令牌 */
function resetToken(): string {
  const t = genToken();
  writeConfig({ token: t });
  return t;
}

export { readConfig, writeConfig, resetToken, genToken, getConfigFile, defaultConfig };
