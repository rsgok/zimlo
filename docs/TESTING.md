# 验证手册

## Codex GUI 插件

```bash
pnpm exec vitest run apps/cli/test/codex-plugin.test.ts
node apps/cli/dist/index.js codex-plugin status
```

手工验证：在本机 Settings 点击“准备 Codex 插件”，使用 deeplink 打开 Codex Plugins，安装并审核 hooks，然后**新建**任务。确认新任务只看到 `feed.post` 与 `material.publish`，MCP 会在 Bridge 未运行时自动拉起它；插件只声明 `SessionStart`、`PermissionRequest` 与 matcher 为 `request_user_input` 的 `PreToolUse`。用户原始指令只进入 Task Detail，不得出现在 Feed。普通轮次必须为 0 hook 且静默结束；只有可审阅产物、用户行动、终止性失败/阻塞或最终结果才调用结构化 `feed.post`。

旧版兼容回归：给 hook transport 输入一个没有 Feed 决策的 `Stop` 事件，stdout 必须为空，SQLite 对应 checkpoint 应变为 `implicit_skip`；重复同一 Stop 仍为空且不会覆盖显式 `post/skip`。新安装配置不得再声明 Stop hook。

## 自动验证

```bash
pnpm architecture:check
pnpm test
pnpm typecheck
pnpm build
node apps/cli/dist/index.js doctor
```

核心仓库可直接运行 `pnpm check`。发布或大范围重构使用 `pnpm check:all`，它会额外验证
macOS Swift package、`landing-page` 与 `work-report`，并在结束后恢复报告的已跟踪事实快照。协议或产品版本只修改
`config/zimlo-contract.json`，随后运行 `pnpm contract:generate`；生成文件不允许手改。

`pnpm test` 覆盖 Codex/Claude fixture parser、Project 回填与卡片归属、测试命令识别、脱敏、Feed 发帖去重与结束检查点、Action Broker 幂等与重启过期、网络地址判断、协议加密/防重放，以及 Codex app-server 审批值映射。

本轮新增的自动化覆盖：

- `packages/protocol`：`packages/protocol/test-vectors/` 的 6 组版本化 JSON 向量（共 83 case）逐条断言 `policy.ts` 的 Feed 合并/优先级、outbox 语义键、重连退避、快捷审批资格与可撤回状态；`client-commands` 测试覆盖 `task.command.cancel`（恰选其一定位）、`feed.dismiss.set` 与旧 `feed.dismiss` 兼容、归档/置顶的可选 idempotencyKey，以及 PushRouteV1 推送路由 schema。
- `apps/cli` 新增 11 个测试文件：稳定 API 错误结构（api-error）、设备列表（device-list）、doctor、feed.dismiss.set 幂等（feed-dismiss）、hooks 事件级摘要（hook-config-summary）、集成探测（integration-probes）、探测缓存（probe-cache）、服务探测（service-inspect）、服务状态文件（service-state）、指令撤回（task-command-cancel）与任务偏好（task-preferences）。
- `apps/web`：feedSequence 固定序列/锚定/移除调和、reconnect 退避控制器、OutboxSheet 撤回语义，以及直接引用 `@zimlo/protocol` 策略函数保证与 iOS 的向量一致性。
- `apps/ios`：`VectorTests` 用 XCTest 读取同一组 JSON 向量逐 case 断言 `SharedRules.swift`；`BehaviorTests` 覆盖高风险双确认状态机、快照缓存 savedAt 迁移、dismiss/undo 乐观更新、outbox 撤回与快捷审批路由解析。在没有 iOS 模拟器运行时的机器上，纯逻辑层（`SharedRules.swift`、`QuickApprove.swift`，均不 import UIKit）可用 macOS SDK 的 swiftc 直接编译驱动向量与逻辑断言，作为 XCTest 之外的兜底验证方式。
- `apps/macos`（`pnpm macos:test`）：`ServiceRecoveryTests`（22 个）覆盖退避/熔断、启动日志故障分类、端口占用解析、二维码倒计时与版本号；`ServiceContractsTests`（8 个）覆盖 manual-stop 标记、service.json 描述符与 /healthz 协议版本契约。
- `landing-page`：waitlist 单元测试 18 个 + Worker 集成测试 8 个（`npm test` 随构建运行）。

