/**
 * Cuckoo Remote 手机端宠物适配层。
 *
 * 职责：把 PWA 的对话事件翻译成桌面端宠物引擎（/pets/pet.js）能懂的状态。
 * 渲染引擎、状态机、气泡、点击彩蛋、横向拖动全部复用 src/ui/pets/pet.js，本文件不重复实现。
 *
 * 设计约束（防腐）：
 *  - 宠物纯装饰：任何异常一律吞掉，绝不影响对话主链路。
 *  - 只做「动画 + 情绪文案」：功能状态（生成中 / 工具运行中 Ns）已由 exec-status 胶囊承担，
 *    这里再冒一遍就是同屏重复、窄屏噪音。
 *  - 手势：不改写 pet.js 的指针逻辑，只用 CSS 把 touch-action 从 none 改成 pan-y
 *    （见 mobile-pet.css）。竖向滑动由浏览器接管滚动并给 pet.js 发 pointercancel，
 *    横向拖动才落到宠物身上 —— 零手势劫持代码，也就零冲突。
 *  - 位置持久化到 localStorage，与桌面端 petX 语义一致（0.08 ~ 0.92）。
 */
(function () {
  'use strict';

  var PACK_ID = 'deepy-whale';
  var SIZE_PX = 64;                 // 手机端固定尺寸：窄屏下不抢输入框
  var X_KEY = 'cuckoo-pet-x';
  // 必须与 pet.js 内部拖动钳位一致（Math.max(0.06, Math.min(0.94, ...))）：
  // 否则拖到边缘存下的 0.94 会被这里判为越界 → 刷新后退回默认位，用户观感是"位置没记住"。
  var X_MIN = 0.06, X_MAX = 0.94, X_DEFAULT = 0.14;

  /** 情绪分组：与桌面端 MOODS 的 key 对齐 */
  var MOOD_BY_STATE = {
    thinking: 'thinking',
    working: 'working',
    waiting: 'waiting',
    idle: 'idle',
    done: 'done',
    error: 'error',
  };

  var pet = null;        // 宠物实例（null = 未创建/已销毁）
  var hostEl = null;     // 宿主（.composer-inner）
  var lastState = 'idle';
  var destroyed = false;
  var creating = false;

  function readX() {
    try {
      var v = parseFloat(localStorage.getItem(X_KEY));
      if (isFinite(v) && v >= X_MIN && v <= X_MAX) return v;
    } catch { /* localStorage 不可用（隐私模式）时用默认值 */ }
    return X_DEFAULT;
  }
  /**
   * 按「宠物自身宽度」把横向比例钳进安全区。
   *
   * pet.js 的钳位是固定比例（0.06~0.94），它不知道宠物有多宽 —— 桌面窗口宽，半个身位
   * 探出宿主无所谓；手机屏窄（宿主约 280px、宠物 64px），6% 意味着中心离左边缘仅 17px，
   * 半个身子直接出屏（实测 petL = 0.3px）。这里按宿主实际宽度重算下/上界。
   *
   * 宿主宽度未知时（登录页）退回固定比例，不做限制。
   */
  function clampXForHost(x) {
    if (!hostEl) hostEl = document.querySelector('.composer-inner');
    var w = hostEl ? hostEl.clientWidth : 0;
    if (!w) return Math.max(X_MIN, Math.min(X_MAX, x));
    var halfPct = (SIZE_PX / 2) / w;          // 半个身位占宿主宽度的比例
    var lo = Math.max(X_MIN, halfPct);
    var hi = Math.min(X_MAX, 1 - halfPct);
    if (lo > hi) return X_DEFAULT;            // 宿主窄到放不下（极端情况）
    return Math.max(lo, Math.min(hi, x));
  }

  function writeX(x) {
    // 落盘前再钳一次：防止上游传入越界值把下一次读取卡在范围检查外
    var v = Math.max(X_MIN, Math.min(X_MAX, Number(x)));
    if (!isFinite(v)) return;
    try { localStorage.setItem(X_KEY, String(v)); } catch { /* ignore */ }
  }

  /** 创建宠物；失败静默返回 null（调用方不需要处理） */
  function create() {
    if (destroyed || pet || creating) return pet;
    try {
      var engine = window.CuckooPet;
      // 引擎未加载（pets.generated.js / pet.js 404）→ 静默降级，不重试
      if (!engine || !engine.create || !engine.packs || !engine.packs[PACK_ID]) return null;
      // 登录页阶段 .composer-inner 还不存在，下次 apply 再试
      hostEl = document.querySelector('.composer-inner');
      if (!hostEl) return null;

      creating = true;
      pet = engine.create(PACK_ID, SIZE_PX, hostEl, {
        x: clampXForHost(readX()),
        // 气泡离宠物头顶的间距：桌面端默认 16px 是按大尺寸宠物调的，
        // 手机端宠物只有 64px，同样的 16px 显得悬空，收到 8px 贴回来。
        bubbleGap: 8,
        // 拖动全程按宠物实际宽度钳位（pet.js 的 clampX 钩子，默认不传时行为不变）。
        // 这样 DOM 位置与 pet.js 内部 xRatio 永远一致，不会出现"松手跳回/下次拖动跳变"。
        clampX: clampXForHost,
        onMove: writeX,
        // 手机上不做滚轮缩放，故不传 onResize
        clickAnimations: [
          'idle-spout', 'react-double', 'roam-hop', 'music',
          'conducting', 'carrying', 'waking', 'idle-look',
        ],
      });
      creating = false;
      if (!pet) return null;
      pet.setState('idle');
      return pet;
    } catch {
      creating = false;
      pet = null;   // 纯装饰：失败后保持静默，不影响对话
      return null;
    }
  }

  /**
   * 应用一个对话事件。
   * @param {string} kind 'thinking' | 'working' | 'waiting' | 'idle' | 'done' | 'error'
   * @param {number} [workers] 并行工具数（决定 working 的动画档位）
   */
  function apply(kind, workers) {
    try {
      if (destroyed) return;
      lastState = kind;
      if (!pet) create();
      if (!pet) return;

      if (kind === 'done') {
        pet.setState('idle');
        pet.flash('attention');
      } else if (kind === 'error') {
        pet.setState('idle');
        pet.flash('error');
      } else if (kind === 'waiting') {
        // 等模型出字：视觉上仍属空闲，不切忙碌动画
        pet.setState('idle');
      } else {
        pet.setState(kind, typeof workers === 'number' ? workers : 0);
      }
      // 情绪文案：与功能状态分离，纯情绪价值（内部 4s 节流）
      var group = MOOD_BY_STATE[kind];
      if (group && typeof pet.randomMood === 'function') pet.randomMood(group);
    } catch { /* 静默 */ }
  }

  function destroy() {
    destroyed = true;
    try { if (pet && pet.destroy) pet.destroy(); } catch { /* ignore */ }
    pet = null;
    hostEl = null;
  }

  /** 首次创建延迟到空闲时：不跟首屏渲染抢带宽（精灵图约 400KB） */
  function scheduleCreate() {
    var run = function () { create(); };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2500 });
    } else {
      setTimeout(run, 1200);
    }
  }

  window.CuckooMobilePet = {
    apply: apply,
    destroy: destroy,
    getState: function () { return lastState; },
    _create: create,   // 供真机验证手动触发
  };

  // 登录态已有缓存时 .composer-inner 在首屏就存在；否则等首个事件触发补建
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleCreate, { once: true });
  } else {
    scheduleCreate();
  }
})();
