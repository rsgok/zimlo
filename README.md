# Zimlo Local Web MVP

Zimlo 是 Codex 与 Claude Code 的本地移动状态层。它自动发现 Mac 上已经存在或正在运行的 session，同时给 Agent 提供显式的 `feed.post`、`feed.skip` 与 `signal.transition` 工具，在可信局域网内提供可配对的响应式 Timeline。

## 当前能力

- 每 2 秒扫描 Codex/Claude Code 进程，并增量读取最近 7 天、每个 provider 最多 200 个 transcript。
- 使用 provider session id、transcript 路径、PID/启动时间、TTY、打开文件和父进程做保守关联；cwd 绝不作为唯一合并依据。
- Feed 只接收用户原始指令和 Agent 主动调用 `feed.post` 发布的内容；平台不 scrape 输出，也不二次生成摘要。
- `signal.transition` 单独维护机器任务状态；Feed 不是状态 source of truth。
- 每轮结束前，Stop hook 要求 Agent 在 `feed.post` 与 `feed.skip` 中二选一；关键状态会校验匹配的帖子种类。
- Timeline 一屏显示一帖，`action_required` 帖子优先，并可绑定真实输入/审批请求。
- 只有真实测试命令与真实退出码才能生成 `tests_passed` / `tests_failed`。
- 闲置 Codex session 通过 app-server 的 `thread/read`、`thread/resume` 和 `turn/start` 安全继续；闲置 Claude session 使用 stream-json runner。
- 活跃外部终端 session 禁止 TTY 注入；精确 hook 审批仍可按原请求闭环。
- SQLite WAL 分开保存规范事件、任务状态、Agent 帖子、设备和操作审计，原始 transcript 不复制入库，默认保留 7 天。
- 本机 loopback 管理页与 X25519 配对；后续 WebSocket 帧使用 XChaCha20-Poly1305、单调计数器与防重放校验。

详细实现见 [架构说明](docs/ARCHITECTURE.md) 与 [验证手册](docs/TESTING.md)。

## 环境要求

- macOS 14+
- Node.js 24+
- Codex CLI 与/或 Claude Code（由用户自行安装、登录）
- 源码开发使用 pnpm 10

## 从源码运行

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js start
```

打开 `http://127.0.0.1:4747`。手机访问时运行：

```bash
node apps/cli/dist/index.js start --lan
```

然后在 Mac 本机 Profile 页面生成 2 分钟、单次使用的二维码。LAN 审批每次 Bridge 启动后默认关闭，必须在 loopback 管理页显式开启。

## npm CLI

三个可发布包分别是 `@zimlo/protocol`、`@zimlo/adapters` 和 `@zimlo/cli`。构建后的 `pnpm pack` 会把 workspace 依赖固定为当前版本；发布后用户可运行：

```bash
npm install --global @zimlo/cli
zimlo doctor
zimlo start
```

CLI 命令：

```text
zimlo start [--lan] [--port 4747]
zimlo doctor
zimlo hooks diff|install|status|uninstall
zimlo mcp --provider codex|claude
zimlo devices list|revoke <device-id>
zimlo open
```

被动发现无需 hooks，但被动 session 只会出现在 Tasks，不会自动产生 Feed。要启用主动发帖协议，先安装 hooks，再把 Zimlo 的本地 MCP server 加给两个 Agent：

```bash
zimlo hooks diff
zimlo hooks install
codex mcp add zimlo -- zimlo mcp --provider codex
claude mcp add --scope user zimlo -- zimlo mcp --provider claude
```

安装器采用备份、临时文件与 rename 原子合并，卸载只移除 Zimlo 自己的 handler。Codex 首次安装后还应在 Codex 中运行 `/hooks` 检查并信任新 hook；Claude Code 可用 `/mcp` 检查工具是否已连接。

Agent 的编辑门槛内置在工具描述中：只有信息会改变用户理解、要求行动，或帮助日后还原任务时才发帖。普通 tool call、文件读取、编译测试过程、短暂重试和心跳应使用沉默；本轮结束时如果确实没有值得说的内容，则调用 `feed.skip`。

## 本地数据

```text
~/.zimlo/zimlo.db
~/.zimlo/config.json
~/.zimlo/run/bridge.sock
~/.zimlo/logs/
```

数据库与 Unix Socket 权限为 `0600`，目录为 `0700`。API Key、Bearer Token、环境变量赋值、`.env` 内容与常见私钥格式会在事件入库前过滤；事件正文最多保留 4 KB。

## 安全边界

这是可信局域网技术 Beta，不是远程访问产品。配对后的敏感消息具有应用层加密，但初始网页仍通过本地 HTTP 交付，无法抵抗局域网内主动篡改页面的攻击。首版不包含云 Relay、TLS 终止、iOS/Android App、远程终端、多人协作或代码编辑器。

实现为 clean-room 代码，没有复制 open-vibe-island 的 GPLv3 源码，也没有引入 CodeIsland 源码。
