import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';

// ========== D12：API 契约元数据 ==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 16,
    category: '会话',
    name: 'nameConversation',
    doc: '给当前对话起一个简短标题（用于工作区列表识别）。对话主题明确时调用；若对话主题发生实质切换，需再次调用覆盖旧标题。',
    params: 'title: string',
    returns: 'Promise<{ message: string }>',
    paramDocs: {
      title: '对话标题（简短，建议不超过 20 字）',
    },
    returnsDoc: '{ message: string }',
    throws: '缺少窗口上下文、当前无会话或标题为空时抛出异常',
  },
];

/** 设置当前会话标题的实现（由 app 层注入，避免 tools → app 反向依赖） */
export type SessionTitleSetter = (args: { windowId: number; title: string }) => Promise<{ success: boolean; error?: string }>;

let _setter: SessionTitleSetter | null = null;

/** 由 app 层注入 */
export function injectSessionTitleSetter(fn: SessionTitleSetter): void {
  _setter = fn;
}

class NameConversationTool extends Tool {
  constructor() {
    super(
      'nameConversation',
      '给当前对话起一个简短标题，便于在工作区列表识别。',
      {
        type: 'object',
        properties: {
          title: { type: 'string', description: '对话标题（简短，建议不超过 20 字）' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      'nameConversation(title)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:nameConversation',
      order: 114,
      text: '**对话命名**：标题用中文、≤20 字，概括"这件事在做什么"；不要照抄首条消息原文（常是规则注入/系统指令/背景粘贴，不代表真实主题）。',
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { title, currentWindowId } = params;
    if (typeof currentWindowId !== 'number') return ToolResult.error('缺少窗口上下文');
    const t = String(title || '').trim();
    if (!t) return ToolResult.error('标题为空');
    if (!_setter) return ToolResult.error('会话标题设置器未初始化');
    try {
      const r = await _setter({ windowId: currentWindowId, title: t });
      if (!r || !r.success) return ToolResult.error((r && r.error) || '设置失败');
      return ToolResult.success({ message: '对话已命名为：' + t });
    } catch (err: any) {
      return ToolResult.error('设置对话标题失败: ' + err.message);
    }
  }
}

/** JsRunner 沙箱注入 */
export function bootstrap(__call: any): void {
  (globalThis as any).nameConversation = async function (title: any) {
    return await __call('nameConversation', { title: title });
  };
}

export { NameConversationTool };
