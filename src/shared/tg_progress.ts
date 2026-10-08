/**
 * Telegram Bridge - 进度消息管理器
 *
 * 设计要点：
 *  1. 用 HTML parse_mode 发送，工具调用渲染成「可展开折叠卡片」
 *     （Telegram 的 <blockquote expandable>），避免刷屏
 *  2. 对 editMessageText 做节流，避免触发限流
 *  3. 超过长度上限时按整块裁剪，保证 HTML 标签闭合
 *  4. 回复完成后按配置删除进度消息
 */

import {
    PROGRESS_MAX_CHARS,
    asText,
    formatDuration,
    truncateSafe
} from "./tg_common";
import { escapeHtml, extractToolCalls } from "./tg_format";
import { tgDeleteMessage, tgEditMessageText, tgSendMessage } from "./tg_api";

export type ProgressOptions = {
    showThinking: boolean;
    showToolCalls: boolean;
    showToolParams: boolean;
    showToolDuration: boolean;
    showStats: boolean;
    showModel: boolean;
    showTimestamps: boolean;
    /** 工具卡片折叠阈值：正文超过这个长度才折叠 */
    collapseThreshold: number;
    maxChars: number;
    editIntervalMs: number;
    mode: string;
    title: string;
};

export function buildDefaultProgressOptions(): ProgressOptions {
    return {
        showThinking: true,
        showToolCalls: true,
        showToolParams: true,
        showToolDuration: true,
        showStats: true,
        showModel: false,
        showTimestamps: false,
        collapseThreshold: 200,
        maxChars: PROGRESS_MAX_CHARS,
        editIntervalMs: 1200,
        mode: "single",
        title: "Operit"
    };
}

/** 一个可渲染的块 */
type Block =
    | { kind: "text"; text: string }
    | { kind: "tool"; title: string; detail: string; folded: boolean };

