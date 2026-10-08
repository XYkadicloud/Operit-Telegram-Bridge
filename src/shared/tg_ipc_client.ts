/**
 * Telegram Bridge - IPC 客户端
 *
 * 只负责「把一段逻辑转发到指定上下文执行」。
 * 刻意不 import 任何业务模块，避免与 tg_ipc / tg_runtime 形成循环导入
 * （循环导入曾导致钩子注册时拿到 undefined 并锁死工具通道）。
 */

export const TG_CONTEXT_RUN_IPC_CHANNEL = "telegram_bridge.context.run";

type ContextRunner<TResult> = () => TResult | Promise<TResult>;

export type ContextRunPayload = {
    functionSource: string;
    envs: object;
};

async function runWithContext<TResult>(
    kind: any,
    envs: object,
    runner: ContextRunner<any>
): Promise<TResult> {
    const payload: ContextRunPayload = {
        functionSource: runner.toString(),
        envs
    };
    return await ToolPkg.ipc.call<ContextRunPayload, TResult>(
        TG_CONTEXT_RUN_IPC_CHANNEL,
        payload,
        { targetRuntime: kind }
    );
}

export function withContext<TResult>(
    kind: any,
    envs: object,
    runner: ContextRunner<any>
): Promise<TResult> {
    return runWithContext<TResult>(kind, envs, runner);
}

/** 静默转发：失败不抛错，用于「尽力而为」的场景 */
export async function withContextQuiet(
    kind: any,
    envs: object,
    runner: ContextRunner<any>
): Promise<any> {
    try {
        return await runWithContext<any>(kind, envs, runner);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tg_ipc_client] withContextQuiet failed: ${message}`);
        return null;
    }
}