'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import {
  toChromiumProxyRules,
  normalizeProxyConfig,
  applyNetIdentity,
  buildAcceptLanguageList,
  DEFAULT_PROXY,
} from '../../src/app/net-identity.js';

describe('buildAcceptLanguageList：Accept-Language 必须是多元素偏好列表', () => {
  test('zh-CN → 母语 + 主语言 + 英语链（真实 Chrome 习惯）', () => {
    assert.strictEqual(buildAcceptLanguageList('zh-CN'), 'zh-CN,zh,en-US,en');
  });

  test('en-US → 至少两个元素（绝不能是单元素数组）', () => {
    const v = buildAcceptLanguageList('en-US');
    assert.strictEqual(v, 'en-US,en');
    assert.ok(v.split(',').length >= 2, 'navigator.languages 不得为单元素');
  });

  test('en-GB 保留地区变体再补 en', () => {
    assert.strictEqual(buildAcceptLanguageList('en-GB'), 'en-GB,en');
  });

  test('ja-JP 补英语链', () => {
    assert.strictEqual(buildAcceptLanguageList('ja-JP'), 'ja-JP,ja,en-US,en');
  });

  test('空/非法 locale 返回空串（让浏览器用原生值，不伪造）', () => {
    assert.strictEqual(buildAcceptLanguageList(''), '');
    assert.strictEqual(buildAcceptLanguageList(null), '');
    assert.strictEqual(buildAcceptLanguageList(undefined), '');
  });

  test('纯主语言（无地区）不重复', () => {
    assert.strictEqual(buildAcceptLanguageList('en'), 'en,en-US');
    assert.strictEqual(buildAcceptLanguageList('zh'), 'zh,en-US,en');
  });
});

describe('toChromiumProxyRules 映射转换', () => {
  test('将 socks5h:// 转换为 Chromium 规范的 socks5://', () => {
    assert.strictEqual(
      toChromiumProxyRules('socks5h://127.0.0.1:1080'),
      'socks5://127.0.0.1:1080'
    );
  });

  test('忽略 socks5h:// 协议头的大小写', () => {
    assert.strictEqual(
      toChromiumProxyRules('SOCKS5H://127.0.0.1:1080'),
      'socks5://127.0.0.1:1080'
    );
    assert.strictEqual(
      toChromiumProxyRules('Socks5h://localhost:7890'),
      'socks5://localhost:7890'
    );
  });

  test('标准 socks5:// 和 http:// 规则保持原样', () => {
    assert.strictEqual(
      toChromiumProxyRules('socks5://127.0.0.1:1080'),
      'socks5://127.0.0.1:1080'
    );
    assert.strictEqual(
      toChromiumProxyRules('http://127.0.0.1:51081'),
      'http://127.0.0.1:51081'
    );
    assert.strictEqual(
      toChromiumProxyRules('127.0.0.1:51081'),
      '127.0.0.1:51081'
    );
  });

  test('分协议多规则字符串中的 socks5h 全部替换', () => {
    const raw = 'http=socks5h://127.0.0.1:1080;https=socks5h://127.0.0.1:1080;socks=socks5h=127.0.0.1:1080';
    const expected = 'http=socks5://127.0.0.1:1080;https=socks5://127.0.0.1:1080;socks=socks5=127.0.0.1:1080';
    assert.strictEqual(toChromiumProxyRules(raw), expected);
  });

  test('空值与非字符串输入安全防御', () => {
    assert.strictEqual(toChromiumProxyRules(''), '');
    assert.strictEqual(toChromiumProxyRules(null), '');
    assert.strictEqual(toChromiumProxyRules(undefined), '');
    assert.strictEqual(toChromiumProxyRules('   '), '');
  });
});

