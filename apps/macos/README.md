# Zimlo for macOS

原生 SwiftUI 菜单栏应用，面向普通用户承载后台服务、首次启动、Agent 接入和手机配对。用户安装正式版本后不需要 Node、pnpm 或终端命令。

## 系统通知

完成首次启动后，Mac App 会请求通知权限，并只提醒待审批/回复、重要结果和失败三类事件。普通进度和工具日志不会触发通知；同一任务在 2 秒窗口内只保留最高优先级的一条，通知点击后直达对应任务。未处理审批临近过期只再提醒一次。主窗口正在显示该任务时抑制前台横幅，Dock badge 则统计尚未处理的审批和未读重要结果。各类别及通知任务标题可在 App 设置中单独关闭；「仅关键通知」和 22:00–08:00 安静时段会隐藏普通结果，但保留审批与失败。

## 本地构建

```bash
pnpm macos:build
```

构建结果位于 `apps/macos/.build/Zimlo.app`。开发 App 和内置 Rust Runtime 都只包含当前 Mac 的 CPU 架构；Runtime 压缩包位于 App 的 `Contents/Resources/Runtime/ZimloRuntime.zip`，新机器首次启动不需要联网下载：

```bash
file apps/macos/.build/Zimlo.app/Contents/MacOS/Zimlo
unzip -l apps/macos/.build/Zimlo.app/Contents/Resources/Runtime/ZimloRuntime.zip
```

启动时优先复用已安装的匹配版本，其次校验并安装 App 内置 Runtime；只有内置副本不可用时才从 `runtime-latest.json` 下载同架构工件。安装过程校验版本、协议、SHA-256、CPU 架构和 Developer ID Team，并原子安装到 `~/Library/Application Support/Zimlo/Runtime`；升级保留上一版作为回退。用户不需要安装 Node、pnpm 或执行终端命令。

Runtime 是独立签名的原生 Rust helper app，不需要 V8 JIT entitlement。发布系统分别生成 `arm64` 和 `x86_64` App、DMG、Runtime 与 Sparkle appcast；用户只会安装和更新与当前 Mac 匹配的一套。

## 正式发布

正式发布需要：

- `Developer ID Application` 签名证书；
- Apple Notary Service 凭据；
- Sparkle EdDSA 更新密钥；
- 已启用的 Cloudflare R2 bucket `zimlo-releases`，并在 Worker 中绑定为 `RELEASES`。

首次生成 Sparkle 密钥：

```bash
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account zimlo
```

把输出的公钥作为 `SPARKLE_PUBLIC_KEY`，随后构建、签名、公证并生成 DMG：

```bash
export ZIMLO_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export ZIMLO_TEAM_ID="TEAMID"
export SPARKLE_PUBLIC_KEY="..."
export APPLE_NOTARY_PROFILE="zimlo-notary"
export ZIMLO_VERSION="0.3.0"
export ZIMLO_BUILD_NUMBER="1"
pnpm macos:release
```

发布到 Cloudflare R2 并更新两条架构独立的 Sparkle appcast：

```bash
export SPARKLE_KEY_ACCOUNT="zimlo"
apps/macos/scripts/publish-release.sh \
  apps/macos/.build/release-0.3.0
```

输出为 `Zimlo-0.3.0-arm64.dmg` 与 `Zimlo-0.3.0-x86_64.dmg`。发布脚本会先上传并验证两种架构的 Runtime 和 DMG，再更新 `appcast-arm64.xml`、`appcast-x86_64.xml` 与架构化 `latest.json`。原来的 `appcast.xml` 会继续包含两个带硬件约束的更新项，确保已有 Universal App 能平滑迁移。Sparkle 验证 EdDSA 与 Apple 代码签名后才安装对应架构更新。
