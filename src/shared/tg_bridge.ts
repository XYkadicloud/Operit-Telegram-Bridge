/**
 * Telegram Bridge - 核心桥接逻辑
 *
 * 会话隔离模型：
 *  - perChatIsolation=true：每个 Telegram 会话各自一个 Operit 对话
 *      · 私聊 → 每个用户一个对话（天然如此）
 *      · 群聊 → 整个群共用一个对话
 *  - perSenderIsolation=true：群聊里再按发送者拆开（可选）
 *  - perChatIsolation=false：全部共用当前对话
 */

import {
    JsonObject,
    asText,
    firstNonBlank,
    hasOwn,
    isObject,
    safeErrorMessage,
    sleep,
    truncateSafe
} from "./tg_common";
import {
    TgChatBinding,
    TgConfig,
    getBindingAsync,
    hasSeenUpdateIdAsync,
    readBotTokenAsync,
    readConfigAsync,
    readRuntimeStateAsync,
    rememberUpdateIdAsync,
    removeBindingAsync,
    setBindingAsync,
    writeRuntimeStateAsync
} from "./tg_state";
import { TgProgressReporter, ProgressText, ProgressOptions } from "./tg_progress";
import { tgGetUpdates, tgSendChatAction, tgSendMessage } from "./tg_api";
import { buildFinalReply, cleanAiReply, extractToolCalls } from "./tg_format";

// ---------------------------------------------------------------------------
// 全局运行句柄
// ---------------------------------------------------------------------------

const bridge = {
    running: false,
    loopToken: 0,
    botName: "Operit",
    botUsername: "",
    botId: 0
};

export function isBridgeRunning(): boolean {
    return bridge.running;
}

export function getBridgeInfo(): {
    running: boolean;
    botName: string;
    botUsername: string;
    botId: number;
} {
    return {
        running: bridge.running,
        botName: bridge.botName,
        botUsername: bridge.botUsername,
        botId: bridge.botId
    };
}

export function setBridgeBotIdentity(name: string, username: string, id?: number): void {
    if (name) {
        bridge.botName = name;
    }
    if (username) {
        bridge.botUsername = username;
    }
    if (id) {
        bridge.botId = id;
    }
}

type ActiveTurn = {
    reporter: TgProgressReporter;
    config: TgConfig;
    toolStartedAt: Record<string, number>;
    toolCount: number;
};

let activeTurn: ActiveTurn | null = null;

// ---------------------------------------------------------------------------
// 工具调用 hook
// ---------------------------------------------------------------------------

export function onToolLifecycleEvent(event: any): any {
    // 最外层硬保险：无论发生什么，都返回 allow。
    // 返回 undefined 会让宿主抛 IllegalStateException 并拦死所有工具调用。
    try {
        return handleToolLifecycleEvent(event);
    } catch (_error) {
        return { action: "allow" };
    }
}

