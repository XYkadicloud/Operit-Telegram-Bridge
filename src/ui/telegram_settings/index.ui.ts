import type { ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import {
    withContext,
    tg_status,
    tg_configure,
    tg_start,
    tg_stop,
    tg_test_connection,
    tg_list_bindings,
    tg_reset_binding,
    tg_reset_runtime,
    tg_selftest,
    tg_dump_config
} from "../../shared/tg_ipc.js";

/**
 * Telegram 桥接设置面板
 *
 * 采用「schema 驱动」渲染：字段集中声明，界面按分组自动铺开，
 * 保存时一次性通过 tg_configure 提交。
 */

type FieldKind = "switch" | "text" | "number" | "password";

type FieldDef = {
    /** config 里的键名（camelCase） */
    key: string;
    /** tg_configure 的参数名（snake_case） */
    param: string;
    kind: FieldKind;
    label: string;
    desc?: string;
};

type SectionDef = {
    id: string;
    icon: string;
    title: string;
    fields: FieldDef[];
};

const SECTIONS: SectionDef[] = [
    {
        id: "connection",
        icon: "vpn_key",
        title: "Bot 与连接",
        fields: [
            { key: "botToken", param: "bot_token", kind: "password", label: "Bot Token", desc: "留空表示保持当前 Token 不变" },
            { key: "apiBaseUrl", param: "api_base_url", kind: "text", label: "API 基址", desc: "默认官方地址，也可填自建反代" },
            { key: "longPollSeconds", param: "long_poll_seconds", kind: "number", label: "长轮询秒数", desc: "越大越省电，消息延迟感知略增" },
            { key: "aiTimeoutMs", param: "ai_timeout_ms", kind: "number", label: "AI 超时（毫秒）" },
            { key: "httpTimeoutMs", param: "http_timeout_ms", kind: "number", label: "HTTP 超时（毫秒）" },
            { key: "maxBackoffMs", param: "max_backoff_ms", kind: "number", label: "失败退避上限（毫秒）" }
        ]
    },
    {
        id: "trigger",
        icon: "bolt",
        title: "触发规则",
        fields: [
            { key: "enabled", param: "enabled", kind: "switch", label: "启用桥接", desc: "允许 Telegram 消息唤醒 AI" },
            { key: "autoStart", param: "auto_start", kind: "switch", label: "自动启动", desc: "Operit 启动或回前台时拉起监听" },
            { key: "privateEnabled", param: "private_enabled", kind: "switch", label: "响应私聊" },
            { key: "groupEnabled", param: "group_enabled", kind: "switch", label: "响应群聊" },
            { key: "groupRequireMention", param: "group_require_mention", kind: "switch", label: "群聊需 @ 才响应" },
            { key: "otherChatEnabled", param: "other_chat_enabled", kind: "switch", label: "响应频道等其他类型" },
            { key: "commandsEnabled", param: "commands_enabled", kind: "switch", label: "响应内置命令", desc: "/start /status /reset /help" },
            { key: "chatIdAllowList", param: "chat_id_allow_list", kind: "text", label: "会话白名单", desc: "逗号分隔 chat id，留空不限制" }
        ]
    },
    {
        id: "display",
        icon: "visibility",
        title: "显示内容",
        fields: [
            { key: "streamingEnabled", param: "streaming_enabled", kind: "switch", label: "流式传输总开关" },
            { key: "showThinking", param: "show_thinking", kind: "switch", label: "显示思考过程", desc: "把 AI 生成内容实时刷新出来" },
            { key: "showToolCalls", param: "show_tool_calls", kind: "switch", label: "显示工具调用" },
            { key: "showToolParams", param: "show_tool_params", kind: "switch", label: "显示工具参数" },
            { key: "showToolDuration", param: "show_tool_duration", kind: "switch", label: "显示工具耗时" },
            { key: "showStats", param: "show_stats", kind: "switch", label: "显示统计", desc: "总耗时 / 工具数 / 字数" },
            { key: "showModel", param: "show_model", kind: "switch", label: "显示模型名" },
            { key: "showTimestamps", param: "show_timestamps", kind: "switch", label: "显示时间戳" },
            { key: "showTypingAction", param: "show_typing_action", kind: "switch", label: "显示打字中状态" },
            { key: "progressMaxChars", param: "progress_max_chars", kind: "number", label: "进度消息最大长度" },
            { key: "progressEditIntervalMs", param: "progress_edit_interval_ms", kind: "number", label: "编辑节流间隔（毫秒）", desc: "越小越实时，但更易触发限流" },
            { key: "progressMode", param: "progress_mode", kind: "text", label: "进度模式", desc: "single = 单条持续编辑" }
        ]
    },
    {
        id: "reply",
        icon: "reply",
        title: "回复与清理",
        fields: [
            { key: "replyStyle", param: "reply_style", kind: "text", label: "回复样式", desc: "auto=超长自动折叠 / full=完整发送" },
            { key: "collapseThreshold", param: "collapse_threshold", kind: "number", label: "折叠阈值（字符）", desc: "正文超过此长度才折叠细节" },
            { key: "detailTitle", param: "detail_title", kind: "text", label: "折叠块标题" },
            { key: "includeDetail", param: "include_detail", kind: "switch", label: "附带完整细节", desc: "关闭则只发摘要" },
            { key: "deleteProgressAfterReply", param: "delete_progress_after_reply", kind: "switch", label: "回复后删除进度消息" },
            { key: "keepProgressOnError", param: "keep_progress_on_error", kind: "switch", label: "失败时保留进度消息" },
            { key: "replyToMessage", param: "reply_to_message", kind: "switch", label: "引用原消息回复" },
            { key: "silentSend", param: "silent_send", kind: "switch", label: "静默发送", desc: "不推送通知" },
            { key: "splitLongReplies", param: "split_long_replies", kind: "switch", label: "超长回复自动分片" },
            { key: "maxReplyChars", param: "max_reply_chars", kind: "number", label: "单条回复最大字符数" }
        ]
    },
    {
        id: "session",
        icon: "forum",
        title: "会话与上下文",
        fields: [
            { key: "perChatIsolation", param: "per_chat_isolation", kind: "switch", label: "按会话隔离", desc: "私聊每人一个对话；群聊整个群共用一个" },
            { key: "perSenderIsolation", param: "per_sender_isolation", kind: "switch", label: "群内再按人拆开", desc: "开启后群聊里每个人各占一个对话" },
            { key: "persistTurn", param: "persist_turn", kind: "switch", label: "保留 Operit 侧记录" },
            { key: "chatGroup", param: "chat_group", kind: "text", label: "对话分组名" },
            { key: "characterCardId", param: "character_card_id", kind: "text", label: "绑定角色卡 ID", desc: "留空则不绑定" },
            { key: "assistantInstruction", param: "assistant_instruction", kind: "text", label: "附加指令", desc: "附加到每条消息" }
        ]
    },
    {
        id: "runtime",
        icon: "settings",
        title: "运行与维护",
        fields: [
            { key: "maxConcurrency", param: "max_concurrency", kind: "number", label: "最大并发数" },
            { key: "announceOnStart", param: "announce_on_start", kind: "switch", label: "启动时发送问候" }
        ]
    }
];

type Values = Record<string, any>;

function useStateValue<T>(ctx: ComposeDslContext, key: string, initialValue: T): {
    value: T;
    set: (value: T) => void;
} {
    const pair = ctx.useState<T>(key, initialValue);
    return { value: pair[0], set: pair[1] };
}

function asText(value: unknown): string {
    return value == null ? "" : String(value);
}

function asBool(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
            return true;
        }
        if (normalized === "false" || normalized === "0") {
            return false;
        }
    }
    return fallback;
}

function toErrorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message || "unknown";
    }
    return String(error || "unknown");
}

function sectionTitle(ctx: ComposeDslContext, icon: string, title: string): ComposeNode {
    return ctx.UI.Row({ verticalAlignment: "center" }, [
        ctx.UI.Icon({ name: icon, tint: "primary", size: 20 }),
        ctx.UI.Spacer({ width: 8 }),
        ctx.UI.Text({
            text: title,
            style: "titleMedium",
            fontWeight: "bold",
            color: "primary"
        })
    ]);
}

function switchRow(
    ctx: ComposeDslContext,
    label: string,
    desc: string,
    checked: boolean,
    onCheckedChange: (value: boolean) => void
): ComposeNode {
    const children: ComposeNode[] = [
        ctx.UI.Text({ text: label, style: "bodyMedium", fontWeight: "medium" })
    ];
    if (desc) {
        children.push(ctx.UI.Text({ text: desc, style: "bodySmall", color: "onSurfaceVariant" }));
    }
    return ctx.UI.Row({
        fillMaxWidth: true,
        verticalAlignment: "center",
        horizontalArrangement: "spaceBetween"
    }, [
        ctx.UI.Column({ weight: 1, spacing: 4 }, children),
        ctx.UI.Spacer({ width: 12 }),
        ctx.UI.Switch({ checked, onCheckedChange })
    ]);
}

