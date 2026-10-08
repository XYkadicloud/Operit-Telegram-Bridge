/**
 * Telegram Bridge - 跨上下文 IPC
 *
 * UI 上下文（compose_dsl）不能直接调用工具，
 * 必须把执行逻辑序列化后通过 IPC 转发到 main 上下文执行。
 * 这是官方 ToolPkg 的标准做法。
 */

import * as TgRuntime from "./tg_runtime";
import {
    TG_CONTEXT_RUN_IPC_CHANNEL,
    ContextRunPayload,
    withContext
} from "./tg_ipc_client";

export { withContext, withContextQuiet } from "./tg_ipc_client";

type ContextFunction = (...args: readonly any[]) => any;
type ContextModule = Record<string, any>;

const contextFunctions: Record<string, ContextFunction> = {};

function previewJson(value: any, maxLength = 800): string {
    try {
        const text = JSON.stringify(value);
        if (typeof text !== "string") {
            return "";
        }
        return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
    } catch (_error) {
        return "[unserializable]";
    }
}

function validateEnvName(name: string): void {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        throw new Error(`withContext env name is not a valid identifier: ${name}`);
    }
}

function buildFactorySource(
    functionSource: string,
    envNames: string[],
    functionNames: string[]
): string {
    const envBindings = envNames
        .map((name) => {
            validateEnvName(name);
            return `const ${name} = __tgContextEnvs[${JSON.stringify(name)}];`;
        })
        .join("\n");
    const functionBindings = functionNames
        .map((name) => {
            validateEnvName(name);
            return `const ${name} = __tgContextFunctions[${JSON.stringify(name)}];`;
        })
        .join("\n");
    return `(function(__tgContextEnvs, __tgContextFunctions) {
${envBindings}
${functionBindings}
return (${functionSource});
})`;
}

/** 把 `Namespace.funcName` 归一成裸函数名，方便 runner 直接调用 */
function normalizeRunnerSource(functionSource: string): string {
    const names = Object.keys(contextFunctions)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
    if (!names) {
        return functionSource;
    }
    return functionSource
        .replace(
            new RegExp(`\\(\\s*0\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$]*\\.(${names})\\s*\\)`, "g"),
            "$1"
        )
        .replace(
            new RegExp(`\\b[A-Za-z_$][A-Za-z0-9_$]*\\.(${names})\\b`, "g"),
            "$1"
        );
}

async function executeRunner(payload: ContextRunPayload): Promise<any> {
    const envs = payload.envs || {};
    try {
        const functionSource = normalizeRunnerSource(payload.functionSource);
        const factorySource = buildFactorySource(
            functionSource,
            Object.keys(envs),
            Object.keys(contextFunctions)
        );
        const createRunner = eval(factorySource) as (
            envs: object,
            functions: Record<string, ContextFunction>
        ) => () => any;
        const runner = createRunner(envs, contextFunctions);
        if (typeof runner !== "function") {
            throw new Error("withContext runner source did not evaluate to a function");
        }
        return await runner();
    } catch (error) {
        const message = error instanceof Error ? error.message : "runner failed";
        console.error(`[tg_ipc] runner failed: ${message}, envs=${previewJson(envs)}`);
        throw error;
    }
}

function registerModule(moduleExports: ContextModule): void {
    Object.keys(moduleExports).forEach((name) => {
        validateEnvName(name);
        if (typeof moduleExports[name] === "function") {
            contextFunctions[name] = moduleExports[name];
        }
    });
}

// ---------------------------------------------------------------------------
// 暴露给 UI 的具名包装（runner 里直接写 tg_status() 即可）
// ---------------------------------------------------------------------------

export async function tg_status(): Promise<any> {
    return await TgRuntime.buildStatusAsync();
}

export async function tg_configure(params: any = {}): Promise<any> {
    return await TgRuntime.tg_configure(params);
}

export async function tg_start(params: any = {}): Promise<any> {
    return await TgRuntime.tg_start(params);
}

export async function tg_stop(): Promise<any> {
    return await TgRuntime.tg_stop();
}

export async function tg_test_connection(): Promise<any> {
    return await TgRuntime.tg_test_connection();
}

export async function tg_send_message(params: any = {}): Promise<any> {
    return await TgRuntime.tg_send_message(params);
}

export async function tg_list_bindings(): Promise<any> {
    return await TgRuntime.tg_list_bindings();
}

export async function tg_reset_binding(params: any = {}): Promise<any> {
    return await TgRuntime.tg_reset_binding(params);
}

export async function tg_reset_runtime(): Promise<any> {
    return await TgRuntime.tg_reset_runtime();
}

export async function tg_dump_config(): Promise<any> {
    return await TgRuntime.tg_dump_config();
}

export async function tg_selftest(params: any = {}): Promise<any> {
    return await TgRuntime.tg_selftest(params);
}

export async function tg_ensure_watchdog(): Promise<any> {
    return await TgRuntime.tg_ensure_watchdog();
}

// 注册到 main 上下文函数表
registerModule({
    tg_status,
    tg_configure,
    tg_start,
    tg_stop,
    tg_test_connection,
    tg_send_message,
    tg_list_bindings,
    tg_reset_binding,
    tg_reset_runtime,
    tg_dump_config,
    tg_selftest,
    tg_ensure_watchdog
});

let runnerRegistered = false;

function registerRunner(): void {
    if (runnerRegistered) {
        return;
    }
    // 关键：IPC 注册失败绝不能影响 ToolPkg 加载，
    // 否则 registerToolPkg() 会半途中断，钩子处于坏状态并拦死所有工具调用。
    try {
        if (!ToolPkg || !ToolPkg.ipc || typeof ToolPkg.ipc.on !== "function") {
            console.error("[tg_ipc] ToolPkg.ipc.on unavailable, skip registration");
            return;
        }
        runnerRegistered = true;
        ToolPkg.ipc.on<ContextRunPayload, any>(
            TG_CONTEXT_RUN_IPC_CHANNEL,
            async (payload) => await executeRunner(payload)
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "register failed";
        console.error(`[tg_ipc] registerRunner failed: ${message}`);
    }
}

registerRunner();

// 注册成功后主动拉一次：ToolPkg 重装会重建 main 上下文，
// 这里借机恢复监听与看门狗，避免依赖用户再手动点一次。
try {
    void (async () => {
        try {
            const state = await TgRuntime.buildStatusAsync();
            const desired = (state && state.runtime) ? state.runtime.running : false;
            if (!desired) {
                await TgRuntime.tg_ensure_watchdog({});
            }
        } catch (_error) {
            // 忽略：自愈失败不影响注册
        }
    })();
} catch (_error) {
    // 忽略
}

export * from "./tg_runtime";