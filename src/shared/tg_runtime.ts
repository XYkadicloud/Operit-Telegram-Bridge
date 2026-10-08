/**
 * Telegram Bridge - 对外工具实现
 */

import {
    BOOLEAN_KEYS,
    DEFAULT_CONFIG,
    NUMBER_KEYS,
    STRING_KEYS,
    TgConfig,
    flushRuntimeStateAsync,
    readBotTokenAsync,
    readConfigAsync,
    readRuntimeStateAsync,
    removeBindingAsync,
    writeBotTokenAsync,
    writeConfigAsync,
    writeRuntimeStateAsync
} from "./tg_state";
import {
    PACKAGE_VERSION,
    JsonObject,
    asText,
    firstNonBlank,
    hasOwn,
    isObject,
    maskSecret,
    parseOptionalBoolean,
    safeErrorMessage
} from "./tg_common";
import {
    getBridgeInfo,
    isBridgeRunning,
    ensureBridgeStartedAsync,
    ensureWatchdogAsync,
    sendTextToChatAsync,
    startBridgeAsync,
    stopBridgeAsync
} from "./tg_bridge";
import { withContextQuiet } from "./tg_ipc_client";
import { tgDeleteMessage, tgGetMe, tgSendMessage, tgEditMessageText } from "./tg_api";

/** 把工具参数（snake_case）映射到配置键（camelCase） */
const PARAM_TO_CONFIG: Record<string, keyof TgConfig> = {
    bot_token: "botToken",
    api_base_url: "apiBaseUrl",
    long_poll_seconds: "longPollSeconds",
    ai_timeout_ms: "aiTimeoutMs",
    http_timeout_ms: "httpTimeoutMs",
    max_backoff_ms: "maxBackoffMs",

    enabled: "enabled",
    auto_start: "autoStart",
    private_enabled: "privateEnabled",
    group_enabled: "groupEnabled",
    group_require_mention: "groupRequireMention",
    other_chat_enabled: "otherChatEnabled",
    chat_id_allow_list: "chatIdAllowList",
    commands_enabled: "commandsEnabled",

    streaming_enabled: "streamingEnabled",
    show_thinking: "showThinking",
    show_tool_calls: "showToolCalls",
    show_tool_params: "showToolParams",
    show_tool_duration: "showToolDuration",
    show_stats: "showStats",
    show_model: "showModel",
    show_timestamps: "showTimestamps",
    progress_max_chars: "progressMaxChars",
    progress_edit_interval_ms: "progressEditIntervalMs",
    progress_mode: "progressMode",
    show_typing_action: "showTypingAction",

    delete_progress_after_reply: "deleteProgressAfterReply",
    keep_progress_on_error: "keepProgressOnError",
    reply_to_message: "replyToMessage",
    silent_send: "silentSend",
    split_long_replies: "splitLongReplies",
    max_reply_chars: "maxReplyChars",
    reply_style: "replyStyle",
    collapse_threshold: "collapseThreshold",
    include_detail: "includeDetail",
    detail_title: "detailTitle",

    per_chat_isolation: "perChatIsolation",
    per_sender_isolation: "perSenderIsolation",
    chat_group: "chatGroup",
    character_card_id: "characterCardId",
    assistant_instruction: "assistantInstruction",
    persist_turn: "persistTurn",

    max_concurrency: "maxConcurrency",
    announce_on_start: "announceOnStart"
};

