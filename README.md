# Zimlo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Zimlo 是 Codex 与 Claude Code 的隐私优先移动状态层。它自动发现 Mac 上已经存在或正在运行的 session，同时给 Agent 提供显式的 `feed.post`、`feed.skip` 与 `signal.transition` 工具。手机默认通过 Cloudflare 与 Mac 完成配对和远程同步；局域网直连只是更快的可选路径。

## 当前能力

- 每 2 秒扫描 Codex/Claude Code 进程，并增量读取最近 7 天、每个 provider 最多 200 个 transcript。
- 把发现到的 Git root/工作目录持久化为 Project；每个 Project 拥有可编辑的 Agent Profile（名称、头像、简介、默认 Runtime），同一 Agent 下聚合 Codex 与 Claude Code Tasks 和插件卡片。
- 使用 provider session id、transcript 路径、PID/启动时间、TTY、打开文件和父进程做保守关联；cwd 绝不作为唯一合并依据。
- 用户原始指令只保留在 Task 详情；Feed 只接收 Agent 主动编辑的结构化阅读卡和真实待处理操作，平台不 scrape 输出，也不二次生成摘要。
- `signal.transition` 单独维护机器任务状态；Feed 不是状态 source of truth。
- 普通轮次可以静默结束；Stop hook 只幂等记录 `implicit_skip`，不会打断或把内部协议提示发进对话。关键状态仍会校验匹配的帖子种类。
- 主 Feed 使用沉浸式一屏一卡，序列在页面会话内固定；阅读中已有卡不因已读、快照刷新或真实审批完成而换位。新内容只短暂浮出“有新内容”，用户真实开始浏览后自动消失。六小时内同任务的常规更新自动合并，稳定停留一秒后按设备记录已读。
- 左滑 Feed 卡进入所属 Task Detail，右滑将卡片从本设备的当前与历史 Feed 中移除；卡片上的 Agent 身份进入跨任务 Agent Profile。Feed 移除与任务归档都是乐观更新并提供 6 秒撤销（`feed.dismiss.set` 携带幂等键，旧 `feed.dismiss` 保留兼容）。
- 底部导航为 `Feed · Tasks · 对话 · Agents · 设置`；中间“对话”是操作入口而不是 Tab。
- 在 Feed 与任务详情中，“对话”关联当前可靠 session；在其他页面或无法可靠关联时进入新任务模式，绝不误发到其他会话。
- 统一输入面板默认不录音、不弹键盘，支持文字、按需语音和附件；草稿按 session 或新任务模式分别恢复，发送继续经过可靠 outbox。
- Web 与 iOS 发送体验一致：先持久化本机 outbox，同周期清空输入与草稿并立即展示本地 pending；服务端拒绝标失败并保留原文，可在 outbox 详情（类型、目标、预览、时间与状态）中重试或重新编辑；本地或服务端仍 queued 的 create/follow-up 可撤回（`task.command.cancel`）。
- Task Detail 固定展示 Task Input、状态、最新结论和下一步；Timeline 按设备保存阅读位置。
- 每张可关联任务的 Feed 卡都能通过统一“对话”入口继续讨论；不再生成接受/修改型 Review 对象。
- 每个 Project 可单独开启“安全自动化”：只自动允许项目边界内可确认的读取、搜索、测试和构建；写入、联网、安装、发布、删除与未知动作继续询问并保留审计。
- 高风险审批双确认：iOS 用底部 Sheet 完整展示风险、作用域、目标命令与确认短语，「填入确认短语」后再次明确提交（不使用 Face ID）；Web 保持同一双确认语义（自动聚焦、Enter 提交、44px 点击目标）。
- 撤销设备与解除配对都有确认对话框；解除配对清理本机凭据、快照、outbox、设备草稿与待路由通知，保留界面偏好。
- iOS 可在完成配对后按需开启审批与失败通知。默认锁屏不显示任务标题，通知只携带设备端可解密的任务路由。低风险审批（无确认短语的批准一次/拒绝）支持锁屏快捷操作：APNs category 只是明文通用标识，决策 id 只放在加密路由内；高风险与需输入的审批仍只能进 App 处理。通知权限被拒时设置页给出去系统设置的引导。
- 原生 iOS 与 PWA 都会优先本地直连，失败后自动切到 Cloudflare；顶栏明确显示“本地 / 云端 / 重连”。双端统一按 1/2/4/8/16/30 秒 ±20% 抖动退避重连，认证成功或回到前台时重置，系统离线时暂停，顶栏与离线胶囊都可手动立即重试。Cloudflare 不保存任务正文，Mac 离线时手机显示保存在设备本地的最近快照（带 savedAt，界面显示“数据更新于 X 分钟前”），操作进入可靠 outbox。
- Web 使用语义化字体 token 与字号阶梯（正文不小于 13px）；iOS 用语义字体与圆角体系并支持 Dynamic Type。
- 只有真实测试命令与真实退出码才能生成 `tests_passed` / `tests_failed`。
- 闲置 Codex session 通过 app-server 的 `thread/read`、`thread/resume` 和 `turn/start` 安全继续；闲置 Claude session 使用 stream-json runner。
- 活跃外部终端 session 禁止 TTY 注入；精确 hook 审批仍可按原请求闭环。
- SQLite WAL 分开保存 Project/位置/Agent Profile、Session、规范事件、任务状态、任务指令队列、Agent 帖子、每设备已读与移除状态、设备和操作审计；Project、Task Input 与任务目录长期保留，详细活动默认保留 7 天，原始 transcript 不复制入库。
- 新任务可附带图片、短视频、PDF 与常用文档；字节走独立 HTTPS 而非 WebSocket，远程上传在设备端加密后只把临时密文放进 Cloudflare R2。Feed 用独立图片组、视频和文档卡展示，iOS 可用系统 Quick Look 打开 PDF。
- Session 额外保存最近一次可靠运行界面：`GUI / CLI / Zimlo managed / unknown`；切换界面不会拆成新的 Task Detail。
- 本机 loopback 管理页与 X25519 配对；后续 WebSocket 帧使用 XChaCha20-Poly1305、单调计数器与防重放校验。