function handleToolLifecycleEvent(event: any): any {
    try {
        // HookEventBase 的实际字段是 eventName / eventPayload，
        // 不是 name / payload。读错字段会导致拦截事件返回 undefined，
        // 宿主抛 IllegalStateException 并拦死所有工具调用。
        const payloadRaw = isObject(event?.eventPayload)
            ? event.eventPayload
            : (isObject(event?.payload) ? event.payload : event);
        const payload: JsonObject = isObject(payloadRaw) ? payloadRaw as JsonObject : {};

        const eventName = firstNonBlank(
            asText(event?.eventName),
            asText(event?.name),
            asText(payload.eventName),
            asText(payload.name)
        );

        // 拦截事件必须显式返回 allow/block
        if (eventName === "tool_call_intercept") {
            return { action: "allow" };
        }

        // 兜底：只有下面这几个展示事件才需要走渲染逻辑，
        // 其余事件一律返回 allow，避免返回 undefined 触发宿主异常。
        const displayEvents = [
            "tool_call_requested",
            "tool_execution_started",
            "tool_execution_result",
            "tool_execution_finished",
            "tool_execution_error"
        ];
        if (displayEvents.indexOf(eventName) < 0) {
            return { action: "allow" };
        }

        const turn = activeTurn;
        if (!turn || !turn.config.showToolCalls) {
            return { action: "allow" };
        }

        const toolName = firstNonBlank(asText(payload.toolName), asText(payload.tool_name));
        if (!toolName) {
            return { action: "allow" };
        }

        if (toolName.toLowerCase().indexOf("telegram") >= 0) {
            return { action: "allow" };
        }

        const params = isObject(payload.parameters)
            ? payload.parameters as Record<string, any>
            : undefined;
        const card = ProgressText.toolStart(toolName, params);

        if (eventName === "tool_call_requested" || eventName === "tool_execution_started") {
            if (hasOwn(turn.toolStartedAt, toolName)) {
                return { action: "allow" };
            }
            turn.toolStartedAt[toolName] = Date.now();
            turn.toolCount += 1;
            turn.reporter.upsertToolCard(
                `run:${toolName}`,
                card.title,
                card.detail,
                turn.config.showToolParams
            );
            return { action: "allow" };
        }

        if (eventName === "tool_execution_result" || eventName === "tool_execution_finished") {
            const startedAt = turn.toolStartedAt[toolName] || 0;
            delete turn.toolStartedAt[toolName];
            const success = payload.success !== false;
            const durationMs = startedAt > 0 ? Date.now() - startedAt : 0;
            turn.reporter.upsertToolCard(
                `run:${toolName}`,
                ProgressText.toolDone(toolName, success, durationMs, turn.config.showToolDuration),
                card.detail,
                turn.config.showToolParams
            );
            return { action: "allow" };
        }

        if (eventName === "tool_execution_error") {
            delete turn.toolStartedAt[toolName];
            turn.reporter.upsertToolCard(
                `run:${toolName}`,
                `❌ ${toolName}`,
                truncateSafe(asText(payload.errorMessage), 600),
                true
            );
            return { action: "allow" };
        }

        return { action: "allow" };
    } catch (_error) {
        // hook 异常绝不能影响主流程；异常时也要放行
        return { action: "allow" };
    }
}

// ---------------------------------------------------------------------------
// 会话绑定
// ---------------------------------------------------------------------------

type TgChatInfo = {
    id: number;
    type: string;
    title: string;
    username: string;
};

function isGroupType(type: string): boolean {
    return type === "group" || type === "supergroup";
}

/**
 * 绑定键：
 *  - 私聊 → 用户 id（每个人一个对话）
 *  - 群聊 → 群 id（整个群只占一个对话）
 *  - perSenderIsolation 打开时，群聊再按发送者拆开
 */
function buildBindingKey(config: TgConfig, chat: TgChatInfo, userId: number): string {
    if (isGroupType(chat.type) && config.perSenderIsolation && userId > 0) {
        return `${chat.id}:${userId}`;
    }
    return String(chat.id);
}

function buildProgressOptions(config: TgConfig, title: string): ProgressOptions {
    return {
        showThinking: config.streamingEnabled && config.showThinking,
        showToolCalls: config.showToolCalls,
        showToolParams: config.showToolParams,
        showToolDuration: config.showToolDuration,
        showStats: config.showStats,
        showModel: config.showModel,
        showTimestamps: config.showTimestamps,
        collapseThreshold: config.collapseThreshold,
        maxChars: config.progressMaxChars,
        editIntervalMs: config.progressEditIntervalMs,
        mode: config.progressMode,
        title
    };
}

async function ensureChatServiceReadyAsync(): Promise<void> {
    try {
        await Tools.Chat.startService({
            initial_mode: "BALL",
            keep_if_exists: true,
            timeout_ms: 20000
        });
    } catch (_error) {
        // 悬浮球拉起失败不阻塞主流程
    }
}

function buildOperitChatTitle(chat: TgChatInfo): string {
    const label = firstNonBlank(chat.title, chat.username, String(chat.id));
    if (isGroupType(chat.type)) {
        return `[TG][群] ${truncateSafe(label, 40)}`;
    }
    if (chat.type === "private") {
        return `[TG][私聊] ${truncateSafe(label, 40)}`;
    }
    return `[TG][${chat.type}] ${truncateSafe(label, 40)}`;
}

