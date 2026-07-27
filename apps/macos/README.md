# Zimlo for macOS

原生 SwiftUI 菜单栏应用，面向普通用户承载后台服务、首次启动、Agent 接入和手机配对。用户安装正式版本后不需要 Node、pnpm 或终端命令。

## 本地构建

```bash
pnpm macos:build
```

构建结果位于 `apps/macos/.build/Zimlo.app`，其中包含 Zimlo CLI、Web UI、生产依赖和 Sparkle。Swift 主程序与内置 Node Runtime 都是 Universal Binary，可同时运行在 Apple Silicon 与 Intel Mac：

```bash
file apps/macos/.build/Zimlo.app/Contents/MacOS/Zimlo
file apps/macos/.build/Zimlo.app/Contents/Resources/runtime/node
```

开发脚本使用 ad-hoc 签名。内置 Node 单独声明 V8 JIT 所需的最小 Hardened Runtime entitlement，主应用不继承这项权限。

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
export SPARKLE_PUBLIC_KEY="..."
export APPLE_NOTARY_PROFILE="zimlo-notary"
export ZIMLO_VERSION="0.3.0"
export ZIMLO_BUILD_NUMBER="1"
pnpm macos:release
```

发布到 Cloudflare R2 并更新 Sparkle appcast：

```bash
export SPARKLE_KEY_ACCOUNT="zimlo"
apps/macos/scripts/publish-release.sh \
  apps/macos/.build/release-0.3.0/Zimlo-0.3.0.dmg
```

Sparkle 会定期检查 `https://zimlo-cloud.zimlo.workers.dev/releases/macos/appcast.xml`，验证 EdDSA 签名与 Apple 代码签名后才安装更新。
