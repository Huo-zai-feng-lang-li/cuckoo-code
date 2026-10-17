import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import path from 'node:path';
import { decodeOutput, normalizeCommand } from '../../infra/decode-output.js';
import { isDangerous, DANGEROUS_CMDS } from '../../infra/dangerous-commands.js';
import { start as startBackgroundTask } from '../../infra/task-manager.js';
import { runCaptured } from '../../infra/run-captured.js';

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 7,
    category: '命令执行',
    name: 'bash',
    types: [
      '/** bash 的选项 */',
      'interface BashOptions {',
      '  /** 命令用途说明（清晰、简洁、主动语态，5-10 词） */',
      '  description?: string;',
      '  /** 工作目录（相对路径基于项目根目录），默认项目根目录 */',
      '  workdir?: string;',
      '  /** 超时毫秒数，默认 30000 */',
      '  timeoutMs?: number;',
      '  /** 后台运行（长驻命令如 dev server/watch）：立即返回任务 ID，不阻塞，可在「任务」页查看/停止 */',
      '  background?: boolean;',
      '}',
    ].join('\n'),
    doc: [
      '执行 shell 命令（Windows 使用 cmd.exe）。',
      '返回纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）。',
      '必须用 log() 方法打印才能看到返回内容。',
      '非零退出不抛异常，通过 [exit code] 标记报告。',
      '危险命令会被安全策略拒绝并抛异常。',
      'background=true 时立即返回任务 ID（适合 dev server 等长驻命令），输出与停止见壳页面「任务」页。',
    ].join('\n'),
    params: 'command: string, options?: BashOptions',
    returns: 'Promise<string>',
    paramDocs: {
      command: '要执行的 shell 命令',
      options: '可选，{ description?: string, workdir?: string, timeoutMs?: number, background?: boolean }',
    },
    returnsDoc: '纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）',
    throws: '危险命令被安全策略拒绝时抛出异常',
  },
];

/**
 * JsRunner 沙箱注入：定义 globalThis.bash。
 * 源码经 scripts/build-tool-api.mjs 提取（.toString()），组装进 JsRunner 的 BOOTSTRAP。
 * 必须在沙箱内自包含（只能引用 __call）。
 */
export function bootstrap(__call: any): void {
  (globalThis as any).bash = async function (command: any, options: any) {
    options = options || {};
    return await __call('bash', {
      command: command,
      description: options.description,
      workdir: options.workdir || options.cwd,
      timeoutMs: options.timeoutMs || options.timeout,
      background: options.background === true,
    });
  };
}

/**
 * Bash 执行工具 - 最小移植 dsh 风格。
 * 非零退出正常返回，附 [exit code] 标记；输出纯文本。
 */
class BashTool extends Tool {
  constructor() {
    super(
      'bash', '执行 bash 命令。非零退出以 [exit code] 标记返回，不视为错误。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令'
          },
          description: {
            type: 'string',
            description: '命令用途说明'
          },
          workdir: {
            type: 'string',
            description: '工作目录（相对路径基于项目根目录），默认项目根目录'
          },
          timeoutMs: {
            type: 'number',
            description: '超时毫秒数，默认 30000',
            default: 30000
          },
          background: {
            type: 'boolean',
            description: '后台运行（长驻命令）：立即返回任务 ID，不阻塞，可在「任务」页查看/停止'
          }
        },
        required: ['command'],
        additionalProperties: false
      },
      'bash(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:bash',
      order: 105,
      text: '执行 bash 命令并返回 stdout/stderr。每次调用在全新 shell 中运行：状态（cwd、变量、函数）不会跨调用保留——请用 workdir 参数而非 cd。非零退出以 [exit code: N] 标记报告。长输出会截断为尾部。跑 dev server / watch 等长驻命令时，传 background:true——立即返回任务 ID，不阻塞对话，用户可在「任务」页查看输出并停止。'
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { command, description, workdir, timeoutMs, background, projectDir } = params;

    try {
      if (!command || typeof command !== 'string') {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      const trimmed = normalizeCommand(command.trim());
      if (!trimmed) {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      // 危险命令检查（统一检测：按 shell 控制符分段逐段匹配）
      if (isDangerous(trimmed)) {
        return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
      }

      // 确定工作目录
      let workDir: string;
      if (workdir) {
        const normalized = workdir.replace(/\//g, path.sep);
        workDir = path.isAbsolute(normalized)
          ? normalized
          : (projectDir ? path.join(projectDir, normalized) : path.resolve(normalized));
      } else if (projectDir) {
        workDir = projectDir;
      } else {
        workDir = process.env.USERPROFILE || process.env.HOME || 'C:\\';
      }

      // ===== 后台模式：长驻命令（dev server/watch 等），立即返回任务 ID，不阻塞 =====
      if (background === true) {
        try {
          const info = startBackgroundTask({
            command: trimmed,
            cwd: workDir,
            source: 'ai',
            label: description || undefined,
          });
          return ToolResult.success(
            '已在后台启动任务（' + info.id + '）\n' +
            '命令: ' + trimmed + '\n' +
            '工作目录: ' + workDir + '\n' +
            (info.pid ? 'PID: ' + info.pid + '\n' : '') +
            '可在壳页面「任务」页查看输出并停止。'
          );
        } catch (err: any) {
          return ToolResult.error('后台任务启动失败: ' + err.message);
        }
      }

      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000;

      console.log('[BashTool] 执行命令: ' + trimmed + ', cwd=' + workDir);

      // spawn + 超时杀整个进程树（修 A-006：不再只杀 shell 本体）
      const r = await runCaptured(trimmed, null, { cwd: workDir, timeout, shell: true });
      const out = decodeOutput(r.stdout);
      const err = decodeOutput(r.stderr);

      // dsh 风格渲染
      let body = out;
      if (err && err.length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n';
        body += '[stderr]\n' + err;
      }
      if (body.length === 0) body = '(no output)';

      const markers: string[] = [];
      if (r.timedOut) {
        markers.push('[timed out after ' + timeout + 'ms]');
      } else if (r.spawnError) {
        markers.push('[exit code: 1]');
      } else if (typeof r.code === 'number' && r.code !== 0) {
        markers.push('[exit code: ' + r.code + ']');
      }

      if (markers.length > 0) {
        if (!body.endsWith('\n')) body += '\n';
        body += markers.join('\n');
      }

      return ToolResult.success(body);
    } catch (err: any) {
      return ToolResult.error('命令执行异常: ' + err.message);
    }
  }
}

export { BashTool, DANGEROUS_CMDS };