async function resolveBoundChatIdAsync(
    config: TgConfig,
    chat: TgChatInfo,
    userId: number
): Promise<string> {
    await ensureChatServiceReadyAsync();

    if (!config.perChatIsolation) {
        const list = await Tools.Chat.listAll() as any;
        const currentChatId = asText(list?.currentChatId).trim();
        if (currentChatId) {
            return currentChatId;
        }
    }

    const key = buildBindingKey(config, chat, userId);
    const existing = await getBindingAsync(key);
    const existingChatId = firstNonBlank(existing?.chatId);

    if (existingChatId) {
        try {
            const found = await Tools.Chat.findChat({
                query: existingChatId,
                match: "exact",
                index: 0
            }) as any;
            if (asText(found?.chat?.id).trim() === existingChatId) {
                return existingChatId;
            }
        } catch (error: unknown) {
            const message = safeErrorMessage(error);
            if (message.indexOf("Chat not found") < 0) {
                throw error;
            }
        }
        await removeBindingAsync(key);
    }

    const creation = await Tools.Chat.createNew(
        config.chatGroup,
        false,
        config.characterCardId || undefined
    ) as any;
    const chatId = asText(creation?.chatId).trim();
    if (!chatId) {
        throw new Error("无法为 Telegram 会话创建 Operit 对话");
    }

    const title = buildOperitChatTitle(chat);
    try {
        await Tools.Chat.updateTitle(chatId, title);
    } catch (_error) {
        // 标题失败无妨
    }

    const binding: TgChatBinding = {
        chatId,
        title,
        tgChatId: key,
        tgChatType: chat.type,
        lastMessageId: 0,
        lastProcessedAt: new Date().toISOString()
    };
    await setBindingAsync(key, binding);
    return chatId;
}

async function touchBindingAsync(
    config: TgConfig,
    chat: TgChatInfo,
    userId: number,
    chatId: string,
    messageId: number
): Promise<void> {
    try {
        const key = buildBindingKey(config, chat, userId);
        const existing = await getBindingAsync(key);
        await setBindingAsync(key, {
            chatId,
            title: firstNonBlank(existing?.title, buildOperitChatTitle(chat)),
            tgChatId: key,
            tgChatType: chat.type,
            lastMessageId: messageId,
            lastProcessedAt: new Date().toISOString()
        });
    } catch (_error) {
        // 忽略
    }
}

// ---------------------------------------------------------------------------
// 消息解析
// ---------------------------------------------------------------------------

type ParsedMessage = {
    updateId: number;
    messageId: number;
    chat: TgChatInfo;
    fromId: number;
    fromName: string;
    isBot: boolean;
    text: string;
    mentionsBot: boolean;
    command: string;
    commandArgs: string;
    hasAttachment: boolean;
};

function extractChatInfo(raw: JsonObject): TgChatInfo {
    return {
        id: Number(raw?.id) || 0,
        type: asText(raw?.type) || "private",
        title: firstNonBlank(asText(raw?.title), asText(raw?.first_name)),
        username: asText(raw?.username)
    };
}

function hasAttachment(raw: JsonObject): boolean {
    return !!(raw?.photo || raw?.document || raw?.voice || raw?.audio || raw?.video || raw?.sticker);
}

function extractText(raw: JsonObject): string {
    return firstNonBlank(asText(raw?.text), asText(raw?.caption));
}

