/**
 * 技能页：列出技能，点击追加"请使用 xxx 技能"；
 * 悬停卡片显示「打开目录 / 删除」（与提示词/记忆/子代理页保持同一套交互）。
 */
import { api, ckAlert, ckConfirm, escapeHtml, escapeAttr } from '../shared.js';
import { addRecent } from '../recent.js';

const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

export async function loadSkills(): Promise<void> {
  const listEl = document.getElementById('skill-list');
  if (!listEl || !api.listSkills) return;
  try {
    const r = await api.listSkills();
    const skills = (r && r.success) ? r.skills : [];
    if (!skills || skills.length === 0) {
      listEl.innerHTML = '<div class="ck-list-empty">未发现技能<br>（.agents/skills/ 或 ~/.agents/skills/）</div>';
      return;
    }
    const skillCard = (s: any) =>
      '<div class="ck-skill-item" data-name="' + escapeHtml(s.name) + '">' +
        '<div class="ck-skill-top">' +
          '<span class="ck-skill-name">' + escapeHtml(s.name) + '</span>' +
          '<div class="ck-agent-actions">' +
            '<button class="ck-snip-icon-btn" data-open-skill="' + escapeAttr(s.skillPath || '') + '" title="打开所在目录">' + ICON_FOLDER + '</button>' +
            '<button class="ck-snip-icon-btn danger" data-del-skill="' + escapeAttr(s.skillPath || '') + '" title="删除技能（移入回收站）">' + ICON_TRASH + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ck-skill-desc">' + escapeHtml(s.description || '（无描述）') + '</div>' +
      '</div>';
    const userSkills = skills.filter((s: any) => s.source !== 'project');
    const projSkills = skills.filter((s: any) => s.source === 'project');
    let html = '';
    if (userSkills.length) html += '<div class="ck-mcp-group-title">用户级</div>' + userSkills.map(skillCard).join('');
    if (projSkills.length) html += '<div class="ck-mcp-group-title">项目级</div>' + projSkills.map(skillCard).join('');
    listEl.innerHTML = html;

    listEl.querySelectorAll('.ck-skill-item').forEach((el: any) => {
      el.addEventListener('click', async (e: any) => {
        // 操作按钮自己处理点击，不能顺带插入提示词
        if (e.target.closest('[data-open-skill]') || e.target.closest('[data-del-skill]')) return;
        if (api.appendSnippet) {
          try { await api.appendSnippet('请使用 ' + el.dataset.name + ' 技能'); } catch (_) { /* ignore */ }
        }
        addRecent('skill', el.dataset.name);
      });
    });

    listEl.querySelectorAll('[data-open-skill]').forEach((btn: any) => {
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        if (!api.openSkillDir) return;
        try {
          const rr = await api.openSkillDir(btn.dataset.openSkill);
          if (rr && !rr.success) await ckAlert((rr && rr.error) || '打开目录失败');
        } catch (err: any) { await ckAlert('打开目录失败: ' + (err.message || err)); }
      });
    });

    listEl.querySelectorAll('[data-del-skill]').forEach((btn: any) => {
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        const cardEl = btn.closest('.ck-skill-item');
        const name = cardEl ? cardEl.dataset.name : '';
        const ok = await ckConfirm('确定删除技能「' + name + '」？\n技能目录会移入系统回收站，可从回收站恢复。', '删除技能');
        if (!ok) return;
        if (!api.deleteSkillDir) return;
        try {
          const rr = await api.deleteSkillDir(btn.dataset.delSkill);
          if (rr && rr.success) loadSkills();
          else await ckAlert((rr && rr.error) || '删除失败');
        } catch (err: any) { await ckAlert('删除失败: ' + (err.message || err)); }
      });
    });
  } catch (_) {
    listEl.innerHTML = '<div class="ck-list-empty">加载失败</div>';
  }
}

document.getElementById('skill-refresh')?.addEventListener('click', loadSkills);
