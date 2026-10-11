import { createRequire } from 'node:module';
import { createUserRule, deleteUserRule, listUserRules, openUserRulesDir, saveUserRule } from '../../rules/files.js';

const require = createRequire(import.meta.url);
const { ipcMain, shell } = require('electron');

function result(action: () => unknown, fallback: string): unknown {
  try { return { success: true, ...(action() as object) }; }
  catch (error: any) { return { success: false, error: error.message || fallback }; }
}

export function registerRulesIpc(): void {
  ipcMain.handle('rules-list', () => result(() => ({ rules: listUserRules() }), '加载规则失败'));
  ipcMain.handle('rules-create', (_event: any, args: any = {}) => result(() => ({ rule: createUserRule(args.fileName, args.content) }), '创建规则失败'));
  ipcMain.handle('rules-save', (_event: any, args: any = {}) => result(() => ({ rule: saveUserRule(args.fileName, args.content, args.expectedHash) }), '保存规则失败'));
  ipcMain.handle('rules-delete', (_event: any, args: any = {}) => result(() => { deleteUserRule(args.fileName, args.expectedHash); return {}; }, '删除规则失败'));
  ipcMain.handle('rules-open-dir', async () => { try { await shell.openPath(openUserRulesDir()); return { success: true }; } catch (error: any) { return { success: false, error: error.message || '打开目录失败' }; } });
}