function parseUpdate(update: JsonObject): ParsedMessage | null {
    const updateId = Number(update?.update_id);
    if (!isFinite(updateId)) {
        return null;
    }

    const raw = isObject(update?.message)
        ? update.message as JsonObject
        : (isObject(update?.edited_message) ? update.edited_message as JsonObject : null);
    if (!raw) {
        return null;
    }

    const chat = extractChatInfo(isObject(raw.chat) ? raw.chat as JsonObject : {});
    if (!chat.id) {
        return null;
    }

    const from = isObject(raw.from) ? raw.from as JsonObject : {};
    const text = extractText(raw);
    const botUsername = bridge.botUsername;

    let mentionsBot = false;
    const entities = Array.isArray(raw.entities) ? raw.entities : [];
    for (let index = 0; index < entities.length; index += 1) {
        const entity = entities[index];
        if (asText(entity?.type) === "mention" && botUsername) {
            const offset = Number(entity?.offset) || 0;
            const length = Number(entity?.length) || 0;
            const mentionText = text.slice(offset, offset + length).toLowerCase();
            if (mentionText === `@${botUsername.toLowerCase()}`) {
                mentionsBot = true;
                break;
            }
        }
    }

    let command = "";
    let commandArgs = "";
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
        const firstSpace = trimmed.search(/\s/);
        const head = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
        command = head.replace(/@.*$/, "").slice(1).toLowerCase();
        commandArgs = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
    }

    return {
        updateId,
        messageId: Number(raw.message_id) || 0,
        chat,
        fromId: Number(from?.id) || 0,
        fromName: firstNonBlank(asText(from?.first_name), asText(from?.username), "unknown"),
        isBot: from?.is_bot === true,
        text,
        mentionsBot,
        command,
        commandArgs,
        hasAttachment: hasAttachment(raw)
    };
}

function isInAllowList(chatId: number, allowList: string): boolean {
    const raw = asText(allowList).trim();
    if (!raw) {
        return true;
    }
    const items = raw.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => !!item);
    if (items.length === 0) {
        return true;
    }
    return items.indexOf(String(chatId)) >= 0;
}

function shouldHandle(parsed: ParsedMessage, config: TgConfig): { ok: boolean; reason: string } {
    if (parsed.isBot) {
        return { ok: false, reason: "bot_message" };
    }
    if (!isInAllowList(parsed.chat.id, config.chatIdAllowList)) {
        return { ok: false, reason: "not_in_allow_list" };
    }

    const type = parsed.chat.type;
    if (type === "private") {
        if (!config.privateEnabled) {
            return { ok: false, reason: "private_disabled" };
        }
    } else if (isGroupType(type)) {
        if (!config.groupEnabled) {
            return { ok: false, reason: "group_disabled" };
        }
        if (config.groupRequireMention && !parsed.mentionsBot && !parsed.command) {
            return { ok: false, reason: "group_mention_required" };
        }
    } else {
        if (!config.otherChatEnabled) {
            return { ok: false, reason: "other_chat_disabled" };
        }
    }

    if (!parsed.text.trim() && !parsed.hasAttachment) {
        return { ok: false, reason: "empty_content" };
    }
    return { ok: true, reason: "" };
}

function stripBotMention(text: string): string {
    const username = bridge.botUsername;
    if (!username) {
        return text;
    }
    const pattern = new RegExp(`@${username}\\s*`, "gi");
    return text.replace(pattern, "").trim();
}

function buildAiMessage(parsed: ParsedMessage, config: TgConfig): string {
    let body = stripBotMention(parsed.text).trim();
    if (!body && parsed.hasAttachment) {
        body = "[用户发送了附件，但当前版本仅转发文本内容]";
    }

    const meta: string[] = [
        "source: telegram",
        `chatType: ${parsed.chat.type}`,
        `from: ${parsed.fromName}`
    ];
    if (isGroupType(parsed.chat.type)) {
        meta.push(`chatTitle: ${firstNonBlank(parsed.chat.title, String(parsed.chat.id))}`);
    }
    const instruction = asText(config.assistantInstruction).trim();
    if (instruction) {
        meta.push(`instruction: ${instruction}`);
    }

    return `${body}\n\n<attachment filename="telegram_message_context.txt" type="text/plain">${meta.join("\n")}</attachment>`;
}

function splitPlainText(text: string, maxChars: number): string[] {
    const value = asText(text);
    if (value.length <= maxChars) {
        return [value];
    }
    const chunks: string[] = [];
    let rest = value;
    while (rest.length > 0) {
        if (rest.length <= maxChars) {
            chunks.push(rest);
            break;
        }
        let cut = rest.lastIndexOf("\n", maxChars);
        if (cut < maxChars * 0.5) {
            cut = maxChars;
        }
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, "");
    }
    return chunks;
}

