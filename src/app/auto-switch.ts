export type SwitchReason = 'rate-limit' | 'context-limit';
interface SwitchInput { groupId: string; profileId: string; currentName: string; reason: SwitchReason; }
interface SwitchResult { success: boolean; switched?: boolean; reason?: string; error?: string; result?: unknown; }
interface SwitchDependencies {
  locks: Set<string>;
  showAlert(data: { currentName: string; seconds: number; reason: SwitchReason }): Promise<string>;
  switchGroup(groupId: string, profileId: string, closeSource: boolean, reason: SwitchReason): Promise<{ success: boolean }>;
}

/** 限流与上下文触发共享去重锁及取消/异常收尾，切换成功后关闭源窗口。 */
export async function runAutomaticSwitch(input: SwitchInput, deps: SwitchDependencies): Promise<SwitchResult> {
  if (deps.locks.has(input.profileId)) return { success: true, switched: false, reason: 'in-progress' };
  deps.locks.add(input.profileId);
  try {
    const decision = await deps.showAlert({ currentName: input.currentName, seconds: 10, reason: input.reason });
    if (decision === 'cancel') return { success: true, switched: false, reason: 'cancelled' };
    if (decision === 'superseded') return { success: true, switched: false, reason: 'superseded' };
    const result = await deps.switchGroup(input.groupId, input.profileId, true, input.reason);
    return { success: result.success, switched: result.success, result };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally { deps.locks.delete(input.profileId); }
}
