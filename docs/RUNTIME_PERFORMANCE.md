# Runtime 性能报告

采样时间：2026-09-01T19:09:31.844Z

环境：darwin 25.5.0；Apple M5 Pro；18 logical CPUs
版本：Node v24.15.0；rustc 1.98.0 (88d9e12ae 2026-08-18)

## 结果

| 指标 | Node Runtime | Rust Runtime | Rust 相对结果 |
|---|---:|---:|---:|
| 冷启动到 /healthz p50（30 次） | 154.44 ms | 19.42 ms | 7.95× faster |
| 冷启动到 /healthz p95 | 178.69 ms | 21.57 ms | — |
| 冷启动到 /healthz p99 | 182.33 ms | 377.90 ms | — |
| 稳态 RSS | 107.1 MB | 15.2 MB | 85.8% lower |
| /healthz 延迟 p50（400 次） | 0.14 ms | 0.10 ms | 1.45× faster |
| /healthz 延迟 p95 | 0.28 ms | 0.19 ms | — |
| /api/local/snapshot 延迟 p50（120 次） | 0.30 ms | 0.17 ms | 1.73× faster |
| /api/local/snapshot 延迟 p95 | 0.48 ms | 0.22 ms | — |
| Runtime 组件体积 | 114.8 MB* | 16.1 MB | 86.0% smaller |

* Node 数字只含 Node 可执行文件与 CLI dist，不含 node_modules，属于保守下界。

## 方法

- 两个 Runtime 都使用 release/production build、关闭 Cloud，并在空的隔离 HOME/ZIMLO_HOME 中运行。
- 冷启动从创建进程计时到首次成功收到 /healthz；每次使用全新数据库。
- 报告保留 p99 尾延迟；本次 Rust 样本中有一次 377.90 ms 离群点，p50/p95 分别为 19.42 / 21.57 ms。
- HTTP 指标为本机 loopback 串行请求，先预热 20 次；不是网络吞吐压测。
- 原始数据见 [runtime-performance-results.json](./runtime-performance-results.json)。结果只代表本机本次采样，不外推为所有设备的绝对值。
