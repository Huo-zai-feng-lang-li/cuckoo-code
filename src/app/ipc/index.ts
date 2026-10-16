/**
 * IPC 处理器注册总入口（渲染进程 → 主进程）
 * 按领域拆分为子注册器；本文件仅负责编排。
 */
import { registerProjectIpc } from './project.js';
import { registerSessionIpc } from './session.js';
import { registerCommandIpc } from './command.js';
import { registerToolIpc } from './tool.js';
import { registerRendererIpc } from './renderer.js';
import { registerShellIpc } from './shell.js';
import { registerSubagentIpc } from './subagent.js';
import { registerHarnessIpc } from './harness.js';
import { registerSnippetsIpc } from './snippets.js';
import { registerSettingsIpc } from './settings.js';
import { registerPluginIpc } from './plugin.js';
import { registerWebServerIpc } from './webserver.js';
import { registerRemoteIpc } from './remote.js';
import { registerThemeIpc } from './theme.js';
import { registerWindowGroupsIpc, onSwitchShareResult, onHarnessExportResult } from './window-groups.js';
import { registerMemoryIpc } from './memory.js';
import { registerSnapshotIpc } from './snapshot.js';
import { registerRulesIpc } from './rules.js';
import { registerGitIpc } from './git.js';
import { registerTaskIpc } from './task.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerIpcHandlers(): void {
  // 窗口组切换：AI 页面分享回执
  ipcMain.on('cuckoo-switch-share-result', onSwitchShareResult);
  // 窗口组切换：harness 状态导出回执
  ipcMain.on('harness-export-state-reply', onHarnessExportResult);
  registerProjectIpc();
  registerSessionIpc();
  registerCommandIpc();
  registerToolIpc();
  registerRendererIpc();
  registerShellIpc();
  registerSubagentIpc();
  registerHarnessIpc();
  registerSnippetsIpc();
  registerSettingsIpc();
  registerPluginIpc();
  registerWebServerIpc();
  registerRemoteIpc();
  registerThemeIpc();
  registerWindowGroupsIpc();
  registerMemoryIpc();
  registerSnapshotIpc();
  registerRulesIpc();
  registerGitIpc();
  registerTaskIpc();
}

export { registerIpcHandlers };
