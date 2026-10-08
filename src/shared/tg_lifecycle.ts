/**
 * Telegram Bridge - 应用生命周期钩子
 *
 * 注意：registerAppLifecycleHook 的函数必须从模块导出，
 * 因此这些 handler 必须放在独立模块里用 export 暴露。
 */

import { ensureBridgeStartedAsync, ensureWatchdogAsync, setBridgeBotIdentity } from "./tg_bridge";
import { readBotTokenAsync } from "./tg_state";
import { tgGetMe } from "./tg_api";
import { asText, isObject, safeErrorMessage } from "./tg_common";

function log(message: string): void {
    console.log(`[telegram_bridge] ${message}`);
}

/** 启动时补一次 bot 身份，供群聊 @ 判定使用 */
async function refreshBotIdentityAsync(): Promise<void> {
    try {
        const token = await readBotTokenAsync();
        if (!token) {
            return;
        }
        const result = await tgGetMe(token);
        if (!result.ok) {
            return;
        }
        const me = isObject(result.result) ? result.result as Record<string, any> : {};
        setBridgeBotIdentity(asText(me.first_name), asText(me.username));
    } catch (_error) {
        // 身份获取失败不影响主流程
    }
}

export async function onTelegramBridgeApplicationCreate(): Promise<any> {
    try {
        log("application_on_create");
        // 看门狗常驻 main 上下文，负责在循环意外死亡时自愈
        try {
            ensureWatchdogAsync();
        } catch (_error) {
            // 忽略
        }
        await refreshBotIdentityAsync();
        return await ensureBridgeStartedAsync();
    } catch (error: unknown) {
        log(`application_on_create failed: ${safeErrorMessage(error)}`);
        return { ok: false, error: safeErrorMessage(error) };
    }
}

export async function onTelegramBridgeApplicationForeground(): Promise<any> {
    try {
        log("application_on_foreground");
        try {
            ensureWatchdogAsync();
        } catch (_error) {
            // 忽略
        }
        await refreshBotIdentityAsync();
        return await ensureBridgeStartedAsync();
    } catch (error: unknown) {
        log(`application_on_foreground failed: ${safeErrorMessage(error)}`);
        return { ok: false, error: safeErrorMessage(error) };
    }
}

export async function onTelegramBridgeApplicationTerminate(): Promise<any> {
    log("application_on_terminate");
    // 进程即将结束，不做额外清理：
    // 监听随进程消失，下次启动由 create/foreground 钩子重新拉起。
    return { ok: true };
}