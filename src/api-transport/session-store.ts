/**
 * API 会话持久化：每个 API profile 一个会话目录，目录内保留多份会话快照。
 *
 * 旧版是 `api-sessions/<profile>.json` 单快照；新版自动迁移到
 * `api-sessions/<profile>/index.json + <sessionId>.json`。旧文件不删除，
 * 只作为迁移来源，避免升级时丢历史。
 *
 * 历史中只保存附件引用（name/path/mime），不保存 base64。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ApiChatMessage } from './client.js';
import { pruneOrphanAttachments } from './attachments.js';

const MAX_PERSISTED_MESSAGES = 300;
const INDEX_VERSION = 2;
const DEFAULT_TITLE = '新对话';

export interface ApiSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 该会话最近一次选择的项目目录；旧版索引没有此字段时为 null */
  projectDir?: string | null;
}

export interface ApiSessionList {
  activeSessionId: string;
  sessions: ApiSessionMeta[];
}

export interface ApiSessionSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ApiChatMessage[];
  usageTotal?: Record<string, any>;
  /** 该会话最近一次选择的项目目录 */
  projectDir?: string | null;
}

export interface SaveApiSessionOptions {
  sessionId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  usageTotal?: Record<string, any>;
  /** 不传则沿用会话已有目录；传 null 可显式清空 */
  projectDir?: string | null;
}

interface ApiSessionIndex {
  version: number;
  activeSessionId: string;
  sessions: ApiSessionMeta[];
}

function storageRoot(): string {
  const home = process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo');
  return path.join(home, 'api-sessions');
}

function safeSegment(value: any): string {
  const raw = String(value || '').trim();
  if (!raw) return 'default';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'default';
}

function profileDir(profileId: string): string {
  return path.join(storageRoot(), safeSegment(profileId));
}

function indexPath(profileId: string): string {
  return path.join(profileDir(profileId), 'index.json');
}

function sessionFile(profileId: string, sessionId: string): string {
  return path.join(profileDir(profileId), safeSegment(sessionId) + '.json');
}

/** 旧版单快照文件；迁移后保留，不参与读写 */
function legacyFile(profileId: string): string {
  return path.join(storageRoot(), safeSegment(profileId) + '.json');
}

function readJson(file: string): any {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function normalizeMessages(messages: any): ApiChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => m && typeof m === 'object'
    && (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));
}

/** 项目目录为空/非字符串统一归一为 null，避免索引里出现空串。 */
function normalizeProjectDir(value: any): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toolCallIds(message: ApiChatMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((c) => c && c.id).filter((id): id is string => typeof id === 'string' && !!id);
}

/**
 * 修复崩盘/关窗时留下的半截工具轮：assistant.tool_calls 缺少对应 tool 结果时补
 * ERROR: interrupted，孤儿 tool 结果直接丢弃。否则下一次请求会被 OpenAI 400。
 */
export function repairToolSequence(messages: ApiChatMessage[]): ApiChatMessage[] {
  const out: ApiChatMessage[] = [];
  let pending: Set<string> | null = null;
  const flush = () => {
    if (!pending) return;
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: 'ERROR: interrupted' });
    pending = null;
  };
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') {
      if (pending && typeof m.tool_call_id === 'string' && pending.has(m.tool_call_id)) {
        out.push(m);
        pending.delete(m.tool_call_id);
      }
      continue;
    }
    if (m.role === 'assistant') {
      flush();
      out.push(m);
      const ids = toolCallIds(m);
      if (ids.length) pending = new Set(ids);
      continue;
    }
    if (m.role === 'user' || m.role === 'system') {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

/**
 * 持久化裁剪必须在 user 轮次边界开始，不能把 assistant(tool_calls) 与 tool 结果裁成两半。
 * 最近一轮本身超过上限时宁可多存一点，也不能存出非法历史。
 */
function trimForPersistence(messages: ApiChatMessage[]): ApiChatMessage[] {
  const system = messages[0] && messages[0].role === 'system' ? messages[0] : null;
  const body = system ? messages.slice(1) : messages;
  const capacity = system ? MAX_PERSISTED_MESSAGES - 1 : MAX_PERSISTED_MESSAGES;
  if (body.length <= capacity) return messages;
  let start = body.length - capacity;
  while (start < body.length && body[start].role !== 'user') start++;
  if (start >= body.length) {
    let lastUser = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].role === 'user') { lastUser = i; break; }
    }
    if (lastUser < 0) return system ? [system] : [];
    start = lastUser;
  }
  const tail = body.slice(start);
  return system ? [system, ...tail] : tail;
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('');
  }
  return '';
}