详细实现见 [架构说明](docs/ARCHITECTURE.md) 与 [验证手册](docs/TESTING.md)。

## 普通用户：下载安装即可

正式版本的使用方式是：

1. 在 Mac 下载并打开 **Zimlo.app**，按首次启动引导完成 Agent 接入；
2. Zimlo 常驻菜单栏并自动管理本机后台服务，不需要打开终端；服务异常时菜单栏提供重试、查看日志与打开服务目录。崩溃按 1–30 秒退避自动重启、两分钟五次失败熔断；端口占用（尽力显示进程名/PID）、配置损坏或运行时缺失属于终止型故障，不自动重启；
3. 在 iPhone 安装 Zimlo，扫描 Mac 显示的二维码；
4. 配对通过 Cloudflare 的两分钟临时房间完成，手机和 Mac 不需要连接同一个 Wi‑Fi；
5. 手机离开局域网后仍可继续查看、批准、回复和审阅。Mac 必须保持开机并运行 Zimlo。

当前仓库会生成一个供开发与内部验证使用的 ad-hoc 签名 macOS App：

```bash
pnpm macos:build
open apps/macos/.build/Zimlo.app
```

该开发包已经是 Universal App，包含 Intel / Apple Silicon Node Runtime 和 Sparkle（自动检查并下载更新，由用户手动安装）。正式发布命令会完成 Developer ID 签名、公证、DMG、Sparkle appcast 与 Cloudflare R2 上传；第一次公开发布仍需提供 Apple Developer 凭据、Sparkle 密钥并在 Cloudflare 账号中启用 R2。普通用户最终不会接触 `pnpm`、Node.js 或 `zimlo start`。

## 开发者：从源码运行

环境要求：

- macOS 14+
- Node.js 24+
- pnpm 10
- 已安装并登录 Codex 与/或 Claude Code

