# Operit Telegram Bridge

把 **Telegram Bot** 变成 [Operit](https://github.com/AAswordman/Operit) 的唤醒入口。

在 Telegram 里发一条消息，Operit 的 AI 大脑就被叫醒开始干活；思考过程和工具调用会以**可折叠卡片**实时回传，回复完成后进度消息自动删除。

> 这是一个 Operit **ToolPkg** 插件（TypeScript → JS），纯 Operit 进程内运行，**不需要** Node、proot、Termux 或任何常驻后台服务。

---

## 特性

| 能力 | 说明 |
|---|---|
| **消息直达 AI** | Telegram 消息 → 绑定/创建 Operit 对话 → `chat.sendMessageStreaming`，无需轮询"问有没有新消息" |
| **流式回传** | AI 生成过程逐块编辑到同一条进度消息里 |
| **折叠卡片** | 思考与工具调用放进 `<blockquote expandable>`，可上下展开，不刷屏 |
| **自动清理** | 回复完成后删除进度消息，聊天记录只留最终答案 |
| **回复清洗** | 剥离 `<tool_result>` / `<param>` 等原始 XML 残留 |
| **会话隔离** | 私聊每人一个独立 Operit 对话；群聊整群共用一个对话（可选再按人拆） |
| **超长折叠** | 回复超过阈值自动折叠后半段 |
| **看门狗自愈** | 轮询循环意外死亡自动拉起；重装后自动恢复 |
| **工具箱设置界面** | 6 组 38 项设置，含 Bot API 选择、显示开关、流式开关、工具调用开关等 |

---

## 架构

```
Telegram 用户
   │  发消息
   ▼
┌──────────────────────────────────────────────┐
│ Operit 进程                                   │
│                                              │
│  main 上下文（长期存活）                       │
│   ├─ 长轮询循环  getUpdates                   │
│   ├─ 看门狗 setInterval 自愈                   │
│   └─ IPC runner（供 UI / 工具转发调用）        │
│                                              │
│  工具沙盒（一次性，用完即销毁）                 │
│   └─ tg_* 工具：只做转发，绝不起循环            │
│                                              │
│  Compose DSL 上下文（设置界面）                │
│   └─ 经 IPC 转发到 main 执行工具               │
└──────────────────────────────────────────────┘
   │  chat.sendMessageStreaming
   ▼
Operit AI 大脑 → 流式 chunk → 折叠卡片 → Telegram
```

### 三个关键设计（都是踩坑换来的）

**① 循环必须托管在 main 上下文**

ToolPkg 的子包工具脚本跑在**一次性沙盒**里，工具返回后 JS 引擎即销毁。如果把长轮询循环写在工具函数里，它会在返回瞬间死掉——表现为"发消息没反应，要再发 1-2 条才回"（其实是 Operit 回到前台触发了补响应）。

所以：**工具只写意图 + 转发，循环由 main 上下文持有。**

**② IPC 参数必须经 `envs` 传递**

`withContext` 的 runner 会被 `toString()` 序列化后在新上下文重建。**闭包变量会丢失**：

```ts
// ❌ restart 在 main 上下文变成 undefined，异常被静默吞掉
withContext("main", {}, async () => ensure({ restart }));

// ✅ envs 里的名字会被注入成同名局部变量
withContext("main", { params: { restart } }, async () => ensure(params));
```

**③ 不注册工具生命周期钩子**

`registerToolLifecycleHook` 曾三次把**整个工具通道锁死**（连 `sleep`、`list_files` 都被拦，只能手动关包才能解锁），根因是拦截事件返回 `undefined` 时宿主抛 `IllegalStateException`。

现在改为**从流式内容里正则解析**工具调用，效果等价且零副作用。

---

## 安装

### 1. 获取 Bot Token

在 Telegram 找 [@BotFather](https://t.me/BotFather)：

```
/newbot        → 按提示设置名字与用户名
/token         → 复制形如 123456:ABC-DEF... 的 token
```

### 2. 编译

```bash
cd telegram_bridge
tsc -p tsconfig.json          # 输出到 dist/
```

> **注意**：`tsconfig.json` 里的 `typeRoots` 指向 `../types`，那是 Operit 官方的 ToolPkg 类型定义目录
> （来自 `SandboxPackage_DEV` 技能包，含 `toolpkg.d.ts`、`chat.d.ts`、`okhttp.d.ts`、`compose-dsl.d.ts` 等）。
> 编译前请把该 `types/` 目录放到本仓库的**同级父目录**，即：
>
> ```
> <父目录>/
> ├── types/                    ← Operit 官方类型定义
> └── Operit-Telegram-Bridge/   ← 本仓库
> ```
>
> 运行时不需要这些类型，只有编译期需要。

### 3. 打包安装

把目录（含 `manifest.json`、`dist/`）复制为 **`com.operit.telegram_bridge`**（目录名必须与 `toolpkg_id` 一致），然后：

- **方式 A（推荐）**：在 Operit 里用 `operit_editor:debug_install_toolpkg` 指向 `manifest.json`
- **方式 B**：手动打包成 `.toolpkg` 放进
  `/sdcard/Android/data/com.ai.assistance.operit/files/packages/`

### 4. 配置并启动

在 Operit 工具箱里打开 **Telegram 桥接设置**，或在对话里：

```
tg_configure  bot_token=<你的 token>
tg_configure  enabled=true
tg_start
```

看到 `runtime.running: true` 且 `lastPollAt` 持续更新即成功。

---

## 工具一览

| 工具 | 作用 |
|---|---|
| `tg_configure` | 保存配置（连接 / 触发 / 显示 / 清理 / 会话 / 维护，共 6 组） |
| `tg_status` | 运行状态 + 完整配置快照 |
| `tg_start` / `tg_stop` | 启停长轮询监听 |
| `tg_test_connection` | `getMe` 验证 token |
| `tg_send_message` | 主动推送消息 |
| `tg_list_bindings` | 查看 TG 会话 ↔ Operit 对话绑定 |
| `tg_reset_binding` | 解除绑定（可单个或全部） |
| `tg_reset_runtime` | 异常退出后清零残留状态 |
| `tg_dump_config` | 导出配置（token 已脱敏） |
| `tg_selftest` | 自检：依次发纯文本/HTML/折叠卡片/编辑/删除，定位显示问题 |

---

## 主要设置项

**连接**：`bot_token`、`api_base_url`（可指向自建反代）、`long_poll_seconds`、超时与退避

**触发规则**：`private_enabled`、`group_enabled`、`group_require_mention`、`chat_id_allow_list`、`commands_enabled`

**显示内容**：`streaming_enabled`、`show_thinking`、`show_tool_calls`、`show_tool_params`、`show_tool_duration`、`show_stats`、`show_model`、`show_timestamps`

**回复与清理**：`delete_progress_after_reply`、`keep_progress_on_error`、`reply_to_message`、`silent_send`、`split_long_replies`、`max_reply_chars`、`reply_style`、`collapse_threshold`

**会话与上下文**：`per_chat_isolation`、`per_sender_isolation`、`chat_group`、`character_card_id`、`assistant_instruction`、`persist_turn`

**运行维护**：`auto_start`、`max_concurrency`、`announce_on_start`、`progress_edit_interval_ms`

### 会话隔离模型

| 场景 | 行为 |
|---|---|
| 私聊 | 每个用户一个独立 Operit 对话（天然按 `chatId` 隔离） |
| 群聊 | **整个群共用一个** Operit 对话（默认） |
| 群聊 + `per_sender_isolation=true` | 群内每个人再各拆一个对话 |

绑定键：`buildBindingKey(config, chat, userId)`
→ 群聊且开按人拆：`${chatId}:${userId}`；否则 `String(chatId)`。

---

## 开发笔记

### 工程结构

```
telegram_bridge/
├── manifest.json                 # ToolPkg 清单
├── tsconfig.json
└── src/
    ├── main.ts                   # 入口：注册设置界面 + 应用生命周期钩子
    ├── packages/
    │   └── telegram_bridge.ts    # 工具定义（METADATA）
    ├── shared/
    │   ├── tg_common.ts          # 通用工具函数
    │   ├── tg_api.ts             # Telegram Bot API 封装（OkHttp）
    │   ├── tg_state.ts           # 配置 + 运行时状态持久化
    │   ├── tg_format.ts          # HTML 转义 / 折叠卡片 / 工具 XML 解析与清洗
    │   ├── tg_progress.ts        # 进度消息管理器（流式编辑 + 节流 + 清理）
    │   ├── tg_bridge.ts          # 核心桥接：消息 → AI → 回传
    │   ├── tg_ipc.ts             # main 上下文 runner 注册
    │   ├── tg_ipc_client.ts      # UI 侧 IPC 调用封装
    │   ├── tg_lifecycle.ts       # 应用生命周期钩子（启动/回前台自动拉起）
    │   └── tg_runtime.ts         # 工具层入口 + 看门狗
    └── ui/telegram_settings/
        └── index.ui.ts           # Compose DSL 设置界面
```

### 踩坑速查

| 现象 | 原因 | 解法 |
|---|---|---|
| `Tool not found: tg_xxx` | UI 上下文不能直接 `ctx.callTool` | 经 `withContext("main")` 转发 |
| 工具通道全锁死 | 生命周期钩子返回 `undefined` | 不注册钩子，改用流式解析 |
| IPC 返回 `null` | 闭包变量序列化后丢失 | 参数走 `envs` |
| `Conflict: terminated by other getUpdates request` | 两个循环抢轮询 | 只让 main 持有循环 |
| 要发 1-2 条才响应 | 循环跑在一次性沙盒里 | 循环托管到 main + 看门狗 |
| `function must be exported` | hook 函数没从模块 export | 拆到独立模块并 export |
| POST 报 "must have a request body" | OkHttp 要求 POST 带 body | 空 payload 传 `{}` |
| 安装报目录名不符 | 目录名须等于 `toolpkg_id` | 重命名目录 |

---

## 安全提醒

- **不要**把 Bot Token 提交进仓库。本项目源码已确认零硬编码密钥，配置存在设备本地。
- Token 一旦在聊天/日志/截图里出现过，建议去 [@BotFather](https://t.me/BotFather) `/revoke` 换新。
- 建议开启 `chat_id_allow_list`，只允许你自己的会话唤醒 AI。

## License

MIT