describe('normalizeProxyConfig 配置规范化', () => {
  test('启用代理但未传 webrtc 时，默认提升为 spoof 保护（防 DNS/IP 泄露）', () => {
    const cfg = normalizeProxyConfig({
      enabled: true,
      rules: 'socks5h://127.0.0.1:1080',
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.rules, 'socks5h://127.0.0.1:1080');
    assert.strictEqual(cfg.webrtc, 'spoof', '开启代理未指定 webrtc 时应默认 spoof');
  });

  test('明确指定 webrtc: off 或 disable 时尊重用户选择', () => {
    const cfgOff = normalizeProxyConfig({
      enabled: true,
      rules: 'socks5h://127.0.0.1:1080',
      webrtc: 'off',
    });
    assert.strictEqual(cfgOff.webrtc, 'off');

    const cfgDis = normalizeProxyConfig({
      enabled: true,
      rules: 'socks5h://127.0.0.1:1080',
      webrtc: 'disable',
    });
    assert.strictEqual(cfgDis.webrtc, 'disable');
  });

  test('直连模式未传值时保持默认原生行为', () => {
    const cfg = normalizeProxyConfig({
      enabled: false,
    });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.webrtc, DEFAULT_PROXY.webrtc);
  });
});

describe('applyNetIdentity WebRTC 底层防 DNS 泄露策略', () => {
  test('相同 session 配置不重复切换，代理变更后关闭旧连接池', async () => {
    let setProxyCalls = 0;
    let closeConnectionCalls = 0;
    const mockSes = {
      setProxy: async () => { setProxyCalls++; },
      closeAllConnections: async () => { closeConnectionCalls++; },
    };
    const mockWc = {
      session: mockSes,
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: async () => {},
        sendCommand: async () => ({}),
      },
      setWebRTCIPHandlingPolicy: () => {},
    };
    const view = { webContents: mockWc };
    const first = normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:51081' });
    const second = normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:51082' });

    await applyNetIdentity(view, first);
    await applyNetIdentity(view, first);
    assert.strictEqual(setProxyCalls, 1, '相同配置不应重复调用 setProxy');
    assert.strictEqual(closeConnectionCalls, 0, '首次设置不需要关闭旧连接');

    await applyNetIdentity(view, second);
    assert.strictEqual(setProxyCalls, 2, '代理地址变化后必须重新设置');
    assert.strictEqual(closeConnectionCalls, 1, '代理地址变化后必须关闭旧连接池');
  });

  test('setProxy 失败必须向调用方传播', async () => {
    const mockWc = {
      session: { setProxy: async () => { throw new Error('proxy unavailable'); } },
      isDestroyed: () => false,
      setWebRTCIPHandlingPolicy: () => {},
    };
    await assert.rejects(
      () => applyNetIdentity({ webContents: mockWc }, normalizeProxyConfig({
        enabled: true,
        rules: 'http://127.0.0.1:51081',
      })),
      /proxy unavailable/
    );
  });

  test('开启代理时调用 wc.setWebRTCIPHandlingPolicy(disable_non_proxied_udp)', async () => {
    let appliedPolicy = '';
    let proxyArg = null;

    const mockSes = {
      setProxy: async (arg) => { proxyArg = arg; },
    };

    const mockWc = {
      session: mockSes,
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: async () => {},
        detach: async () => {},
        sendCommand: async () => ({}),
      },
      setWebRTCIPHandlingPolicy: (policy) => {
        appliedPolicy = policy;
      },
    };

    const mockView = {
      webContents: mockWc,
    };

    const cfg = normalizeProxyConfig({
      enabled: true,
      rules: 'socks5h://127.0.0.1:1080',
      webrtc: 'spoof',
    });

    await applyNetIdentity(mockView, cfg);

    assert.strictEqual(appliedPolicy, 'disable_non_proxied_udp', '开启代理必须禁用非代理 UDP');
    assert.ok(proxyArg, '应调用 setProxy');
    assert.strictEqual(proxyArg.proxyRules, 'socks5://127.0.0.1:1080', '传给底层应规范化为 socks5://');
  });

  test('关闭代理（直连）且 webrtc 为 off 时恢复 default 策略', async () => {
    let appliedPolicy = '';
    const mockSes = {
      setProxy: async () => {},
    };
    const mockWc = {
      session: mockSes,
      isDestroyed: () => false,
      setWebRTCIPHandlingPolicy: (policy) => {
        appliedPolicy = policy;
      },
    };
    const mockView = {
      webContents: mockWc,
    };

    const cfg = normalizeProxyConfig({
      enabled: false,
      webrtc: 'off',
    });

    await applyNetIdentity(mockView, cfg);
    assert.strictEqual(appliedPolicy, 'default', '直连且 off 时应恢复 default 策略');
  });

  test('开启代理时自动注入主世界网络隐私盾脚本并 evaluate 到当前页面', async () => {
    const cdpCommands = [];
    const mockSes = {
      setProxy: async () => {},
    };
    const mockWc = {
      session: mockSes,
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (method, params) => {
          cdpCommands.push({ method, params });
          return { identifier: 'shield-id-123' };
        },
      },
      setWebRTCIPHandlingPolicy: () => {},
    };
    const mockView = { webContents: mockWc };
    const cfg = normalizeProxyConfig({
      enabled: true,
      rules: 'socks5h://127.0.0.1:51081',
      webrtc: 'spoof',
    });

    await applyNetIdentity(mockView, cfg);

    const addScriptCmd = cdpCommands.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
    assert.ok(addScriptCmd, '必须向新文档注入隐私盾脚本');
    const scriptSource = addScriptCmd.params.source;
    assert.ok(scriptSource.includes('x-dns-prefetch-control'), '脚本必须包含 x-dns-prefetch-control 关闭逻辑');
    assert.ok(scriptSource.includes('dns-prefetch'), '脚本必须拦截 dns-prefetch');
    assert.ok(scriptSource.includes('preconnect'), '脚本必须拦截 preconnect');
    assert.ok(scriptSource.includes('RTCPeerConnection'), '脚本必须伪装 RTCPeerConnection');
    assert.ok(scriptSource.includes('modified.iceServers = []'), '脚本必须断开 STUN iceServers');

    const evalCmd = cdpCommands.find((c) => c.method === 'Runtime.evaluate');
    assert.ok(evalCmd, '必须立即在当前文档上下文 evaluate 防御脚本，保证未刷新前亦获得保护');
    assert.ok(scriptSource.includes('origRemove'), '必须支持 removeEventListener 闭环解绑');
    assert.ok(scriptSource.includes('listenerMap'), '必须使用 listenerMap 跟踪包装函数');
  });

  test('RTCPeerConnection 包装器运行时真值测试：验证解绑有效性、事件原型链与结束透传', async () => {
    // 模拟原生浏览器环境
    class MockRTCIceCandidate {
      constructor(init) { Object.assign(this, init); }
    }
    class MockRTCPeerConnectionIceEvent {
      constructor(type, init) {
        this.type = type;
        this.candidate = init ? init.candidate : null;
      }
    }
    class MockNativePC {
      constructor() {
        this._listeners = new Map();
      }
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(fn);
      }
      removeEventListener(type, fn) {
        const list = this._listeners.get(type);
        if (list) {
          const idx = list.indexOf(fn);
          if (idx !== -1) list.splice(idx, 1);
        }
      }
      _fire(type, ev) {
        const list = this._listeners.get(type) || [];
        for (const fn of [...list]) fn(ev);
      }
    }

    const cdpCommands = [];
    const mockWc = {
      session: { setProxy: async () => {} },
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (method, params) => {
          cdpCommands.push({ method, params });
          return {};
        },
      },
      setWebRTCIPHandlingPolicy: () => {},
    };
    await applyNetIdentity({ webContents: mockWc }, normalizeProxyConfig({ enabled: true, webrtc: 'spoof' }));
    const script = cdpCommands.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').params.source;

    // 在沙箱中执行脚本注入逻辑
    const sandboxWindow = {
      RTCPeerConnection: MockNativePC,
      RTCIceCandidate: MockRTCIceCandidate,
      RTCPeerConnectionIceEvent: MockRTCPeerConnectionIceEvent,
      document: { head: { appendChild: () => {} }, querySelectorAll: () => [] },
      navigator: {},
    };
    // 脚本会 hook 全局 Function.prototype.toString；本 test 为文件末尾最后一个，
    // 在断言 7（toString 伪装验证）之后统一恢复即可（见末尾），避免提前恢复导致该断言失效。
    const origFnToString = Function.prototype.toString;
    const exec = new Function('window', 'document', 'RTCPeerConnection', 'RTCIceCandidate', script);
    exec(sandboxWindow, sandboxWindow.document, MockNativePC, MockRTCIceCandidate);

    const WrappedPC = sandboxWindow.RTCPeerConnection;
    const pc = new WrappedPC();

    // 1. 验证 addEventListener 拦截与 candidate 虚构
    let receivedEvents = [];
    const onCandidate = (e) => { receivedEvents.push(e); };
    pc.addEventListener('icecandidate', onCandidate);

    // 派发真实包含 IP 的原生候选
    const realEvent = new MockRTCPeerConnectionIceEvent('icecandidate', {
      candidate: { candidate: 'candidate:0 1 udp 2130706431 192.168.1.100 55400 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    pc._fire('icecandidate', realEvent);

    assert.strictEqual(receivedEvents.length, 1, '应收到 1 个候选事件');
    assert.ok(receivedEvents[0].candidate.candidate.includes('.local'), '候选 IP 必须被替换为虚拟 mDNS (.local)');
    assert.strictEqual(receivedEvents[0].candidate.candidate.includes('192.168.1.100'), false, '绝不能泄露真实局域网 IP');
    assert.ok(Object.getPrototypeOf(receivedEvents[0]) === realEvent, '虚构事件必须继承原生事件的原型链');

    // 派发结束事件 (candidate = null)
    const endEvent = new MockRTCPeerConnectionIceEvent('icecandidate', { candidate: null });
    pc._fire('icecandidate', endEvent);
    assert.strictEqual(receivedEvents.length, 2, '结束事件 (null candidate) 必须被放行透传');
    assert.strictEqual(receivedEvents[1].candidate, null, '结束事件候选应为 null');

    // 2. 验证 removeEventListener 真正生效（闭环解绑）
    pc.removeEventListener('icecandidate', onCandidate);
    pc._fire('icecandidate', realEvent);
    assert.strictEqual(receivedEvents.length, 2, '解绑后不再触发回调，证明 removeEventListener 已真正生效且底层解绑闭环');

    // 3. 验证 onicecandidate 属性覆盖与注销
    let onHandlerCount = 0;
    pc.onicecandidate = () => { onHandlerCount++; };
    pc._fire('icecandidate', endEvent);
    assert.strictEqual(onHandlerCount, 1, 'onicecandidate 回调应被触发');

    // 重新赋值为 null
    pc.onicecandidate = null;
    pc._fire('icecandidate', endEvent);
    assert.strictEqual(onHandlerCount, 1, '置空后旧 onicecandidate 不应再被触发，无监听器泄漏');

    // 4. 验证多个 listener 独立派发（防饿死丢失）
    let countA = 0;
    let countB = 0;
    const listenerA = () => { countA++; };
    const listenerB = () => { countB++; };
    pc.addEventListener('icecandidate', listenerA);
    pc.addEventListener('icecandidate', listenerB);

    pc._fire('icecandidate', realEvent);
    assert.strictEqual(countA, 1, 'listenerA 应收到候选');
    assert.strictEqual(countB, 1, 'listenerB 也必须独立收到候选，绝不能因全局共享标记被饥饿静音');

    // 5. 同一 listener 重复 addEventListener 必须按原生语义去重（否则旧 wrapped 孤儿化泄漏）
    let dupCount = 0;
    const dupListener = () => { dupCount++; };
    pc.addEventListener('icecandidate', dupListener);
    pc.addEventListener('icecandidate', dupListener);
    pc._fire('icecandidate', realEvent);
    assert.strictEqual(dupCount, 1, '重复 add 同一 listener 只应触发一次（原生去重语义）');

    // 6. 实例 constructor 必须指向被替换的 RTCPeerConnection（否则 new X().constructor === X 探测得 false）
    assert.strictEqual(pc.constructor, WrappedPC, 'pc.constructor 必须指向包装后的构造函数');

    // 7. toString 伪装：Function.prototype.toString.call 不可泄露伪造源码（本次关键修复）
    const fakeSrc = Function.prototype.toString.call(WrappedPC);
    assert.strictEqual(fakeSrc, 'function RTCPeerConnection() { [native code] }', '构造函数 toString 必须伪装为 native code');
    assert.strictEqual(fakeSrc.includes('iceServers'), false, '绝不可通过 toString 泄露伪造逻辑');

    // 恢复被 hook 的 Function.prototype.toString（脚本执行时已 hook 真实全局）
    Function.prototype.toString = origFnToString;
  });
});


