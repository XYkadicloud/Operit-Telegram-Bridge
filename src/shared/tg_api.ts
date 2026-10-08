/**
 * Telegram Bot API 封装
 *
 * 支持自定义 API 基址（官方 api.telegram.org 或自建反代）。
 */

import {
    API_BASE_URL,
    DEFAULT_HTTP_TIMEOUT_MS,
    JsonObject,
    asText,
    firstNonBlank,
    isObject,
    safeErrorMessage
} from "./tg_common";
import { readApiBaseUrlAsync } from "./tg_state";

export type TgCallResult = {
    ok: boolean;
    statusCode: number;
    result: any;
    error: string;
    description: string;
};

function toSeconds(ms: number): number {
    return Math.max(1, Math.ceil(ms / 1000));
}

export function buildApiUrl(baseUrl: string, token: string, method: string): string {
    const base = (asText(baseUrl).trim() || API_BASE_URL).replace(/\/+$/, "");
    return `${base}/bot${asText(token).trim()}/${method}`;
}

/**
 * 调用任意 Telegram Bot API 方法（JSON body）。
 *
 * 注意：Tools.Net.http 对 POST 强制要求 body，
 * 即使无参数也必须传 {}，否则会抛
 * "method POST must have a request body"。
 */
export async function callTg(
    token: string,
    method: string,
    payload: JsonObject | null,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    baseUrlOverride?: string
): Promise<TgCallResult> {
    let baseUrl = baseUrlOverride;
    if (!baseUrl) {
        try {
            baseUrl = await readApiBaseUrlAsync();
        } catch (_error) {
            baseUrl = API_BASE_URL;
        }
    }

    const url = buildApiUrl(baseUrl, token, method);
    const body = payload && Object.keys(payload).length > 0 ? payload : {};

    let response: any = null;
    try {
        response = await Tools.Net.http({
            url,
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                Accept: "application/json"
            },
            body,
            connect_timeout: toSeconds(timeoutMs),
            read_timeout: toSeconds(timeoutMs),
            validateStatus: false
        });
    } catch (error: unknown) {
        return {
            ok: false,
            statusCode: 0,
            result: null,
            error: safeErrorMessage(error),
            description: ""
        };
    }

    const statusCode = Number(response?.statusCode == null ? 0 : response.statusCode);
    const content = asText(response?.content);
    let parsed: JsonObject = {};
    try {
        const json = JSON.parse(content);
        parsed = isObject(json) ? json as JsonObject : {};
    } catch (_error) {
        parsed = {};
    }

    const ok = parsed.ok === true;
    const description = firstNonBlank(asText(parsed.description));
    return {
        ok,
        statusCode,
        result: parsed.result,
        error: ok ? "" : firstNonBlank(description, `HTTP ${statusCode}`, content.slice(0, 300)),
        description
    };
}

/** 纯文本发送 */
export async function tgSendMessage(
    token: string,
    chatId: string | number,
    text: string,
    options: {
        replyToMessageId?: number;
        disableNotification?: boolean;
        linkPreview?: boolean;
        /** 传入 "HTML" 时启用 HTML 解析 */
        parseMode?: string;
    } = {},
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<TgCallResult> {
    const payload: JsonObject = {
        chat_id: chatId,
        text,
        disable_web_page_preview: options.linkPreview === true ? false : true
    };
    if (options.parseMode) {
        payload.parse_mode = options.parseMode;
    }
    if (options.replyToMessageId) {
        payload.reply_to_message_id = options.replyToMessageId;
    }
    if (options.disableNotification === true) {
        payload.disable_notification = true;
    }
    return await callTg(token, "sendMessage", payload, timeoutMs);
}

export async function tgEditMessageText(
    token: string,
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: string,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<TgCallResult> {
    const payload: JsonObject = {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true
    };
    if (parseMode) {
        payload.parse_mode = parseMode;
    }
    return await callTg(token, "editMessageText", payload, timeoutMs);
}

export async function tgDeleteMessage(
    token: string,
    chatId: string | number,
    messageId: number,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<TgCallResult> {
    return await callTg(token, "deleteMessage", {
        chat_id: chatId,
        message_id: messageId
    }, timeoutMs);
}

export async function tgSendChatAction(
    token: string,
    chatId: string | number,
    action = "typing",
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<TgCallResult> {
    return await callTg(token, "sendChatAction", {
        chat_id: chatId,
        action
    }, timeoutMs);
}

export async function tgGetMe(token: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<TgCallResult> {
    return await callTg(token, "getMe", {}, timeoutMs);
}

export async function tgSetMyCommands(
    token: string,
    commands: Array<{ command: string; description: string }>,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<TgCallResult> {
    return await callTg(token, "setMyCommands", { commands }, timeoutMs);
}

export async function tgDeleteWebhook(token: string): Promise<TgCallResult> {
    return await callTg(token, "deleteWebhook", { drop_pending_updates: false });
}

/**
 * 长轮询拉取更新。
 * HTTP 超时要比 Telegram 侧 timeout 略大，否则会频繁空转。
 */
export async function tgGetUpdates(
    token: string,
    offset: number,
    longPollSeconds: number
): Promise<TgCallResult> {
    const payload: JsonObject = {
        timeout: Math.max(0, Math.floor(longPollSeconds)),
        allowed_updates: ["message", "edited_message", "callback_query"]
    };
    if (offset > 0) {
        payload.offset = offset;
    }
    const httpTimeoutMs = (longPollSeconds + 15) * 1000;
    return await callTg(token, "getUpdates", payload, httpTimeoutMs);
}