// ---------------------------------------------------------------------------
// 单条消息处理
// ---------------------------------------------------------------------------

export type TurnOutcome = {
    ok: boolean;
    chatId: string;
    replyText: string;
    durationMs: number;
    deletedProgress: number;
    error: string;
};

async function handleMessageAsync(
    token: string,
    parsed: ParsedMessage,
    config: TgConfig
): Promise<TurnOutcome> {
    const startedAt = Date.now();
    const tgChatId = parsed.chat.id;

    let operitChatId = "";
    let deletedProgress = 0;

    const reporter = new TgProgressReporter(
        token,
        tgChatId,
        parsed.messageId > 0 ? parsed.messageId : undefined,
        buildProgressOptions(config, bridge.botName)
    );

    const turn: ActiveTurn = {
        reporter,
        config,
        toolStartedAt: {},
        toolCount: 0
    };

    try {
        reporter.append(ProgressText.header(bridge.botName));
        if (config.showTypingAction) {
            void tgSendChatAction(token, tgChatId, "typing");
        }

        operitChatId = await resolveBoundChatIdAsync(config, parsed.chat, parsed.fromId);
        activeTurn = turn;

        let streamBuffer = "";
        let chunkCount = 0;

        const sendResult = await Tools.Chat.sendMessageStreaming(
            buildAiMessage(parsed, config),
            operitChatId,
            config.characterCardId || undefined,
            undefined,
            {
                waifu: false,
                persist_turn: config.persistTurn,
                notify_reply: false,
                hide_user_message: false,
                disable_warning: true,
                timeout_ms: config.aiTimeoutMs,
                onIntermediateResult: (event: any) => {
                    try {
                        if (asText(event?.type) !== "chunk") {
                            return;
                        }
                        const chunk = asText(event?.chunk);
                        if (!chunk) {
                            return;
                        }
                        streamBuffer += chunk;
                        chunkCount += 1;
                        // 工具调用从流式原文里解析（钩子已禁用，避免锁死工具通道）
                        reporter.setRawForToolScan(streamBuffer);
                        if (config.streamingEnabled && config.showThinking) {
                            reporter.setStream(cleanAiReply(streamBuffer));
                        }
                    } catch (_error) {
                        // 忽略
                    }
                }
            }
        ) as any;

        const rawReply = firstNonBlank(asText(sendResult?.aiResponse), streamBuffer);
        const replyText = cleanAiReply(rawReply);
        if (!replyText) {
            throw new Error("AI 返回了空回复");
        }

        reporter.setStream("");
        if (chunkCount > 0) {
            reporter.append(ProgressText.thinkingDone(Date.now() - startedAt));
        }
        reporter.setFooter(ProgressText.stats({
            totalMs: Date.now() - startedAt,
            toolCount: turn.toolCount,
            charCount: replyText.length,
            showStats: config.showStats
        }));

        activeTurn = null;
        await reporter.finish();
        await sleep(120);

        const style = asText(config.replyStyle).trim().toLowerCase() || "auto";
        const threshold = Math.max(200, config.collapseThreshold);
        const detailTitle = style === "full" ? "" : asText(config.detailTitle).trim();

        let html: string;
        if (style === "full" || !detailTitle) {
            html = buildFinalReply(replyText, { collapseThreshold: 999999, detailTitle: "" });
        } else if (config.includeDetail) {
            html = buildFinalReply(replyText, { collapseThreshold: threshold, detailTitle });
        } else {
            html = buildFinalReply(truncateSafe(replyText, threshold), {
                collapseThreshold: 999999,
                detailTitle: ""
            });
        }

        const maxChars = Math.max(200, config.maxReplyChars);
        const plainPieces = config.splitLongReplies
            ? splitPlainText(replyText, maxChars)
            : [replyText];

        for (let index = 0; index < plainPieces.length; index += 1) {
            const isFirst = index === 0;
            const isOnly = plainPieces.length === 1;
            const payload = isOnly
                ? html
                : buildFinalReply(plainPieces[index], { collapseThreshold: 999999, detailTitle: "" });

            let result = await tgSendMessage(token, tgChatId, payload, {
                replyToMessageId: config.replyToMessage && isFirst && parsed.messageId > 0
                    ? parsed.messageId
                    : undefined,
                disableNotification: config.silentSend,
                parseMode: "HTML"
            });

            if (!result.ok) {
                result = await tgSendMessage(token, tgChatId, isOnly ? replyText : plainPieces[index], {
                    replyToMessageId: config.replyToMessage && isFirst && parsed.messageId > 0
                        ? parsed.messageId
                        : undefined,
                    disableNotification: config.silentSend
                });
            }

            if (!result.ok) {
                throw new Error(`发送回复失败：${result.error}`);
            }
        }

        await touchBindingAsync(
            config,
            parsed.chat,
            parsed.fromId,
            operitChatId,
            parsed.messageId
        );

        deletedProgress = await reporter.cleanup(config.deleteProgressAfterReply);

        return {
            ok: true,
            chatId: operitChatId,
            replyText,
            durationMs: Date.now() - startedAt,
            deletedProgress,
            error: ""
        };
    } catch (error: unknown) {
        const message = safeErrorMessage(error);
        activeTurn = null;

        try {
            reporter.append(`⚠️ 处理失败：${truncateSafe(message, 300)}`);
            await reporter.finish();
        } catch (_error) {
            // 忽略
        }

        await reporter.cleanup(!config.keepProgressOnError);

        try {
            await tgSendMessage(token, tgChatId, `⚠️ 处理失败：${truncateSafe(message, 600)}`, {
                replyToMessageId: config.replyToMessage && parsed.messageId > 0 ? parsed.messageId : undefined,
                disableNotification: config.silentSend
            });
        } catch (_error) {
            // 忽略
        }

        return {
            ok: false,
            chatId: operitChatId,
            replyText: "",
            durationMs: Date.now() - startedAt,
            deletedProgress,
            error: message
        };
    }
}

