/**
 * Token 显示（状态条 + Token 页）+ 近 10 日柱状图 + 自动压缩。
 */
import { api, ckAlert, ckConfirm, formatTokenCount, formatTokenCountHTML, formatShort, escapeHtml, escapeAttr } from '../shared.js';

const contextEl = document.getElementById('sb-context');
const cumulativeEl = document.getElementById('sb-cumulative');
const windowEl = document.getElementById('sb-window');
const todayEl = document.getElementById('sb-today');
const systemEl = document.getElementById('sb-system');

/** 是否 DeepSeek 高峰时段（工作日 9-12、14-18，北京时间，未含夏令时）。
 *  不含法定节假日判断（节假日会略高估为高峰，可接受）。 */
function isDeepSeekPeak(): boolean {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const day = d.getUTCDay();      // 0=周日
  const hour = d.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

/**
 * 按 DeepSeek Flash 单价粗略估算费用（元）。
 * 假设：输出占 15%、输入缓存命中 70%；高峰时段单价翻倍。
 * 闲时单价（元/百万）：命中 0.02、未命中 1、输出 4。
 */
function estimateCost(totalTokens: number): { cost: number; peak: boolean } {
  const peak = isDeepSeekPeak();
  if (!isFinite(totalTokens) || totalTokens <= 0) return { cost: 0, peak };
  const OUT_RATIO = 0.15;
  const CACHE_HIT = 0.7;
  const M = 1000000;
  const output = totalTokens * OUT_RATIO;
  const input = totalTokens * (1 - OUT_RATIO);
  const hit = input * CACHE_HIT;
  const miss = input * (1 - CACHE_HIT);
  const mul = peak ? 2 : 1;
  const cost = ((hit / M) * 0.02 + (miss / M) * 1 + (output / M) * 4) * mul;
  return { cost, peak };
}

function formatCost(cost: number): string {
  if (!isFinite(cost) || cost <= 0) return '¥0';
  if (cost < 0.01) return '<¥0.01';
  return '¥' + cost.toFixed(2);
}

function costTooltip(peak: boolean): string {
  return '基于「今日窗口」粗略估算，非精确账单\n' +
    '⚠ 假设输出占 15%、输入缓存命中 70%（实际未知）\n' +
    '当前按【' + (peak ? '高峰' : '闲时') + '】价\n' +
    '单价(元/百万)：命中 0.02 / 未命中 1 / 输出 4\n' +
    '高峰时段(工作日 9-12、14-18)翻倍';
}

/** 渲染「今日各窗口用量」柱图（按今日降序） */
function renderChart(windows: any[]): void {
  const chart = document.getElementById('tk-chart');
  if (!chart) return;
  if (!Array.isArray(windows) || windows.length === 0) {
    chart.innerHTML = '<div class="ck-list-empty" style="width:100%;">暂无数据</div>';
    return;
  }
  const sorted = windows.slice().sort((a: any, b: any) => (b.today || 0) - (a.today || 0));
  const values = sorted.map((w: any) => w.today || 0);
  const max = Math.max(1, Math.max.apply(null, values));
  const total = values.reduce((s: number, v: number) => s + v, 0);
  const activeCount = values.filter((v: number) => v > 0).length;

  const summary = '<div class="ck-chart-summary">' +
    '<span>今日全窗口 <b>' + formatShort(total) + '</b></span>' +
    '<span>活跃窗口 <b>' + activeCount + '</b> / ' + sorted.length + '</span>' +
    '</div>';

  const rows = sorted.map((w: any) => {
    const v = w.today || 0;
    const pct = Math.max(1, Math.round((v / max) * 100));
    const name = String(w.name || w.profileId || '--');
    return '<div class="ck-bar-row" data-name="' + escapeAttr(name) + '">' +
      '<span class="ck-bar-label" title="' + escapeAttr(name) + '">' + escapeHtml(name) + '</span>' +
      '<div class="ck-bar-track"><div class="ck-bar" style="width:' + pct + '%;"></div></div>' +
      '<span class="ck-bar-val">' + formatShort(v) + '</span>' +
    '</div>';
  }).join('');

  chart.innerHTML = summary + rows;

  // 点击某窗口 → 详情（今日 + 历史累计）
  chart.querySelectorAll('.ck-bar-row').forEach((row: any) => {
    row.addEventListener('click', () => {
      const name = row.getAttribute('data-name') || '';
      const found = sorted.find((x: any) => String(x.name || x.profileId) === name);
      const todayV = found ? (found.today || 0) : 0;
      const cumV = found ? (found.cumulative || 0) : 0;
      const share = total > 0 ? (todayV / total) * 100 : 0;
      ckAlert(
        '今日 ' + formatShort(todayV) + ' tokens ｜ 占今日全窗口 ' + share.toFixed(1) + '%\n历史累计 ' + formatShort(cumV),
        name || '详情'
      );
    });
  });
}

const tkContext = document.getElementById('tk-context');
const tkCumulative = document.getElementById('tk-cumulative');
const tkToday = document.getElementById('tk-today');
const tkWindow = document.getElementById('tk-window');
const tkSystem = document.getElementById('tk-system');
const tkTodayTotal = document.getElementById('tk-today-total');
const tkCost = document.getElementById('tk-cost');
const tkCostHint = document.getElementById('tk-cost-hint');

if ((api as any).onTokenUpdated) {
  (api as any).onTokenUpdated((data: any) => {
    if (!data) return;
    if (contextEl) contextEl.textContent = formatTokenCount(data.context);
    if (cumulativeEl) cumulativeEl.textContent = formatTokenCount(data.cumulative);
    if (windowEl) windowEl.textContent = formatTokenCount(data.windowCumulative);
    if (todayEl) todayEl.textContent = formatTokenCount(data.todayCumulative);
    if (tkContext) tkContext.innerHTML = formatTokenCountHTML(data.context);
    if (tkCumulative) tkCumulative.textContent = formatTokenCount(data.cumulative);
    if (tkToday) tkToday.textContent = formatTokenCount(data.todayCumulative);
    if (tkTodayTotal && typeof data.todayTotal === 'number') tkTodayTotal.textContent = formatTokenCount(data.todayTotal);
    if (tkWindow) tkWindow.textContent = formatTokenCount(data.windowCumulative);
    if (tkCost) {
      const est = estimateCost(data.todayCumulative);
      tkCost.textContent = formatCost(est.cost);
      if (tkCostHint) tkCostHint.setAttribute('data-tooltip', costTooltip(est.peak));
    }
    if (data.windows) renderChart(data.windows);
  });
}
// 各窗口今日用量（柱图 + 今日全窗口）
if ((api as any).onWindowUsage) {
  (api as any).onWindowUsage((data: any) => {
    if (!data) return;
    if (tkTodayTotal && typeof data.todayTotal === 'number') tkTodayTotal.textContent = formatTokenCount(data.todayTotal);
    if (data.windows) renderChart(data.windows);
  });
}
if ((api as any).getWindowUsage) {
  (api as any).getWindowUsage().then((r: any) => {
    if (r && r.success) {
      if (tkTodayTotal && typeof r.todayTotal === 'number') tkTodayTotal.textContent = formatTokenCount(r.todayTotal);
      if (r.windows) renderChart(r.windows);
    }
  }).catch(() => {});
}

const tpsEl = document.getElementById('sb-tps');
// 常驻显示：生成中实时更新，生成结束后保留本轮最终值；无数据时显示 "--"
if ((api as any).onTpsUpdated) {
  (api as any).onTpsUpdated((data: any) => {
    const t = data && data.tps ? String(data.tps) : '';
    if (tpsEl) tpsEl.textContent = t || '--';
  });
}
if ((api as any).onTotalUpdated) {
  (api as any).onTotalUpdated((data: any) => {
    if (data && systemEl) systemEl.textContent = formatTokenCount(data.systemTotal);
    if (data && tkSystem) tkSystem.textContent = formatTokenCount(data.systemTotal);
  });
}
if ((api as any).getSystemTotal) {
  (api as any).getSystemTotal().then((r: any) => {
    if (r && r.success && systemEl) systemEl.textContent = formatTokenCount(r.systemTotal);
    if (r && r.success && tkSystem) tkSystem.textContent = formatTokenCount(r.systemTotal);
  }).catch(() => {});
}

export async function loadAutoCompact(): Promise<void> {
  if (!api.getAutoCompact) return;
  try {
    const r = await api.getAutoCompact();
    if (r && r.success && r.data) {
      const enEl = document.getElementById('tk-auto-enabled') as any;
      const thEl = document.getElementById('tk-auto-threshold') as any;
      if (enEl) enEl.checked = r.data.enabled === true;
      if (thEl) thEl.value = r.data.threshold;
    }
  } catch (_) { /* ignore */ }
}
const tkCompactBtn = document.getElementById('tk-compact');
if (tkCompactBtn) tkCompactBtn.addEventListener('click', async () => {
  if (!api.triggerCompact) return;
  if (!(await ckConfirm('确定压缩上下文？将生成摘要并在新会话继续。', '压缩上下文'))) return;
  try { await api.triggerCompact(); } catch (_) { /* ignore */ }
});
const tkAutoSaveBtn = document.getElementById('tk-auto-save') as any;
if (tkAutoSaveBtn) tkAutoSaveBtn.addEventListener('click', async () => {
  if (!api.saveAutoCompact) return;
  const enEl = document.getElementById('tk-auto-enabled') as any;
  const thEl = document.getElementById('tk-auto-threshold') as any;
  const enabled = !!(enEl && enEl.checked);
  const threshold = parseFloat(thEl ? thEl.value : '80');
  if (!Number.isFinite(threshold) || threshold <= 0) { await ckAlert('阈值需为正数（万）'); return; }
  tkAutoSaveBtn.disabled = true;
  try {
    const r = await api.saveAutoCompact({ enabled, threshold });
    if (r && r.success) {
      tkAutoSaveBtn.textContent = '已保存';
      setTimeout(() => { tkAutoSaveBtn.textContent = '保存设置'; }, 1200);
    } else {
      await ckAlert((r && r.error) || '保存失败');
    }
  } catch (e: any) { await ckAlert('保存失败: ' + (e.message || e)); }
  tkAutoSaveBtn.disabled = false;
});
