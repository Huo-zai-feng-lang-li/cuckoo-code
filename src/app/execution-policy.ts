/**
 * 执行策略（X-001 第三层：自动执行策略开关）
 *
 * 策略文件：~/.cuckoo/execution-policy.json（CUCKOO_HOME 覆盖），原子写。
 *   - smart（默认）：只读自动；项目内写入自动；bash/pwsh 仅命中投递特征时弹；
 *   - workspace：按工作区信任——未信任的项目首次执行命令/项目外写入时弹；
 *   - strict：所有命令与写入每次询问。
 *
 * 判定纯函数 decideToolGate 不依赖 electron，便于单测；
 * host 硬校验（第一层）与弹窗（dialog）在 ipc-guard 里编排。
 */
import path from 'node:path';
import { cuckooHomeDir, writeJsonAtomicSync, readJsonRobustSync } from '../infra/atomic-json.js';

export type ExecutionMode = 'smart' | 'workspace' | 'strict';

const VALID_MODES: ReadonlySet<string> = new Set(['smart', 'workspace', 'strict']);

function policyFile(): string {
  return path.join(cuckooHomeDir(), 'execution-policy.json');
}

/** 读取当前执行模式；文件缺失/非法值回退 smart */
export function getExecutionMode(): ExecutionMode {
  const data = readJsonRobustSync<{ mode?: string }>(policyFile(), { mode: 'smart' });
  const m = data && typeof data.mode === 'string' ? data.mode : '';
  return VALID_MODES.has(m) ? (m as ExecutionMode) : 'smart';
}

/**
 * 设置执行模式并持久化。
 * @param m 目标模式；非法值回退 smart
 * @returns 生效的模式
 */
export function setExecutionMode(m: string): ExecutionMode {
  const mode: ExecutionMode = VALID_MODES.has(m) ? (m as ExecutionMode) : 'smart';
  writeJsonAtomicSync(policyFile(), { mode });
  return mode;
}

// ===== 工具分类（据实补全；与 src/tools/impl 注册名一致）=====

/** 只读工具：任意模式自动放行 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'readLines', 'glob', 'grep',
  'todoWrite', 'nameConversation', 'goalDone',
  'listSnapshots', 'mcpListServers', 'mcpGetTools',
  'attachFile', 'webFetch', // 网络读/上传已受 SSRF 守卫，按只读处理
  'mysql', // SQL 读写无法在入口静态区分，按契约归只读（DB 侧凭据由用户自配）
]);

/** 写入工具 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit', 'deleteFile', 'restoreSnapshot', 'remember', 'forgetMemory',
]);

/** 命令工具（bash/pwsh） */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh']);

/** 全局记忆类写入（不碰项目文件）：smart 下自动放行 */
const GLOBAL_WRITE_TOOLS: ReadonlySet<string> = new Set(['remember', 'forgetMemory']);

export interface GateInput {
  /** 工具名（toolRegistry 注册名） */
  toolName: string;
  /** 工具入参（用于定位写入目标路径） */
  params: any;
  /** 当前项目目录（绝对路径，可空） */
  projectDir: string | null;
  /** findDeliverySignature 命中的中文描述；未命中 null */
  deliveryMatched: string | null;
  /** 当前项目是否已在工作区信任门里被信任 */
  isWorkspaceTrusted: boolean;
  /** 测试/调用方直接指定模式；缺省读持久化策略 */
  mode?: ExecutionMode;
}

export type GateDecision = 'allow' | 'confirm' | 'deny';

export interface GateResult {
  decision: GateDecision;
  reason: string;
  detail?: string;
}

/** 从工具入参里提取写入目标路径（常见键名） */
function resolveTargetPath(params: any): string | null {
  if (!params || typeof params !== 'object') return null;
  for (const key of ['file_path', 'path', 'target_file', 'relPath', 'filePath']) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** 判断路径 p 是否落在 dir 内（均需先 resolve） */
function isPathWithin(dir: string, p: string): boolean {
  try {
    const d = path.resolve(dir);
    const t = path.resolve(d, p); // p 为绝对路径时 resolve 以其为准
    return t === d || t.startsWith(d + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * 工具执行决策纯函数（X-001 第三层）。
 *
 * 规则：
 *  - 只读 → 任意模式 allow；
 *  - bash/pwsh：deliveryMatched 非空 → 任何模式 confirm（detail 含命中特征）；
 *    否则 smart allow / workspace 受信任 allow 否则 confirm / strict confirm；
 *  - 写入：smart 项目内 allow、越界或无法确认 confirm；workspace 受信任 allow 否则 confirm；
 *    strict confirm；
 *  - 未归类工具：smart allow、workspace 受信任 allow 否则 confirm、strict confirm。
 */
export function decideToolGate(i: GateInput): GateResult {
  const mode: ExecutionMode = i.mode || getExecutionMode();
  const name = i.toolName || '';

  if (READ_ONLY_TOOLS.has(name)) {
    return { decision: 'allow', reason: '只读工具，自动放行' };
  }

  if (COMMAND_TOOLS.has(name)) {
    if (i.deliveryMatched) {
      return {
        decision: 'confirm',
        reason: '命中高危投递/反弹/持久化特征，任何模式都需用户确认',
        detail: i.deliveryMatched,
      };
    }
    if (mode === 'smart') return { decision: 'allow', reason: 'smart：命令自动执行（未命中投递特征）' };
    if (mode === 'strict') return { decision: 'confirm', reason: 'strict：每次命令都需确认' };
    // workspace
    return i.isWorkspaceTrusted
      ? { decision: 'allow', reason: 'workspace：工作区已信任' }
      : { decision: 'confirm', reason: 'workspace：未信任工作区执行命令需确认' };
  }

  if (WRITE_TOOLS.has(name)) {
    if (mode === 'strict') return { decision: 'confirm', reason: 'strict：每次写入都需确认' };
    if (mode === 'workspace') {
      return i.isWorkspaceTrusted
        ? { decision: 'allow', reason: 'workspace：工作区已信任' }
        : { decision: 'confirm', reason: 'workspace：未信任工作区写入需确认' };
    }
    // smart
    if (GLOBAL_WRITE_TOOLS.has(name)) return { decision: 'allow', reason: 'smart：全局记忆写入自动放行' };
    const target = resolveTargetPath(i.params);
    if (i.projectDir && target && isPathWithin(i.projectDir, target)) {
      return { decision: 'allow', reason: 'smart：项目内写入自动放行' };
    }
    return {
      decision: 'confirm',
      reason: 'smart：项目外写入（或无法确认在项目内）需确认',
      detail: target || undefined,
    };
  }

  // 未归类工具（mcpCall、runAgent、injectJS 等）
  if (mode === 'smart') return { decision: 'allow', reason: 'smart：非命令/非项目写入工具自动放行' };
  if (mode === 'strict') return { decision: 'confirm', reason: 'strict：执行工具需确认' };
  return i.isWorkspaceTrusted
    ? { decision: 'allow', reason: 'workspace：工作区已信任' }
    : { decision: 'confirm', reason: 'workspace：未信任工作区调用工具需确认' };
}
