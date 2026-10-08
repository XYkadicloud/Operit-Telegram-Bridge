/**
 * Telegram Bridge - 公共工具与常量
 */

export const TG_TOOLPKG_ID = "com.operit.telegram_bridge";
export const PACKAGE_VERSION = "0.1.0";
export const CONFIG_FILE_NAME = "config.json";
export const STATE_FILE_NAME = "state.json";

export const API_BASE_URL = "https://api.telegram.org";
export const FILE_BASE_URL = "https://api.telegram.org/file/bot";

export const ENV_KEYS = {
    botToken: "TELEGRAM_BOT_TOKEN"
};

export const DEFAULT_LONG_POLL_SECONDS = 30;
export const DEFAULT_AI_TIMEOUT_MS = 600000;
export const DEFAULT_HTTP_TIMEOUT_MS = 45000;
export const PROGRESS_EDIT_MIN_INTERVAL_MS = 1200;
export const PROGRESS_MAX_CHARS = 3600;
export const DEFAULT_MAX_CONCURRENCY = 3;

export type JsonObject = { [key: string]: any };

export function asText(value: unknown): string {
    if (value == null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return "";
    }
}

export function hasOwn(target: unknown, key: string): boolean {
    return !!target && typeof target === "object" && Object.prototype.hasOwnProperty.call(target, key);
}

export function isObject(value: unknown): boolean {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

export function firstNonBlank(...values: unknown[]): string {
    for (let index = 0; index < values.length; index += 1) {
        const text = asText(values[index]).trim();
        if (text) {
            return text;
        }
    }
    return "";
}

export function toBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "yes") {
            return true;
        }
        if (normalized === "false" || normalized === "0" || normalized === "no") {
            return false;
        }
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    return fallback;
}

export function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "yes") {
            return true;
        }
        if (normalized === "false" || normalized === "0" || normalized === "no") {
            return false;
        }
    }
    throw new Error(`Invalid boolean for ${fieldName}: ${asText(value)}`);
}

export function parsePositiveInt(value: unknown, fieldName: string, fallback: number): number {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = Number(value);
    if (!isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid positive integer for ${fieldName}: ${asText(value)}`);
    }
    return Math.floor(parsed);
}

export function parseJsonObject(raw: string): JsonObject {
    const trimmed = asText(raw).trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed);
        return isObject(parsed) ? parsed as JsonObject : {};
    } catch (_error) {
        return {};
    }
}

export function safeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || String(error);
    }
    return asText(error);
}

export function maskSecret(value: string): string {
    const text = asText(value).trim();
    if (!text) {
        return "";
    }
    if (text.length <= 8) {
        return "****";
    }
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

export function escapeXml(value: string): string {
    return asText(value)
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/\x22/g, "&" + "quot;")
        .replace(/'/g, "&" + "apos;");
}

export function hashText(value: string): string {
    let hash = 0;
    const text = asText(value);
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(16);
}

export function sanitizePathSegment(value: string, fallback: string): string {
    const normalized = asText(value)
        .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "_")
        .replace(/\s+/g, "_")
        .trim()
        .replace(/^_+|_+$/g, "");
    return normalized || fallback;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 按 UTF-16 安全截断，避免把 emoji/代理对切断 */
export function truncateSafe(text: string, maxChars: number): string {
    const value = asText(text);
    if (value.length <= maxChars) {
        return value;
    }
    let cut = value.slice(0, maxChars);
    const lastCode = cut.charCodeAt(cut.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        cut = cut.slice(0, -1);
    }
    return cut;
}

/** 只保留尾部若干行，防止进度消息超过 Telegram 4096 限制 */
export function tailLines(text: string, maxChars: number): string {
    const value = asText(text);
    if (value.length <= maxChars) {
        return value;
    }
    const lines = value.split("\n");
    const kept: string[] = [];
    let total = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (total + line.length + 1 > maxChars) {
            break;
        }
        kept.unshift(line);
        total += line.length + 1;
    }
    return kept.join("\n");
}

export function formatDuration(ms: number): string {
    if (!isFinite(ms) || ms < 0) {
        return "0ms";
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}
