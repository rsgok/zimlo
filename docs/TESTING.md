# 验证手册

## 自动验证

```bash
pnpm test
pnpm typecheck
pnpm build
node apps/cli/dist/index.js doctor
```

`pnpm test` 覆盖 Codex/Claude fixture parser、测试命令识别、脱敏、Feed 发帖去重与结束检查点、Action Broker 幂等与重启过期、网络地址判断、协议加密/防重放，以及 Codex app-server 审批值映射。

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
| JSONL 追加/截断/轮转 | 增量恢复，不产生 Feed 帖子 |
| 真实测试成功/失败 | 依据命令与 exit code 生成正确测试事件 |
| 外部终端正在运行 | 回复按钮关闭并显示原因 |
| 空闲 Codex 回复 | app-server 握手、resume、turn 完成 |
| 四个并发审批 | 每个 action 只解析到自己的上游请求 |
| 双击/重放/断线重试 | 同一 idempotency key 不重复执行 |
| Bridge 在审批时崩溃 | resolver 失效，重启后旧 action 过期 |
| Mac Safari/Chrome、iPhone Safari | 一屏一帖、Tasks、详情与 Profile 无横向溢出 |
| hook 安装/升级/卸载 | 用户已有配置与非 Zimlo handler 保持不变 |
| 机密 fixture | SQLite、网页消息和日志均不含原始机密 |

## 性能采样

Beta 发布前以 10 个 session、4 个并发审批和 20 个活跃 session 采样发现延迟、hook p95、被动事件 p95、CPU、RSS 与滚动流畅度。目标分别为 ≤5 秒、≤1 秒、≤3 秒、空闲 CPU <3%、RSS <250 MB。
