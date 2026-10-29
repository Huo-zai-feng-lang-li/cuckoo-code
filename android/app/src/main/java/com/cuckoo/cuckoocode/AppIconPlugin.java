package com.cuckoo.cuckoocode;

import android.content.ComponentName;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 应用图标切换（activity-alias 方案）。
 *
 * 原理：Android 不支持运行时直接改 android:icon。标准做法是为主 Activity 注册
 * 多个 activity-alias，每个 alias 携带不同的 icon/roundIcon，同一时刻只 enable 一个。
 * 切换时 disable 旧 alias + enable 新 alias，使用 DONT_KILL_APP 避免杀掉当前进程。
 *
 * 状态持久化到 SharedPreferences（不能依赖 getComponentEnabledSetting 回读，
 * 部分 ROM 读回有延迟/不可靠）。
 */
@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {

    private static final String PREFS = "cuckoo_app_icon";
    private static final String KEY = "current";
    private static final String[] ALL_IDS = { "default", "glass", "sticker", "gold" };
    private static final String DEFAULT_ID = "default";

    private ComponentName aliasOf(String id) {
        return new ComponentName(getContext().getPackageName(), getContext().getPackageName() + ".MainActivity_" + id);
    }

    private boolean isValid(String id) {
        for (String s : ALL_IDS) {
            if (s.equals(id)) return true;
        }
        return false;
    }

    private String readCurrent() {
        SharedPreferences sp = getContext().getSharedPreferences(PREFS, 0);
        String id = sp.getString(KEY, DEFAULT_ID);
        return isValid(id) ? id : DEFAULT_ID;
    }

    private void writeCurrent(String id) {
        getContext().getSharedPreferences(PREFS, 0).edit().putString(KEY, id).apply();
    }

    /**
     * 当前 alias 是否实际启用。
     * COMPONENT_ENABLED_STATE_DEFAULT 时以 manifest 为准——只有 default 声明为 enabled。
     */
    private boolean isAliasEnabled(String id) {
        PackageManager pm = getContext().getPackageManager();
        int state = pm.getComponentEnabledSetting(aliasOf(id));
        if (state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) return true;
        if (state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) return false;
        return DEFAULT_ID.equals(id);
    }

    /**
     * 清理当前 id 之外的所有 alias（对已是 DISABLED 的重复设置是幂等空操作）。
     * 用于两处：① get() 启动时对账，修复历史异常残留的双图标；
     *          ② set() 幂等分支，避免"再点同一个图标无法自愈"。
     * @return true 表示所有清理成功；false 表示有失败（可能残留双图标）
     */
    private boolean reconcileAliases(String keepId) {
        PackageManager pm = getContext().getPackageManager();
        boolean ok = true;
        for (String other : ALL_IDS) {
            if (other.equals(keepId)) continue;
            try {
                pm.setComponentEnabledSetting(
                        aliasOf(other),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP);
            } catch (Exception e) {
                ok = false;
            }
        }
        return ok;
    }

    /**
     * 返回当前生效的图标 id（以持久化状态为准）。
     * 顺带执行一次对账，修复"上次切换中途崩溃"留下的残留双图标。
     */
    @PluginMethod
    public void get(PluginCall call) {
        String current = readCurrent();
        boolean clean = reconcileAliases(current);
        JSObject ret = new JSObject();
        ret.put("current", current);
        ret.put("available", ALL_IDS);
        if (!clean) ret.put("warning", "部分旧图标组件未清理，可能出现双图标");
        call.resolve(ret);
    }

    /**
     * 切换图标。参数 { id: 'default' | 'glass' | 'sticker' | 'gold' }
     * 幂等：目标已是当前状态时直接 resolve，不触发任何组件状态变更。
     */
    @PluginMethod
    public void set(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !isValid(id)) {
            call.reject("无效的图标 id: " + id);
            return;
        }

        String prev = readCurrent();
        if (id.equals(prev) && isAliasEnabled(id)) {
            // 幂等分支：仍执行一次对账，清理可能残留的多余 alias（自愈路径）
            boolean clean = reconcileAliases(id);
            JSObject ret = new JSObject();
            ret.put("current", id);
            ret.put("changed", false);
            if (!clean) ret.put("warning", "部分旧图标组件未清理，可能出现双图标");
            call.resolve(ret);
            return;
        }

        PackageManager pm = getContext().getPackageManager();

        // 第一步：先 enable 目标。若失败，所有组件保持原状，不会出现"零 launcher"。
        try {
            pm.setComponentEnabledSetting(
                    aliasOf(id),
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
        } catch (Exception e) {
            call.reject("启用图标失败: " + e.getMessage(), e);
            return;
        }

        // 第二步：目标已生效，立即落盘。即使后续清理失败，持久化状态与实际一致。
        writeCurrent(id);

        // 第三步：兜底 disable 其余 alias，防止历史状态残留导致双图标。
        // 单条失败只降级为"可能双图标"，不影响整体成功（此时已切换完成）。
        boolean cleanFailed = !reconcileAliases(id);

        JSObject ret = new JSObject();
        ret.put("current", id);
        // 仅当目标真的变化时才标记 changed；同 id 的"状态修复"静默处理，避免误导 toast
        ret.put("changed", !id.equals(prev));
        if (cleanFailed) ret.put("warning", "部分旧图标组件未清理，可能出现双图标");
        call.resolve(ret);
    }
}
