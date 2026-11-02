/**
 * 把 src/ui/pets 复制到 out/src/ui/pets
 * （宠物精灵图与运行时 JS 不是 TS，tsc 不会输出；harness.html 相对路径加载）
 *
 * 幂等：目标已存在则覆盖更新。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd();
const src = path.join(root, 'src', 'ui', 'pets');
const dest = path.join(root, 'out', 'src', 'ui', 'pets');

if (!fs.existsSync(src)) {
  console.warn('[copy-pets] 未找到 src/ui/pets，跳过');
  process.exit(0);
}

try {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log('[copy-pets] 已复制宠物资源 → out/src/ui/pets');
} catch (err) {
  console.warn('[copy-pets] 复制失败:', err.message);
}
