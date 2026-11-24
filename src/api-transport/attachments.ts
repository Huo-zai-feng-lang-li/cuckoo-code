/**
 * API 附件物化。
 *
 * 历史里只存附件路径/类型；每次请求前才读取文件，图片用 sharp 压到
 * 1568 长边、2MB 内，再转成 OpenAI 的 image_url content part。
 * 这样 base64 不会进入历史、JSONL、localStorage，也不会被当成文本 token 全量计费。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { ApiChatMessage, ApiAttachmentRef } from './client.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

export interface IncomingAttachment {
  name?: string;
  mime?: string;
  data?: string;
}

export interface StoredAttachment {
  name: string;
  mime: string;
  path: string;
  size: number;
  kind: 'image' | 'text';
}

export interface SaveAttachmentsResult {
  success: boolean;
  stored: StoredAttachment[];
  error?: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.csv', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.swift', '.lua', '.sql',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.toml', '.ini', '.conf',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.patch', '.diff', '.gitignore',
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1568;

function storageRoot(): string {
  const home = process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo');
  return path.join(home, 'api-attachments');
}

function safeSegment(value: any): string {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function safeName(name: any): string {
  return path.basename(String(name || 'attachment')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'attachment';
}

function decodeBase64(raw: any): Buffer {
  const text = typeof raw === 'string' ? raw : '';
  const comma = text.indexOf(',');
  const data = comma >= 0 ? text.slice(comma + 1) : text;
  return Buffer.from(data, 'base64');
}

function classify(name: string, mime: string): 'image' | 'text' | null {
  const ext = path.extname(name).toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  return null;
}

/**
 * 保存用户附件到 ~/.cuckoo/api-attachments/<profile>/。
 * @param profileId 窗口/profile ID
 * @param files 前端传来的 { name,mime,data(base64) }
 */
export async function saveIncomingAttachments(profileId: string, files: IncomingAttachment[]): Promise<SaveAttachmentsResult> {
  const stored: StoredAttachment[] = [];
  const errors: string[] = [];
  const dir = path.join(storageRoot(), safeSegment(profileId));
  for (const file of Array.isArray(files) ? files : []) {
    const name = safeName(file && file.name);
    const mime = typeof file.mime === 'string' && file.mime ? file.mime : 'application/octet-stream';
    const kind = classify(name, mime);
    if (!kind) {
      errors.push(name + '：暂不支持该类型（API 模式仅支持图片和文本文件）');
      continue;
    }
    let buf: Buffer;
    try { buf = decodeBase64(file && file.data); } catch (_) {
      errors.push(name + '：附件数据损坏');
      continue;
    }
    if (!buf.length) {
      errors.push(name + '：附件为空');
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) {
      errors.push(name + '：文件超过 20MB');
      continue;
    }
    const ext = path.extname(name).toLowerCase() || (kind === 'image' ? '.png' : '.txt');
    const target = path.join(dir, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(target, buf);
      stored.push({ name, mime, path: target, size: buf.length, kind });
    } catch (err: any) {
      errors.push(name + '：保存失败 ' + ((err && err.message) || String(err)));
    }
  }
  return {
    success: stored.length > 0,
    stored,
    error: errors.length ? errors.join('；') : undefined,
  };
}

/**
 * 清理某个 profile 下不再被任何会话引用的附件。
 *
 * 只删“孤儿文件”且默认只删超过 minAgeMs 的旧文件：
 * - 刚保存、尚未写进会话快照的附件不会在阈值内被误删；
 * - 被历史引用的附件永远保留，避免恢复历史时图片丢失。
 *
 * @param profileId profile 目录
 * @param keepPaths 仍被会话引用的绝对路径
 * @param opts.minAgeMs 孤儿文件最短保留时间，默认 0（删除已确认无引用的文件）
 * @returns 删除文件数与释放字节数
 */
export function pruneOrphanAttachments(
  profileId: string,
  keepPaths: Iterable<string>,
  opts: { minAgeMs?: number } = {},
): { removed: number; bytes: number } {
  const dir = path.join(storageRoot(), safeSegment(profileId));
  const keep = new Set<string>();
  for (const p of keepPaths) {
    if (typeof p === 'string' && p) keep.add(normalizePath(p));
  }
  const minAge = Math.max(0, Number(opts.minAgeMs) || 0);
  let removed = 0;
  let bytes = 0;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return { removed, bytes }; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    if (keep.has(normalizePath(full))) continue;
    try {
      const stat = fs.statSync(full);
      if (minAge > 0 && now - stat.mtimeMs < minAge) continue;
      fs.unlinkSync(full);
      removed++;
      bytes += stat.size;
    } catch (_) { /* ignore */ }
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
  return { removed, bytes };
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}