/**
 * 会话标题优先使用界面展示文本，避免把技能/计划隐藏指令显示成标题。
 */
export function deriveSessionTitle(messages: ApiChatMessage[]): string {
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const text = String((m as any).displayText || textFromContent(m.content) || '')
      .replace(/^\[附件\s*\d+\s*个\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 60);
  }
  return DEFAULT_TITLE;
}

function newSessionId(): string {
  return 's-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function normalizeMeta(raw: any): ApiSessionMeta | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : DEFAULT_TITLE,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
    messageCount: Number.isFinite(raw.messageCount) ? Math.max(0, Number(raw.messageCount)) : 0,
    projectDir: normalizeProjectDir(raw.projectDir),
  };
}

function writeIndex(profileId: string, index: ApiSessionIndex): void {
  writeJsonAtomic(indexPath(profileId), index);
}

function readSnapshotFile(profileId: string, sessionId: string): any {
  return readJson(sessionFile(profileId, sessionId));
}

function snapshotToMessages(raw: any): ApiChatMessage[] {
  return repairToolSequence(normalizeMessages(raw && raw.messages));
}

/**
 * 索引丢失/损坏时的兜底：目录里的会话快照还在，就按文件重建索引。
 * 没有这一步，一次坏写会让所有旧会话在列表里“消失”（文件仍在但没人引用）。
 */
function recoverSessionsFromFiles(profileId: string): ApiSessionMeta[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(profileDir(profileId), { withFileTypes: true }); } catch (_) { return []; }
  const out: ApiSessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name) || entry.name === 'index.json') continue;
    const full = path.join(profileDir(profileId), entry.name);
    const raw = readJson(full);
    if (!raw || !Array.isArray(raw.messages)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : entry.name.replace(/\.json$/i, '');
    const messages = snapshotToMessages(raw);
    const stat = (() => { try { return fs.statSync(full); } catch (_) { return null; } })();
    out.push({
      id,
      title: (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim().slice(0, 80) : deriveSessionTitle(messages),
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : (stat ? stat.birthtimeMs : Date.now()),
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : (stat ? stat.mtimeMs : Date.now()),
      messageCount: messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
      projectDir: normalizeProjectDir(raw.projectDir),
    });
  }
  return out;
}

function createEmptySession(profileId: string, id: string, title: string, projectDir: string | null = null): ApiSessionMeta {
  const now = Date.now();
  const dir = normalizeProjectDir(projectDir);
  const meta: ApiSessionMeta = { id, title: title || DEFAULT_TITLE, createdAt: now, updatedAt: now, messageCount: 0, projectDir: dir };
  writeJsonAtomic(sessionFile(profileId, id), {
    version: INDEX_VERSION,
    id,
    title: meta.title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    usageTotal: {},
    projectDir: dir,
  });
  return meta;
}

/**
 * 读取/修复会话目录。首次升级时把旧版 `<profile>.json` 迁移为一份 legacy 会话；
 * 没有旧数据则创建一份空会话，保证 activeSessionId 永远有效。
 */