启动 Bridge 后可运行端到端加密握手 smoke：

```bash
node apps/cli/dist/index.js start --port 4747
pnpm --filter @zimlo/cli smoke
```

## 发布前人工矩阵

| 场景 | 预期 |
|---|---|
| 已运行 Codex / Claude session | 5 秒内出现在 Tasks |
| 同 cwd 两个 session | 保持两个 session，不交叉事件 |
| 同 Git root 的 Codex/Claude session | 共享一个持久 Project，仍保留各自 Session |
| Git 项目移动或改名 | 通过 Git identity 找回相同 UUID，Agent 名称、头像和默认 Runtime 保留 |
| Agents 目录与详情 | Project Agent 身份优先于 Runtime；跨任务 Timeline 可进入对应 Task Detail |
| 插件 FeedPost | 同时继承强 Session 与 Project；无法确定时保持未归属 |
| 旧数据库升级 | 幂等回填 Project/Session/FeedPost，不丢历史 Timeline |
| JSONL 追加/截断/轮转 | 增量恢复，不产生 Feed 帖子 |
| 真实测试成功/失败 | 依据命令与 exit code 生成正确测试事件 |
| 外部终端正在运行 | 回复按钮关闭并显示原因 |
| 空闲 Codex 回复 | app-server 握手、resume、turn 完成 |
| 四个并发审批 | 每个 action 只解析到自己的上游请求 |
| 双击/重放/断线重试 | 同一 idempotency key 不重复执行 |
| 手机离开 LAN、Mac 在线 | 自动从“本地”切成“云端”，Snapshot、审批和回复继续同步 |
| Mac 离线、手机在外网 | 显示最近缓存与“重连”，操作只进入设备 outbox，不写入云端任务库 |
| Mac 恢复在线 | 拉取最新 Snapshot，幂等发送 outbox，不产生重复审批或回复 |
| 撤销手机 | 本地设备身份和 Cloudflare 设备记录都失效，旧令牌不能再次连接 |
| Bridge 在审批时崩溃 | resolver 失效，重启后旧 action 过期 |
| Mac Safari/Chrome、iPhone Safari | 一屏一帖、Tasks、Agents、Task Detail 与 Settings 无横向溢出 |
| 320×568、390×844、768px、桌面 | 五套文字卡无横向溢出；普通卡无内部滚动 |
| Feed 内容收敛 | 标题最多三行、正文最多四行、事实最多两条；证据只在 Task Detail 展示 |
| Task Detail 阅读位置 | 每台设备独立保存 Timeline cursor；重开时准确显示未读数量 |
| 新任务与 follow-up 草稿 | 刷新或重开后恢复；相同在途指令不会重复入队；失败保留原文 |
| 输入、普通审批、高风险审批 | 卡内完成操作；确认短语只在选择高风险决策后展开 |
| Plugin 旧内容版本 | status 提示重新安装；重新安装后要求新建任务 |
| hook 安装/升级/卸载 | 用户已有配置与非 Zimlo handler 保持不变 |
| GUI/CLI/托管来源 | surface 正确显示；unknown 更新不能覆盖已确认来源 |
| Tasks 稳定性 | 普通活动时间更新不重排项目或组内任务；只有关注状态变化可跨组 |
| 新任务按钮 | 默认不使用 Tab 选中态；Composer 打开时才高亮 |
| 机密 fixture | SQLite、网页消息和日志均不含原始机密 |

## 性能采样

Beta 发布前以 10 个 session、4 个并发审批和 20 个活跃 session 采样发现延迟、hook p95、被动事件 p95、CPU、RSS 与滚动流畅度。目标分别为 ≤5 秒、≤1 秒、≤3 秒、空闲 CPU <3%、RSS <250 MB。
