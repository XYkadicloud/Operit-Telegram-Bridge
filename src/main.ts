/**
 * Telegram Bridge - ToolPkg 入口
 *
 * 注册：
 *  - 工具箱设置界面
 *  - 应用生命周期钩子（启动 / 回前台时自动拉起监听）
 *  - 工具调用生命周期钩子（把工具调用推送到 Telegram 进度消息）
 *
 * 注意：所有 hook 处理函数都必须从模块 export，
 * 否则注册时会报 "function must be exported from a toolpkg module"。
 */

import telegramSettingsScreen from "./ui/telegram_settings/index.ui.js";
import { onToolLifecycleEvent } from "./shared/tg_bridge";
import {
    onTelegramBridgeApplicationCreate,
    onTelegramBridgeApplicationForeground,
    onTelegramBridgeApplicationTerminate
} from "./shared/tg_lifecycle";
// 引入 IPC 模块以注册 main 上下文 runner（UI 通过它调用工具）
import "./shared/tg_ipc";

function log(message: string): void {
    console.log(`[telegram_bridge] ${message}`);
}

export function registerToolPkg(): boolean {
    log("registerToolPkg start");

    // 每一项注册都独立 try-catch：
    // 任何一项失败都不能中断整体注册，否则钩子会处于半注册的坏状态。
    try {
        ToolPkg.registerToolboxUiModule({
            id: "telegram_settings",
            runtime: "compose_dsl",
            screen: telegramSettingsScreen,
            params: {},
            title: {
                zh: "Telegram 桥接设置",
                en: "Telegram Bridge Settings"
            }
        });
    } catch (error) {
        log(`registerToolboxUiModule failed: ${String(error)}`);
    }

    const appHooks: Array<{ id: string; event: any; fn: any }> = [
        { id: "telegram_bridge_app_create", event: "application_on_create", fn: onTelegramBridgeApplicationCreate },
        { id: "telegram_bridge_app_foreground", event: "application_on_foreground", fn: onTelegramBridgeApplicationForeground },
        { id: "telegram_bridge_app_terminate", event: "application_on_terminate", fn: onTelegramBridgeApplicationTerminate }
    ];
    appHooks.forEach((item) => {
        try {
            ToolPkg.registerAppLifecycleHook({
                id: item.id,
                event: item.event,
                function: item.fn
            });
        } catch (error) {
            log(`registerAppLifecycleHook(${item.id}) failed: ${String(error)}`);
        }
    });

    // 工具生命周期钩子：默认不注册。
    // 它已三次因 IllegalStateException 拦死全部工具调用（含自救调用），
    // 每次都需要用户手动到设置里关包才能解锁，代价远大于收益。
    // 工具调用信息改为从流式内容中解析后渲染成折叠卡片。
    log("tool lifecycle hook disabled by design");

    log("registerToolPkg done");
    return true;
}