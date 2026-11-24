'use strict';
/**
 * bridge preload 启动参数测试。
 *
 * 开发态必须在 additionalArguments 里带 --cuckoo-debug：
 * preload 渲染进程拿不到主进程的 process.defaultApp，只能靠显式参数判断。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { buildBridgeAdditionalArguments } from '../../src/app/bridge-args.js';

test('开发态附加 --cuckoo-debug', () => {
  assert.deepStrictEqual(
    buildBridgeAdditionalArguments({ isPackaged: false, userDataPath: 'C:/data', subagentArg: null }),
    ['--cuckoo-user-data=C:/data', '--cuckoo-debug'],
  );
});

test('打包态不附加 --cuckoo-debug', () => {
  assert.deepStrictEqual(
    buildBridgeAdditionalArguments({ isPackaged: true, userDataPath: 'C:/data', subagentArg: null }),
    ['--cuckoo-user-data=C:/data'],
  );
});

test('子代理参数保留在末尾', () => {
  assert.deepStrictEqual(
    buildBridgeAdditionalArguments({ isPackaged: false, userDataPath: 'C:/data', subagentArg: '--cuckoo-subagent=x' }),
    ['--cuckoo-user-data=C:/data', '--cuckoo-debug', '--cuckoo-subagent=x'],
  );
});
