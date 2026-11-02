/**
 * 纯净模式输入框上方的宠物（移植自 dsh-go 的 PetStage / PetPerch）。
 *
 * 渲染：每只宠物是一张 sprite sheet 网格，按 pack.json 的 frames 顺序逐帧切图。
 * 定位：作为 .composer-inner 的绝对定位子元素（bottom:100%），贴着输入框上边缘；
 *      输入框长高 / 键盘弹起时随布局自然上移，无需 JS 跟随（沿用 dsh-go 的层内跟随思路）。
 * 数据：window.CUCKOO_PETS 由 scripts/build-pets.mjs 从 src/ui/pets/<id>/pack.json 生成。
 *
 * 只做渲染与状态机，不感知业务：调用方用 setState / flash / react 驱动。
 */
(function () {
  'use strict';

  var PACKS = (typeof window !== 'undefined' && window.CUCKOO_PETS) || {};
  var SIZE_PX = { small: 64, medium: 96, large: 128 };
  // 上下限必须与 src/app/ui-prefs.ts 的 PET_SIZE_MIN/PET_SIZE_MAX 保持一致
  // （这里是渲染层兜底钳位，主进程落盘前也会钳一次；改一处务必同步另一处）
  var MIN_PX = 48, MAX_PX = 256;
  // 设备像素比：像素画必须按「整数个设备像素」缩放，否则 pixelated 也会发糊
  // （Windows 125%/250% 缩放下 dpr 常为 1.25 / 2.5，非整数缩放是模糊主因）。
  var DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  /**
   * 像素画缩放的核心：把「逻辑像素」对齐到整数个设备像素。
   *
   * 为什么这样就清晰：
   *  - 源图是 scale 倍预放大（本包 5），即 1 逻辑像素 = 5×5 同色源像素块；
   *  - 只要逻辑像素的边界落在整数设备像素上，最近邻采样无论落在块内何处，
   *    取到的都是同一颜色 → 不产生任何错误色彩，边缘绝对锐利；
   *  - 反之若逻辑像素占 1.48 个设备像素，块边界会落在半个像素上，
   *    有些块被渲染成 1 设备像素、有些 2 个 → 这就是"糊/脏/粗细不均"。
   *
   * @returns 每逻辑像素的 CSS 像素数（已对齐到整数设备像素）
   */
  function snapUnit(px, canvasW) {
    var cssPerLogic = (px || 96) / canvasW;              // 意图值
    var devPerLogic = Math.max(1, Math.round(cssPerLogic * DPR));  // 取整数设备像素
    return devPerLogic / DPR;
  }
  /** 像素画固定最近邻：配合上面的整数对齐才不会丢像素，也不会糊 */
  function pickRendering() {
    return 'pixelated';
  }
  /**
   * 把 CSS px 值对齐到设备像素网格（1/dpr 的整数倍）。
   * 精灵图的 background-size / background-position 若落在亚像素上，
   * pixelated 的最近邻采样会取到相邻像素 → 边缘糊掉。
   */
  function snapCSS(v) {
    return Math.round(v * DPR) / DPR;
  }
  /** 尺寸归一：三档字符串 → 固定 px；数字 → 钳到 [MIN_PX, MAX_PX] */
  function sizeToPx(size) {
    if (typeof size === 'number' && isFinite(size)) return Math.max(MIN_PX, Math.min(MAX_PX, size));
    return SIZE_PX[size] || SIZE_PX.medium;
  }
  var SLEEP_AFTER_MS = 60000;   // 空闲多久切「睡觉」

  /**
   * 情绪文案（借鉴 dsh-Go 的 activity_zh.arb）。
   * 与"功能状态"（工具执行中 7s）分开：这层只负责情绪价值，
   * 随机轮换、不占状态语义，让宠物显得"活着"。
   */
  var MOODS = {
    thinking: [
      '脑子在煮咖啡', '嗯…让我捋捋', '盘一下盘一下', '大脑转起来了', '给我一秒',
      '脑内风暴中', '让我琢磨下', '正在盘逻辑', '小脑瓜动一下', '翻翻脑子',
      '让子弹飞一会', '思路加载中', '嗯…让我拆一下', '脑内跑火车', '思考泡泡',
      '脑电波传输中', '我打个腹稿', '脑子冒泡泡', '先捋一下逻辑', '让我康康',
      '搓搓手想想', '这把我得认真', '确实有点绕', '快好了，真的', '憋大招中',
      '脑细胞在燃烧', '烧脑中…', '让我再捋一捋', '有眉目了', '转圈圈…',
    ],
    working: [
      '跑起来了', '开干', '这就去办', '搬砖中', '手上活没停',
      '一个个来', '正在执行', '别急，在跑', '工具人说它行', '咔咔干',
    ],
    waiting: [
      '模型在喝水', '等它伸懒腰', '它在组织语言', '模型在路上了', '等它出字',
      '它在酝酿', '模型在冥想', '等它眨个眼', '它说稍等', '还在排队',
      '等它开口…', '模型醒了么', '等它热身', '它打了个哈欠',
    ],
    writing: [
      '码字中', '组织语言中', '下笔如有神', '在写了在写了', '字斟句酌',
      '一气呵成', '整理成人话', '敲字中', '马上写完', '娓娓道来',
      '奋笔疾书', '笔下生风', '排个版',
    ],
    idle: [
      '歇会儿', '喝口水', '发个呆', '摸摸鱼', '伸个懒腰',
      '好安静', '在的', '随叫随到',
    ],
    done: ['搞定', '收工', '这轮结束啦', '干完了', '任务清空'],
    error: ['翻车了', '哎呀', '没跑通', '摔了一跤', '这不对', '裂开', '血压上来了', '换个姿势再来'],
  };

  /** 从分组里随机取一条（尽量不与上一条重复） */
  function pickMood(group, last) {
    var list = MOODS[group] || MOODS.idle;
    if (!list.length) return '';
    for (var i = 0; i < 5; i++) {
      var s = list[Math.floor(Math.random() * list.length)];
      if (s !== last) return s;
    }
    return list[0];
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function randRange(min, max) { return min + Math.random() * (max - min); }

  /**
   * 在 host 元素内创建一只宠物。
   * @param {string} packId 宠物包 id（见 src/ui/pets/<id>/pack.json）
   * @param {'small'|'medium'|'large'} size 显示尺寸档
   * @param {HTMLElement} host 定位宿主（需 position:relative；宠物脚部贴其顶边）
   * @param {{x?:number, onMove?:(x:number)=>void}} [opts]
   *        x：横向位置比例（0~1，相对宿主宽度），默认 0.18（避开居中的「回到底部」按钮）；
   *        onMove：拖动结束回调，参数为最终比例（供上层持久化）
   * @returns {{setState:Function, flash:Function, react:Function, bubble:Function, destroy:Function}|null}
   */
  function create(packId, size, host, opts) {
    var pack = PACKS[packId];
    if (!pack || !host || !pack.canvas) return null;
    opts = opts || {};
    var xRatio = (typeof opts.x === 'number' && isFinite(opts.x)) ? opts.x : 0.18;
    var onMove = typeof opts.onMove === 'function' ? opts.onMove : null;
    // 点击彩蛋池（动画名数组）：点一下按顺序轮播，播完一圈重新洗牌。
    // 为空时回退 pack.reactions 的 tapLeft / tapRight。
    var clickPool = Array.isArray(opts.clickAnimations) ? opts.clickAnimations.filter(function (n) {
      return !!pack.animations[n];
    }) : [];
    var clickBag = [];
    function nextClickAnim() {
      if (!clickPool.length) return null;
      if (!clickBag.length) {
        clickBag = clickPool.slice();
        for (var i = clickBag.length - 1; i > 0; i--) {   // Fisher-Yates
          var j = Math.floor(Math.random() * (i + 1));
          var t = clickBag[i]; clickBag[i] = clickBag[j]; clickBag[j] = t;
        }
      }
      return clickBag.pop();
    }

    var curPx = sizeToPx(size);                                    // 当前显示边长（px）
    var unit = snapUnit(curPx, pack.canvas[0]);                    // 每逻辑像素的 CSS 像素（已对齐设备像素）
    var k = unit / (pack.scale || 1);                              // sheet 像素 → 显示像素
    var dir = 'pets/' + packId + '/';

    var el = document.createElement('div');
    el.className = 'ck-pet';
    el.style.left = (xRatio * 100) + '%';
    /** 应用元素尺寸；snap=false 时保留浮点值（滚轮过程中用，避免逐格跳动） */
    function applyGeometry(snap) {
      var raw = pack.canvas[0] * unit;
      var w = snap === false ? raw : snapCSS(raw);
      el.style.width = w + 'px';
      el.style.height = (snap === false ? pack.canvas[1] * unit : snapCSS(pack.canvas[1] * unit)) + 'px';
      // 居中用负 margin（像素值）而非 translateX(-50%)，避免亚像素导致精灵图模糊
      el.style.marginLeft = (-w / 2) + 'px';
    }
    applyGeometry(true);
    var img = document.createElement('div');
    img.className = 'ck-pet-img';
    el.appendChild(img);
    // 气泡容器：底部对齐「鲸鱼实际可见顶部」（canvas 上半截是透明留白，
    // 直接贴 100% 会离宠物很远），内部竖向堆叠，最多两层（状态 + 瞬时提醒）。
    var bubblesEl = document.createElement('div');
    bubblesEl.className = 'ck-pet-bubbles';
    /**
     * 气泡底边距 .ck-pet 元素底边的距离。
     *
     * 关键：精灵图的绘制框（anim.box）顶部通常有大片透明留白，鲸鱼身体实际在
     * contentBox.y 附近。若直接贴 box.y，气泡会悬在透明区顶端，看着离宠物很远。
     * 故取「contentBox 顶部」与「box 顶部」中更靠下的一个，再夹在 box 范围内。
     */
    /**
     * 气泡底边距元素底边的距离，锚定「当前动画绘制框顶部」上方 8px。
     *
     * 只用 box.y，绝不掺 contentBox：contentBox 是所有动画的公共内容区，
     * 某些动画的 box.y 远大于 contentBox.y，用后者会把气泡拉到身体上压住动画。
     * 遮挡比留白严重得多 —— 宁可高一点。
     */
    /**
     * 气泡底边距「.ck-pet 元素底边」的距离。
     *
     * 推导：
     *   绘制框顶部相对元素顶部的距离  = box.y * unit
     *   元素总高                      = canvas.h * unit
     *   → 绘制框顶部距元素底边        = (canvas.h - box.y) * unit
     *   气泡底边还要再往上让 8px，避免贴脸。
     *
     * 只用 box.y（每帧真实绘制框），绝不掺 contentBox：
     * contentBox 是全局公共内容区，某些动画的 box.y 远小于它，
     * 用它会把气泡拉到身体上，直接遮住动画。
     */
    function anchorBottom(box) {
      var visibleH = Math.max(0, (pack.canvas[1] - box.y) * unit);
      // 与宠物拉开距离：点击彩蛋（conducting / building 等 box.y=0 的高个动画）
      // 头顶会顶到画布最上沿，间隙太小会压住动画本体，故留 52px。
      return visibleH + 16;
    }
    // 初始值给一个偏高位置，paint() 首次调用会按真实动画修正（宁高勿低）
    bubblesEl.style.bottom = anchorBottom({ y: 0 }) + 'px';
    var bubbleStatusEl = document.createElement('div');
    bubbleStatusEl.className = 'ck-pet-bubble ck-pet-bubble-status';
    var bubbleHintEl = document.createElement('div');
    bubbleHintEl.className = 'ck-pet-bubble ck-pet-bubble-hint';
    // 顺序配合 CSS 的 column（非 reverse）：
    //   hint（情绪，荧光）在上，status（状态，蓝框）在下并紧贴宠物。
    bubblesEl.appendChild(bubbleHintEl);
    bubblesEl.appendChild(bubbleStatusEl);
    el.appendChild(bubblesEl);
    host.appendChild(el);

    // ---- 精灵图原始尺寸（异步；加载完才能正确缩放）----
    var sheetSize = {};
    var loading = {};
    function ensureSheet(file) {
      if (sheetSize[file] || loading[file]) return;
      loading[file] = true;
      var im = new Image();
      im.onload = function () {
        loading[file] = false;
        sheetSize[file] = [im.naturalWidth, im.naturalHeight];
        if (cur && pack.animations[cur] && pack.animations[cur].sheet === file) paint();
      };
      im.onerror = function () { loading[file] = false; sheetSize[file] = [1, 1]; };
      im.src = dir + file;
    }
    for (var name in pack.animations) ensureSheet(pack.animations[name].sheet);

    // ---- 状态 ----
    var base = 'idle';       // 基础态：idle / thinking / working
    var workers = 0;         // 并行工具数（决定 working 的档位）
    var transient = null;    // 瞬时态：{ anim, until }
    var cur = null;          // 正在播的动画
    var idx = 0;             // 当前帧
    var acc = 0;             // 当前帧已播 ms
    var last = 0;
    var rafId = 0;
    var lastActive = nowMs();
    var idleAt = nowMs() + 90000;
    var sleeping = false;

    function stateAnim(state) {
      var tiers = pack.tiers[state];
      if (tiers && tiers.length) {
        for (var i = 0; i < tiers.length; i++) {
          if ((tiers[i].min | 0) <= workers) return tiers[i].anim;
        }
      }
      var list = pack.states[state] || pack.states.idle || [];
      return list[0] || 'idle';
    }

    function paint() {
      var anim = pack.animations[cur];
      if (!anim) return;
      var sz = sheetSize[anim.sheet];
      if (!sz) return;
      var n = anim.frames.length >> 1;
      if (!n) return;
      var cell = anim.frames[idx << 1] | 0;
      var col = anim.cols ? (cell % anim.cols) : 0;
      var row = anim.cols ? Math.floor(cell / anim.cols) : 0;
      var b = anim.box;
      // 逐帧的绘制矩形同样要对齐设备像素（否则每帧偏移半像素，动画看起来在抖/糊）
      img.style.left = snapCSS(b[0] * unit) + 'px';
      img.style.top = snapCSS(b[1] * unit) + 'px';
      img.style.width = snapCSS(b[2] * unit) + 'px';
      img.style.height = snapCSS(b[3] * unit) + 'px';
      img.style.backgroundImage = 'url("' + dir + anim.sheet + '")';
      img.style.imageRendering = pickRendering();
      img.style.backgroundSize = snapCSS(sz[0] * k) + 'px ' + snapCSS(sz[1] * k) + 'px';
      img.style.backgroundPosition = snapCSS(-col * anim.fw * k) + 'px ' + snapCSS(-row * anim.fh * k) + 'px';
      // 气泡锚点跟随当前动画的顶部（+6px 呼吸位）：各动画高度差很大，
      // 用固定 contentBox 会把 thinking/typing 这类"高个"动画的头顶盖住。
      bubblesEl.style.bottom = anchorBottom({ x: b[0], y: b[1], w: b[2], h: b[3] }) + 'px';
    }

    function pickAnim() {
      var target;
      if (transient) target = transient.anim;
      else if (sleeping) target = stateAnim('sleeping');
      else target = stateAnim(base);
      if (!pack.animations[target]) target = 'idle';
      if (target === cur) return;
      cur = target;
      idx = 0;
      acc = 0;
      paint();
    }

    function advance(dt) {
      var t = nowMs();
      if (transient && t >= transient.until) {
        transient = null;
        pickAnim();
      }
      if (!transient && !sleeping && base === 'idle' && t - lastActive > SLEEP_AFTER_MS) {
        sleeping = true;
        pickAnim();
      }
      if (!transient && !sleeping && base === 'idle' && t >= idleAt) {
        idleAt = t + (pack.idlePool.everyMs
          ? randRange(pack.idlePool.everyMs.min, pack.idlePool.everyMs.max) : 120000);
        var pool = pack.idlePool.anims || [];
        if (pool.length) {
          var p = pool[Math.floor(Math.random() * pool.length)];
          transient = { anim: p.anim, until: t + (p.ms || 3000) };
          pickAnim();
        }
      }
      if (!cur) return;
      var anim = pack.animations[cur];
      if (!anim) return;
      var n = anim.frames.length >> 1;
      if (!n) return;
      acc += dt;
      var dur = anim.frames[(idx << 1) + 1] | 0;
      if (acc < dur) return;
      acc -= dur;
      if (idx + 1 >= n) {
        if (anim.loop) idx = 0;
        else { idx = n - 1; return; }
      } else {
        idx++;
      }
      paint();
    }

    function tick(ts) {
      rafId = requestAnimationFrame(tick);
      if (document.hidden) { last = ts; return; }   // 页面隐藏时冻结，回来不跳帧
      var dt = last ? Math.min(ts - last, 200) : 16;
      last = ts;
      advance(dt);
    }

    /** 设置基础态（idle / thinking / working）；非 idle 时清掉残留瞬时态 */
    function setState(state, workerCount) {
      if (typeof workerCount === 'number') workers = Math.max(0, workerCount | 0);
      lastActive = nowMs();
      sleeping = false;
      if (base !== state) {
        base = state;
        if (state !== 'idle') transient = null;
      }
      pickAnim();
    }

    /** 播一次瞬时态（attention / error 等），时长取 pack 的 autoReturn / minDisplay */
    function flash(state) {
      var list = pack.states[state];
      if (!list || !list.length) return;
      var ms = pack.autoReturn[state] || pack.minDisplay[state] || 2500;
      lastActive = nowMs();
      sleeping = false;
      transient = { anim: list[0], until: nowMs() + ms };
      pickAnim();
    }

    /** 点击反应：优先 pack.reactions 的 key（tapLeft/tapRight…），也接受直接给动画名 */
    function react(kind) {
      var animName = pack.reactions[kind] || kind;
      var anim = animName && pack.animations[animName];
      if (!anim) return;
      lastActive = nowMs();
      sleeping = false;
      transient = { anim: animName, until: nowMs() + (anim.ms || 1500) };
      pickAnim();
    }

    // ---- 气泡（文字互动）----
    // 两层，语义分离、上下堆叠：
    //   下（status，贴宠物）：功能状态 + 耗时同一行，如「工具执行中 7s」
    //   上（hint）           ：情绪文案，如「模型在喝水」（纯情绪价值，随机轮换）
    // opts.html=true 时按 HTML 渲染（用于秒数 <b> 强调）。调用方必须保证内容可控。
    var hintTimer = null;
    var moodText = '';      // 当前情绪文案（瞬时提示结束后还原它）

    /**
     * 情绪气泡：常驻显示一句"人话"，随机轮换。
     * 与功能状态分开 —— 状态回答"在干嘛"，情绪回答"它像什么样子"。
     */
    function mood(text) {
      moodText = text || '';
      if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
      if (!moodText) { bubbleHintEl.classList.remove('show'); return; }
      bubbleHintEl.textContent = moodText;
      bubbleHintEl.classList.add('show');
    }

    /**
     * 状态气泡：sticky=true → 功能状态行（含耗时）；
     *           sticky=false → 瞬时提醒（这轮做完了 / 出错了），到期后还原情绪层。
     */
    function bubble(text, sticky, ms, opts) {
      var el = sticky ? bubbleStatusEl : bubbleHintEl;
      if (!text) {
        el.classList.remove('show');
        return;
      }
      if (opts && opts.html) el.innerHTML = text;
      else el.textContent = text;
      el.classList.add('show');
      if (sticky) return;
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        hintTimer = null;
        // 还原情绪层：有 mood 就回退显示，没有就收起
        if (moodText) { bubbleHintEl.textContent = moodText; }
        else { bubbleHintEl.classList.remove('show'); }
      }, ms || 2600);
    }
    /** 清空两层 */
    function clearBubble() {
      bubble('', true);
      mood('');
    }
    /** 按分组随机换一句情绪文案（内部节流，避免每次调用都变） */
    var lastMoodAt = 0;
    var lastMoodText = '';
    function randomMood(group) {
      var t = nowMs();
      if (t - lastMoodAt < 4000) return lastMoodText;   // 4s 内不换，读得完
      lastMoodAt = t;
      lastMoodText = pickMood(group, lastMoodText);
      mood(lastMoodText);
      return lastMoodText;
    }

    // ---- 点击反应 + 横向拖动 ----
    // 拖动超过 4px 视为"拖"，不触发点击反应；松手后吸附到 6%~94% 并回调记忆。
    // windowDrag：桌面宠物窗口里传 { move(dx,dy), click() }，
    // 拖动宠物本体 = 移动整个窗口（而不是改横向站位）。
    // 左键单击 = 播互动动画；右键 = 恢复主窗口（click 回调）。
    var windowDrag = opts.windowDrag || null;
    var drag = null;
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      drag = {
        id: ev.pointerId, startX: ev.clientX, startY: ev.clientY,
        lastScreenX: ev.screenX, lastScreenY: ev.screenY, moved: false,
      };
      try { el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (windowDrag && windowDrag.start) { try { windowDrag.start(); } catch { /* ignore */ } }
    });
    el.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(ev.clientX - drag.startX) < 4) return;
      drag.moved = true;
      el.classList.add('dragging');
      if (windowDrag) {
        // 传增量：桌面窗口直接按位移移动，不依赖窗口初始坐标
        var dx = ev.screenX - drag.lastScreenX;
        var dy = ev.screenY - drag.lastScreenY;
        drag.lastScreenX = ev.screenX;
        drag.lastScreenY = ev.screenY;
        if (dx || dy) { try { windowDrag.move(dx, dy); } catch { /* ignore */ } }
        return;
      }
      var box = host.getBoundingClientRect();
      if (!box.width) return;
      var ratio = (ev.clientX - box.left) / box.width;
      ratio = Math.max(0.06, Math.min(0.94, ratio));
      xRatio = ratio;
      el.style.left = (ratio * 100) + '%';
    });
    function endDrag(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      var moved = drag.moved;
      drag = null;
      el.classList.remove('dragging');
      try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (moved) {
        if (windowDrag) { try { if (windowDrag.end) windowDrag.end(); } catch { /* ignore */ } }
        else if (onMove) { try { onMove(xRatio); } catch { /* ignore */ } }
        return;
      }
      if (windowDrag) {
        // 桌面宠物：左键单击（非拖动）→ 播互动动画；回主窗口改由右键触发
        try { if (windowDrag.end) windowDrag.end(); } catch { /* ignore */ }
      }
      var pick = nextClickAnim();
      if (pick) {
        react(pick);
        return;
      }
      var r = el.getBoundingClientRect();
      react((ev.clientX || r.left) < r.left + r.width / 2 ? 'tapLeft' : 'tapRight');
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    // 右键 → 恢复主窗口（仅桌面宠物窗口启用；纯净模式不绑 windowDrag，无副作用）
    el.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (windowDrag && windowDrag.click) { try { windowDrag.click(); } catch { /* ignore */ } }
    });

    // ---- hover 滚轮缩放（可选，由 opts.onResize 开启）----
    // 只有调用方给了 onResize 才接管滚轮，避免影响纯净模式页面本身滚动。
    var onResize = typeof opts.onResize === 'function' ? opts.onResize : null;
    if (onResize) {
      var wheelTimer = null;
      el.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        // 步进与当前尺寸成正比：小尺寸时细调、大尺寸时快速跨档，手感一致
        var step = Math.max(2, Math.round(curPx * 0.06));
        var want = Math.max(MIN_PX, Math.min(MAX_PX, curPx + (ev.deltaY < 0 ? step : -step)));
        if (want === curPx) return;             // 已到上下限
        // 滚轮过程中不量化（否则尺寸会按 6px 一格跳，观感是"抖"），
        // 保证连续跟手；停手后再对齐设备像素并落盘。
        setSizeSmooth(want);
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = setTimeout(function () {
          wheelTimer = null;
          setSize(curPx);                       // 静止后重新对齐，恢复绝对锐利
          try { onResize(curPx); } catch { /* ignore */ }
        }, 180);
      }, { passive: false });
    }

    /**
     * 滚轮过程中的连续缩放：不量化到设备像素，尺寸随滚轮线性变化。
     * 量化会让尺寸按固定格子跳（96→102→108），视觉上就是"抖"。
     */
    function setSizeSmooth(px) {
      var next = sizeToPx(px);
      if (!next || next === curPx) return curPx;
      curPx = next;
      unit = next / pack.canvas[0];      // 不做 snapUnit，保持连续
      k = unit / (pack.scale || 1);
      img.style.imageRendering = pickRendering();
      applyGeometry(false);              // 保留浮点尺寸
      paint();
      return curPx;
    }

    /** 运行时改尺寸（最终值）：量化到整数设备像素，保证静态时绝对锐利 */
    function setSize(px) {
      var next = sizeToPx(px);
      if (!next) return curPx;
      curPx = next;
      unit = snapUnit(next, pack.canvas[0]);
      k = unit / (pack.scale || 1);
      img.style.imageRendering = pickRendering();
      applyGeometry(true);
      paint();
      return curPx;
    }
    function getSize() { return curPx; }

    cur = stateAnim('idle');
    paint();
    rafId = requestAnimationFrame(tick);

    return {
      setState: setState,
      flash: flash,
      react: react,
      bubble: bubble,
      mood: mood,
      randomMood: randomMood,
      clearBubble: clearBubble,
      setSize: setSize,
      setSizeSmooth: setSizeSmooth,
      getSize: getSize,
      destroy: function () {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (hintTimer) clearTimeout(hintTimer);
        if (el.parentNode) el.parentNode.removeChild(el);
      },
    };
  }

  window.CuckooPet = { create: create, packs: PACKS };
})();
