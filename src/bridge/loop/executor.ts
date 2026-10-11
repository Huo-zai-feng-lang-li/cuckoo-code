/**
 * 工具/JS 脚本执行器（与回复获取方式无关）
 * 拦截模式和 DOM 模式共用的执行逻辑：执行 JS 脚本。
 *
 * 注：原"更新预览/结果面板/历史/徽章/任务状态"的 UI 逻辑，其目标元素随
 * overlay 面板迁移到壳页面后已不存在（空操作），故一并移除。
 */
import { truncate } from '../../overlay/panel.js';

// 是否正在执行命令或工具
let isExecuting = false;

/**
 * 执行检测到的 JS 工具脚本
 */
async function handleJsToolScript(code: string): Promise<{ code: string; result: any }> {
  isExecuting = true;
  const callId = 'js_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  console.log('[Cuckoo Code] [诊断] 即将执行的代码(JSON转义): ' + JSON.stringify(code));
  try {
    const result = await (window as any).electronAPI.executeJs(code, callId);
    return { code, result };
  } catch (err: any) {
    console.error('[Cuckoo Code] JS 工具脚本执行异常:', err);
    return { code, result: { success: false, error: '系统异常: ' + (err.message || String(err)) } };
  } finally {
    isExecuting = false;
  }
}

export {
  handleJsToolScript,
};
