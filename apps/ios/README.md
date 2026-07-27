# Zimlo for iOS

原生 SwiftUI 客户端，复用 Zimlo Bridge protocol v2，不是 WebView 包装。

## 已实现的闭环

- 扫描或粘贴 Mac 配对链接；设备密钥保存在 iOS Keychain。
- X25519 + HKDF + HMAC 配对，以及 XChaCha20-Poly1305 加密 WebSocket。
- Snapshot 驱动的一页一卡 Feed；左滑 Task Detail、右滑移出 Feed、稳定停留 1 秒标记已读。
- Feed、Tasks、居中新任务、Agents、个人设置五键底栏。
- Task Detail 的紧凑 Header、分层 Timeline、待处理事项和可靠 follow-up 队列。
- Feed、Tasks、Agents、Settings 与详情页共用 44pt `AppTopBar`；系统安全区由 `safeAreaInset` 管理，无障碍字号时内容行最多 52pt。
- 结果审阅支持接受或填写原因要求修改；后者进入持久 outbox，断网、退出和重连后仍可幂等重放。
- 配对后由用户主动请求 APNs 权限，只接收审批/回复、失败和待审结果三类可见通知；加密任务路由只在设备端解密。
- 局域网连接失败时自动切到 Cloudflare 加密中继；最近快照保存在受文件保护的数据目录，离线操作进入持久 outbox。
- 新任务草稿、最近 Runtime / Project、断网 outbox、重连重放与幂等 key。
- 用户与 Project Agent 共用 24 个预置头像；Agent 初次创建时随机分配并可编辑，另有固定 Zimlo 头像和原生语音输入。

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

先在 Mac 启动允许局域网访问的 Bridge：

```bash
node apps/cli/dist/index.js start --lan
```

再打开 `apps/ios/Zimlo.xcodeproj`，选择 iPhone 模拟器或已签名真机运行，并使用 Mac 网页 Settings 中生成的配对信息。首次配对需要真机与 Mac 处于同一可信 LAN；配置 Cloudflare 后，之后可离开该局域网继续同步。

Bridge 在局域网使用用户提供的 HTTP / WebSocket 地址，但所有配对证明和应用消息均由 Zimlo protocol v2 自行认证和端到端加密。

## 安装到自己的 iPhone

1. 用 Xcode 打开 `apps/ios/Zimlo.xcodeproj`。
2. 在 Zimlo target 的 **Signing & Capabilities** 选择自己的 Team，并确保 Bundle Identifier 唯一。
3. 保留 **Push Notifications** capability；首次只调试局域网功能时可以暂不配置 APNs。
4. 用数据线或已启用无线调试的方式连接 iPhone，在 Xcode 顶部选择该设备后运行。
5. Mac 执行 `node apps/cli/dist/index.js start --lan`，然后在 Mac 网页 Settings 生成配对二维码，使用 App 扫码。
6. 配对成功后，再到 App 的“设置 → 主动通知”开启通知。Zimlo 不会在首次启动时直接弹系统权限框。

真机 APNs 需要 Apple Developer 签名、Push Notifications entitlement，以及已经部署的 Cloudflare Worker。App 本身不再包含 Relay URL 或全局注册密钥：Worker 地址和每台手机独有的随机访问令牌都由 Mac 在可信配对响应中下发。

Mac 端设置 `ZIMLO_CLOUD_URL` 并重新配对一次即可。APNs provider key 只作为 Cloudflare Worker secret 保存，绝不能写入 Xcode 配置或 App 包。完整步骤见 [Cloudflare 服务说明](../cloud/README.md)。
