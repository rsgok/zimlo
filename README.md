# Zimlo Local Web MVP

Zimlo 是 Codex 与 Claude Code 的本地移动状态层。它自动发现 Mac 上已经存在或正在运行的 session，同时给 Agent 提供显式的 `feed.post`、`feed.skip` 与 `signal.transition` 工具，在可信局域网内提供可配对的响应式 Timeline。

## 当前能力

- 每 2 秒扫描 Codex/Claude Code 进程，并增量读取最近 7 天、每个 provider 最多 200 个 transcript。
- 把发现到的 Git root/工作目录持久化为 Project；每个 Project 拥有可编辑的 Agent Profile（名称、头像、简介、默认 Runtime），同一 Agent 下聚合 Codex 与 Claude Code Tasks 和插件卡片。
- 使用 provider session id、transcript 路径、PID/启动时间、TTY、打开文件和父进程做保守关联；cwd 绝不作为唯一合并依据。
- 用户原始指令只保留在 Task 详情；Feed 只接收 Agent 主动编辑的结构化阅读卡和真实待处理操作，平台不 scrape 输出，也不二次生成摘要。
- `signal.transition` 单独维护机器任务状态；Feed 不是状态 source of truth。
- 普通轮次可以静默结束；Stop hook 只幂等记录 `implicit_skip`，不会打断或把内部协议提示发进对话。关键状态仍会校验匹配的帖子种类。
- 主 Feed 使用全屏纵向 scroll-snap，一屏一张卡；待处理、失败、结果、判断和进展按内容价值排序，六小时内同任务的常规更新自动合并，稳定停留一秒后按设备记录已读。
- 左滑 Feed 卡进入所属 Task Detail，右滑将卡片从本设备的当前与历史 Feed 中移除；卡片上的 Agent 身份进入跨任务 Agent Profile。
- 底部导航为 `Feed · Tasks · ＋ · Agents`；设备、安全和 Runtime 接入位于右上角 Settings。
- 底部 `+` 可从 Mac 已发现的可信项目中创建 Codex/Claude Code 任务；运行中 follow-up 会先持久化，再等待精确 session 空闲后执行。
- 新任务默认最近 Project Agent/Runtime，支持项目搜索和草稿恢复；发送后立即出现启动中占位卡。Task Detail 的 follow-up 同样保存草稿、显示队列状态并阻止同文重复提交。
- Task Detail 固定展示 Task Input、状态、最新结论和下一步；Timeline 按设备保存阅读位置。
- 只有真实测试命令与真实退出码才能生成 `tests_passed` / `tests_failed`。
- 闲置 Codex session 通过 app-server 的 `thread/read`、`thread/resume` 和 `turn/start` 安全继续；闲置 Claude session 使用 stream-json runner。
- 活跃外部终端 session 禁止 TTY 注入；精确 hook 审批仍可按原请求闭环。
- SQLite WAL 分开保存 Project/位置/Agent Profile、Session、规范事件、任务状态、任务指令队列、Agent 帖子、每设备已读与移除状态、设备和操作审计；Project、Task Input 与任务目录长期保留，详细活动默认保留 7 天，原始 transcript 不复制入库。
- Session 额外保存最近一次可靠运行界面：`GUI / CLI / Zimlo managed / unknown`；切换界面不会拆成新的 Task Detail。
- 本机 loopback 管理页与 X25519 配对；后续 WebSocket 帧使用 XChaCha20-Poly1305、单调计数器与防重放校验。

详细实现见 [架构说明](docs/ARCHITECTURE.md) 与 [验证手册](docs/TESTING.md)。

## 环境要求

- macOS 14+
- Node.js 24+
- Codex CLI 与/或 Claude Code（由用户自行安装、登录）
- 源码开发使用 pnpm 10

## 快速启动

### 在本仓库中首次启动

