# Node / Rust Runtime 能力对拍

结论：Rust 是产品 Runtime，Node/TypeScript Runtime 仅保留为测试基准。当前产品公开能力没有因
切换到 Rust 而缺失；Rust 另提供 `integrations` 聚合命令。内部实现、日志措辞和性能不要求相同。

## 能力矩阵

| 能力域 | Node 参考实现 | Rust 产品实现 | 验证证据 | 结果 |
|---|---|---|---|---|
| 服务生命周期 | `start/status/stop`、实例归属、手动停止 | 同名原生命令、独占锁与描述符 | CLI 对拍、CLI/ServiceState tests、macOS contracts | 一致 |
| 运维 CLI | `logs/doctor/hooks/codex-plugin/devices/open` | 同命令；另有 `integrations` | `runtime:parity` help surface、Rust clap tests | 无缺失 |
| 默认存储 | `~/.zimlo/zimlo.db` 单写者、WAL、恢复 | 同 schema、同默认写入语义 | schema gate、store/snapshot fixtures、write smoke | 一致 |
| HTTP 与 Snapshot | health、bootstrap、Snapshot、session events | 同路由、字段与 feature gates | live black-box parity | 一致 |
| LAN 与安全通道 | 配对、设备鉴权、加密 WS、防重放 | X25519/HKDF/HMAC/XChaCha20-Poly1305 同协议 | crypto vectors、TCP WebSocket tests、write smoke | 一致 |
| 客户端命令 | protocol v5 的 34 个命令 | 34 个命令全部 dispatch | 静态 inventory + live state flow | 一致 |
| session 发现 | Codex/Claude 进程与 transcript 增量发现 | 同 provider、稳定 ID、保守关联、脱敏 | discovery/store tests、hook live parity | 一致 |
| Agent hooks | Session 绑定、审批、结构化输入 | 本地 UDS transport；断线使 action 过期 | hook tests、disconnect expiry、live parity | 一致 |
| Agent MCP | `feed.post`、`material.publish` | 同工具、同 schema、同去重/合并语义 | live MCP initialize/list/call parity | 一致 |
| Task runner | Codex app-server、Claude stream-json | 原生子进程执行器、队列/CAS/取消/重试 | fake provider integration tests、write smoke | 一致 |
| 审批与信任 | PendingAction、确认短语、safe automation | 同权限、幂等、审计与 fail-closed | ActionBroker/trust tests、write smoke | 一致 |
| Material | 本地导入、设备上传、Range、Cloud R2 | 同本地/远程链路与密文中转 | material tests、write smoke | 一致 |
| Cloud/Push | 安装身份、relay、撤销、APNs | P-256 签名、relay、Push 路由与撤销 | cloud/push unit tests、WS revoke test | 一致 |
| 集成安装 | Codex plugin、Codex/Claude hooks/MCP | 原子安装、激活失败回滚、精确卸载 | integration tests、CLI surface parity | 一致 |
| 本机 Web | 静态管理页 | Rust Axum 直接托管相同 Web dist | bundle build + local route tests | 一致 |

## 自动对拍

```bash
pnpm runtime:parity
```

脚本在两个全新的隔离 `HOME/ZIMLO_HOME` 中关闭 Cloud，分别启动 Node reference 与 Rust release：

- 对拍 Node 已有的顶层/嵌套运维命令，保证 Rust 没有丢命令；
- 检查 protocol v5 全部 client command 在两侧都有实现；
- 实际请求 health、bootstrap、Snapshot 与 session events；
- 实际完成 hook → MCP `feed.post` → Stop → Feed/Task 终态；
- 比较公开 MCP 工具名、归一化 JSON schema、稳定 session id、事件种类与脱敏结果。

机器可读结果在 [`runtime-parity-results.json`](./runtime-parity-results.json)。Cloud 被刻意关闭以避免
对拍依赖外部服务；Cloud、Push 与远程 Material 由 Rust 定向测试和协议/存储回归覆盖。
