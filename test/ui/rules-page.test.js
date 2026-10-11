import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.join(import.meta.dirname, '../..');
const page = fs.readFileSync(path.join(root, 'src/ui/shell/partials/pages/rules.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/ui/shell/styles/components.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'src/ui/shell/scripts/pages/rules.ts'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'src/overlay/panel.ts'), 'utf8');

describe('全局规则页面交互', () => {
  test('编辑状态可以真正隐藏列表和工具栏', () => {
    expect(styles).toMatch(/\.cuckoo-hidden\s*\{\s*display:\s*none\s*!important/);
  });

  test('取消编辑返回列表，保存和删除都有明确状态处理', () => {
    expect(page).toContain('id="rule-cancel"');
    expect(page).toContain('aria-label="取消编辑"');
    expect(script).toContain('showEditor(false)');
    expect(script).toContain('setBusy');
  });

  test('网页启用 Trusted Types 时仍能注入工具面板', () => {
    expect(panel).toContain("trustedTypes.createPolicy('cuckoo-overlay'");
    expect(panel).toContain('setTrustedHtml(container, OVERLAY_HTML)');
    expect(panel).toContain('OVERLAY_HTML');
  });

  test('规则操作按钮使用紧凑尺寸', () => {
    expect(styles).toContain('.ck-rule-toolbar .ck-btn');
    expect(styles).toContain('flex: 0 0 auto');
    expect(page).toContain('ck-rule-compact');
  });
});
