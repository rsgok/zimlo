# Mac 与 iOS 完整产品验收 · 2026-09-06

## 结论与运行范围

本次使用正常 App 入口、真实用户数据、真实 Mac 后台、cloud.zimlo.app 加密连接和真实 Codex 执行器完成主流程；没有使用 Gallery Review 启动参数或隔离数据替代产品验收。

- Mac：本工作区完整构建 `apps/macos/.build/Zimlo.app`，应用版本 0.3.1，内嵌 Runtime `0.3.1-local-20260906-mcp`。当前运行该完整开发签名包；未覆盖 `/Applications/Zimlo.app`，未发布新版本。
- iOS：完整 Zimlo App，iPhone 17 Pro / iOS 26.5 Simulator，正常模拟器签名，正常 Keychain 和云端配对。
- 真机：已发现配对的 iPhone 15 Pro Max，iPhoneOS 开发签名构建成功；安装因 CoreDevice 无线连接超时失败。真机运行、相机扫码、实际触控、后台推送/APNs 不记为通过，需手机解锁并连接数据线后继续。

## 实际走通的用户流程

| 流程 | 实测结果 |
| --- | --- |
| Mac 启动、安装/启动后台、读取真实项目和任务 | 通过；识别并排除了旧后台及 Linux 端口转发冲突 |
| Codex App / CLI 接入修复 | 正常设置页完成，状态为 ready；Claude 本轮未配置或执行 |
| Mac 生成/复制连接码，iOS 正常云端配对 | 通过；读取真实任务、项目与设备状态 |
| iOS 保存连接，退出/重启 App | 通过；恢复已有连接，无需重新配对 |
| Mac 创建任务、iOS 搜索并进入该任务 | 通过；同一个真实 Codex session |
| iOS 追加指令、审批素材与成果发布 | 通过；三次 material.publish 和一次 feed.post 审批收到后台确认 |
| Agent 成果进入 Mac 与 iOS Feed | 通过；相同帖子、相同三份独立原文件、相同顺序 |
| Mac 三张翻页、键盘方向键、原图查看/关闭 | 通过；纵向截图完整显示，没有缩略图 |
| iOS 三张翻页、原图查看/关闭 | 通过；使用系统可访问翻页动作验证 1/3 → 2/3 → 3/3。普通手指滑动的真机体验仍待真机检查 |
| 下载文件与原文件一致 | Mac/iOS 实际缓存三份文件的 SHA-256 全部匹配 |
| Mac 设备列表、移除设备 | 通过；仅清理本次失败配对产生的遗留测试设备，保留成功配对设备 |
| Mac 离线时手机发送，重启手机，再恢复 Mac | 通过；消息保留并自动续发，只产生一条指令和一个执行轮次 |

## 本次完整流程发现并修复的问题

1. Mac 连接页只有二维码：增加复制连接码、重新生成、过期提示；设备数变化后重新加载设备列表，避免已经配对仍显示 0 台。
2. iOS 未签名模拟器包无法写入 Keychain：改用正常签名构建验收，并给缺少 Keychain 权限的错误增加可执行的解释。
3. iOS 配对成功后页面未关闭：配对方法返回本次保存结果，页面按本次结果关闭，避免其他连接的旧错误干扰成功判断。修复已编译；成功连接与重启恢复已实际验证。
4. Codex MCP 工具被直接拒绝：Bridge 以前没有处理 `mcpServer/elicitation/request`。现在把空表单确认请求交给已有审批机制，逐次返回 accept/decline；不自动授权、不扩大成永久权限。不支持的结构化表单/URL 请求仍返回 cancel。
5. Mac 正在启动后台时短暂显示断线错误：启动阶段显示准备状态。
6. 任务追加执行或有待审批时仍沿用旧成果的“已完成”：两端采用共享当前状态规则，待处理审批优先，新执行覆盖旧结果；新的审阅结果保留其语义。

环境修复：本机 OrbStack Debian 的另一个空 Zimlo 实例占用/转发了 4747。已仅给该实例增加 systemd 用户服务 drop-in，将端口改为 4748，并保留该实例运行；Mac 使用 4747。未改动其他 VM 服务或项目数据。

审批协议依据：本机 Codex 生成的协议类型，以及 [OpenAI app-server 的 MCP elicitation 说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#mcp-server-elicitations)。

## 可追溯证据

- 真实 session：`zim_09328b1324df0c331ec35e34`
- Codex thread：`01a07333-7fa8-7520-af6c-2183c911dfca`
- Mac 创建指令：`01a07333-7f5a-7413-aa09-83034e888971`
- iOS 继续执行：`01a07343-7efe-7203-b97e-0d08e1063a70`
- 图集帖子：`01a07345-467a-77b3-ac7b-2869930ada10`，标题「主视觉与页面预览已核对」。内容明确为已有文件验收，不是新生成作品。
- 离线恢复指令：`01a0734f-d344-7041-af3b-b22c25011691`
- 离线恢复唯一轮次：`01a0734f-d409-72b2-a131-885d5fc9a152`，回复「离线消息恢复执行一次」。

| 文件 | SHA-256 | Mac/iOS 下载 |
| --- | --- | --- |
| fieldwork-campaign.png | `4ba0013519826d3cf7365a239263b51d85997d3886a4ca3fb8a204b0306c0729` | 均匹配 |
| zimlo-feed-mobile-en.png | `6a61c97a131a94a5225943c2ab5ab8999e465efb2d5e1505291e91c265e5c4df` | 均匹配 |
| zimlo-feed-desktop-en.png | `f3f39fac2630936bb3455e834126b82a8a79a45aa396773f7714d4b23b305fbe` | 均匹配 |

## 回归检查

- `pnpm check` 通过：架构边界、458 个 TypeScript 测试、类型检查、各包构建、90 个 Rust 测试、写入/加密/审批/重启恢复等 smoke、diff 检查。
- macOS：111 个测试通过；完整 App 构建及签名验证通过。
- iOS：76 个测试通过；正常签名 Simulator 构建运行通过。
- 共享 Swift 核心：6 个测试通过，含继续执行/审批优先级回归。
- 日志：`/tmp/zimlo-full-check.log`、`/tmp/zimlo-full-mac-test-final.log`、`/tmp/zimlo-full-shared-tests.log`、`/tmp/zimlo-full-mac-final-build.log`、`/tmp/zimlo-ios-full-device-build.log`。

以上是核心产品链路的完整 App 验收，不代表所有设备、所有 Agent、系统推送及发布升级路径均已验完。真机运行和 APNs 是明确保留项。