首次构建和检查：

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js doctor
```

启动开发 Bridge：

```bash
node apps/cli/dist/index.js start
```

终端出现以下信息就表示启动成功：

```text
Zimlo 已启动：http://127.0.0.1:4747
按 Ctrl-C 停止。
```

保持这个终端窗口运行，然后：

1. Mac 打开 [http://127.0.0.1:4747](http://127.0.0.1:4747)；
2. 在右上角 **Settings → 配对手机** 生成二维码；
3. 用 iPhone App 扫码。二维码包含短时 Cloudflare 配对房间，不要求同一局域网；
4. iOS 构建与运行见 [iOS README](apps/ios/README.md)。

手机审批必须由 Mac 在已知设备列表中逐台授权；授权会跨 Bridge 重启保留，高风险操作仍要求确认短语。
手机管理 Project 自动化策略也必须由 Mac 在设备列表中单独授权；首次授权不能由手机自行提升。

需要验证局域网直连时才加 `--lan`；它是开发/诊断选项，不是普通用户步骤：

```text
zimlo start                         # 默认：本机管理 + 云端配对/同步
zimlo start --lan                   # 可选：同时开放可信局域网直连
zimlo start --port 4748             # 开发时使用自定义端口
zimlo open                          # 打开本机管理页
```

Codex GUI 插件调用 Zimlo MCP 时也可以按需拉起本机 Bridge，不要求用户先运行命令。

启动后的健康检查使用 protocol v4，并通过 capability 增量声明新能力：

```bash
curl http://127.0.0.1:4747/healthz
```

响应中的 `features.projectTrustPolicy`、`features.pushNotifications`、`features.remoteSync`、`features.multiHost` 为 `true` 时，客户端才显示相应入口。协议 v4 客户端遇到旧 Bridge 时会明确提示升级，不会进入无限重连。

同一个 iOS/Web 客户端可以配对多台 Mac。每台 Mac 拥有稳定的 `hostId` 和独立端到端加密通道；客户端只在本地合并 Feed、任务和离线快照，回复、审批、附件与 outbox 会按来源 `hostId` 精确回到对应 Mac。设置页的“运行设备”可查看连接状态并继续添加 Mac。

## 手机离开局域网后如何工作

Cloudflare 不是任务数据库，Mac 仍是唯一的任务状态源：

1. Mac 用安装私钥签名并建立到 Durable Object 的长连接；
2. 手机使用配对时取得的设备令牌连接同一 Durable Object；发现可信本地地址时也可优先走 LAN；
3. Durable Object 只按安装与连接 ID 转发密文；现有 Bridge 在密文内部再次验证设备身份、加密消息并防重放；
4. Mac 在线时，快照、审批、回复和审阅实时同步；Mac 离线时，Cloudflare 返回离线状态，手机显示最近缓存，写操作保存在设备 outbox；
5. Mac 恢复连接后，客户端重新请求最新快照并幂等重放未确认操作。

因此，手机离开电脑的 Wi-Fi **可以继续使用**，但 Mac 必须开机并运行 Zimlo。Mac 关机时不会把代码、任务正文或可执行操作托管到云端。

默认线上服务已经部署在 `https://zimlo-cloud.zimlo.workers.dev`，普通用户无需配置服务器。自建或本地开发可覆盖：

```bash
export ZIMLO_CLOUD_URL="https://zimlo-cloud.<account>.workers.dev"
```

设置 `ZIMLO_CLOUD_DISABLED=1` 可以完全关闭远程通道，只保留 LAN。

已在旧版本完成配对的手机没有云端设备令牌，启用 Cloudflare 后需要撤销并重新配对一次。

## iPhone 安装与通知

开发阶段需要用 Xcode 将原生 App 安装到模拟器或已登记真机，详细步骤见 [iOS README](apps/ios/README.md)。普通用户的目标路径是从 TestFlight / App Store 安装；不会要求运行 Mac 命令。APNs 主动通知只由原生 iOS App 提供。

通知与远程同步共用 Cloudflare 服务，但用途分离：通知只负责唤醒用户，真实状态总是在 App 打开后向 Mac 同步。Cloudflare D1 只保存安装公钥、设备令牌哈希、APNs token、每设备 sandbox/production 环境、路由公钥和投递审计，不保存任务标题、提示词、代码或结果。

## npm CLI

三个可发布包分别是 `@zimlo/protocol`、`@zimlo/adapters` 和 `@zimlo/cli`。构建后的 `pnpm pack` 会把 workspace 依赖固定为当前版本；发布后用户可安装：

```bash
npm install --global @zimlo/cli
```

CLI 命令：

```text
zimlo start [--lan] [--port 4747]
zimlo status [--json]
zimlo stop
zimlo logs [--follow] [--desktop|--cli]
zimlo doctor
zimlo codex-plugin install|status|uninstall
zimlo hooks diff|install|status|uninstall
zimlo mcp --provider codex|claude
zimlo devices list|revoke <device-id>
zimlo open
```