async function resizeImage(buf: Buffer): Promise<{ data: Buffer; mime: string }> {
  const image = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const hasAlpha = !!meta.hasAlpha;
  let edge = MAX_IMAGE_EDGE;
  let quality = 80;
  for (let attempt = 0; attempt < 4; attempt++) {
    const pipeline = sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    const out = hasAlpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= MAX_IMAGE_BYTES) return { data: out, mime: hasAlpha ? 'image/png' : 'image/jpeg' };
    if (quality > 64) quality -= 8;
    else edge = 1024;
  }
  return { data: await sharp(buf, { failOn: 'none' }).rotate().resize({ width: 1024, height: 1024, fit: 'inside' }).jpeg({ quality: 60 }).toBuffer(), mime: 'image/jpeg' };
}

async function materializeImage(ref: ApiAttachmentRef): Promise<string> {
  const buf = await fs.promises.readFile(ref.path);
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  // 以文件真实格式为准，不信任前端/浏览器给的 mime。Windows 文件选择器常给
  // application/octet-stream；若直接拼进 data URL，上游会把图片块当未知类型 400。
  const detectedMime = meta.format === 'jpeg' ? 'image/jpeg'
    : meta.format === 'png' ? 'image/png'
      : null;
  if (detectedMime && buf.length <= MAX_IMAGE_BYTES
    && (meta.width || 0) <= MAX_IMAGE_EDGE && (meta.height || 0) <= MAX_IMAGE_EDGE) {
    return 'data:' + detectedMime + ';base64,' + buf.toString('base64');
  }
  const out = await resizeImage(buf);
  return 'data:' + out.mime + ';base64,' + out.data.toString('base64');
}

async function readTextAttachment(ref: ApiAttachmentRef): Promise<string> {
  const raw = await fs.promises.readFile(ref.path, 'utf8');
  if (raw.length <= MAX_TEXT_CHARS) return raw;
  return raw.slice(0, MAX_TEXT_CHARS) + '\n\n…（附件过长，已截断 ' + (raw.length - MAX_TEXT_CHARS) + ' 字符）';
}

/**
 * 把历史消息里的附件路径物化成 OpenAI content parts。
 * 从最新消息往前分配图片额度，旧图只保留文字占位，避免整段历史反复传图。
 * @param messages 历史消息（可能含 attachments 路径）
 * @param maxImages 活跃上下文最多物化几张图（默认 8）
 */
export async function materializeMessages(
  messages: ApiChatMessage[],
  maxImages = 8,
  opts: { zeroImagePlaceholder?: string } = {},
): Promise<ApiChatMessage[]> {
  const limit = Math.max(0, Math.min(32, Math.round(maxImages)));
  const zeroPlaceholder = opts.zeroImagePlaceholder || '[图片未发送：当前连接未启用图片输入]';
  let imageBudget = limit;
  const counts: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const refs: ApiAttachmentRef[] = (Array.isArray(messages[i].attachments) ? messages[i].attachments : []) || [];
    const imgs = refs.filter((r) => r && r.kind === 'image').length;
    counts[i] = Math.min(imgs, imageBudget);
    imageBudget -= counts[i];
  }

  const out: ApiChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const refs: ApiAttachmentRef[] = (Array.isArray(msg.attachments) ? msg.attachments : []) || [];
    if (!refs.length) { out.push(msg); continue; }
    const baseText = typeof msg.content === 'string' ? msg.content : '';
    const textParts: string[] = [];
    if (baseText) textParts.push(baseText);
    const images: any[] = [];
    let allowImages = counts[i] || 0;
    for (const ref of refs) {
      if (!ref || !ref.path) continue;
      if (ref.kind === 'image') {
        if (allowImages > 0) {
          allowImages--;
          try {
            const url = await materializeImage(ref);
            images.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
          } catch (_) {
            textParts.push('[图片读取失败：' + ref.name + ']');
          }
        } else {
          textParts.push(limit === 0 ? zeroPlaceholder : '[图片已省略：' + ref.name + '（超出活跃图片预算）]');
        }
      } else {
        try {
          const text = await readTextAttachment(ref);
          textParts.push('[附件 ' + ref.name + ']\n' + text);
        } catch (_) {
          textParts.push('[附件读取失败：' + ref.name + ']');
        }
      }
    }
    if (images.length === 0) {
      out.push({ ...msg, content: textParts.join('\n\n'), attachments: undefined });
    } else {
      out.push({
        ...msg,
        content: [{ type: 'text', text: textParts.join('\n\n') || '（附件）' }, ...images],
        attachments: undefined,
      });
    }
  }
  return out;
}

export { MAX_TEXT_CHARS, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE };
