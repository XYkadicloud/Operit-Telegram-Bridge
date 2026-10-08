/**
 * Telegram Bridge - 输出格式化
 *
 * 1. HTML 转义与折叠卡片（<blockquote expandable>）
 * 2. 清洗 AI 回复里残留的工具 XML
 */

import { asText, truncateSafe } from "./tg_common";

/** Telegram HTML parse_mode 只允许这几种标签，其余必须转义 */
export function escapeHtml(value: string): string {
    return asText(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * 折叠卡片。
 * Telegram 的 <blockquote expandable> 默认只显示前几行，点击展开。
 */
export function collapsible(summary: string, body: string): string {
    const head = escapeHtml(summary);
    const content = escapeHtml(body);
    if (!content.trim()) {
        return `<b>${head}</b>`;
    }
    return `<b>${head}</b>\n<blockquote expandable>${content}</blockquote>`;
}

/**
 * 清洗 AI 回复中残留的工具调用 XML。
 *
 * 这些内容本该由宿主剥离，但流式聚合时可能漏出来，
 * 直接发到 Telegram 会非常难看（而且很长）。
 */
export function cleanAiReply(raw: string): string {
    let text = asText(raw);

    // 成对标签整体移除（含内容），只保留最终回答
    const pairedTags = [
        "tool_result_[A-Za-z0-9]*",
        "tool_call_[A-Za-z0-9]*",
        "tool_[A-Za-z0-9]*",
        "param",
        "think",
        "thinking",
        "reasoning",
        "tool_use",
        "function_call"
    ];
    pairedTags.forEach((tag) => {
        const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag.replace("[A-Za-z0-9]*", "[A-Za-z0-9]*")}>`, "gi");
        text = text.replace(pattern, "");
    });

    // 自闭合 / 单标签移除
    text = text.replace(/<[A-Za-z_][A-Za-z0-9_:-]*(?:\s[^>]*)?\/>/g, "");

    // 残留的孤立开/闭标签（如 </tool_4JFb>）
    text = text.replace(/<\/?[A-Za-z_][A-Za-z0-9_:-]*(?:\s[^>]*)?>/g, "");

    // 压缩过多空行
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");

    return text.trim();
}

/** 折叠卡片的标题行：工具名 + 状态 */
export function toolCardTitle(toolName: string, state: string): string {
    return `🔧 ${toolName} ${state}`.trim();
}

/** 判断文本是否值得折叠（太短就不折了） */
export function shouldCollapse(text: string, threshold = 200): boolean {
    return asText(text).length > threshold;
}

/**
 * 把长文本压成「折叠卡片」；短文本原样返回。
 */
export function asCollapsibleBlock(summary: string, body: string, threshold = 200): string {
    const content = asText(body);
    if (!content.trim()) {
        return `<b>${escapeHtml(summary)}</b>`;
    }
    if (!shouldCollapse(content, threshold)) {
        return `<b>${escapeHtml(summary)}</b>\n${escapeHtml(content)}`;
    }
    return collapsible(summary, content);
}

/**
 * 把最终回复拆成「正文 + 可折叠的细节」。
 *
 * 正文只保留前面的结论部分，后面超长的明细塞进折叠块，
 * 这样聊天页面不会被一整屏文字占满。
 */
export function buildFinalReply(
    reply: string,
    options: {
        collapseThreshold: number;
        /** 折叠块标题，留空则不折叠 */
        detailTitle: string;
    }
): string {
    const text = asText(reply).trim();
    if (!text) {
        return "";
    }

    const threshold = Math.max(200, options.collapseThreshold);
    if (text.length <= threshold || !options.detailTitle) {
        return escapeHtml(text);
    }

    // 优先在换行处切分，尽量不破坏句子
    let cut = text.lastIndexOf("\n\n", threshold);
    if (cut < threshold * 0.4) {
        cut = text.lastIndexOf("\n", threshold);
    }
    if (cut < threshold * 0.4) {
        cut = threshold;
    }

    const head = truncateSafe(text.slice(0, cut).trim(), threshold);
    const rest = text.slice(cut).trim();
    if (!rest) {
        return escapeHtml(head);
    }

    return `${escapeHtml(head)}\n\n<blockquote expandable><b>${escapeHtml(options.detailTitle)}</b>\n${escapeHtml(rest)}</blockquote>`;
}

/** 只保留尾部若干字符，避免进度消息无限增长 */
export function clampTail(text: string, maxChars: number): string {
    const value = asText(text);
    if (value.length <= maxChars) {
        return value;
    }
    const head = "…\n";
    return head + value.slice(value.length - maxChars + head.length);
}

// ---------------------------------------------------------------------------
// 从流式内容里解析工具调用
// ---------------------------------------------------------------------------

export type ParsedToolCall = {
    /** 工具名 */
    name: string;
    /** 参数明细（多行文本） */
    detail: string;
    /** 该工具调用是否已闭合 */
    closed: boolean;
};

/**
 * 从 AI 流式输出中提取工具调用。
 *
 * 宿主在流式聚合时可能把工具调用 XML 一并吐出来，形如：
 *   <tool_xxxx name="query_memory">
 *     <param name="query">待办</param>
 *   </tool_xxxx>
 *   <tool_result_yyyy name="query_memory" status="success">…</tool_result_yyyy>
 *
 * 这里把它们抽出来单独渲染成折叠卡片，正文里不再重复显示。
 */
export function extractToolCalls(raw: string): {
    calls: ParsedToolCall[];
    /** 去掉工具 XML 后的正文 */
    body: string;
} {
    const text = asText(raw);
    const calls: ParsedToolCall[] = [];

    // 1) 工具调用块：<tool_xxx ...>...</tool_xxx> 或自闭合
    const openTagPattern = /<(tool_[A-Za-z0-9_]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let body = text.replace(openTagPattern, (match, tagName, attrs, inner) => {
        const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(attrs || "");
        const toolName = (nameMatch && nameMatch[1]) || String(tagName);
        const params = extractParams(inner);
        calls.push({
            name: toolName,
            detail: params,
            closed: true
        });
        return "";
    });

    // 2) 工具结果块：<tool_result_xxx ...>...</tool_result_xxx>
    body = body.replace(
        /<(tool_result_[A-Za-z0-9_]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
        (match, tagName, attrs, inner) => {
            const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(attrs || "");
            const statusMatch = /status\s*=\s*"([^"]*)"/i.exec(attrs || "");
            const toolName = (nameMatch && nameMatch[1]) || String(tagName).replace(/^tool_result_/, "");
            const status = (statusMatch && statusMatch[1]) || "";
            const mark = status === "success" ? "✅" : (status ? "❌" : "");
            // 结果内容可能很长，只留摘要
            const preview = truncateSafe(asText(inner).replace(/\s+/g, " ").trim(), 400);
            calls.push({
                name: `${mark} ${toolName} 结果`.trim(),
                detail: preview,
                closed: true
            });
            return "";
        }
    );

    // 3) 未闭合的工具调用（流式进行中）
    const pendingPattern = /<(tool_[A-Za-z0-9_]*)\b([^>]*)>([\s\S]*)$/i;
    const pending = pendingPattern.exec(body);
    if (pending) {
        const attrs = pending[2] || "";
        const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(attrs);
        const toolName = (nameMatch && nameMatch[1]) || String(pending[1]);
        calls.push({
            name: `🔧 ${toolName}`,
            detail: extractParams(pending[3] || ""),
            closed: false
        });
        body = body.slice(0, pending.index);
    }

    return {
        calls,
        body: body.trim()
    };
}

/** 从工具块内部抽取 <param name="x">y</param> 明细 */
function extractParams(inner: string): string {
    const lines: string[] = [];
    const paramPattern = /<param\b([^>]*)>([\s\S]*?)<\/param>/gi;
    let match: RegExpExecArray | null = paramPattern.exec(inner);
    while (match) {
        const attrs = match[1] || "";
        const value = asText(match[2]).trim();
        const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(attrs);
        const key = (nameMatch && nameMatch[1]) || "param";
        if (value) {
            lines.push(`${key}: ${truncateSafe(value.replace(/\s+/g, " "), 200)}`);
        }
        match = paramPattern.exec(inner);
    }
    if (lines.length === 0) {
        // 没有 param 结构，退化成原始文本摘要
        const fallback = asText(inner).replace(/\s+/g, " ").trim();
        if (fallback) {
            lines.push(truncateSafe(fallback, 300));
        }
    }
    return lines.join("\n");
}