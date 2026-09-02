# 当前技术栈

| 层 | 当前技术 | 是否产品运行时 | TypeScript 状态 |
|---|---|---:|---|
| Mac 本地 Runtime / Bridge / CLI | Rust 1.98、Tokio、Axum、rusqlite、rustls | 是 | 已移除 |
| macOS 桌面壳 | Swift 6、SwiftUI/AppKit、UserNotifications、Sparkle | 是 | 无 |
| iOS 客户端 | Swift 6、SwiftUI、CryptoKit、Network、APNs | 是 | 无 |
| Web/PWA | TypeScript、React 19、Vite 8 | 是 | 保留 |
| Cloud relay / Push / R2 API | TypeScript、Cloudflare Workers、Durable Objects、D1、R2 | 是 | 仍保留 |
| 协议与 Web 共享策略源 | TypeScript、Zod、JSON test vectors | 构建与 Web 依赖 | 仍保留 |
| Rust 协议/策略实现 | Rust；与共享 vectors 逐 case 对拍 | 是 | 无 |
| Node Runtime reference | TypeScript、Fastify、better-sqlite3 | 否，仅 parity/smoke | 暂时保留 |
| 构建/测试脚本 | pnpm、Vitest、Node scripts、Cargo、XCTest | 否 | 部分保留 |
| 独立站点 | TypeScript/React/Workers | 独立部署 | 保留 |

因此当前完成的是“本地产品 Runtime 全量 Rust 化”，不是“仓库除 Web 外零 TypeScript”。若目标是
后者，还需要继续迁移 Cloud Worker、协议/共享策略源、Node reference 与构建脚本；这与本地 Runtime
切换是独立工程。