export async function tg_configure(params: JsonObject = {}): Promise<JsonObject> {
    try {
        const updatedEnvKeys: string[] = [];
        const updatedFields: string[] = [];
        const patch: JsonObject = {};

        // bot_token 单独处理（要同步写环境变量）
        if (hasOwn(params, "bot_token")) {
            const token = asText(params.bot_token).trim();
            if (token) {
                await writeBotTokenAsync(token);
                updatedEnvKeys.push("TELEGRAM_BOT_TOKEN");
                updatedFields.push("botToken");
            }
        }

        Object.keys(PARAM_TO_CONFIG).forEach((paramName) => {
            if (paramName === "bot_token") {
                return;
            }
            if (!hasOwn(params, paramName)) {
                return;
            }
            const configKey = PARAM_TO_CONFIG[paramName];
            const raw = params[paramName];

            if (BOOLEAN_KEYS.indexOf(configKey) >= 0) {
                const parsed = parseOptionalBoolean(raw, paramName);
                if (parsed !== undefined) {
                    patch[configKey] = parsed;
                    updatedFields.push(String(configKey));
                }
                return;
            }

            if (NUMBER_KEYS.indexOf(configKey) >= 0) {
                const num = Number(raw);
                if (isFinite(num) && num > 0) {
                    patch[configKey] = Math.floor(num);
                    updatedFields.push(String(configKey));
                }
                return;
            }

            // 字符串
            const text = asText(raw).trim();
            if (configKey === "chatGroup" && !text) {
                patch[configKey] = DEFAULT_CONFIG.chatGroup;
            } else {
                patch[configKey] = text;
            }
            updatedFields.push(String(configKey));
        });

        const config = Object.keys(patch).length > 0
            ? await writeConfigAsync(patch)
            : await readConfigAsync();

        // 关闭总开关时自动停止监听
        let restartResult: JsonObject | null = null;
        const shouldRestart = parseOptionalBoolean(params.restart_if_running, "restart_if_running") === true;
        if (!config.enabled && isBridgeRunning()) {
            await stopBridgeAsync();
        } else if (shouldRestart && isBridgeRunning()) {
            await stopBridgeAsync();
            restartResult = await startBridgeAsync();
        }

        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            updatedEnvKeys,
            updatedFields,
            config,
            restart: restartResult
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function buildStatusAsync(): Promise<JsonObject> {
    try {
        const config = await readConfigAsync();
        const token = await readBotTokenAsync();
        const state = await readRuntimeStateAsync();
        const info = getBridgeInfo();
        const bindingKeys = Object.keys(state.bindings);

        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            configured: !!token,
            botTokenMasked: maskSecret(token),
            botName: info.botName,
            botUsername: info.botUsername,
            botId: info.botId,
            config,
            runtime: {
                running: info.running,
                startedAt: state.startedAt,
                lastPollAt: state.lastPollAt,
                lastError: state.lastError,
                processedTotal: state.processedTotal,
                failedTotal: state.failedTotal
            },
            bindingCount: bindingKeys.length
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_start(params: JsonObject = {}): Promise<JsonObject> {
    try {
        const restart = parseOptionalBoolean(params.restart, "restart") === true;

        // 关键：绝不在工具沙盒里起轮询循环。
        // 沙盒在工具返回后即销毁，循环会随之死亡；而且会和 main 里的循环
        // 争抢 getUpdates，导致 "Conflict: terminated by other getUpdates request"。
        // 这里只写意图 + 转发给 main 上下文，由 main 持有唯一循环。
        await writeRuntimeStateAsync({ desiredRunning: true });

        // 关键：参数必须经 envs 传递。
        // runner 会被 toString() 序列化后在 main 上下文重建，
        // 闭包变量（如直接写 { restart }）会丢失成 undefined，
        // 只有 envs 里的名字会被注入成同名局部变量。
        const forwarded = await withContextQuiet("main", { params: { restart } }, async () => {
            return await tg_ensure_watchdog(params);
        });

        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            forwardedToMain: forwarded,
            status: await buildStatusAsync()
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

/** 供工具请求 main 上下文启动看门狗（本函数自身在 main 上下文执行） */
export async function tg_ensure_watchdog(params: JsonObject = {}): Promise<JsonObject> {
    try {
        const restart = params.restart === true;
        if (restart && isBridgeRunning()) {
            await stopBridgeAsync();
        }
        const watchdog = ensureWatchdogAsync();
        const started = await ensureBridgeStartedAsync();
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            watchdog,
            bridge: started
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_stop(): Promise<JsonObject> {
    try {
        const result = await stopBridgeAsync();
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            ...result,
            status: await buildStatusAsync()
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_test_connection(): Promise<JsonObject> {
    try {
        const token = await readBotTokenAsync();
        if (!token) {
            throw new Error("未配置 Bot Token");
        }
        const result = await tgGetMe(token);
        if (!result.ok) {
            throw new Error(firstNonBlank(result.error, "getMe 失败"));
        }
        const me = isObject(result.result) ? result.result as JsonObject : {};
        const info = getBridgeInfo();
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            botId: Number(me.id) || 0,
            botName: asText(me.first_name),
            botUsername: asText(me.username),
            canJoinGroups: me.can_join_groups === true,
            canReadAllGroupMessages: me.can_read_all_group_messages === true,
            supportsInlineQueries: me.supports_inline_queries === true,
            currentRunning: info.running
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_send_message(params: JsonObject = {}): Promise<JsonObject> {
    try {
        const chatId = asText(params.chat_id).trim();
        const text = asText(params.text);
        if (!chatId) {
            throw new Error("缺少参数：chat_id");
        }
        if (!text) {
            throw new Error("缺少参数：text");
        }
        const result = await sendTextToChatAsync(chatId, text);
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            ...result
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_list_bindings(): Promise<JsonObject> {
    try {
        const state = await readRuntimeStateAsync();
        const items = Object.keys(state.bindings).map((key) => {
            const binding = state.bindings[key];
            return {
                tgChatId: key,
                tgChatType: asText(binding?.tgChatType),
                operitChatId: asText(binding?.chatId),
                title: asText(binding?.title),
                lastProcessedAt: asText(binding?.lastProcessedAt)
            };
        });
        items.sort((left, right) => String(right.lastProcessedAt).localeCompare(String(left.lastProcessedAt)));
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            totalCount: items.length,
            items
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

export async function tg_reset_binding(params: JsonObject = {}): Promise<JsonObject> {
    try {
        const chatId = asText(params.chat_id).trim();
        if (chatId) {
            await removeBindingAsync(chatId);
            return {
                success: true,
                packageVersion: PACKAGE_VERSION,
                cleared: 1,
                chatId
            };
        }

        const state = await readRuntimeStateAsync();
        const count = Object.keys(state.bindings).length;
        await writeRuntimeStateAsync({ bindings: {} });
        await flushRuntimeStateAsync();
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            cleared: count
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

/** 把运行状态重置为“停止”（用于异常退出后清理残留标记） */
export async function tg_reset_runtime(): Promise<JsonObject> {
    try {
        await stopBridgeAsync();
        await writeRuntimeStateAsync({
            running: false,
            lastError: "",
            updateOffset: 0,
            processedTotal: 0,
            failedTotal: 0
        });
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            message: "运行状态已重置"
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

/** 导出当前配置为 JSON 文本，方便排查 */
export async function tg_dump_config(): Promise<JsonObject> {
    try {
        const config = await readConfigAsync();
        const token = await readBotTokenAsync();
        const safeConfig: JsonObject = {
            ...config,
            botToken: maskSecret(token)
        };
        return {
            success: true,
            packageVersion: PACKAGE_VERSION,
            config: safeConfig
        };
    } catch (error: unknown) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: safeErrorMessage(error)
        };
    }
}

/**
 * 自检：逐项验证 Telegram 侧能力，定位显示/折叠问题。
 */
export async function tg_selftest(params: JsonObject = {}): Promise<JsonObject> {
    const results: JsonObject[] = [];
    const token = await readBotTokenAsync();
    let chatId = asText(params.chat_id).trim();

    if (!chatId) {
        const state = await readRuntimeStateAsync();
        const keys = Object.keys(state.bindings);
        if (keys.length > 0) {
            chatId = asText(state.bindings[keys[0]]?.tgChatId).trim();
        }
    }
    // 绑定键可能是 "chatId:userId"，取前半段
    if (chatId.indexOf(":") > 0) {
        chatId = chatId.split(":")[0];
    }

    if (!token) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: "未配置 Bot Token"
        };
    }
    if (!chatId) {
        return {
            success: false,
            packageVersion: PACKAGE_VERSION,
            error: "找不到可用会话，请先给 Bot 发一条消息，或传入 chat_id"
        };
    }

    // 1) 纯文本
    const plain = await tgSendMessage(token, chatId, "【自检 1/5】纯文本发送正常", {
        disableNotification: true
    });
    results.push({
        step: "plain_text",
        ok: plain.ok,
        error: plain.error
    });

    // 2) HTML 基础标签
    const htmlBasic = await tgSendMessage(token, chatId, "【自检 2/5】<b>粗体</b> 与 <i>斜体</i>", {
        disableNotification: true,
        parseMode: "HTML"
    });
    results.push({
        step: "html_basic",
        ok: htmlBasic.ok,
        error: htmlBasic.error
    });

    // 3) 折叠卡片（关键）
    const collapse = await tgSendMessage(
        token,
        chatId,
        "【自检 3/5】折叠卡片测试 👇\n<blockquote expandable>这里是一段较长的内容，正常情况下应该默认折叠起来，点击才展开。如果这条消息报错，说明当前客户端/服务端不支持该标签。</blockquote>",
        { disableNotification: true, parseMode: "HTML" }
    );
    results.push({
        step: "collapse_card",
        ok: collapse.ok,
        error: collapse.error
    });

    // 4) 编辑已有消息
    const sentMsgId = Number(plain.result?.message_id) || 0;
    let editOk = false;
    let editError = "";
    if (sentMsgId > 0) {
        const edited = await tgEditMessageText(
            token,
            chatId,
            sentMsgId,
            "【自检 4/5】<b>编辑</b> + 折叠 👇\n<blockquote expandable>编辑时嵌套折叠块</blockquote>",
            "HTML"
        );
        editOk = edited.ok;
        editError = edited.error;
    }
    results.push({
        step: "edit_with_html",
        ok: editOk,
        error: editError
    });

    // 5) 删除
    let deleteOk = false;
    let deleteError = "";
    if (sentMsgId > 0) {
        const deleted = await tgDeleteMessage(token, chatId, sentMsgId);
        deleteOk = deleted.ok;
        deleteError = deleted.error;
    }
    results.push({
        step: "delete_message",
        ok: deleteOk,
        error: deleteError
    });

    const allOk = results.every((item) => item.ok === true);
    const collapseOk = results[2]?.ok === true;

    return {
        success: true,
        packageVersion: PACKAGE_VERSION,
        chatId,
        allOk,
        collapseSupported: collapseOk,
        summary: collapseOk
            ? "折叠卡片可用；若实际未折叠，请检查显示设置中的「显示工具参数」是否开启"
            : "折叠卡片不可用，已自动降级为纯文本显示",
        results
    };
}