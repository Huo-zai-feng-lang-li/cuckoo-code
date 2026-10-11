import { api, ckAlert, ckConfirm, escapeHtml } from '../shared.js';

interface RuleRecord { fileName: string; content: string; hash: string; updatedAt?: string; }
let records: RuleRecord[] = [];
let selected: RuleRecord | null = null;
let creating = false;

function byId(id: string): HTMLElement | null { return document.getElementById(id); }
/** 时间：YYYY-MM-DD HH:mm（本地时区），无时间返回空 */
function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p2 = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function setError(message: string): void { const el = byId('rule-error'); if (el) el.textContent = message; }
function setBusy(busy: boolean): void {
  ['rule-save', 'rule-delete', 'rule-cancel'].forEach((id) => {
    const button = byId(id) as HTMLButtonElement | null;
    if (button) button.disabled = busy;
  });
}

function renderList(): void {
  const list = byId('rule-list');
  if (!list) return;
  if (!records.length) { list.innerHTML = '<div class="ck-list-empty">暂无全局规则</div>'; return; }
  list.innerHTML = records.map((r) => `<button class="ck-skill-item ck-rule-item" data-rule="${escapeHtml(r.fileName)}"><div><div class="ck-skill-name">${escapeHtml(r.fileName)}</div><div class="ck-skill-desc">${escapeHtml(fmtTime(r.updatedAt) || '全局规则')}</div></div><span class="ck-rule-item-action">编辑 ›</span></button>`).join('');
  list.querySelectorAll('[data-rule]').forEach((el) => el.addEventListener('click', () => openRecord((el as HTMLElement).dataset.rule || '')));
}

function showEditor(show: boolean): void {
  byId('rule-editor')?.classList.toggle('cuckoo-hidden', !show);
  byId('rule-list')?.classList.toggle('cuckoo-hidden', show);
  byId('rule-new')?.classList.toggle('cuckoo-hidden', show);
  byId('rule-open-dir')?.classList.toggle('cuckoo-hidden', show);
  byId('rule-refresh')?.classList.toggle('cuckoo-hidden', show);
}

function openRecord(fileName: string): void {
  const record = records.find((r) => r.fileName === fileName);
  if (!record) return;
  selected = record; creating = false; showEditor(true); setError('');
  const title = byId('rule-editor-title'); if (title) title.textContent = '编辑规则';
  byId('rule-delete')?.classList.remove('cuckoo-hidden');
  (byId('rule-file-name') as HTMLInputElement).value = record.fileName;
  (byId('rule-file-name') as HTMLInputElement).readOnly = true;
  (byId('rule-content') as HTMLTextAreaElement).value = record.content;
}

function startCreate(): void {
  selected = null; creating = true; showEditor(true); setError('');
  const title = byId('rule-editor-title'); if (title) title.textContent = '新建规则';
  byId('rule-delete')?.classList.add('cuckoo-hidden');
  const name = byId('rule-file-name') as HTMLInputElement; name.readOnly = false; name.value = 'rule.md';
  (byId('rule-content') as HTMLTextAreaElement).value = '---\nname: rule\n---\n\n'; name.focus();
}

async function loadRulesData(): Promise<void> {
  if (!api.listRules) return;
  try { const result = await api.listRules(); if (!result?.success) throw new Error(result?.error || '加载失败'); records = result.rules || []; renderList(); }
  catch (error: any) { const list = byId('rule-list'); if (list) list.innerHTML = `<div class="ck-list-empty">${escapeHtml(error.message || error)}</div>`; }
}

async function save(): Promise<void> {
  if (!api.createRule && creating || !api.saveRule && !creating) { setError('规则接口未连接，请重启应用后重试'); return; }
  const name = (byId('rule-file-name') as HTMLInputElement).value.trim();
  const content = (byId('rule-content') as HTMLTextAreaElement).value;
  if (!name) { setError('请填写文件名'); return; }
  setBusy(true); setError('');
  try {
    const result = creating ? await api.createRule?.(name, content) : await api.saveRule?.(name, content, selected?.hash || '');
    if (!result?.success || !result.rule) { setError(result?.error || '保存失败'); return; }
    selected = result.rule; creating = false; await loadRulesData(); openRecord(result.rule.fileName);
  } catch (error: any) { setError(error?.message || '保存失败'); }
  finally { setBusy(false); }
}

async function remove(): Promise<void> {
  if (!selected || creating || !(await ckConfirm(`确定删除 ${selected.fileName}？此操作不可恢复。`))) return;
  if (!api.deleteRule) { setError('规则接口未连接，请重启应用后重试'); return; }
  setBusy(true); setError('');
  try {
    const result = await api.deleteRule(selected.fileName, selected.hash);
    if (!result?.success) { setError(result?.error || '删除失败'); return; }
    selected = null; showEditor(false); await loadRulesData();
  } catch (error: any) { setError(error?.message || '删除失败'); }
  finally { setBusy(false); }
}

export function loadRules(): void { void loadRulesData(); }
byId('rule-new')?.addEventListener('click', startCreate);
byId('rule-refresh')?.addEventListener('click', () => { void loadRulesData(); });
byId('rule-open-dir')?.addEventListener('click', async () => { const result = await api.openRulesDir?.(); if (!result?.success) await ckAlert(result?.error || '打开目录失败'); });
byId('rule-cancel')?.addEventListener('click', () => { showEditor(false); selected = null; creating = false; setError(''); });
byId('rule-save')?.addEventListener('click', () => { void save(); });
byId('rule-delete')?.addEventListener('click', () => { void remove(); });

