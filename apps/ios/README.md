# Zimlo for iOS

原生 SwiftUI 客户端，复用 Zimlo Bridge protocol v4，不是 WebView 包装。

## 已实现的闭环

- 扫描或粘贴 Mac 配对链接；设备密钥保存在 iOS Keychain。
- 可在“设置 → 运行设备”继续连接多台 Mac；Feed/Tasks 聚合展示，回复、审批、附件与离线队列精确路由回来源 Mac。
- X25519 + HKDF + HMAC 配对，以及 XChaCha20-Poly1305 加密 WebSocket。
- Snapshot 驱动的一页一卡 Feed；左滑 Task Detail、右滑移出 Feed、稳定停留 1 秒标记已读。
- Feed、Tasks、居中对话入口、Agents、个人设置五键底栏。
- Task Detail 的紧凑 Header、分层 Timeline、待处理事项和可靠 follow-up 队列。
- Feed、Tasks、Agents、Settings 与详情页共用 44pt `AppTopBar`；系统安全区由 `safeAreaInset` 管理，无障碍字号时内容行最多 52pt。
- 任意可关联任务的卡片都能从统一输入面板继续对话；面板默认既不录音也不弹键盘，文字、语音和附件由用户自由选择。
- 配对后由用户主动请求 APNs 权限，只接收真实审批与失败通知；加密任务路由只在设备端解密。
- 局域网连接失败时自动切到 Cloudflare 加密中继；最近快照保存在受文件保护的数据目录，离线操作进入持久 outbox。
- 新任务草稿、最近 Runtime / Project、断网 outbox、重连重放与幂等 key。
- 用户与 Project Agent 共用 24 个预置头像；Agent 初次创建时随机分配并可编辑，另有固定 Zimlo 头像和原生语音输入。
- 高风险审批走底部 Sheet：完整展示风险、作用域、目标命令与确认短语，「填入确认短语」+「确认执行」双确认，取消或过期自动清空。
- 对话 follow-up 与审批回答发送即清空：先持久化 outbox，成功后清空输入与草稿并立即展示本地 pending；服务端拒绝标失败，可在 outbox 详情里重试或重新编辑。
- 右滑移除 Feed、归档任务均乐观更新并提供 6 秒撤销；任务列表有「已归档」筛选可找回。
- Outbox 详情（设置页或顶部胶囊进入）展示每条指令的类型、目标、预览与状态；本地或服务端仍 queued 的 create/follow-up 可撤回（task.command.cancel）。
- 重连使用共享退避序列 [1,2,4,8,16,30]s ±20% 抖动，系统离线时暂停，认证成功或回前台重置；离线/重连胶囊与顶栏状态都可点按立即重试。
- 离线快照带 savedAt，离线胶囊显示「数据更新于 X 分钟前」。
- 通知权限被拒时设置页给出持久引导与「打开系统设置」；冷启动点通知但 session 未同步时，Feed 顶部保留可重试的路由占位条。
- 低风险审批（无确认短语的批准一次/拒绝）支持锁屏快捷操作（UNNotificationCategory `ZIMLO_LOW_RISK_APPROVAL`）：category 是明文通用标识，决策 id 只在设备端解密的 PushRouteV1 加密路由内；高风险与需输入的审批仍进 App 完成。旧客户端收到未知 category 按普通打开处理，快捷路由解析失败同样回退普通打开。

## 规范对齐与测试

Feed 合并（6h 窗口）、阅读优先级（covered +6 / 已读 +10）、真实 PendingAction 独立置顶、outbox 语义键、
重连退避、撤回状态与快捷审批规则由 `Zimlo/SharedRules.swift` 实现，与
`packages/protocol/src/policy.ts` 逐行对齐。`ZimloTests/VectorTests.swift` 直接读取
`packages/protocol/test-vectors/` 下的 6 个 JSON 向量文件（共 83 个 case）逐个断言，
与 apps/web 的 vitest 使用同一组输入与期望。

## 本轮明确不做（遗留）

