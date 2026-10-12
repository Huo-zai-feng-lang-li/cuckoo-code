'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('项目文件：右键菜单提供 新建/重命名/删除', () => {
  const filesTs = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'scripts', 'pages', 'files.ts'), 'utf8');
  assert.ok(filesTs.includes('function showCtxMenu'), '应有右键菜单构造函数');
  assert.ok(filesTs.includes('doCreate('), '应有新建逻辑');
  assert.ok(filesTs.includes('doRename('), '应有重命名逻辑');
  assert.ok(filesTs.includes('doDelete('), '应有删除逻辑');
  assert.ok(filesTs.includes("createProjectEntry"), '应调用新建 IPC');
  assert.ok(filesTs.includes("renameProjectEntry"), '应调用重命名 IPC');
  assert.ok(filesTs.includes("deleteProjectEntry"), '应调用删除 IPC');
});

test('文件管理：删除走回收站 + 主进程防护（不删根目录/防目录穿越）', () => {
  const sess = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'app', 'ipc', 'session.ts'), 'utf8');
  assert.ok(sess.includes("shell.trashItem"), '删除应走系统回收站');
  assert.ok(sess.includes('不能删除项目根目录'), '删除应拒绝项目根目录');
  assert.ok(sess.includes('不能重命名项目根目录'), '重命名应拒绝项目根目录');
  assert.ok(sess.includes('resolveProjectPath'), '应复用防目录穿越解析');
});

test('Diff 视图：与 git HEAD 对比，独立容器不覆盖编辑器', () => {
  const pm = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'scripts', 'preview-monaco.ts'), 'utf8');
  assert.ok(pm.includes('createDiffEditor'), '应使用 Monaco createDiffEditor');
  assert.ok(pm.includes('renderSideBySide: false'), '应为内联 diff');
  const sess = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'app', 'ipc', 'session.ts'), 'utf8');
  assert.ok(sess.includes("'git', ['show', 'HEAD:'"), '应通过 git show HEAD 取基准');
  const prev = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'scripts', 'preview.ts'), 'utf8');
  assert.ok(prev.includes('ck-monaco-diff'), 'diff 应用独立容器，不覆盖编辑器');
});