function textField(
    ctx: ComposeDslContext,
    field: FieldDef,
    value: string,
    onChange: (value: string) => void
): ComposeNode {
    const children: ComposeNode[] = [];
    if (field.desc) {
        children.push(ctx.UI.Text({
            text: field.desc,
            style: "bodySmall",
            color: "onSurfaceVariant"
        }));
    }
    return ctx.UI.TextField({
        value,
        onValueChange: onChange,
        label: field.label,
        isPassword: field.kind === "password",
        singleLine: field.kind !== "text" || field.key !== "assistantInstruction",
        supportingText: children.length > 0 ? ctx.UI.Column({ spacing: 2 }, children) : undefined
    });
}

export default function Screen(ctx: ComposeDslContext): ComposeNode {
    const values = useStateValue<Values>(ctx, "values", {});
    const busy = useStateValue<boolean>(ctx, "busy", false);
    const toast = useStateValue<string>(ctx, "toast", "");
    const infoText = useStateValue<string>(ctx, "infoText", "");
    const bindingsText = useStateValue<string>(ctx, "bindingsText", "");
    const loaded = ctx.useRef<boolean>("loaded", false);

    const setField = (key: string, value: any): void => {
        const next: Values = { ...values.value };
        next[key] = value;
        values.set(next);
    };

    const getValue = (key: string): any => values.value[key];

    const call = async (name: string, params?: Record<string, unknown>): Promise<any> => {
        const payload = params || {};
        switch (name) {
            case "tg_status":
                return await withContext("main", {}, async () => await tg_status());
            case "tg_configure":
                return await withContext("main", { payload }, async () => await tg_configure(payload));
            case "tg_start":
                return await withContext("main", { payload }, async () => await tg_start(payload));
            case "tg_stop":
                return await withContext("main", {}, async () => await tg_stop());
            case "tg_test_connection":
                return await withContext("main", {}, async () => await tg_test_connection());
            case "tg_list_bindings":
                return await withContext("main", {}, async () => await tg_list_bindings());
            case "tg_reset_binding":
                return await withContext("main", { payload }, async () => await tg_reset_binding(payload));
            case "tg_reset_runtime":
                return await withContext("main", {}, async () => await tg_reset_runtime());
            case "tg_selftest":
                return await withContext("main", { payload }, async () => await tg_selftest(payload));
            case "tg_dump_config":
                return await withContext("main", {}, async () => await tg_dump_config());
            default:
                throw new Error(`未知操作：${name}`);
        }
    };

    const applyStatus = (status: any): void => {
        const config = status?.config || {};
        const next: Values = {};
        SECTIONS.forEach((section) => {
            section.fields.forEach((field) => {
                if (field.key === "botToken") {
                    next[field.key] = "";
                    return;
                }
                if (field.kind === "switch") {
                    next[field.key] = asBool(config[field.key], false);
                } else {
                    next[field.key] = asText(config[field.key]);
                }
            });
        });
        values.set(next);

        const runtime = status?.runtime || {};
        const lines = [
            `运行中：${asBool(runtime.running, false) ? "✅ 是" : "— 否"}`,
            `Bot：${asText(status?.botUsername) || "(未验证)"}`,
            `Token：${asText(status?.botTokenMasked) || "(未配置)"}`,
            `已处理：${asText(runtime.processedTotal || 0)} 条`,
            `失败：${asText(runtime.failedTotal || 0)} 条`,
            `已绑定会话：${asText(status?.bindingCount || 0)} 个`,
            `最近轮询：${asText(runtime.lastPollAt) || "-"}`
        ];
        if (asText(runtime.lastError)) {
            lines.push(`最近错误：${asText(runtime.lastError).slice(0, 200)}`);
        }
        infoText.set(lines.join("\n"));
    };

    const refreshBindings = async (): Promise<void> => {
        try {
            const result = await call("tg_list_bindings", {});
            const items = Array.isArray(result?.items) ? result.items : [];
            if (items.length === 0) {
                bindingsText.set("（暂无绑定）");
                return;
            }
            bindingsText.set(items.slice(0, 10).map((item: any) => {
                return `• ${asText(item.title) || asText(item.tgChatId)}\n  TG ${asText(item.tgChatId)} → ${asText(item.operitChatId)}`;
            }).join("\n"));
        } catch (error) {
            bindingsText.set(`读取失败：${toErrorText(error)}`);
        }
    };

    const refresh = async (): Promise<void> => {
        const status = await call("tg_status", {});
        applyStatus(status);
        await refreshBindings();
    };

    if (!loaded.current) {
        loaded.current = true;
        void refresh().catch((error: unknown) => {
            ctx.showToast(`加载失败：${toErrorText(error)}`);
        });
    }

    const withBusy = async (label: string, task: () => Promise<void>): Promise<void> => {
        if (busy.value) {
            return;
        }
        busy.set(true);
        toast.set(label);
        try {
            await task();
        } catch (error) {
            ctx.showToast(`失败：${toErrorText(error)}`);
        } finally {
            busy.set(false);
            toast.set("");
        }
    };

    const onSave = (): void => {
        void withBusy("保存中…", async () => {
            const params: Record<string, unknown> = {};
            SECTIONS.forEach((section) => {
                section.fields.forEach((field) => {
                    const value = getValue(field.key);
                    if (field.key === "botToken") {
                        const token = asText(value).trim();
                        if (token) {
                            params[field.param] = token;
                        }
                        return;
                    }
                    if (field.kind === "switch") {
                        params[field.param] = asBool(value, false);
                        return;
                    }
                    if (field.kind === "number") {
                        const num = Number(asText(value).trim());
                        if (isFinite(num) && num > 0) {
                            params[field.param] = num;
                        }
                        return;
                    }
                    params[field.param] = asText(value).trim();
                });
            });

            const result = await call("tg_configure", params);
            if (result && result.success === false) {
                throw new Error(asText(result.error || "保存失败"));
            }
            await refresh();
            ctx.showToast("设置已保存");
        });
    };

    const onTest = (): void => {
        void withBusy("测试中…", async () => {
            const result = await call("tg_test_connection", {});
            if (result && result.success === false) {
                throw new Error(asText(result.error || "测试失败"));
            }
            await refresh();
            ctx.showToast(`连接正常：@${asText(result?.botUsername)}`);
        });
    };

    const onStart = (): void => {
        void withBusy("启动中…", async () => {
            const result = await call("tg_start", {});
            if (result && result.success === false) {
                throw new Error(asText(result.error || "启动失败"));
            }
            await refresh();
            ctx.showToast("监听已启动");
        });
    };

    const onStop = (): void => {
        void withBusy("停止中…", async () => {
            await call("tg_stop", {});
            await refresh();
            ctx.showToast("监听已停止");
        });
    };

    const onResetRuntime = (): void => {
        void withBusy("重置中…", async () => {
            await call("tg_reset_runtime", {});
            await refresh();
            ctx.showToast("运行状态已重置");
        });
    };

    const onClearBindings = (): void => {
        void withBusy("清空中…", async () => {
            await call("tg_reset_binding", {});
            await refresh();
            ctx.showToast("绑定已清空");
        });
    };

    const onSelftest = (): void => {
        void withBusy("自检中…", async () => {
            const result = await call("tg_selftest", {});
            if (result && result.success === false) {
                throw new Error(asText(result.error || "自检失败"));
            }
            const summary = asText(result?.summary);
            const detail = Array.isArray(result?.results)
                ? result.results.map((item: any) => {
                    const mark = item?.ok ? "✅" : "❌";
                    return `${mark} ${asText(item?.step)}${item?.ok ? "" : ` · ${asText(item?.error).slice(0, 60)}`}`;
                }).join("\n")
                : "";
            ctx.showToast(summary || "自检完成");
            if (detail) {
                infoText.set(`【自检结果】\n${detail}\n\n${summary}`);
            }
        });
    };

    const renderSection = (section: SectionDef): ComposeNode => {
        const children: ComposeNode[] = [sectionTitle(ctx, section.icon, section.title)];
        section.fields.forEach((field) => {
            if (field.kind === "switch") {
                children.push(switchRow(
                    ctx,
                    field.label,
                    field.desc || "",
                    asBool(getValue(field.key), false),
                    (value: boolean) => setField(field.key, value)
                ));
                return;
            }
            children.push(textField(
                ctx,
                field,
                asText(getValue(field.key)),
                (value: string) => setField(field.key, value)
            ));
        });
        return ctx.UI.Surface({ fillMaxWidth: true, padding: 14, containerColor: "surfaceVariant" }, [
            ctx.UI.Column({ fillMaxWidth: true, spacing: 12 }, children)
        ]);
    };

    const rootChildren: ComposeNode[] = [
        ctx.UI.Column({ fillMaxWidth: true, spacing: 4 }, [
            ctx.UI.Text({ text: "Telegram 桥接", style: "headlineSmall", fontWeight: "bold" }),
            ctx.UI.Text({
                text: "让 Telegram 消息直接唤醒 Operit AI，并可实时显示思考与工具调用。",
                style: "bodySmall",
                color: "onSurfaceVariant"
            })
        ]),

        // 状态
        ctx.UI.Surface({ fillMaxWidth: true, padding: 14, containerColor: "surfaceVariant" }, [
            ctx.UI.Column({ fillMaxWidth: true, spacing: 10 }, [
                sectionTitle(ctx, "info", "运行状态"),
                ctx.UI.Text({ text: infoText.value || "-", style: "bodySmall" })
            ])
        ])
    ];

    SECTIONS.forEach((section) => {
        rootChildren.push(renderSection(section));
    });

    // 运行控制 + 维护
    rootChildren.push(
        ctx.UI.Surface({ fillMaxWidth: true, padding: 14, containerColor: "surfaceVariant" }, [
            ctx.UI.Column({ fillMaxWidth: true, spacing: 10 }, [
                sectionTitle(ctx, "play_circle", "运行控制"),
                ctx.UI.Row({ horizontalArrangement: "end", spacing: 8 }, [
                    ctx.UI.Button({ onClick: onStop, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "停止" })
                    ]),
                    ctx.UI.Button({ onClick: onStart, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "启动" })
                    ])
                ]),
                ctx.UI.Row({ horizontalArrangement: "end", spacing: 8 }, [
                    ctx.UI.Button({ onClick: onSelftest, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "自检" })
                    ]),
                    ctx.UI.Button({ onClick: () => void refresh(), enabled: !busy.value }, [
                        ctx.UI.Text({ text: "刷新" })
                    ])
                ]),
                ctx.UI.Row({ horizontalArrangement: "end", spacing: 8 }, [
                    ctx.UI.Button({ onClick: onTest, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "测试连接" })
                    ]),
                    ctx.UI.Button({ onClick: onSave, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "保存设置" })
                    ])
                ]),
                ctx.UI.Row({ horizontalArrangement: "end", spacing: 8 }, [
                    ctx.UI.Button({ onClick: onResetRuntime, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "重置运行状态" })
                    ]),
                    ctx.UI.Button({ onClick: onClearBindings, enabled: !busy.value }, [
                        ctx.UI.Text({ text: "清空绑定" })
                    ])
                ])
            ])
        ])
    );

    // 绑定列表
    rootChildren.push(
        ctx.UI.Surface({ fillMaxWidth: true, padding: 14, containerColor: "surfaceVariant" }, [
            ctx.UI.Column({ fillMaxWidth: true, spacing: 10 }, [
                sectionTitle(ctx, "link", "会话绑定"),
                ctx.UI.Text({ text: bindingsText.value || "-", style: "bodySmall" })
            ])
        ])
    );

    // 底部保存
    rootChildren.push(
        ctx.UI.Surface({ fillMaxWidth: true, padding: 14, containerColor: "surfaceVariant" }, [
            ctx.UI.Column({ fillMaxWidth: true, spacing: 10 }, [
                ctx.UI.Button({ onClick: onSave, enabled: !busy.value, fillMaxWidth: true }, [
                    ctx.UI.Text({ text: "保存全部设置" })
                ])
            ])
        ])
    );

    rootChildren.push(
        toast.value
            ? ctx.UI.Text({ text: toast.value, style: "bodySmall", color: "primary" })
            : ctx.UI.Spacer({ height: 8 })
    );

    return ctx.UI.LazyColumn({ fillMaxWidth: true, spacing: 14 }, rootChildren);
}