- 不迁 NavigationStack、不加边缘右滑返回手势：全屏 Feed 卡的横向手势与边缘返回冲突，
  且详情页开关状态深嵌 AppModel，迁移需要单独一轮（RootView.swift 头部有同样注释）。

## 本地构建

```bash
xcodebuild \
  -project apps/ios/Zimlo.xcodeproj \
  -target Zimlo \
  -configuration Debug \
  -sdk iphonesimulator \
  -arch arm64 \
  CONFIGURATION_BUILD_DIR=/tmp/zimlo-ios-products \
  CODE_SIGNING_ALLOWED=NO \
  build
```

编译测试 target：

```bash
xcodebuild \
  -project apps/ios/Zimlo.xcodeproj \
  -target ZimloTests \
  -configuration Debug \
  -sdk iphonesimulator \
  -arch arm64 \
  CONFIGURATION_BUILD_DIR=/tmp/zimlo-ios-products \
  CODE_SIGNING_ALLOWED=NO \
  build
```

开发时先在 Mac 启动 Bridge：

```bash
node apps/cli/dist/index.js start
```

再打开 `apps/ios/Zimlo.xcodeproj`，选择 iPhone 模拟器或已签名真机运行，并使用 Mac 网页 Settings 中生成的配对信息。首次配对默认通过两分钟有效的 Cloudflare 配对房间完成，真机与 Mac 不需要处于同一 LAN；配对后也可在外网继续同步。

Bridge 在局域网使用用户提供的 HTTP / WebSocket 地址，但所有配对证明和应用消息均由 Zimlo protocol v4 自行认证和端到端加密。

## 安装到自己的 iPhone

1. 用 Xcode 打开 `apps/ios/Zimlo.xcodeproj`。
2. 在 Zimlo target 的 **Signing & Capabilities** 选择自己的 Team，并确保 Bundle Identifier 唯一。
3. 保留 **Push Notifications** capability；首次只调试局域网功能时可以暂不配置 APNs。
4. 用数据线或已启用无线调试的方式连接 iPhone，在 Xcode 顶部选择该设备后运行。
5. 打开 Mac 版 Zimlo（源码调试时执行 `node apps/cli/dist/index.js start`），生成配对二维码并使用 App 扫码。
6. 配对成功后，再到 App 的“设置 → 主动通知”开启通知。Zimlo 不会在首次启动时直接弹系统权限框。

真机 APNs 需要 Apple Developer 签名、Push Notifications entitlement，以及已经部署的 Cloudflare Worker。App 本身不再包含 Relay URL 或全局注册密钥：Worker 地址和每台手机独有的随机访问令牌都由 Mac 在可信配对响应中下发。

官方 Beta 默认使用已部署的 Cloudflare 服务；自建环境才需要在 Mac 端设置 `ZIMLO_CLOUD_URL`。APNs provider key 只作为 Cloudflare Worker secret 保存，绝不能写入 Xcode 配置或 App 包。完整步骤见 [Cloudflare 服务说明](../cloud/README.md)。

## TestFlight Beta

普通用户安装路径是 TestFlight，不需要 Xcode、数据线或终端。仓库中的
`.github/workflows/release-ios.yml` 会使用 Release 配置归档主 App 与通知
Service Extension，并直接上传到 App Store Connect。

首次发布前在 GitHub Actions 配置：

- `APPLE_TEAM_ID`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_API_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_P8_BASE64`
- `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64`
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`
- `IOS_KEYCHAIN_PASSWORD`

随后手动运行 **Release iOS Beta**，输入语义化版本号和递增 build number。
工作流会在缺少任何凭据、版本格式错误、签名或上传失败时停止，不会生成一个
看似成功但无法安装的 Beta。

主 App 随包包含 `PrivacyInfo.xcprivacy`：Zimlo 不声明收集或追踪用户数据，
仅为设备内草稿、待发送操作和偏好设置声明 Apple 要求的 `UserDefaults`
required-reason API 用途。
