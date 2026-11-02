/**
 * 生成宠物包数据（src/ui/pets/pets.generated.js）
 *
 * 真源：src/ui/pets/<id>/pack.json + 同名精灵图 PNG（来自 dsh-go 的 Clawd on Desk 主题包）。
 * 产物：把 pack.json 压成精简运行时数据（逐帧数组压平、去掉仅 Flutter 用的字段），
 *       由 src/ui/pets/pet.js 直接消费。pack.json 保持原样以便后续替换/新增宠物。
 *
 * 生成物勿手改；改完真源跑 npm run compile（或 node scripts/build-pets.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'ui', 'pets');
const OUT = path.join(SRC_DIR, 'pets.generated.js');

/** 逐帧 [i,ms] 压成扁平数组 */
function flatFrames(frames) {
  const out = [];
  for (const f of frames || []) { out.push(f.i | 0, f.ms | 0); }
  return out;
}

/** 只保留渲染要用的字段 */
function slimAnim(a) {
  const box = a.box || {};
  return {
    sheet: a.sheet,
    fw: a.frameW | 0,
    fh: a.frameH | 0,
    cols: a.cols | 0,
    box: [box.x | 0, box.y | 0, box.w | 0, box.h | 0],
    loop: a.loop !== false,
    ms: a.ms | 0,
    frames: flatFrames(a.frames),
  };
}

function loadPack(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const anims = {};
  for (const [name, a] of Object.entries(raw.animations || {})) anims[name] = slimAnim(a);
  const timings = raw.timings || {};
  const idlePool = raw.idlePool || {};
  return {
    id: raw.id,
    name: raw.name,
    scale: raw.scale || 1,
    canvas: [raw.canvas.w, raw.canvas.h],
    pixelArt: raw.pixelArt !== false,
    animations: anims,
    // 可见内容区（idle 身体在 canvas 内的位置）：气泡贴着它顶边，避免贴到透明留白上
    contentBox: raw.contentBox
      ? [raw.contentBox.x | 0, raw.contentBox.y | 0, raw.contentBox.w | 0, raw.contentBox.h | 0]
      : [0, 0, raw.canvas.w | 0, raw.canvas.h | 0],
    states: raw.states || {},
    tiers: raw.tiers || {},
    minDisplay: timings.minDisplay || {},
    autoReturn: timings.autoReturn || {},
    reactions: raw.reactions || {},
    idlePool: {
      everyMs: idlePool.everyMs || null,
      anims: (idlePool.anims || []).map((x) => ({ anim: x.anim, ms: x.ms, weight: x.weight || 1 })),
    },
  };
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.warn('[build-pets] 未找到 src/ui/pets，跳过');
    return;
  }
  const ids = fs.readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(SRC_DIR, n, 'pack.json')));
  const packs = {};
  for (const id of ids) packs[id] = loadPack(path.join(SRC_DIR, id));

  const banner = '/* 本文件由 scripts/build-pets.mjs 自动生成，请勿手动编辑。真源：src/ui/pets/<id>/pack.json */\n';
  const body = 'window.CUCKOO_PETS = ' + JSON.stringify(packs) + ';\n';
  fs.writeFileSync(OUT, banner + body, 'utf8');
  console.log('[build-pets] 生成 src/ui/pets/pets.generated.js（' + (banner.length + body.length) + ' 字节，' + ids.length + ' 个宠物包）');
}

main();
