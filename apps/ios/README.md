# Zimlo for iOS

原生 SwiftUI 客户端，复用 Zimlo Bridge protocol v2，不是 WebView 包装。

## 已实现的闭环

- 扫描或粘贴 Mac 配对链接；设备密钥保存在 iOS Keychain。
- X25519 + HKDF + HMAC 配对，以及 XChaCha20-Poly1305 加密 WebSocket。
- Snapshot 驱动的一页一卡 Feed；左滑 Task Detail、右滑移出 Feed、稳定停留 1 秒标记已读。
- Feed、Tasks、居中新任务、Agents、个人设置五键底栏。
- Task Detail 的紧凑 Header、分层 Timeline、待处理事项和可靠 follow-up 队列。
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

再打开 `apps/ios/Zimlo.xcodeproj`，选择 iPhone 模拟器或已签名真机运行，并使用 Mac 网页 Settings 中生成的配对信息。真机需要与 Mac 处于同一可信 LAN，或连接用户自己的 VPN / Tailscale。

Bridge 在局域网使用用户提供的 HTTP / WebSocket 地址，但所有配对证明和应用消息均由 Zimlo protocol v2 自行认证和端到端加密。
