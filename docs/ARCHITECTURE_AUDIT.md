# Zimlo 仓库架构审计与演进路线

## 结论

Zimlo 的产品边界已经清楚，但代码边界落后于产品复杂度：Bridge、Web、iOS、macOS、Cloud
已经形成完整系统，仍有若干“单文件拥有过多职责”和“跨端手写同一契约”的实现方式。后续迭代的
主要风险不是功能缺失，而是一个协议或状态变化要在多处同步，漏改时只能靠运行期发现。

目标不是把仓库抽象成通用框架，而是建立四条稳定边界：

1. **契约只有一个来源**：版本、协议结构和跨端规则先改契约，再生成或验证客户端实现。
2. **持久化分层**：物理 schema、行编解码、领域查询和应用服务分别负责自己的变化。
3. **客户端按功能闭环**：Transport → Repository/Outbox → Feature Store/ViewModel → View，页面不直接拼协议细节。
4. **自动护栏先于评审记忆**：依赖方向、生成文件、二进制资源和复杂度预算由脚本检查。

## 当前证据与处置

| 领域 | 证据 | 风险 | 目标模式 | 当前处置 |
|---|---|---|---|---|
| 运行时契约 | 协议版本曾分别硬编码在 CLI、Cloud、iOS、macOS | 单端升级后无法连接，错误到运行期才出现 | `config/zimlo-contract.json` + 生成文件 | 已完成 |
| Bridge 持久化 | `store.ts` 曾约 1,900 行，同时含 schema、兼容迁移、查询与行映射 | 迁移和业务查询互相影响，评审范围过大 | Schema → Codec → Repository facade | 已拆出 schema 与 codec；Repository 继续渐进拆分 |
| Project 聚合 | `listProjects()` 曾为每个 Project 再执行位置、Runtime、任务数、Feed 数查询 | Project 增长后查询数线性放大 | 批量 relation loader | 已完成，固定为四组聚合查询 |
| 运行时图标 | Codex/Claude PNG 曾以 Base64 同时嵌入 Swift/TS 三份源码 | 约 140KB 重复文本、资源更新易漂移 | 共享品牌资源 + 客户端资源加载器 | 已完成 |
| Swift 协议模型 | iOS `Models.swift` 与 macOS `NativeModels.swift` 手写相同 JSON 模型，字段已有差异 | 新字段可能只在一端解码或展示 | 由 TS schema 生成 Swift Codable DTO，或独立 Swift Contract package | 下一阶段 P0 |
| 客户端状态 | iOS `AppModel.swift`、Web `useBridge.ts`、macOS `NativeAppStore.swift` 同时处理连接、调和、outbox 和页面状态 | 修改局部交互时容易触发全局回归 | Transport、SnapshotRepository、CommandOutbox、Feature Store 四层 | 下一阶段 P1 |
| 协议入口 | `packages/protocol/src/index.ts` 集中事件、Feed、Trust、通知与传输命令 | 文件继续增长后所有协议改动集中冲突 | session/content/security/transport 模块，入口只 re-export | 下一阶段 P1 |
| 辅助站点 | `landing-page` 与 `work-report` 是独立 npm deployable，原根验证不覆盖 | 主分支绿色不代表整个仓库可构建 | 保持独立发布，但提供 `sites:check` / `check:all` | 已完成 |
| 文档事实 | 验收报告保留历史 protocolVersion，主架构文档描述当前值 | 历史材料被误当运行时真相 | 运行时事实由生成契约负责；报告明确是快照 | 需要按发布节奏整理 |

## 目标依赖方向

```text
config/zimlo-contract.json
        │
        ├── generated TS / Swift runtime constants
        │
packages/protocol       apps/shared/branding
        │                         │
packages/adapters                 ├── Web
        │                         ├── iOS
apps/cli application services     └── macOS
        │
        ├── local Bridge / persistence
        ├── apps/cloud encrypted relay
        └── Web / iOS / macOS clients
```

约束：`protocol` 不依赖任何 Zimlo 包；`adapters` 只依赖 `protocol`；`packages/*` 不依赖
`apps/*`；客户端只能通过协议和资源消费核心能力，不能引用 Bridge 实现。

## 持久化模式

```text
store-schema.ts   物理表、索引、幂等兼容迁移
       ↓
store-codecs.ts   SQLite row ↔ protocol DTO 的纯转换
       ↓
store.ts          事务、领域查询、Repository facade
       ↓
Runtime / Bridge / Services
```

`ZimloStore` 暂时保留 facade，避免一次性重写所有调用方。新领域达到三个以上操作时，再按
`ProjectRepository`、`TaskRepository`、`DeviceRepository` 拆分，并让 facade 委托；不要为只有
一个查询的表提前创建类。

## 客户端模式

每个客户端后续统一采用相同责任链，而不是强求 UI 代码复用：

```text
Transport
  只负责连接、加密、重连和原始消息
SnapshotRepository
  负责多 Host 合并、缓存、增量调和
CommandOutbox
  负责 durable command、幂等、撤回、重试和确认
Feature Store / ViewModel
  负责 Feed、Tasks、Agents、Settings 的派生状态
View
  只负责展示和用户意图
```

真正需要跨端一致的是 DTO、状态机和测试向量；布局与原生交互分别实现。新增命令必须先进入
协议 schema 和共享向量，禁止先在 Swift/TS 页面里加入裸字符串。

## 验证层级

- `pnpm architecture:check`：生成契约、依赖方向、内联二进制、构建产物和热点文件预算。
- `pnpm check`：核心 TS/React/Cloud/CLI 的测试、类型检查和构建。
- `pnpm check:all`：再加入 macOS 与两个独立站点；用于发布和大范围重构。
- iOS：在 Xcode/CI 使用 XCTest 与 archive；纯规则继续由共享 JSON 向量驱动。

## 后续顺序

1. **P0：Swift Contract**——从 Zod/JSON schema 生成两个客户端共用的 Codable DTO、命令类型和服务端消息类型。
2. **P1：客户端状态拆分**——先拆 iOS outbox 与 snapshot repository，再把相同边界映射到 Web/macOS。
3. **P1：Protocol 模块化**——保持 `@zimlo/protocol` 公共入口不变，只拆内部文件，避免调用方迁移噪音。
4. **P2：Repository 细分**——按真实修改频率拆 Project/Task/Device，并在 service 层依赖窄接口。
5. **P2：辅助站点治理**——升级依赖或重构站点时再决定是否统一包管理器；当前不为形式统一破坏独立部署。

所有步骤都应保持可回滚的小提交：契约/资源、持久化、客户端状态分别提交，禁止把 UI 改版与底层迁移放进同一 diff。
