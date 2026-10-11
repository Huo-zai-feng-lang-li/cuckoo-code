/**
 * ChatGPT 网络拦截器（注入 AI 网页主世界执行）
 *
 * 构建期经 esbuild 打包为自包含 IIFE（见 scripts/build-hooks.mjs）。
 * ChatGPT 登录态接口使用 SSE，匿名接口使用 NDJSON；两种格式都在这里解码。
 */

function install(): void {
  var MARKER = '__cuckooChatgptHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      var host = u.hostname;
      if (host.indexOf('chatgpt.com') === -1 && host.indexOf('chat.openai.com') === -1) return false;
      return /\/backend-api\/(?:f\/)?conversation\/?$/.test(u.pathname) ||
        /\/unauth-mweb\/conversation\/updates\/?$/.test(u.pathname);
    } catch (e) {
      return false;
    }
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

  // 流式增量事件（纯新增，供纯净模式实时渲染；节流 ~80ms）
  var lastStreamAt = 0;
  function dispatchStream(text, finished) {
    var now = Date.now();
    if (!finished && now - lastStreamAt < 80) return;
    lastStreamAt = now;
    try {
      window.dispatchEvent(new CustomEvent('cuckoo-ai-stream', {
        detail: { think: '', text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  // 同时解码登录态 SSE 与匿名态 NDJSON，输出 { parsed, done } 事件。
  function createResponseDecoder() {
    var buffer = '';
    var sseData = [];

    function flushSse(events) {
      if (sseData.length === 0) return;
      var data = sseData.join('\n');
      sseData = [];
      if (data === '[DONE]') {
        events.push({ parsed: null, done: true });
        return;
      }
      try { events.push({ parsed: JSON.parse(data), done: false }); } catch (e) { /* ignore */ }
    }

    function consumeLine(line, events) {
      var value = line.replace(/\r$/, '');
      var trimmed = value.trim();
      if (!trimmed) {
        flushSse(events);
        return;
      }
      if (trimmed.indexOf('data:') === 0) {
        sseData.push(trimmed.slice(5).trim());
        return;
      }
      flushSse(events);
      try { events.push({ parsed: JSON.parse(trimmed), done: false }); } catch (e) { /* ignore */ }
    }

    return {
      push: function (text) {
        buffer += text || '';
        var events = [];
        var index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          consumeLine(buffer.slice(0, index), events);
          buffer = buffer.slice(index + 1);
        }
        return events;
      },
      finish: function () {
        var events = [];
        if (buffer) {
          consumeLine(buffer, events);
          buffer = '';
        }
        flushSse(events);
        return events;
      }
    };
  }

  // ---------- 回复文本提取 ----------
  function createExtractor() {
    var text = '';
    var finished = false;

    function extractParts(content) {
      if (!content || !Array.isArray(content.parts)) return null;
      var out = '';
      for (var i = 0; i < content.parts.length; i++) {
        var p = content.parts[i];
        if (typeof p === 'string') out += p;
        else if (p && typeof p === 'object' && typeof p.text === 'string') out += p.text;
      }
      return out;
    }

    function applyOp(node) {
      if (!node || typeof node !== 'object') return;

      // 匿名接口的正文事件直接携带 markdown，replace 后 append 增量。
      if (node.type === 'content') {
        if (typeof node.markdown === 'string') {
          if (node.mode === 'append') text += node.markdown;
          else text = node.markdown;
        }
        if (node.status === 'complete') finished = true;
        return;
      }
      if (node.type === 'end') {
        finished = true;
        return;
      }

      // 1) 批量操作：o='patch' / 'BATCH'，v 为操作数组
      if (Array.isArray(node.v) && (node.o === 'patch' || node.o === 'BATCH')) {
        for (var i = 0; i < node.v.length; i++) applyOp(node.v[i]);
        return;
      }

      // 2) 消息快照：v.message（仅采纳 assistant）
      if (node.v && typeof node.v === 'object' && node.v.message) {
        var m = node.v.message;
        var role = m.author && m.author.role;
        if (role === 'assistant') {
          var snap = extractParts(m.content);
          if (snap !== null) text = snap;
        }
        return;
      }

      // 3) 路径操作
      if (typeof node.p === 'string' && node.p !== '') {
        if (node.p === '/message/status' && node.v === 'finished_successfully') { finished = true; return; }
        if (node.p === '/message/end_turn' && node.v === true) { finished = true; return; }
        if (/\/message\/content\/parts\/\d+$/.test(node.p)) {
          if (typeof node.v === 'string') {
            if (node.o === 'append' || node.o === 'add') text += node.v;
            else text = node.v;
          }
        }
        return;
      }

      // 4) 裸 v 字符串（无有效 p）：追加正文
      if (typeof node.v === 'string') { text += node.v; return; }

      // 5) 类型化结束事件
      if (node.type === 'message_stream_complete' || node.type === 'message_stream_completed') {
        finished = true;
      }
    }

    return {
      consume: function (parsed) { applyOp(parsed); },
      markDone: function () { finished = true; },
      get text() { return text; },
      get finished() { return finished; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var responseDecoder = createResponseDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function consumeEvents(events) {
      for (var i = 0; i < events.length; i++) {
        if (events[i].done) extractor.markDone();
        else if (events[i].parsed) extractor.consume(events[i].parsed);
      }
    }

    function feed(chunk) {
      consumeEvents(responseDecoder.push(chunk));
      dispatchStream(extractor.text, extractor.finished);
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
          consumeEvents(responseDecoder.finish());
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
      });
    }
    pump();
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input: any, init: any) {
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
    };
  }

  // ---------- XHR 拦截 ----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  };

  function observeXhr(xhr) {
    var lastLen = 0;
    var responseDecoder = createResponseDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function consumeEvents(events) {
      for (var i = 0; i < events.length; i++) {
        if (events[i].done) extractor.markDone();
        else if (events[i].parsed) extractor.consume(events[i].parsed);
      }
    }

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      consumeEvents(responseDecoder.push(chunk));
      dispatchStream(extractor.text, extractor.finished);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        consumeEvents(responseDecoder.finish());
        dispatched = true;
        dispatch(extractor.text, true);
      }
    });
  }
}

install();

export { install };