`zimlo status` 报告服务描述文件、PID 归属、端口、/healthz 协议版本、socket、启动诊断与日志路径；`zimlo stop` 校验描述文件归属后发送 SIGTERM，并写入手动停止标记（macOS 不会自动拉起，`zimlo start` 重新启动时清除）；`zimlo open` 读取真实地址并先健康检查再打开。`zimlo doctor` 覆盖 Bridge、端口、协议版本、Agent 集成与启动诊断，每个失败项给出可复制的修复命令，阻塞项失败时以非零退出。

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

`zimlo hooks diff` 默认输出事件级摘要（新增/移除/保留的 hook 条数，`--json` 查看全量配置）；`zimlo hooks install` 只给已安装的 Agent 写配置，并打印每个文件的改动与备份路径。安装器采用备份、临时文件与 rename 原子合并，卸载只移除 Zimlo 自己的 handler。只有 Codex CLI 使用 `/hooks` 检查并信任用户级 hook；Codex GUI 使用上面的 Plugins 页面。Claude Code 可用 `/mcp` 检查工具是否已连接。

也可以在 Mac 本机的 **Settings → Runtime 接入方式** 中查看 Codex/Claude 的 GUI、CLI 状态，并显式点击“配置 / 修复 CLI 接入”。Zimlo 启动时不会静默修改用户配置；Claude Code 的 GUI 与 CLI 共用用户级 Hooks/MCP，hook 会根据终端与父进程链记录实际 surface。Zimlo 自己创建的 Codex app-server 与 Claude runner 任务标记为 `Zimlo 托管`。

Agent 的编辑门槛内置在工具描述与 Skill 中：只有信息会改变用户判断、行动或信心才发帖。每张卡按“结论 → 用户影响 → 关键事实 → 证据 → 下一步”书写，并从 `paper / grid / sticky / marker / poster` 中选择模板。普通 tool call、文件读取、编译测试过程、短暂重试和心跳应保持沉默；只有受控 Runner 或显式 `completed` 状态检查点才需要用 `feed.skip` 记录“本轮不发”。

Feed V3 的 `feed.post` 使用结构化字段：`headline`、`takeaway`、最多三条 `highlights`、可选 `proof` 和 Artifact。卡片不再携带接受、修改或审批字段；真实高风险操作继续通过独立 `PendingAction` 明确批准或拒绝。升级插件后必须新建 Codex 任务，旧协议客户端需要同步升级。

## 本地数据

```text
~/.zimlo/zimlo.db
~/.zimlo/config.json
~/.zimlo/run/bridge.sock
~/.zimlo/run/service.lock/               # 实例锁（owner.json：pid/token/entrypoint/startedAt）
~/.zimlo/run/service.json                # 运行中 Bridge 的服务描述符
~/.zimlo/run/startup-diagnostics.json    # 最近一次启动诊断
~/.zimlo/run/manual-stop                 # zimlo stop 写入；仅 macOS 自动管理尊重
~/.zimlo/logs/
```

数据库与 Unix Socket 权限为 `0600`，目录为 `0700`。API Key、Bearer Token、环境变量赋值、`.env` 内容与常见私钥格式会在事件入库前过滤；事件正文最多保留 4 KB。

## 安全边界

这是端到端加密远程同步 Beta，不是云端代码执行平台。首次配对通过只有两分钟寿命的一次性 Cloudflare rendezvous 交换设备公钥与加密配置；配对服务不接触任务正文。完成配对后，LAN 与 Cloudflare 通道都使用相同的设备认证和应用层加密。Cloudflare 不提供远程 shell、任务正文存储、多人协作或代码编辑器。Beta 已对安装注册和中继认证启用 Cloudflare 速率限制；正式规模化发布前仍需补充账号或邀请体系以及账户级配额。

实现为 clean-room 代码，没有复制 open-vibe-island 的 GPLv3 源码，也没有引入 CodeIsland 源码。

## 开源许可

Zimlo 的源代码以 [MIT License](LICENSE) 开源，可自由使用、修改、分发和用于商业项目，但须保留版权与许可声明。

`Zimlo` 名称、Logo 与官方发行身份不包含在 MIT 授权中；未经许可，不得以官方版本或官方服务的名义进行分发。