// ---------------------------------------------------------------------------
// 内置命令
// ---------------------------------------------------------------------------

function buildHelpText(botName: string): string {
    return [
        `${botName} · Operit Telegram 桥接`,
        "",
        "直接发送文字即可唤醒 Operit 处理。",
        "",
        "可用命令：",
        "/start  查看帮助",
        "/status  查看桥接状态",
        "/reset  解除本会话与 Operit 对话的绑定",
        "/help  查看帮助"
    ].join("\n");
}

async function buildStatusTextAsync(): Promise<string> {
    const state = await readRuntimeStateAsync();
    const bindingCount = Object.keys(state.bindings).length;
    return [
        "桥接状态",
        `运行中：${bridge.running ? "是" : "否"}`,
        `Bot：${firstNonBlank(bridge.botUsername, "(未知)")}`,
        `已处理：${state.processedTotal} 条`,
        `失败：${state.failedTotal} 条`,
        `已绑定会话：${bindingCount} 个`,
        `最近轮询：${firstNonBlank(state.lastPollAt, "-")}`,
        state.lastError ? `最近错误：${truncateSafe(state.lastError, 200)}` : ""
    ].filter((line) => !!line).join("\n");
}

async function handleCommandAsync(
    token: string,
    parsed: ParsedMessage,
    config: TgConfig
): Promise<boolean> {
    const command = parsed.command;
    if (!command || !config.commandsEnabled) {
        return false;
    }

    if (command === "start" || command === "help") {
        await tgSendMessage(token, parsed.chat.id, buildHelpText(bridge.botName), {
            replyToMessageId: parsed.messageId,
            disableNotification: config.silentSend
        });
        return true;
    }

    if (command === "status") {
        await tgSendMessage(token, parsed.chat.id, await buildStatusTextAsync(), {
            replyToMessageId: parsed.messageId,
            disableNotification: config.silentSend
        });
        return true;
    }

    if (command === "reset") {
        const key = buildBindingKey(config, parsed.chat, parsed.fromId);
        await removeBindingAsync(key);
        await tgSendMessage(token, parsed.chat.id, "已解除绑定，下一条消息将创建新的 Operit 对话。", {
            replyToMessageId: parsed.messageId,
            disableNotification: config.silentSend
        });
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// 轮询主循环
// ---------------------------------------------------------------------------

async function processOneUpdateAsync(
    token: string,
    update: JsonObject,
    config: TgConfig
): Promise<void> {
    const parsed = parseUpdate(update);
    if (!parsed) {
        return;
    }

    if (await hasSeenUpdateIdAsync(parsed.updateId)) {
        return;
    }
    await rememberUpdateIdAsync(parsed.updateId);

    if (await handleCommandAsync(token, parsed, config)) {
        return;
    }

    const gate = shouldHandle(parsed, config);
    if (!gate.ok) {
        return;
    }

    const outcome = await handleMessageAsync(token, parsed, config);
    const state = await readRuntimeStateAsync();
    if (outcome.ok) {
        await writeRuntimeStateAsync({
            processedTotal: state.processedTotal + 1,
            lastError: ""
        });
    } else {
        await writeRuntimeStateAsync({
            failedTotal: state.failedTotal + 1,
            lastError: outcome.error
        });
    }
}

async function pollLoopAsync(token: string, loopToken: number): Promise<void> {
    let consecutiveErrors = 0;

    while (bridge.running && bridge.loopToken === loopToken) {
        let updates: any[] = [];
        let config: TgConfig;
        try {
            config = await readConfigAsync();
        } catch (_error) {
            await sleep(3000);
            continue;
        }

        try {
            const state = await readRuntimeStateAsync();
            const offset = Number(state.updateOffset) || 0;

            const result = await tgGetUpdates(token, offset, config.longPollSeconds);
            await writeRuntimeStateAsync({
                lastPollAt: new Date().toISOString()
            });

            if (!result.ok) {
                throw new Error(result.error || "getUpdates 失败");
            }

            updates = Array.isArray(result.result) ? result.result : [];
            consecutiveErrors = 0;
        } catch (error: unknown) {
            consecutiveErrors += 1;
            const message = safeErrorMessage(error);
            await writeRuntimeStateAsync({ lastError: message });
            console.error(`[telegram_bridge] poll error: ${message}`);
            const cap = Math.max(3000, config.maxBackoffMs);
            const backoff = Math.min(cap, 1000 * Math.pow(2, Math.min(consecutiveErrors, 5)));
            await sleep(backoff);
            continue;
        }

        for (let index = 0; index < updates.length; index += 1) {
            if (!bridge.running || bridge.loopToken !== loopToken) {
                break;
            }
            const update = updates[index];
            const updateId = Number(update?.update_id);
            if (isFinite(updateId)) {
                await writeRuntimeStateAsync({ updateOffset: updateId + 1 });
            }

            const freshConfig = await readConfigAsync();
            if (!freshConfig.enabled) {
                break;
            }

            try {
                await processOneUpdateAsync(token, update as JsonObject, freshConfig);
            } catch (error: unknown) {
                console.error(`[telegram_bridge] process error: ${safeErrorMessage(error)}`);
            }
        }
    }

    bridge.running = false;
    await writeRuntimeStateAsync({ running: false });
}

// ---------------------------------------------------------------------------
// 对外控制
// ---------------------------------------------------------------------------

export async function startBridgeAsync(
    botName?: string,
    botUsername?: string,
    botId?: number
): Promise<JsonObject> {
    // 先记录“希望运行”意图，即使本轮启动失败，看门狗也会持续重试
    try {
        await writeRuntimeStateAsync({ desiredRunning: true });
    } catch (_error) {
        // 忽略
    }

    if (bridge.running) {
        return {
            started: false,
            alreadyRunning: true,
            message: "监听已在运行"
        };
    }

    const token = await readBotTokenAsync();
    if (!token) {
        throw new Error("未配置 Bot Token，请先在设置中填写");
    }

    const config = await readConfigAsync();
    if (!config.enabled) {
        throw new Error("Telegram 桥接未启用（enabled=false）");
    }

    if (botName) {
        bridge.botName = botName;
    }
    if (botUsername) {
        bridge.botUsername = botUsername;
    }
    if (botId) {
        bridge.botId = botId;
    }

    bridge.loopToken += 1;
    const loopToken = bridge.loopToken;
    bridge.running = true;

    await writeRuntimeStateAsync({
        running: true,
        startedAt: new Date().toISOString(),
        lastError: ""
    });

    void pollLoopAsync(token, loopToken);

    return {
        started: true,
        botName: bridge.botName,
        botUsername: bridge.botUsername
    };
}

export async function stopBridgeAsync(): Promise<JsonObject> {
    // 清除“希望运行”意图，看门狗不再自动拉起
    try {
        await writeRuntimeStateAsync({ desiredRunning: false });
    } catch (_error) {
        // 忽略
    }
    if (!bridge.running) {
        return { stopped: false, alreadyStopped: true };
    }
    bridge.running = false;
    bridge.loopToken += 1;
    activeTurn = null;
    await writeRuntimeStateAsync({ running: false });
    return { stopped: true };
}

// ---------------------------------------------------------------------------
// 看门狗：解决“工具沙盒销毁后循环随之死亡”的问题
// ---------------------------------------------------------------------------

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** 单次自愈尝试：若配置允许且当前没在跑，就拉起来 */
async function watchdogTickAsync(): Promise<void> {
    try {
        if (bridge.running) {
            return;
        }
        const config = await readConfigAsync();
        if (!config.enabled) {
            return;
        }
        const state = await readRuntimeStateAsync();
        // 只有用户/自启动明确表达过“要运行”时才自愈，
        // 避免用户主动 stop 之后被强行拉起。
        if (!state.desiredRunning) {
            return;
        }
        const token = await readBotTokenAsync();
        if (!token) {
            return;
        }
        console.log("[telegram_bridge] watchdog restarting poll loop");
        await startBridgeAsync();
    } catch (error: unknown) {
        console.error(`[telegram_bridge] watchdog failed: ${safeErrorMessage(error)}`);
    }
}

/**
 * 启动看门狗。
 * 必须由 main 上下文调用，因为子包工具沙盒在工具返回后会被销毁。
 */
export function ensureWatchdogAsync(): JsonObject {
    if (watchdogTimer) {
        return { started: false, alreadyRunning: true };
    }
    // 每 5 秒检查一次，开销极低（只读本地状态，不碰网络）
    watchdogTimer = setInterval(() => {
        void watchdogTickAsync();
    }, 5000);
    console.log("[telegram_bridge] watchdog started");
    return { started: true };
}

export function stopWatchdog(): JsonObject {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
        console.log("[telegram_bridge] watchdog stopped");
        return { stopped: true };
    }
    return { stopped: false };
}

export async function ensureBridgeStartedAsync(): Promise<JsonObject> {
    try {
        const config = await readConfigAsync();
        if (!config.enabled || !config.autoStart) {
            return { started: false, reason: "disabled" };
        }
        if (bridge.running) {
            return { started: false, reason: "already_running" };
        }
        return await startBridgeAsync();
    } catch (error: unknown) {
        console.error(`[telegram_bridge] ensure start failed: ${safeErrorMessage(error)}`);
        return { started: false, reason: safeErrorMessage(error) };
    }
}

export async function sendTextToChatAsync(
    chatId: string | number,
    text: string
): Promise<JsonObject> {
    const token = await readBotTokenAsync();
    if (!token) {
        throw new Error("未配置 Bot Token");
    }
    const config = await readConfigAsync();
    const result = await tgSendMessage(token, chatId, text, {
        disableNotification: config.silentSend
    });
    if (!result.ok) {
        throw new Error(result.error || "发送失败");
    }
    return {
        success: true,
        chatId: String(chatId),
        messageId: Number(result.result?.message_id) || 0
    };
}