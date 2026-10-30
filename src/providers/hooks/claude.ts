/**
 * Claude 网络拦截器（注入 AI 网页主世界执行）
 *
 * 构建期经 esbuild 打包为自包含 IIFE（见 scripts/build-hooks.mjs）。
 * 共享 SSE 解码见 ./shared/sse.js。
 */
import { createFrameDecoder, parseBlock } from './shared/sse.js';
import { decideClaudeStreamExit } from './shared/claude-status.js';
import { createIdleWatchdog } from './shared/idle-watchdog.js';
import { maskAsNative } from './shared/native-mask.js';

function install(): void {
  // 幂等标记放闭包内，避免在 window 上留可枚举的 cuckoo 标签（同 deepseek）
  var __installed = false;
  if (__installed) return;
  __installed = true;

  // claude.ai 的 completion 端点形如：
  // /api/organizations/{org}/chat_conversations/{conv}/completion
  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      if (u.hostname.indexOf('claude.ai') === -1) return false;
      return /\/chat_conversations\/[^/]+\/(completion|retry_completion)$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  // 读流静默看门狗超时（毫秒，<=0 禁用）；默认 300000（与 DeepSeek 一致）
  function readIdleTimeout() {
    try {
      var v = parseInt(localStorage.getItem('cuckoo-xhr-idle-timeout') || '', 10);
      if (isFinite(v)) return v;
    } catch (e) { /* ignore */ }
    return 300000;
  }

  // 从当前 URL 提取会话 id（claude.ai/chat/{uuid}），供看门狗会话复核
  function getSessionIdFromUrl() {
    try {
      var m = String(location.href).match(/\/chat\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function dispatch(text, finished) {
    try {
      // 空回复（正文为空）→ 按失败处理，触发自动重试（普通失败间隔）
      if (finished && !(text && text.trim())) {
        window.dispatchEvent(new CustomEvent('cuckoo-ai-error', {
          detail: { text: '', status: 'error', reason: 'empty' }
        }));
        return;
      }
      window.dispatchEvent(new CustomEvent('cuckoo-ai-response', {
        detail: { text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  // B-002：派发"流失败"事件（触发自动重试），而非把截断正文当 finished 成功。
  function dispatchError(text, reason) {
    try {
      window.dispatchEvent(new CustomEvent('cuckoo-ai-error', {
        detail: { text: text || '', status: 'error', reason: reason }
      }));
    } catch (e) { /* ignore */ }
  }

  // 流式增量事件（供纯净模式实时渲染；节流 ~40ms）
  var lastStreamAt = 0;
  function dispatchStream(think, text, finished) {
    var now = Date.now();
    if (!finished && now - lastStreamAt < 40) return;
    lastStreamAt = now;
    try {
      window.dispatchEvent(new CustomEvent('cuckoo-ai-stream', {
        detail: { think: think || '', text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------- 回复文本提取（Anthropic 流式事件格式）----------
  // 关注：
  //   content_block_delta + delta.type==='text_delta' → delta.text
  //   message_stop                                    → finished
  // 忽略 thinking_delta（思考内容）
  function createExtractor() {
    var text = '';
    var thinkText = '';
    var finished = false;

    function consume(parsed) {
      if (!parsed || typeof parsed !== 'object') return;
      var type = parsed.type;
      if (type === 'content_block_delta' && parsed.delta) {
        var d = parsed.delta;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text;
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          thinkText += d.thinking;
        }
        // signature_delta 忽略
        return;
      }
      if (type === 'message_stop') { finished = true; return; }
      if (type === 'error') { finished = true; return; }
    }

    return {
      consume: consume,
      get text() { return text; },
      get think() { return thinkText; },
      get finished() { return finished; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      dispatchStream(extractor.think, extractor.text, extractor.finished);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) feed(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) {
            var parsed = parseBlock(rest[i]);
            if (parsed) extractor.consume(parsed);
          }
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function (e) {
        if (dispatched) return;
        dispatched = true;
        // B-002：网络异常/连接被掐不应把截断正文当 finished 成功；区分用户中止与真错误
        var exit = decideClaudeStreamExit({
          sawMessageStop: extractor.finished,
          text: extractor.text,
          networkError: true,
          aborted: !!(e && e.name === 'AbortError'),
        });
        if (exit === 'error') {
          console.log('[Cuckoo Code][hook] fetch stream error name=' + (e && e.name));
          dispatchError(extractor.text, 'stream');
        } else {
          dispatch(extractor.text, true);
        }
      });
    }
    pump();
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = maskAsNative(function (input: any, init: any) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var p = origFetch.apply(this, arguments);
      if (!isCompletion(url, method)) return p;
      return p.then(function (response) {
        try {
          if (response && response.body) observeBody(response.clone().body);
        } catch (e) { /* ignore */ }
        return response;
      });
    }, 'fetch', 1);
  }

  // ---------- XHR 拦截（被动读取 responseText）----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = maskAsNative(function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  }, 'open', 2);
  XMLHttpRequest.prototype.send = maskAsNative(function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  }, 'send', 0);

  function observeXhr(xhr) {
    var lastLen = 0;
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;
    // B-005：XHR 路径补流静默看门狗（此前仅 fetch 路径有）
    var reqSessionId = getSessionIdFromUrl();
    var wd = createIdleWatchdog({
      timeoutMs: readIdleTimeout(),
      onIdle: function () {
        try {
          window.dispatchEvent(new CustomEvent('cuckoo-stream-idle', { detail: { sessionId: reqSessionId } }));
        } catch (e) { /* ignore */ }
      }
    });

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      dispatchStream(extractor.think, extractor.text, extractor.finished);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        wd.stop();
        dispatch(extractor.text, true);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      wd.touch(); // B-005：任何状态变化都视为活跃
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        wd.stop();
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseBlock(rest[i]);
          if (parsed) extractor.consume(parsed);
        }
        dispatched = true;
        // B-002：XHR 终态按 HTTP 状态 + 是否收到 message_stop 判定；
        // 历史不看 status 直接 dispatch(text,true)，把失败/截断响应当成功。
        var st = decideClaudeStreamExit({
          sawMessageStop: extractor.finished,
          text: extractor.text,
          httpStatus: (typeof xhr.status === 'number') ? xhr.status : null,
        });
        if (st === 'error') dispatchError(extractor.text, 'xhr');
        else dispatch(extractor.text, true);
      }
    });
  }
}

install();

export { install };
