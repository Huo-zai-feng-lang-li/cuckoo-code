/**
 * 生成 Android 应用图标全部 mipmap 资源（4 套可选图标）。
 * 用法：
 *   node scripts/gen-android-icons.mjs             # 从 assets/android-icons 生成 mipmap
 *   node scripts/gen-android-icons.mjs --prepare   # 额外把外部原图缩放到 assets/android-icons
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'android-icons');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

const ICONS = [
  { id: 'default', label: 'Cuckoo' },
  { id: 'glass', label: 'Glass' },
  { id: 'sticker', label: 'Sticker' },
  { id: 'gold', label: 'Gold' },
];

const EXT_SOURCES = [
  { id: 'default', src: path.join(ROOT, 'assets', 'icon.png'), crop: 1.0 },
  { id: 'glass', src: 'D:/Desktop/app-icon/1.png', crop: 0.92 },
  { id: 'sticker', src: 'D:/Desktop/app-icon/2.png', crop: 0.82 },
  { id: 'gold', src: 'D:/Desktop/app-icon/3.png', crop: 0.92 },
];

const DENSITIES = [
  { dir: 'mipmap-mdpi', scale: 1 },
  { dir: 'mipmap-hdpi', scale: 1.5 },
  { dir: 'mipmap-xhdpi', scale: 2 },
  { dir: 'mipmap-xxhdpi', scale: 3 },
  { dir: 'mipmap-xxxhdpi', scale: 4 },
];

const WHITE_THRESHOLD = 235;

async function removeOuterWhite(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const isWhite = (i) =>
    data[i] >= WHITE_THRESHOLD &&
    data[i + 1] >= WHITE_THRESHOLD &&
    data[i + 2] >= WHITE_THRESHOLD;
  const visited = new Uint8Array(W * H);
  const queue = [];
  for (let x = 0; x < W; x++) {
    for (const y of [0, H - 1]) {
      const idx = y * W + x;
      if (!visited[idx] && isWhite(idx * channels)) { visited[idx] = 1; queue.push(idx); }
    }
  }
  for (let y = 0; y < H; y++) {
    for (const x of [0, W - 1]) {
      const idx = y * W + x;
      if (!visited[idx] && isWhite(idx * channels)) { visited[idx] = 1; queue.push(idx); }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % W, y = (idx / W) | 0;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < W - 1 ? idx + 1 : -1,
      y > 0 ? idx - W : -1,
      y < H - 1 ? idx + W : -1,
    ];
    for (const n of neighbors) {
      if (n < 0 || visited[n]) continue;
      if (!isWhite(n * channels)) continue;
      visited[n] = 1;
      queue.push(n);
    }
  }
  for (const idx of queue) data[idx * channels + 3] = 0;
  return sharp(data, { raw: { width: W, height: H, channels } }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * 采样四个角内侧（5%~18% 区域）的平均色作为 adaptive icon 底色。
 * 四角一定是背景，不会被主体/贴纸边框/装饰线干扰。
 */
async function sampleBgColor(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const from = Math.round(Math.min(W, H) * 0.05);
  const to = Math.round(Math.min(W, H) * 0.18);
  const corners = [
    [from, from, to, to],                     // 左上
    [W - to, from, W - from, to],             // 右上
    [from, H - to, to, H - from],             // 左下
    [W - to, H - to, W - from, H - from],     // 右下
  ];
  let r = 0, g = 0, b = 0, count = 0;
  for (const [x0, y0, x1, y1] of corners) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * channels;
        if (data[i + 3] < 200) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
      }
    }
  }
  if (count === 0) return '#0a0e17';
  const hex = (v) => Math.round(v / count).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

async function prepare() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  for (const s of EXT_SOURCES) {
    if (!fs.existsSync(s.src)) {
      console.warn('[prepare] 源图不存在，跳过:', s.src);
      continue;
    }
    const meta = await sharp(s.src).metadata();
    const w = meta.width, h = meta.height;
    const side = Math.min(w, h);
    const keep = Math.round(side * s.crop);
    const left = Math.round((w - keep) / 2);
    const top = Math.round((h - keep) / 2);
    const cropped = await sharp(s.src)
      .extract({ left, top, width: keep, height: keep })
      .resize(1024, 1024, { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const cleaned = await removeOuterWhite(cropped);
    const out = path.join(SRC_DIR, s.id + '.png');
    fs.writeFileSync(out, cleaned);
    console.log('[prepare]', s.id, '→', out);
  }
}

function roundedMaskSvg(size, radius) {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<rect x="0" y="0" width="' + size + '" height="' + size + '" rx="' + radius + '" ry="' + radius + '" fill="#fff"/>' +
    '</svg>'
  );
}

function circleMaskSvg(size) {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + size / 2 + '" fill="#fff"/>' +
    '</svg>'
  );
}

async function makeLegacy(srcBuf, size, shape) {
  const base = await sharp(srcBuf)
    .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
    .ensureAlpha()
    .png()
    .toBuffer();
  const mask = shape === 'round' ? circleMaskSvg(size) : roundedMaskSvg(size, Math.round(size * 0.22));
  return sharp(base)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function makeForeground(srcBuf, size) {
  const inner = Math.round(size * (72 / 108));
  const content = await sharp(srcBuf)
    .resize(inner, inner, { fit: 'cover', kernel: 'lanczos3' })
    .ensureAlpha()
    .png()
    .toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: content, left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function xmlAdaptive(bgColorName, fgId) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/' + bgColorName + '"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_' + fgId + '_foreground"/>\n' +
    '</adaptive-icon>\n';
}

async function generate() {
  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  const values = path.join(RES, 'values');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.mkdirSync(values, { recursive: true });

  for (const icon of ICONS) {
    const srcPath = path.join(SRC_DIR, icon.id + '.png');
    if (!fs.existsSync(srcPath)) {
      console.warn('[gen] 源图不存在，跳过整套:', srcPath);
      continue;
    }
    const srcBuf = fs.readFileSync(srcPath);
    const cleaned = await removeOuterWhite(srcBuf);
    const bgColor = await sampleBgColor(cleaned);

    const colorName = 'ic_launcher_background_' + icon.id;
    fs.writeFileSync(
      path.join(values, colorName + '.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="' + colorName + '">' + bgColor + '</color>\n</resources>\n'
    );

    fs.writeFileSync(
      path.join(anydpi, 'ic_launcher_' + icon.id + '.xml'),
      xmlAdaptive(colorName, icon.id)
    );
    fs.writeFileSync(
      path.join(anydpi, 'ic_launcher_' + icon.id + '_round.xml'),
      xmlAdaptive(colorName, icon.id)
    );

    for (const d of DENSITIES) {
      const outDir = path.join(RES, d.dir);
      fs.mkdirSync(outDir, { recursive: true });

      const legacySize = Math.round(48 * d.scale);
      fs.writeFileSync(
        path.join(outDir, 'ic_launcher_' + icon.id + '.png'),
        await makeLegacy(cleaned, legacySize, 'square')
      );
      fs.writeFileSync(
        path.join(outDir, 'ic_launcher_' + icon.id + '_round.png'),
        await makeLegacy(cleaned, legacySize, 'round')
      );

      const fgSize = Math.round(108 * d.scale);
      fs.writeFileSync(
        path.join(outDir, 'ic_launcher_' + icon.id + '_foreground.png'),
        await makeForeground(cleaned, fgSize)
      );
    }
    console.log('[gen] ' + icon.id + ' 完成，底色 ' + bgColor);
  }
}

const isPrepare = process.argv.includes('--prepare');
if (isPrepare) await prepare();
await generate();
console.log('[gen-android-icons] 完成');
