(async function(){
  var stream = document.getElementById('stream');
  var t = window.__ckHarnessTest;
  
  // 造足够长的内容
  for (var i = 0; i < 10; i++) {
    var d = document.createElement('div');
    d.className = 'msg assistant';
    d.textContent = 'LOCK-TEST-' + i + ' ' + 'X'.repeat(200);
    stream.appendChild(d);
  }
  
  stream.scrollTop = 0;
  await new Promise(r => setTimeout(r, 100));
  var before = Math.round(stream.scrollTop);
  
  // 连续调 scrollBottom 10 次（模拟流式每帧）
  for (var j = 0; j < 10; j++) {
    // 通过 scroll-btn 点击间接触发（scrollBtn 会调 settleScrollBottom，不是 scrollBottom）
    // 直接调不到 scrollBottom（内部私有），改用 stream 内容增长 + focus 模拟
  }
  
  // 更可靠的验证：模拟内容增长后检查 pinBottom 是否仍 true（scrollBottom 死锁时会保持旧值）
  stream.scrollTop = stream.scrollHeight;
  stream.dispatchEvent(new Event('scroll'));
  await new Promise(r => setTimeout(r, 100));
  var afterScroll = { pin: t.scrollState().pinBottom, top: Math.round(stream.scrollTop), dist: Math.round(stream.scrollHeight - stream.scrollTop - stream.clientHeight) };
  
  // 内容再增长 + 触发 resize（模拟窗口撑大）
  window.dispatchEvent(new Event('resize'));
  await new Promise(r => setTimeout(r, 300));
  var afterResize = { pin: t.scrollState().pinBottom, suppress: t.scrollState().suppressPin, dist: Math.round(stream.scrollHeight - stream.scrollTop - stream.clientHeight) };
  
  // 清理
  var children = Array.prototype.slice.call(stream.children);
  for (var k = 0; k < children.length; k++) {
    if ((children[k].textContent || '').indexOf('LOCK-TEST-') !== -1) { if (children[k].parentNode) children[k].parentNode.removeChild(children[k]); }
  }
  
  return {
    visibility: document.visibilityState,
    before: before,
    afterScroll: afterScroll,
    afterResize: afterResize,
    suppressNotStuck: afterResize.suppress === false,
    note: 'hidden 下 resize 后 suppressPin 必须为 false（不死锁）'
  };
})()