function ensureIndex(profileId: string, createIfMissing = true): ApiSessionIndex {
  const rawIndex = readJson(indexPath(profileId));
  if (rawIndex && rawIndex.version === INDEX_VERSION && Array.isArray(rawIndex.sessions)) {
    const sessions = rawIndex.sessions.map(normalizeMeta).filter((m: ApiSessionMeta | null): m is ApiSessionMeta => !!m);
    if (sessions.length > 0) {
      const active = sessions.some((s: ApiSessionMeta) => s.id === rawIndex.activeSessionId)
        ? rawIndex.activeSessionId
        : sessions[0].id;
      return { version: INDEX_VERSION, activeSessionId: active, sessions };
    }
  }

  // 索引丢失/损坏：优先按目录里残留的 v2 快照重建，而不是直接造一份空会话。
  const recovered = recoverSessionsFromFiles(profileId);
  if (recovered.length > 0) {
    const active = recovered.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    const index: ApiSessionIndex = { version: INDEX_VERSION, activeSessionId: active, sessions: recovered };
    writeIndex(profileId, index);
    return index;
  }

  const legacy = readJson(legacyFile(profileId));
  if (legacy && Array.isArray(legacy.messages)) {
    const id = 'legacy';
    const messages = snapshotToMessages(legacy);
    const title = typeof legacy.title === 'string' && legacy.title.trim()
      ? legacy.title.trim()
      : deriveSessionTitle(messages);
    const now = Date.now();
    const created = Number.isFinite(legacy.createdAt) ? Number(legacy.createdAt) : now;
    const legacyProjectDir = normalizeProjectDir(legacy.projectDir);
    writeJsonAtomic(sessionFile(profileId, id), {
      version: INDEX_VERSION,
      id,
      title,
      createdAt: created,
      updatedAt: now,
      messages,
      usageTotal: legacy.usageTotal && typeof legacy.usageTotal === 'object' ? legacy.usageTotal : {},
      projectDir: legacyProjectDir,
    });
    const index: ApiSessionIndex = {
      version: INDEX_VERSION,
      activeSessionId: id,
      sessions: [{ id, title, createdAt: created, updatedAt: now, messageCount: messages.filter((m) => m.role === 'user' || m.role === 'assistant').length, projectDir: legacyProjectDir }],
    };
    writeIndex(profileId, index);
    return index;
  }

  if (!createIfMissing) return { version: INDEX_VERSION, activeSessionId: '', sessions: [] };
  const id = newSessionId();
  const meta = createEmptySession(profileId, id, DEFAULT_TITLE);
  const index: ApiSessionIndex = { version: INDEX_VERSION, activeSessionId: id, sessions: [meta] };
  writeIndex(profileId, index);
  return index;
}

/** 当前 active 会话 id；首次读取会创建目录/默认会话。 */
export function getActiveApiSessionId(profileId: string): string {
  return ensureIndex(profileId).activeSessionId;
}