function timestampPrefix(show: boolean): string {
    if (!show) {
        return "";
    }
    const now = new Date();
    const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] `;
}

export class TgProgressReporter {
    private token: string;
    private chatId: string | number;
    private replyToMessageId?: number;
    private options: ProgressOptions;

    /** 事件块（工具卡片等，append-only） */
    private blocks: Block[] = [];
    /** 从流式内容解析出的工具事件（整体替换） */
    private toolEvents: Array<{ name: string; detail: string; ok: boolean }> = [];
    /** 流式正文（整体替换，不折叠） */
    private streamText = "";
    /** 页脚统计 */
    private footerText = "";

    private currentMessageId = 0;
    private sentMessageIds: number[] = [];
    /** 工具标题 -> 块索引，用于原地更新 */
    private toolBlockIndex: Record<string, number> = Object.create(null);

    private lastEditAt = 0;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing = false;
    private dirty = false;
    private disposed = false;
    /** HTML 连续失败次数；达到阈值后本轮降级为纯文本，下一轮自动恢复 */
    private htmlFailCount = 0;

    constructor(
        token: string,
        chatId: string | number,
        replyToMessageId?: number,
        options?: Partial<ProgressOptions>
    ) {
        this.token = token;
        this.chatId = chatId;
        this.replyToMessageId = replyToMessageId;
        this.options = {
            ...buildDefaultProgressOptions(),
            ...(options || {})
        };
    }

    get messageIds(): number[] {
        return this.sentMessageIds.slice();
    }

    /** 追加纯文本行 */
    append(text: string): void {
        if (this.disposed) {
            return;
        }
        const value = asText(text);
        if (!value) {
            return;
        }
        this.blocks.push({ kind: "text", text: value });
        this.dirty = true;
        this.scheduleFlush();
    }

    /**
     * 记录一次工具调用（折叠卡片）。
     * @param toolKey 用于原地更新的键（同一工具重复调用时复用）
     */
    upsertToolCard(
        toolKey: string,
        title: string,
        detail: string,
        folded: boolean
    ): void {
        if (this.disposed || !this.options.showToolCalls) {
            return;
        }
        const index = this.toolBlockIndex[toolKey];
        const block: Block = {
            kind: "tool",
            title: asText(title),
            detail: asText(detail),
            folded: folded && this.options.showToolParams
        };

        if (index === undefined) {
            this.toolBlockIndex[toolKey] = this.blocks.length;
            this.blocks.push(block);
        } else {
            this.blocks[index] = block;
        }
        this.dirty = true;
        this.scheduleFlush();
    }

    /** 覆盖流式正文 */
    setStream(text: string): void {
        if (this.disposed || !this.options.showThinking) {
            return;
        }
        const value = asText(text);
        if (value === this.streamText) {
            return;
        }
        this.streamText = value;
        this.dirty = true;
        this.scheduleFlush();
    }

    /**
     * 从流式原文里扫描工具调用，渲染成折叠卡片。
     *
     * 工具生命周期钩子已禁用（它曾三次锁死工具通道），
     * 改为从流式内容里解析，效果等价且无副作用。
     */
    setRawForToolScan(raw: string): void {
        if (this.disposed || !this.options.showToolCalls) {
            return;
        }
        const parsed = extractToolCalls(asText(raw));
        parsed.calls.forEach((call, index) => {
            this.upsertToolCard(
                `scan:${index}:${call.name}`,
                call.closed ? call.name : `🔧 ${call.name}`,
                call.detail,
                this.options.showToolParams
            );
        });
    }

        setFooter(text: string): void {
        if (this.disposed) {
            return;
        }
        this.footerText = asText(text);
        this.dirty = true;
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.disposed) {
            return;
        }
        const interval = Math.max(300, this.options.editIntervalMs);
        const elapsed = Date.now() - this.lastEditAt;
        if (elapsed >= interval) {
            void this.flush();
            return;
        }
        if (this.pendingTimer) {
            return;
        }
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            void this.flush();
        }, interval - elapsed);
    }

    async flush(force = false): Promise<void> {
        if (this.disposed && !force) {
            return;
        }
        if (this.flushing) {
            this.dirty = true;
            return;
        }
        if (!this.dirty && !force) {
            return;
        }

        this.flushing = true;
        this.dirty = false;
        try {
            await this.syncNow();
        } catch (_error) {
            // 进度显示失败不应影响主流程
        } finally {
            this.flushing = false;
            if (this.dirty && !this.disposed) {
                this.scheduleFlush();
            }
        }
    }

    /** 渲染单个块 */
    private renderBlock(block: Block): string {
        if (block.kind === "text") {
            return escapeHtml(block.text);
        }
        const title = `<b>${escapeHtml(block.title)}</b>`;
        if (!block.detail.trim()) {
            return title;
        }
        if (block.folded) {
            return `${title}\n<blockquote expandable>${escapeHtml(block.detail)}</blockquote>`;
        }
        return `${title}\n${escapeHtml(block.detail)}`;
    }

    /** 纯文本降级渲染 */
    private renderBlockPlain(block: Block): string {
        if (block.kind === "text") {
            return block.text;
        }
        if (!block.detail.trim()) {
            return block.title;
        }
        return `${block.title}\n${block.detail}`;
    }

    private composeBlocks(plain: boolean): string[] {
        const parts: string[] = [];
        if (this.streamText.trim()) {
            parts.push(plain ? this.streamText.trim() : escapeHtml(this.streamText.trim()));
        }
        // 解析出的工具事件 → 折叠卡片
        if (this.options.showToolCalls) {
            this.toolEvents.forEach((item) => {
                const mark = item.ok ? "✅" : "❌";
                const title = `<b>${mark} ${escapeHtml(item.name)}</b>`;
                if (!item.detail.trim()) {
                    parts.push(plain ? `${mark} ${item.name}` : title);
                    return;
                }
                if (plain || !this.options.showToolParams) {
                    parts.push(`${mark} ${item.name}`);
                    return;
                }
                parts.push(`${title}\n<blockquote expandable>${escapeHtml(item.detail)}</blockquote>`);
            });
        }
        this.blocks.forEach((block) => {
            parts.push(plain ? this.renderBlockPlain(block) : this.renderBlock(block));
        });
        if (this.footerText.trim()) {
            parts.push(plain ? this.footerText.trim() : escapeHtml(this.footerText.trim()));
        }
        return parts;
    }

    /**
     * 按块裁剪，保证不会把 HTML 标签切断。
     * 优先保留最新的块。
     */
    private renderPayload(plain: boolean): string {
        const max = Math.max(500, this.options.maxChars);
        const parts = this.composeBlocks(plain);
        let text = parts.join("\n\n");
        if (text.length <= max) {
            return text;
        }

        // 从后往前保留整块
        const kept: string[] = [];
        let total = 0;
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (total + part.length + 2 > max - 20) {
                break;
            }
            kept.unshift(part);
            total += part.length + 2;
        }
        const omittedNote = plain ? "…（已省略较早内容）" : "<i>…（已省略较早内容）</i>";
        return `${omittedNote}\n\n${kept.join("\n\n")}`;
    }

    private async syncNow(): Promise<void> {
        // 连续失败 2 次才降级，成功一次即恢复
        const useHtml = this.htmlFailCount < 2;
        const parseMode = useHtml ? "HTML" : undefined;
        const payload = this.renderPayload(!useHtml);
        if (!payload) {
            return;
        }

        if (!this.currentMessageId) {
            const sent = await tgSendMessage(this.token, this.chatId, payload, {
                replyToMessageId: this.replyToMessageId,
                parseMode
            });
            if (sent.ok) {
                this.htmlFailCount = 0;
                const messageId = Number(sent.result?.message_id) || 0;
                if (messageId > 0) {
                    this.currentMessageId = messageId;
                    this.sentMessageIds.push(messageId);
                    this.lastEditAt = Date.now();
                }
                return;
            }

            // HTML 被拒（例如标签不合法）→ 降级纯文本重试一次
            if (useHtml && this.looksLikeParseError(sent.description)) {
                this.htmlFailCount += 1;
                const plainPayload = this.renderPayload(true);
                const retry = await tgSendMessage(this.token, this.chatId, plainPayload, {
                    replyToMessageId: this.replyToMessageId
                });
                if (retry.ok) {
                    const messageId = Number(retry.result?.message_id) || 0;
                    if (messageId > 0) {
                        this.currentMessageId = messageId;
                        this.sentMessageIds.push(messageId);
                        this.lastEditAt = Date.now();
                    }
                }
            }
            return;
        }

        const edited = await tgEditMessageText(
            this.token,
            this.chatId,
            this.currentMessageId,
            payload,
            parseMode
        );
        if (edited.ok) {
            this.htmlFailCount = 0;
            this.lastEditAt = Date.now();
            return;
        }

        const description = asText(edited.description).toLowerCase();
        if (description.indexOf("message is not modified") >= 0) {
            this.lastEditAt = Date.now();
            return;
        }
        if (useHtml && this.looksLikeParseError(edited.description)) {
            this.htmlFailCount += 1;
            return;
        }
        // 其他错误（消息被删等）→ 下轮另起一条
        this.currentMessageId = 0;
    }

    private looksLikeParseError(description: string): boolean {
        const text = asText(description).toLowerCase();
        return text.indexOf("parse") >= 0
            || text.indexOf("entit") >= 0
            || text.indexOf("can't find end tag") >= 0
            || text.indexOf("unsupported start tag") >= 0;
    }

    async finish(): Promise<void> {
        await this.flush(true);
    }

    /** 按配置清理进度消息，返回删除条数 */
    async cleanup(deleteMessages: boolean): Promise<number> {
        this.disposed = true;
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }

        const ids = Array.from(new Set(this.sentMessageIds.concat(
            this.currentMessageId > 0 ? [this.currentMessageId] : []
        ))).filter((id) => id > 0);

        if (!deleteMessages || ids.length === 0) {
            return 0;
        }

        let deleted = 0;
        for (let index = 0; index < ids.length; index += 1) {
            const result = await tgDeleteMessage(this.token, this.chatId, ids[index]);
            if (result.ok) {
                deleted += 1;
            }
        }
        return deleted;
    }
}

/** 进度行文案 */
export const ProgressText = {
    header(title: string): string {
        return `🤖 ${title} 处理中…`;
    },

    /** 工具开始：返回标题 + 详情，供折叠卡片使用 */
    toolStart(toolName: string, parameters?: Record<string, any>): {
        title: string;
        detail: string;
    } {
        return {
            title: `🔧 ${toolName}`,
            detail: ProgressText.previewParams(parameters)
        };
    },

    toolDone(
        toolName: string,
        success: boolean,
        durationMs: number,
        showDuration: boolean
    ): string {
        const mark = success ? "✅" : "❌";
        if (!showDuration) {
            return `${mark} ${toolName}`;
        }
        return `${mark} ${toolName} · ${formatDuration(durationMs)}`;
    },

    toolFailed(toolName: string, errorMessage: string): string {
        const message = truncateSafe(asText(errorMessage), 300);
        return `❌ ${toolName}\n${message}`;
    },

    previewParams(parameters?: Record<string, any>): string {
        if (!parameters || typeof parameters !== "object") {
            return "";
        }
        const keys = Object.keys(parameters);
        if (keys.length === 0) {
            return "";
        }
        const lines: string[] = [];
        for (let index = 0; index < keys.length && index < 8; index += 1) {
            const key = keys[index];
            const raw = asText(parameters[key]).replace(/\s+/g, " ").trim();
            if (!raw) {
                continue;
            }
            lines.push(`${key}: ${truncateSafe(raw, 200)}`);
        }
        return lines.join("\n");
    },

    stats(options: {
        totalMs: number;
        toolCount: number;
        charCount: number;
        showStats?: boolean;
    }): string {
        if (options.showStats === false) {
            return "";
        }
        return `⏱ ${formatDuration(options.totalMs)} · 🔧 ${options.toolCount} · 📝 ${options.charCount} 字`;
    },

    thinkingDone(totalMs: number): string {
        return `🧠 生成完成 · ${formatDuration(totalMs)}`;
    }
};