/**
 * Telegram Bridge - 配置与状态持久化
 *
 * 配置目录来自 getPluginConfigDir(toolpkgId)，随 ToolPkg 一起被管理。
 */

import {
    CONFIG_FILE_NAME,
    ENV_KEYS,
    JsonObject,
    STATE_FILE_NAME,
    TG_TOOLPKG_ID,
    asText,
    hasOwn,
    isObject,
    parseJsonObject,
    toBoolean
} from "./tg_common";

type CachedStoreEntry = {
    loaded: boolean;
    dirty: boolean;
    value: JsonObject;
};

let stateDirectoryPathCache = "";
const cachedStores: Record<string, CachedStoreEntry> = Object.create(null);

function cloneJsonObject(value: JsonObject): JsonObject {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function normalizeStorePath(path: string): string {
    return asText(path).trim().replace(/\\/g, "/");
}

function getCachedStoreEntry(path: string): CachedStoreEntry {
    const normalizedPath = normalizeStorePath(path);
    if (!normalizedPath) {
        throw new Error("State store path is empty");
    }
    if (!cachedStores[normalizedPath]) {
        cachedStores[normalizedPath] = {
            loaded: false,
            dirty: false,
            value: {}
        };
    }
    return cachedStores[normalizedPath];
}

async function readJsonFileAsync(path: string): Promise<JsonObject> {
    try {
        const exists = await Tools.Files.exists(path, "android");
        if (!exists?.exists) {
            return {};
        }
        const result = await Tools.Files.read({ path, environment: "android" });
        return parseJsonObject(asText(result?.content));
    } catch (_error) {
        return {};
    }
}

async function writeJsonFileAsync(path: string, value: JsonObject): Promise<void> {
    await Tools.Files.write(path, JSON.stringify(value), false, "android");
}

async function readCachedStoreAsync(
    path: string,
    sanitize?: (value: JsonObject) => JsonObject
): Promise<JsonObject> {
    const entry = getCachedStoreEntry(path);
    if (!entry.loaded) {
        const raw = await readJsonFileAsync(path);
        const nextValue = sanitize ? sanitize(raw) : raw;
        entry.value = cloneJsonObject(nextValue);
        entry.loaded = true;
        entry.dirty = false;
    }
    return cloneJsonObject(entry.value);
}

async function writeCachedStoreAsync(
    path: string,
    value: JsonObject,
    sanitize?: (value: JsonObject) => JsonObject
): Promise<JsonObject> {
    const entry = getCachedStoreEntry(path);
    const nextValue = sanitize ? sanitize(value) : value;
    entry.value = cloneJsonObject(nextValue);
    entry.loaded = true;
    entry.dirty = true;
    return cloneJsonObject(entry.value);
}

async function flushCachedStoreAsync(path: string): Promise<void> {
    const entry = getCachedStoreEntry(path);
    if (!entry.loaded || !entry.dirty) {
        return;
    }
    await writeJsonFileAsync(path, entry.value);
    entry.dirty = false;
}

export function getStateDirectoryPath(): string {
    if (stateDirectoryPathCache) {
        return stateDirectoryPathCache;
    }
    if (typeof getPluginConfigDir !== "function") {
        throw new Error("getPluginConfigDir is unavailable");
    }
    const path = asText(getPluginConfigDir(TG_TOOLPKG_ID)).trim();
    if (!path) {
        throw new Error(`Failed to resolve plugin config dir for ${TG_TOOLPKG_ID}`);
    }
    stateDirectoryPathCache = path;
    return stateDirectoryPathCache;
}

export function getStateFilePath(name: string): string {
    return `${getStateDirectoryPath()}/${name}`;
}

export function getConfigFilePath(): string {
    return getStateFilePath(CONFIG_FILE_NAME);
}

export function getRuntimeStateFilePath(): string {
    return getStateFilePath(STATE_FILE_NAME);
}

export function readEnv(key: string): string {
    if (typeof getEnv !== "function") {
        return "";
    }
    const value = getEnv(key);
    return value == null ? "" : asText(value).trim();
}

export async function writeEnv(key: string, value: string): Promise<void> {
    await Tools.SoftwareSettings.writeEnvironmentVariable(key, value);
}

// ---------------------------------------------------------------------------
// 配置模型
// ---------------------------------------------------------------------------

export type TgConfig = {
    // ---- Bot 与连接 ----
    /** Bot Token */
    botToken: string;
    /** API 基址（官方或反代） */
    apiBaseUrl: string;
    /** 长轮询秒数 */
    longPollSeconds: number;
    /** 单次 AI 回合超时 */
    aiTimeoutMs: number;
    /** HTTP 请求超时 */
    httpTimeoutMs: number;
    /** 轮询失败退避上限 */
    maxBackoffMs: number;

    // ---- 触发规则 ----
    /** 总开关：是否允许 Telegram 消息唤醒 AI */
    enabled: boolean;
    /** Operit 启动/回前台时自动拉起监听 */
    autoStart: boolean;
    /** 是否响应私聊 */
    privateEnabled: boolean;
    /** 是否响应群聊 */
    groupEnabled: boolean;
    /** 群聊必须 @ 才响应 */
    groupRequireMention: boolean;
    /** 是否响应频道/其他类型 */
    otherChatEnabled: boolean;
    /** 白名单：只响应这些 chat id（逗号分隔，留空=不限制） */
    chatIdAllowList: string;
    /** 是否响应命令（/start /status 等） */
    commandsEnabled: boolean;

    // ---- 显示内容 ----
    /** 流式传输总开关 */
    streamingEnabled: boolean;
    /** 显示思考过程（AI 生成正文） */
    showThinking: boolean;
    /** 显示工具调用 */
    showToolCalls: boolean;
    /** 显示工具参数 */
    showToolParams: boolean;
    /** 显示工具耗时 */
    showToolDuration: boolean;
    /** 显示统计信息 */
    showStats: boolean;
    /** 显示当前模型名 */
    showModel: boolean;
    /** 显示时间戳 */
    showTimestamps: boolean;
    /** 进度消息最大长度 */
    progressMaxChars: number;
    /** 编辑节流间隔（毫秒，防限流） */
    progressEditIntervalMs: number;
    /** 进度消息模式：single=单条持续编辑 / segmented=分段追加 */
    progressMode: string;
    /** 是否显示打字动作（typing） */
    showTypingAction: boolean;

    // ---- 回复与清理 ----
    /** 回复后删除进度消息 */
    deleteProgressAfterReply: boolean;
    /** 失败时保留进度消息 */
    keepProgressOnError: boolean;
    /** 引用原消息回复 */
    replyToMessage: boolean;
    /** 静默发送（不推送通知） */
    silentSend: boolean;
    /** 回复超长时自动分片 */
    splitLongReplies: boolean;
    /** 单条回复最大字符数 */
    maxReplyChars: number;
    /** 回复样式：auto=自动折叠 / short=只发摘要 / full=完整发送 */
    replyStyle: string;
    /** 正文超过多少字符就把细节折叠起来 */
    collapseThreshold: number;
    /** 是否附带可折叠的完整细节 */
    includeDetail: boolean;
    /** 折叠块标题 */
    detailTitle: string;

    // ---- 会话与上下文 ----
    /** 每个 TG 会话独立 Operit 对话 */
    perChatIsolation: boolean;
    /** 群聊里每个人也各开一个对话 */
    perSenderIsolation: boolean;
    /** Operit 对话分组名 */
    chatGroup: string;
    /** 绑定角色卡 ID */
    characterCardId: string;
    /** 附加系统指令 */
    assistantInstruction: string;
    /** 保留 Operit 侧对话记录 */
    persistTurn: boolean;

    // ---- 运行与维护 ----
    /** 最大并发处理数 */
    maxConcurrency: number;
    /** 启动时发送问候 */
    announceOnStart: boolean;
};

export const DEFAULT_CONFIG: TgConfig = {
    botToken: "",
    apiBaseUrl: "https://api.telegram.org",
    longPollSeconds: 30,
    aiTimeoutMs: 600000,
    httpTimeoutMs: 45000,
    maxBackoffMs: 30000,

    enabled: false,
    autoStart: true,
    privateEnabled: true,
    groupEnabled: true,
    groupRequireMention: true,
    otherChatEnabled: false,
    chatIdAllowList: "",
    commandsEnabled: true,

    streamingEnabled: true,
    showThinking: true,
    showToolCalls: true,
    showToolParams: true,
    showToolDuration: true,
    showStats: true,
    showModel: false,
    showTimestamps: false,
    progressMaxChars: 3600,
    progressEditIntervalMs: 1200,
    progressMode: "single",
    showTypingAction: true,

    deleteProgressAfterReply: true,
    keepProgressOnError: true,
    replyToMessage: true,
    silentSend: false,
    splitLongReplies: true,
    maxReplyChars: 4000,
    replyStyle: "auto",
    collapseThreshold: 600,
    includeDetail: true,
    detailTitle: "展开完整内容",

    perChatIsolation: true,
    perSenderIsolation: false,
    chatGroup: "Telegram",
    characterCardId: "",
    assistantInstruction: "",
    persistTurn: true,

    maxConcurrency: 3,
    announceOnStart: false
};

/** 布尔型字段清单，供配置读写统一处理 */
export const BOOLEAN_KEYS: Array<keyof TgConfig> = [
    "enabled",
    "autoStart",
    "privateEnabled",
    "groupEnabled",
    "groupRequireMention",
    "otherChatEnabled",
    "commandsEnabled",
    "streamingEnabled",
    "showThinking",
    "showToolCalls",
    "showToolParams",
    "showToolDuration",
    "showStats",
    "showModel",
    "showTimestamps",
    "showTypingAction",
    "deleteProgressAfterReply",
    "keepProgressOnError",
    "replyToMessage",
    "silentSend",
    "splitLongReplies",
    "perChatIsolation",
    "perSenderIsolation",
    "persistTurn",
    "announceOnStart",
    "includeDetail"
];

/** 数值型字段清单 */
export const NUMBER_KEYS: Array<keyof TgConfig> = [
    "longPollSeconds",
    "aiTimeoutMs",
    "httpTimeoutMs",
    "maxBackoffMs",
    "progressMaxChars",
    "progressEditIntervalMs",
    "maxReplyChars",
    "collapseThreshold",
    "maxConcurrency"
];

/** 字符串型字段清单 */
export const STRING_KEYS: Array<keyof TgConfig> = [
    "botToken",
    "apiBaseUrl",
    "chatIdAllowList",
    "progressMode",
    "replyStyle",
    "detailTitle",
    "chatGroup",
    "characterCardId",
    "assistantInstruction"
];
function sanitizeConfig(value: JsonObject): JsonObject {
    const next: JsonObject = {};

    STRING_KEYS.forEach((key) => {
        if (hasOwn(value, key)) {
            next[key] = asText(value[key]).trim();
        }
    });

    BOOLEAN_KEYS.forEach((key) => {
        if (hasOwn(value, key)) {
            next[key] = toBoolean(value[key], DEFAULT_CONFIG[key] as boolean);
        }
    });

    NUMBER_KEYS.forEach((key) => {
        if (hasOwn(value, key)) {
            const parsed = Number(value[key]);
            if (isFinite(parsed) && parsed > 0) {
                next[key] = Math.floor(parsed);
            }
        }
    });

    return next;
}

function normalizeConfig(raw: JsonObject): TgConfig {
    const merged = sanitizeConfig(raw);
    return {
        ...DEFAULT_CONFIG,
        ...merged
    } as TgConfig;
}

export async function readConfigAsync(): Promise<TgConfig> {
    const stored = await readCachedStoreAsync(getConfigFilePath(), sanitizeConfig);
    return normalizeConfig(stored);
}

export async function writeConfigAsync(patch: JsonObject): Promise<TgConfig> {
    const current = await readConfigAsync();
    const next = normalizeConfig({
        ...current,
        ...patch
    });
    await writeCachedStoreAsync(getConfigFilePath(), next, sanitizeConfig);
    await flushCachedStoreAsync(getConfigFilePath());
    return next;
}

/** 直接用完整配置覆盖（供设置面板批量保存） */
export async function writeFullConfigAsync(patch: JsonObject): Promise<TgConfig> {
    return await writeConfigAsync(patch);
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

export type TgChatBinding = {
    chatId: string;
    title: string;
    tgChatId: string;
    tgChatType: string;
    lastMessageId: number;
    lastProcessedAt: string;
};

export type TgRuntimeState = {
    running: boolean;
    startedAt: string;
    lastPollAt: string;
    lastError: string;
    updateOffset: number;
    processedTotal: number;
    failedTotal: number;
    bindings: Record<string, TgChatBinding>;
    recentUpdateIds: number[];
    /** 用户/自启动表达的“希望运行”意图，供看门狗自愈 */
    desiredRunning: boolean;
};

export const DEFAULT_RUNTIME_STATE: TgRuntimeState = {
    running: false,
    startedAt: "",
    lastPollAt: "",
    lastError: "",
    updateOffset: 0,
    processedTotal: 0,
    failedTotal: 0,
    bindings: {},
    recentUpdateIds: [],
    desiredRunning: false
};

const RECENT_UPDATE_KEEP = 300;
const BINDING_KEEP = 200;

function sanitizeRuntimeState(value: JsonObject): JsonObject {
    const bindings = hasOwn(value, "bindings") && isObject(value.bindings)
        ? cloneJsonObject(value.bindings as JsonObject)
        : {};
    const recent = Array.isArray(value.recentUpdateIds)
        ? (value.recentUpdateIds as any[]).map((item) => Number(item)).filter((item) => isFinite(item))
        : [];

    return {
        running: toBoolean(value.running, false),
        startedAt: asText(value.startedAt),
        lastPollAt: asText(value.lastPollAt),
        lastError: asText(value.lastError),
        updateOffset: Number(value.updateOffset) || 0,
        processedTotal: Number(value.processedTotal) || 0,
        failedTotal: Number(value.failedTotal) || 0,
        bindings,
        recentUpdateIds: recent.slice(-RECENT_UPDATE_KEEP),
        desiredRunning: toBoolean(value.desiredRunning, false)
    };
}

function normalizeRuntimeState(raw: JsonObject): TgRuntimeState {
    const sanitized = sanitizeRuntimeState(raw);
    return {
        ...DEFAULT_RUNTIME_STATE,
        ...sanitized
    } as TgRuntimeState;
}

export async function readRuntimeStateAsync(): Promise<TgRuntimeState> {
    const stored = await readCachedStoreAsync(getRuntimeStateFilePath(), sanitizeRuntimeState);
    return normalizeRuntimeState(stored);
}

export async function writeRuntimeStateAsync(patch: JsonObject): Promise<TgRuntimeState> {
    const current = await readRuntimeStateAsync();
    const next = normalizeRuntimeState({
        ...current,
        ...patch
    });
    await writeCachedStoreAsync(getRuntimeStateFilePath(), next, sanitizeRuntimeState);
    await flushCachedStoreAsync(getRuntimeStateFilePath());
    return next;
}

export async function flushRuntimeStateAsync(): Promise<void> {
    await flushCachedStoreAsync(getRuntimeStateFilePath());
}

export async function rememberUpdateIdAsync(updateId: number): Promise<void> {
    const current = await readRuntimeStateAsync();
    const recent = current.recentUpdateIds.filter((item) => item !== updateId);
    recent.push(updateId);
    await writeRuntimeStateAsync({
        recentUpdateIds: recent.slice(-RECENT_UPDATE_KEEP)
    });
}

export async function hasSeenUpdateIdAsync(updateId: number): Promise<boolean> {
    const current = await readRuntimeStateAsync();
    return current.recentUpdateIds.indexOf(updateId) >= 0;
}

export async function getBindingAsync(tgChatId: string): Promise<TgChatBinding | null> {
    const current = await readRuntimeStateAsync();
    const key = asText(tgChatId).trim();
    const binding = current.bindings[key];
    return binding ? binding as TgChatBinding : null;
}

export async function setBindingAsync(tgChatId: string, binding: TgChatBinding): Promise<void> {
    const current = await readRuntimeStateAsync();
    const key = asText(tgChatId).trim();
    const bindings: Record<string, TgChatBinding> = {
        ...current.bindings
    };
    bindings[key] = binding;

    const keys = Object.keys(bindings);
    if (keys.length > BINDING_KEEP) {
        keys.sort((left, right) => {
            const leftAt = asText(bindings[left]?.lastProcessedAt);
            const rightAt = asText(bindings[right]?.lastProcessedAt);
            return leftAt.localeCompare(rightAt);
        });
        const drop = keys.slice(0, keys.length - BINDING_KEEP);
        drop.forEach((item) => {
            delete bindings[item];
        });
    }

    await writeRuntimeStateAsync({ bindings });
}

export async function removeBindingAsync(tgChatId: string): Promise<void> {
    const current = await readRuntimeStateAsync();
    const key = asText(tgChatId).trim();
    if (!hasOwn(current.bindings, key)) {
        return;
    }
    const bindings: Record<string, TgChatBinding> = {
        ...current.bindings
    };
    delete bindings[key];
    await writeRuntimeStateAsync({ bindings });
}

/** 读取 Bot Token：环境变量优先，其次 config.json */
export async function readBotTokenAsync(): Promise<string> {
    const fromEnv = readEnv(ENV_KEYS.botToken);
    if (fromEnv) {
        return fromEnv;
    }
    const config = await readConfigAsync();
    return asText(config.botToken).trim();
}

export async function writeBotTokenAsync(token: string): Promise<void> {
    const trimmed = asText(token).trim();
    if (trimmed) {
        await writeEnv(ENV_KEYS.botToken, trimmed);
    }
    await writeConfigAsync({ botToken: trimmed });
}

/** 读取 API 基址（去掉结尾斜杠） */
export async function readApiBaseUrlAsync(): Promise<string> {
    const config = await readConfigAsync();
    const base = asText(config.apiBaseUrl).trim() || DEFAULT_CONFIG.apiBaseUrl;
    return base.replace(/\/+$/, "");
}