先安装依赖、构建并检查本机环境：

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js doctor
```

如果要在手机浏览器或原生 iOS App 使用 Zimlo，推荐这样启动：

```bash
node apps/cli/dist/index.js start --lan
```

终端出现以下信息就表示启动成功：

```text
Zimlo 已启动：http://127.0.0.1:4747
可信局域网：http://<你的 Mac 局域网地址>:4747
按 Ctrl-C 停止。
```

保持这个终端窗口运行，然后：

1. Mac 打开 [http://127.0.0.1:4747](http://127.0.0.1:4747)；
2. 在右上角 **Settings → 配对手机 Safari** 生成二维码；
3. 手机与 Mac 连接同一个可信局域网，用 Safari 扫码完成配对；
4. 原生 iOS App 也连接这个 `--lan` Bridge，构建与运行见 [iOS README](apps/ios/README.md)。

手机审批必须由 Mac 在已知设备列表中逐台授权；授权会跨 Bridge 重启保留，高风险操作仍要求确认短语。

### 只在 Mac 本机使用

不需要手机访问时可以省略 `--lan`：

```bash
node apps/cli/dist/index.js start
```

此时只监听 `127.0.0.1`，同一局域网内的手机无法连接。

### 以后每天怎么启动

依赖和代码没有变化时，不需要重复 `pnpm install` 或 `pnpm build`，直接运行：

```bash
node apps/cli/dist/index.js start --lan
```

拉取新代码、切换分支或修改 Web/CLI 源码后，先重新执行 `pnpm build`。使用 `Ctrl-C` 可以安全停止 Bridge。

### 已全局安装 CLI

如果已经通过 npm 安装 `@zimlo/cli`，对应命令更短：

```bash
zimlo doctor
zimlo start --lan
```

常用启动方式：

```text
zimlo start                         # 仅 Mac 本机
zimlo start --lan                   # Mac + 手机，推荐
zimlo start --lan --port 4748       # 使用自定义端口
zimlo open                          # 打开默认端口的本机管理页
```

Codex GUI 插件在调用 Zimlo MCP 时可以自动拉起仅本机 Bridge，但不会自动开放局域网。需要手机访问时，仍应在终端显式运行 `zimlo start --lan`。

## npm CLI

三个可发布包分别是 `@zimlo/protocol`、`@zimlo/adapters` 和 `@zimlo/cli`。构建后的 `pnpm pack` 会把 workspace 依赖固定为当前版本；发布后用户可安装：

```bash
npm install --global @zimlo/cli
```

CLI 命令：

```text
zimlo start [--lan] [--port 4747]
zimlo doctor
zimlo codex-plugin install|status|uninstall
zimlo hooks diff|install|status|uninstall
zimlo mcp --provider codex|claude
zimlo devices list|revoke <device-id>
zimlo open
```

被动发现无需 hooks，但被动 session 只会出现在 Tasks，不会自动产生 Feed。主动发帖协议需要 Agent 获得 Zimlo MCP 工具和编辑规则。

### Codex GUI

启动 Zimlo 后，在本机网页打开 **Settings → Codex GUI 发帖插件**：

1. 点击“准备 Codex 插件”；
2. 点击“在 Codex 中打开”；
3. 在 Codex GUI 的 Plugins → Personal 中安装 Zimlo，并审核它声明的 hooks；
4. 新建一个 Codex 任务。

整个流程不使用 `/hooks`。网页按钮等价于：

```bash
zimlo codex-plugin install
```

插件统一携带 `zimlo-feed` Skill、`feed.post` / `feed.skip` / `signal.transition` MCP 工具和精简的 lifecycle hooks。MCP 启动时会按需自动拉起本地 Bridge，因此 Codex GUI 不要求用户先输入终端命令。安装时使用当前 Node 与 CLI 入口的绝对路径，因此不依赖 Codex GUI 继承终端的 npm PATH。插件安装或升级后必须新建任务，已有任务不会动态获得新 Skill 和工具。

### Codex CLI 与 Claude Code

Codex CLI 和 Claude Code 仍可使用手动集成：

```bash
zimlo hooks diff
zimlo hooks install
codex mcp add zimlo -- zimlo mcp --provider codex
claude mcp add --scope user zimlo -- zimlo mcp --provider claude
```

安装器采用备份、临时文件与 rename 原子合并，卸载只移除 Zimlo 自己的 handler。只有 Codex CLI 使用 `/hooks` 检查并信任用户级 hook；Codex GUI 使用上面的 Plugins 页面。Claude Code 可用 `/mcp` 检查工具是否已连接。

也可以在 Mac 本机的 **Settings → Runtime 接入方式** 中查看 Codex/Claude 的 GUI、CLI 状态，并显式点击“配置 / 修复 CLI 接入”。Zimlo 启动时不会静默修改用户配置；Claude Code 的 GUI 与 CLI 共用用户级 Hooks/MCP，hook 会根据终端与父进程链记录实际 surface。Zimlo 自己创建的 Codex app-server 与 Claude runner 任务标记为 `Zimlo 托管`。

Agent 的编辑门槛内置在工具描述与 Skill 中：只有信息会改变用户判断、行动或信心才发帖。每张卡按“结论 → 用户影响 → 关键事实 → 证据 → 下一步”书写，并从 `paper / grid / sticky / marker / poster` 中选择模板。普通 tool call、文件读取、编译测试过程、短暂重试和心跳应保持沉默；只有受控 Runner 或显式 `completed` 状态检查点才需要用 `feed.skip` 记录“本轮不发”。

Feed V2 的 `feed.post` 使用结构化字段：`headline`、`takeaway`、最多三条 `highlights`、可选 `proof`，以及需要用户处理时的 `action_prompt`。升级插件后必须新建 Codex 任务；旧任务缓存的 V1 工具参数不再兼容。

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