describe('applyNetIdentity 代理切换：失败传播与连接池幂等关闭', () => {
  function makeMockSession(overrides = {}) {
    const calls = { setProxy: [], closeAllConnections: 0 };
    const ses = {
      setProxy: async (arg) => { calls.setProxy.push(arg); },
      closeAllConnections: () => { calls.closeAllConnections++; },
      ...overrides,
    };
    return { ses, calls };
  }
  function makeMockView(ses) {
    return {
      webContents: {
        session: ses,
        isDestroyed: () => false,
        debugger: {
          isAttached: () => false,
          attach: async () => {},
          detach: async () => {},
          sendCommand: async () => ({}),
        },
        setWebRTCIPHandlingPolicy: () => {},
      },
    };
  }

  test('setProxy 失败必须向上抛出（不能静默吞掉导致直连加载）', async () => {
    const ses = {
      setProxy: async () => { throw new Error('ERR_PROXY_CONNECTION_FAILED'); },
      closeAllConnections: () => {},
    };
    const view = makeMockView(ses);
    const cfg = normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:9999' });
    await assert.rejects(
      () => applyNetIdentity(view, cfg),
      /设置代理失败/,
      'setProxy 失败必须抛出，否则 entry.ts 会直连加载目标站点（真实 IP 泄露）',
    );
  });

  test('setProxy 失败时不得调用 closeAllConnections', async () => {
    let closeCount = 0;
    const ses = {
      setProxy: async () => { throw new Error('boom'); },
      closeAllConnections: () => { closeCount++; },
    };
    const view = makeMockView(ses);
    try { await applyNetIdentity(view, normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:9999' })); } catch (_) {}
    assert.strictEqual(closeCount, 0, '代理未生效却关闭所有连接，只会让页面更糟');
  });

  test('相同配置重复应用：不重复关闭连接池（避免打断在途请求）', async () => {
    const { ses, calls } = makeMockSession();
    const view = makeMockView(ses);
    const cfg = normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:8888' });
    await applyNetIdentity(view, cfg);
    assert.strictEqual(calls.closeAllConnections, 0, '首次应用无存量连接，不关闭连接池');
    await applyNetIdentity(view, cfg);
    assert.strictEqual(calls.closeAllConnections, 0, '相同配置重复应用不得关闭连接池');
  });

  test('配置变更后：重新关闭旧连接池（旧连接仍走旧出口）', async () => {
    const { ses, calls } = makeMockSession();
    const view = makeMockView(ses);
    await applyNetIdentity(view, normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:1111' }));
    assert.strictEqual(calls.closeAllConnections, 0, '首次应用不关闭');
    await applyNetIdentity(view, normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:2222' }));
    assert.strictEqual(calls.closeAllConnections, 1, '代理地址变更后必须关闭旧连接池');
  });

  test('代理 → 直连：同样关闭旧代理连接池', async () => {
    const { ses, calls } = makeMockSession();
    const view = makeMockView(ses);
    await applyNetIdentity(view, normalizeProxyConfig({ enabled: true, rules: 'http://127.0.0.1:3333' }));
    await applyNetIdentity(view, normalizeProxyConfig({ enabled: false, webrtc: 'off' }));
    assert.strictEqual(calls.setProxy[calls.setProxy.length - 1].mode, 'direct');
    assert.strictEqual(calls.closeAllConnections, 1, '从代理切到直连，旧代理连接池必须关闭');
  });
});






