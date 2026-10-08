/* METADATA
{
    "name": "telegram_bridge",
    "display_name": {
        "zh": "Telegram 桥接",
        "en": "Telegram Bridge"
    },
    "description": {
        "zh": "把 Telegram Bot 变成 Operit 的唤醒入口：收到消息直接喂给 AI，并在 Telegram 侧流式显示思考与工具调用，回复后自动清理进度消息。",
        "en": "Turn a Telegram bot into an Operit wake-up entry: forward inbound messages straight to the AI, stream thinking and tool calls back into Telegram, and clean up progress messages after replying."
    },
    "enabledByDefault": false,
    "category": "Communication",
    "env": [
        {
            "name": "TELEGRAM_BOT_TOKEN",
            "description": { "zh": "Telegram Bot Token（从 @BotFather 获取）", "en": "Telegram bot token from @BotFather" },
            "required": false
        }
    ],
    "tools": [
        {
            "name": "usage_advice",
            "description": {
                "zh": "Telegram 桥接使用建议：\\n- 先用 tg_configure 保存 bot_token，再调用 tg_test_connection 验证。\\n- 打开 enabled 后调用 tg_start 拉起长轮询监听；监听常驻在 Operit 进程内，只有真的有消息时才会唤醒 AI。\\n- 显示内容由 streaming_enabled / show_thinking / show_tool_calls / show_tool_params / show_tool_duration / show_stats 等开关控制。\\n- delete_progress_after_reply 控制回复后是否删除进度消息。\\n- api_base_url 可指向自建反代。\\n- tg_send_message 用于主动推送消息。",
                "en": "Telegram bridge advice:\\n- Save the bot token with tg_configure, then verify with tg_test_connection.\\n- Turn on enabled and call tg_start to launch the long-poll listener; it lives inside the Operit process and only wakes the AI when a real message arrives.\\n- Display is controlled by streaming_enabled / show_thinking / show_tool_calls / show_tool_params / show_tool_duration / show_stats.\\n- delete_progress_after_reply controls whether progress messages are removed after replying.\\n- api_base_url can point to a self-hosted reverse proxy.\\n- Use tg_send_message for proactive pushes."
            },
            "parameters": [],
            "advice": true
        },
        {
            "name": "tg_configure",
            "description": {
                "zh": "保存 Telegram 桥接配置。覆盖连接、触发规则、显示内容、回复清理、会话上下文与运行维护五组设置。只传需要修改的字段。",
                "en": "Persist Telegram bridge settings across connection, trigger rules, display, reply cleanup, session context, and runtime groups. Pass only the fields you want to change."
            },
            "parameters": [
                { "name": "bot_token", "description": { "zh": "Telegram Bot Token", "en": "Telegram bot token" }, "type": "string", "required": false },
                { "name": "api_base_url", "description": { "zh": "API 基址，默认 https://api.telegram.org，可填自建反代", "en": "API base URL, default https://api.telegram.org; may be a self-hosted proxy" }, "type": "string", "required": false },
                { "name": "long_poll_seconds", "description": { "zh": "长轮询秒数", "en": "Long-poll seconds" }, "type": "number", "required": false },
                { "name": "ai_timeout_ms", "description": { "zh": "单次 AI 回合超时毫秒数", "en": "Per-turn AI timeout in ms" }, "type": "number", "required": false },
                { "name": "http_timeout_ms", "description": { "zh": "HTTP 请求超时毫秒数", "en": "HTTP request timeout in ms" }, "type": "number", "required": false },
                { "name": "max_backoff_ms", "description": { "zh": "轮询失败退避上限毫秒数", "en": "Max backoff after poll failures in ms" }, "type": "number", "required": false },

                { "name": "enabled", "description": { "zh": "是否允许 Telegram 消息唤醒 AI", "en": "Whether Telegram messages may wake the AI" }, "type": "boolean", "required": false },
                { "name": "auto_start", "description": { "zh": "Operit 启动/回前台时自动拉起监听", "en": "Auto-start the listener on launch/foreground" }, "type": "boolean", "required": false },
                { "name": "private_enabled", "description": { "zh": "是否响应私聊", "en": "Respond to private chats" }, "type": "boolean", "required": false },
                { "name": "group_enabled", "description": { "zh": "是否响应群聊", "en": "Respond to group chats" }, "type": "boolean", "required": false },
                { "name": "group_require_mention", "description": { "zh": "群聊必须 @ 机器人才响应", "en": "Require @mention in groups" }, "type": "boolean", "required": false },
                { "name": "other_chat_enabled", "description": { "zh": "是否响应频道等其他类型会话", "en": "Respond to other chat types such as channels" }, "type": "boolean", "required": false },
                { "name": "chat_id_allow_list", "description": { "zh": "会话白名单（逗号分隔 chat id，留空=不限制）", "en": "Chat ID allow list (comma separated; blank means no restriction)" }, "type": "string", "required": false },
                { "name": "commands_enabled", "description": { "zh": "是否响应 /start /status /reset 等命令", "en": "Respond to built-in commands" }, "type": "boolean", "required": false },

                { "name": "streaming_enabled", "description": { "zh": "流式传输总开关", "en": "Master switch for streaming display" }, "type": "boolean", "required": false },
                { "name": "show_thinking", "description": { "zh": "显示思考过程（AI 生成正文）", "en": "Show streamed AI output" }, "type": "boolean", "required": false },
                { "name": "show_tool_calls", "description": { "zh": "显示工具调用", "en": "Show tool calls" }, "type": "boolean", "required": false },
                { "name": "show_tool_params", "description": { "zh": "显示工具参数", "en": "Show tool parameters" }, "type": "boolean", "required": false },
                { "name": "show_tool_duration", "description": { "zh": "显示工具耗时", "en": "Show tool durations" }, "type": "boolean", "required": false },
                { "name": "show_stats", "description": { "zh": "显示统计信息（耗时/工具数/字数）", "en": "Show stats (duration/tools/chars)" }, "type": "boolean", "required": false },
                { "name": "show_model", "description": { "zh": "显示当前模型名", "en": "Show current model name" }, "type": "boolean", "required": false },
                { "name": "show_timestamps", "description": { "zh": "显示时间戳", "en": "Show timestamps" }, "type": "boolean", "required": false },
                { "name": "progress_max_chars", "description": { "zh": "进度消息最大长度", "en": "Max progress message length" }, "type": "number", "required": false },
                { "name": "progress_edit_interval_ms", "description": { "zh": "编辑节流间隔毫秒数（防限流）", "en": "Edit throttle interval in ms" }, "type": "number", "required": false },
                { "name": "progress_mode", "description": { "zh": "进度模式：single / segmented", "en": "Progress mode: single / segmented" }, "type": "string", "required": false },
                { "name": "show_typing_action", "description": { "zh": "是否显示打字中状态", "en": "Show typing action" }, "type": "boolean", "required": false },

                { "name": "delete_progress_after_reply", "description": { "zh": "回复后删除进度消息", "en": "Delete progress after replying" }, "type": "boolean", "required": false },
                { "name": "keep_progress_on_error", "description": { "zh": "失败时保留进度消息", "en": "Keep progress message on failure" }, "type": "boolean", "required": false },
                { "name": "reply_to_message", "description": { "zh": "引用原消息回复", "en": "Reply to the source message" }, "type": "boolean", "required": false },
                { "name": "silent_send", "description": { "zh": "静默发送（不推送通知）", "en": "Send silently without notification" }, "type": "boolean", "required": false },
                { "name": "split_long_replies", "description": { "zh": "回复超长时自动分片", "en": "Split long replies automatically" }, "type": "boolean", "required": false },
                { "name": "max_reply_chars", "description": { "zh": "单条回复最大字符数", "en": "Max characters per reply chunk" }, "type": "number", "required": false },

                { "name": "per_chat_isolation", "description": { "zh": "每个会话独立 Operit 对话", "en": "Give each chat its own Operit conversation" }, "type": "boolean", "required": false },
                { "name": "chat_group", "description": { "zh": "Operit 侧对话分组名", "en": "Operit chat group name" }, "type": "string", "required": false },
                { "name": "character_card_id", "description": { "zh": "绑定角色卡 ID", "en": "Bound character card ID" }, "type": "string", "required": false },
                { "name": "assistant_instruction", "description": { "zh": "附加到每条消息的指令", "en": "Extra instruction appended to every message" }, "type": "string", "required": false },
                { "name": "persist_turn", "description": { "zh": "保留 Operit 侧对话记录", "en": "Persist turns in the Operit conversation" }, "type": "boolean", "required": false },

                { "name": "max_concurrency", "description": { "zh": "最大并发处理数", "en": "Max concurrent processing" }, "type": "number", "required": false },
                { "name": "announce_on_start", "description": { "zh": "启动时发送问候", "en": "Announce on start" }, "type": "boolean", "required": false },

                { "name": "restart_if_running", "description": { "zh": "保存后若监听正在运行则重启以生效", "en": "Restart listener after saving if running" }, "type": "boolean", "required": false }
            ]
        },
        {
            "name": "tg_status",
            "description": {
                "zh": "读取 Telegram 桥接运行状态：是否运行、Bot 信息、已处理/失败计数、已绑定会话数、最近轮询时间与最近错误，并返回完整配置快照。",
                "en": "Read bridge status: running state, bot info, counters, bound chats, last poll, last error, plus a full config snapshot."
            },
            "parameters": []
        },
        {
            "name": "tg_start",
            "description": {
                "zh": "启动 Telegram 长轮询监听。要求已保存 Bot Token 且 enabled=true。",
                "en": "Start the Telegram long-poll listener. Requires a saved token and enabled=true."
            },
            "parameters": [
                { "name": "restart", "description": { "zh": "已在运行时先停止再启动", "en": "Stop and restart if running" }, "type": "boolean", "required": false }
            ]
        },
        {
            "name": "tg_stop",
            "description": { "zh": "停止 Telegram 长轮询监听。", "en": "Stop the listener." },
            "parameters": []
        },
        {
            "name": "tg_test_connection",
            "description": {
                "zh": "用当前 Bot Token 调用 getMe 验证连通性，返回 Bot 名称、用户名、ID 及进群/读群能力。",
                "en": "Verify the token via getMe and return bot name, username, ID, and group capabilities."
            },
            "parameters": []
        },
        {
            "name": "tg_send_message",
            "description": {
                "zh": "主动向指定 Telegram 会话发送文本消息。",
                "en": "Proactively send a text message to a Telegram chat."
            },
            "parameters": [
                { "name": "chat_id", "description": { "zh": "目标会话 ID", "en": "Target chat ID" }, "type": "string", "required": true },
                { "name": "text", "description": { "zh": "要发送的文本", "en": "Text to send" }, "type": "string", "required": true }
            ]
        },
        {
            "name": "tg_list_bindings",
            "description": {
                "zh": "列出 Telegram 会话与 Operit 对话的绑定关系。",
                "en": "List bindings between Telegram chats and Operit conversations."
            },
            "parameters": []
        },
        {
            "name": "tg_reset_binding",
            "description": {
                "zh": "解除指定会话绑定；不传 chat_id 时清空全部绑定。",
                "en": "Remove a chat binding; omit chat_id to clear all."
            },
            "parameters": [
                { "name": "chat_id", "description": { "zh": "可选：目标会话 ID，留空表示清空全部", "en": "Optional chat ID; blank clears all" }, "type": "string", "required": false }
            ]
        },
        {
            "name": "tg_reset_runtime",
            "description": {
                "zh": "把运行状态重置为停止并清零计数，用于异常退出后清理残留。",
                "en": "Reset runtime state to stopped and clear counters, useful after an abnormal exit."
            },
            "parameters": []
        },
        {
            "name": "tg_dump_config",
            "description": {
                "zh": "导出当前完整配置（Token 已脱敏），便于排查。",
                "en": "Dump the full current config with the token masked, for troubleshooting."
            },
            "parameters": []
        },
        {
            "name": "tg_selftest",
            "description": {
                "zh": "自检：向指定会话依次发送纯文本、HTML、折叠卡片、编辑、删除，验证 Telegram 侧能力并定位显示问题。不传 chat_id 时用最近绑定的会话。",
                "en": "Self-test: send plain text, HTML, a collapsible card, an edit, and a delete to the target chat to verify Telegram-side capabilities and pinpoint display issues."
            },
            "parameters": [
                { "name": "chat_id", "description": { "zh": "可选：目标会话 ID，留空用最近绑定的会话", "en": "Optional chat ID; defaults to the most recent bound chat" }, "type": "string", "required": false }
            ]
        }
    ]
}
*/

import {
    buildStatusAsync,
    tg_configure,
    tg_dump_config,
    tg_list_bindings,
    tg_reset_binding,
    tg_reset_runtime,
    tg_selftest,
    tg_send_message,
    tg_start,
    tg_stop,
    tg_test_connection
} from "../shared/tg_runtime";

exports.tg_configure = tg_configure;
exports.tg_status = buildStatusAsync;
exports.tg_start = tg_start;
exports.tg_stop = tg_stop;
exports.tg_test_connection = tg_test_connection;
exports.tg_send_message = tg_send_message;
exports.tg_list_bindings = tg_list_bindings;
exports.tg_reset_binding = tg_reset_binding;
exports.tg_reset_runtime = tg_reset_runtime;
exports.tg_dump_config = tg_dump_config;
exports.tg_selftest = tg_selftest;