/** 列出当前 profile 的会话（按最近更新倒序，active 不特殊排序）。 */
export function listApiSessions(profileId: string): ApiSessionList {
  const index = ensureIndex(profileId);
  pruneProfileAttachments(profileId);
  return {
    activeSessionId: index.activeSessionId,
    sessions: index.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

/** 切换 active；返回是否有效 id。 */
export function setActiveApiSession(profileId: string, sessionId: string): boolean {
  const index = ensureIndex(profileId);
  if (!index.sessions.some((s) => s.id === sessionId)) return false;
  index.activeSessionId = sessionId;
  writeIndex(profileId, index);
  return true;
}

/** 新建一个空会话并设为 active。 */
export function createApiSession(profileId: string, opts: { id?: string; title?: string; projectDir?: string | null } = {}): string {
  const index = ensureIndex(profileId, false);
  const id = opts.id && !index.sessions.some((s) => s.id === opts.id) ? opts.id : newSessionId();
  const meta = createEmptySession(profileId, id, opts.title || DEFAULT_TITLE, opts.projectDir || null);
  index.sessions.push(meta);
  index.activeSessionId = id;
  writeIndex(profileId, index);
  return id;
}

/**
 * 读取会话快照；默认读 active。坏文件/半截写入不阻断启动。
 */
export function loadApiSessionSnapshot(profileId: string, sessionId?: string): ApiSessionSnapshot | null {
  const index = ensureIndex(profileId);
  const id = sessionId || index.activeSessionId;
  const meta = index.sessions.find((s) => s.id === id);
  if (!meta) return null;
  const raw = readSnapshotFile(profileId, id);
  if (!raw) return null;
  return {
    id,
    title: (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : meta.title,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : meta.createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : meta.updatedAt,
    messages: snapshotToMessages(raw),
    usageTotal: raw.usageTotal && typeof raw.usageTotal === 'object' ? raw.usageTotal : {},
    projectDir: normalizeProjectDir(raw.projectDir) || meta.projectDir || null,
  };
}

/** 读取会话的项目目录；默认读 active，没有则返回 null。 */
export function getApiSessionProjectDir(profileId: string, sessionId?: string): string | null {
  const snap = loadApiSessionSnapshot(profileId, sessionId);
  return snap ? (snap.projectDir || null) : null;
}

/**
 * 只更新会话的项目目录，不动消息与 active；默认作用于 active 会话。
 * 快照缺失时补一个最小快照，保证下次读取不会丢目录。
 */
export function setApiSessionProjectDir(profileId: string, sessionId: string | null | undefined, projectDir: string | null): boolean {
  const index = ensureIndex(profileId);
  const sid = sessionId && index.sessions.some((s) => s.id === sessionId) ? sessionId : index.activeSessionId;
  const meta = index.sessions.find((s) => s.id === sid);
  if (!meta) return false;
  const dir = normalizeProjectDir(projectDir);
  meta.projectDir = dir;
  const raw = readSnapshotFile(profileId, sid) || {
    version: INDEX_VERSION,
    id: sid,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messages: [],
    usageTotal: {},
  };
  raw.projectDir = dir;
  writeJsonAtomic(sessionFile(profileId, sid), raw);
  writeIndex(profileId, index);
  return true;
}

/** 兼容旧调用：只返回消息，默认 active 会话。 */
export function loadApiSession(profileId: string, sessionId?: string): ApiChatMessage[] {
  const snap = loadApiSessionSnapshot(profileId, sessionId);
  return snap ? snap.messages : [];
}

/**
 * 原子保存会话快照；只保留最近 MAX_PERSISTED_MESSAGES 条，system 始终保留。
 * @returns 实际写入的 sessionId
 */
function saveApiSessionInner(
  profileId: string,
  messages: ApiChatMessage[],
  opts: SaveApiSessionOptions = {},
): string {
  const index = ensureIndex(profileId);
  const sid = opts.sessionId && opts.sessionId.trim() ? opts.sessionId : index.activeSessionId;
  const system = messages[0] && messages[0].role === 'system' ? messages[0] : null;
  const trimmed = trimForPersistence(messages);
  const out = system && !trimmed.includes(system) ? [system, ...trimmed] : trimmed;
  const existing = index.sessions.find((s) => s.id === sid);
  const now = opts.updatedAt || Date.now();
  const createdAt = Number.isFinite(opts.createdAt) ? Number(opts.createdAt) : (existing ? existing.createdAt : now);
  const title = (opts.title && opts.title.trim()) ? opts.title.trim().slice(0, 80)
    : (existing && existing.title && existing.title !== DEFAULT_TITLE ? existing.title : deriveSessionTitle(out));
  const existingProjectDir = existing ? (existing.projectDir || null) : null;
  const projectDir = opts.projectDir !== undefined
    ? normalizeProjectDir(opts.projectDir)
    : existingProjectDir;
  const meta: ApiSessionMeta = {
    id: sid,
    title,
    createdAt,
    updatedAt: now,
    messageCount: out.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    projectDir,
  };
  writeJsonAtomic(sessionFile(profileId, sid), {
    version: INDEX_VERSION,
    id: sid,
    title,
    createdAt,
    updatedAt: now,
    messages: out,
    usageTotal: opts.usageTotal && typeof opts.usageTotal === 'object' ? opts.usageTotal : {},
    projectDir,
  });
  if (existing) Object.assign(existing, meta);
  else index.sessions.push(meta);
  writeIndex(profileId, index);
  return sid;
}

/** 保存失败不能影响主对话；下一次持久化会再尝试。 */
export function saveApiSession(
  profileId: string,
  messages: ApiChatMessage[],
  opts: SaveApiSessionOptions = {},
): string {
  try {
    return saveApiSessionInner(profileId, messages, opts);
  } catch (err: any) {
    console.warn('[Cuckoo API] 会话保存失败:', (err && err.message) || err);
    return opts.sessionId || '';
  }
}

/**
 * 删除一个会话；删除 active 时自动切到最近更新的一份，全部删空则新建空会话。
 * @returns 删除后的 activeSessionId
 */
export function deleteApiSession(profileId: string, sessionId: string): string {
  const index = ensureIndex(profileId);
  const idx = index.sessions.findIndex((s) => s.id === sessionId);
  if (idx < 0) return index.activeSessionId;
  index.sessions.splice(idx, 1);
  try { fs.unlinkSync(sessionFile(profileId, sessionId)); } catch (_) { /* ignore */ }
  if (index.sessions.length === 0) {
    const id = newSessionId();
    const meta = createEmptySession(profileId, id, DEFAULT_TITLE);
    index.sessions.push(meta);
    index.activeSessionId = id;
  } else if (index.activeSessionId === sessionId || !index.sessions.some((s) => s.id === index.activeSessionId)) {
    index.activeSessionId = index.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }
  writeIndex(profileId, index);
  pruneProfileAttachments(profileId, { minAgeMs: 0, force: true });
  return index.activeSessionId;
}

/** 新对话/删除窗口时清空该 profile 的全部会话（兼容旧调用）。 */
export function clearApiSession(profileId: string): void {
  try {
    fs.rmSync(profileDir(profileId), { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  try {
    const legacy = legacyFile(profileId);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch (_) { /* ignore */ }
}

/** 收集某个 profile 所有会话里引用到的附件路径（供附件清理使用）。 */
export function collectApiAttachmentPaths(profileId: string): string[] {
  const index = ensureIndex(profileId);
  const paths: string[] = [];
  for (const meta of index.sessions) {
    const raw = readSnapshotFile(profileId, meta.id);
    for (const m of normalizeMessages(raw && raw.messages)) {
      for (const ref of (Array.isArray(m.attachments) ? m.attachments : [])) {
        if (ref && typeof ref.path === 'string' && ref.path) paths.push(ref.path);
      }
    }
  }
  return paths;
}

const attachmentGcDone = new Set<string>();

/**
 * 清理没有被任何会话引用的附件。每个 profile 每个进程默认只跑一次，
 * 避免每次列表都全量扫盘；删除会话时可 force 立即回收。
 */
export function pruneProfileAttachments(profileId: string, opts: { minAgeMs?: number; force?: boolean } = {}): { removed: number; bytes: number } {
  if (!opts.force && attachmentGcDone.has(profileId)) return { removed: 0, bytes: 0 };
  attachmentGcDone.add(profileId);
  try {
    return pruneOrphanAttachments(profileId, collectApiAttachmentPaths(profileId), {
      minAgeMs: Number.isFinite(opts.minAgeMs) ? Number(opts.minAgeMs) : 24 * 60 * 60 * 1000,
    });
  } catch (_) {
    return { removed: 0, bytes: 0 };
  }
}

export { MAX_PERSISTED_MESSAGES };
