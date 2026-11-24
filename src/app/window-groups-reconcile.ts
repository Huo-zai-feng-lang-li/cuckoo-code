/**
 * 窗口组孤儿引用清理（纯函数，不依赖 Electron，便于单测）。
 *
 * 背景：profile 被删除/导入失败后，window-groups.json 里的 windowIds
 * 可能仍指向已经不存在的 profile；窗口组管理页会把它当成一个可选窗口。
 * 启动时与删除窗口时统一调用 reconcile，保证组配置与 profile 列表一致。
 */

export interface WindowGroupReconcileResult {
  data: any;
  changed: boolean;
}

/**
 * 从窗口组数据里剔除不存在的 profile。
 * @param data window-groups.json 原始对象
 * @param validIds 当前仍存在的 profileId 列表
 */
export function reconcileWindowGroups(data: any, validIds: string[]): WindowGroupReconcileResult {
  if (!data || typeof data !== 'object') return { data, changed: false };

  const valid = new Set((Array.isArray(validIds) ? validIds : []).map(String));
  // 空列表通常是 profile 配置损坏/尚未加载，不是"所有窗口都删除"。
  // 直接按空集合清理会把用户的分组配置不可逆清空，必须短路。
  if (valid.size === 0) return { data, changed: false };
  let changed = false;

  const groups = Array.isArray(data.groups) ? data.groups : [];
  const nextGroups: any[] = [];

  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      changed = true;
      continue;
    }
    const ids = Array.isArray(group.windowIds) ? group.windowIds.map(String) : [];
    const kept = ids.filter((id: string) => valid.has(id));
    if (kept.length !== ids.length) changed = true;

    if (group.lastWindowId && !valid.has(String(group.lastWindowId))) {
      group.lastWindowId = null;
      group.lastSessionId = null;
      changed = true;
    }
    if (kept.length === 0) {
      changed = true;
      continue;
    }
    group.windowIds = kept;
    nextGroups.push(group);
  }

  if (nextGroups.length !== groups.length) changed = true;
  data.groups = nextGroups;

  if (data.rateLimits && typeof data.rateLimits === 'object') {
    for (const key of Object.keys(data.rateLimits)) {
      if (!valid.has(key)) {
        delete data.rateLimits[key];
        changed = true;
      }
    }
  }

  return { data, changed };
}
