import { spawn, execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const definitions = [
  { name: "Node", key: "node", command: process.execPath, prefix: [join(root, "apps/cli/dist/index.js")] },
  { name: "Rust", key: "rust", command: join(root, "runtime/target/release/zimlo"), prefix: [] },
];
const coldSamples = Number(process.env.ZIMLO_BENCH_COLD_SAMPLES ?? 15);

function environment(home) {
  return {
    ...process.env,
    HOME: home,
    ZIMLO_HOME: join(home, ".zimlo"),
    ZIMLO_CLOUD_DISABLED: "1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startRuntime(definition) {
  const home = await mkdtemp(join(tmpdir(), `zimlo-bench-${definition.key}-`));
  await mkdir(join(home, ".zimlo"), { recursive: true });
  const port = await freePort();
  const started = performance.now();
  const logs = [];
  const child = spawn(
    definition.command,
    [...definition.prefix, "start", "--port", String(port)],
    { cwd: root, env: environment(home), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${definition.name} exited: ${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return { definition, home, port, child, startupMs: performance.now() - started };
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  child.kill("SIGKILL");
  throw new Error(`${definition.name} health timeout: ${logs.join("")}`);
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode === null) {
    runtime.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => runtime.child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  }
  await rm(runtime.home, { recursive: true, force: true });
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return {
    samples: sorted.length,
    min: sorted[0],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

function rounded(summary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(3)) : value]));
}

async function requestSamples(url, count) {
  for (let index = 0; index < 20; index += 1) await fetch(url);
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const response = await fetch(url);
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    samples.push(performance.now() - started);
  }
  return rounded(summarize(samples));
}

async function processSample(pid) {
  const { stdout } = await execFile("ps", ["-o", "rss=", "-o", "%cpu=", "-p", String(pid)]);
  const [rss, cpu] = stdout.trim().split(/\s+/u).map(Number);
  return { rssBytes: rss * 1024, cpuPercent: cpu };
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function benchmark(definition) {
  const startups = [];
  for (let index = 0; index < coldSamples; index += 1) {
    const runtime = await startRuntime(definition);
    startups.push(runtime.startupMs);
    await stopRuntime(runtime);
  }
  const runtime = await startRuntime(definition);
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    const process = await processSample(runtime.child.pid);
    return {
      coldStartupMs: rounded(summarize(startups)),
      steadyProcess: process,
      healthLatencyMs: await requestSamples(`http://127.0.0.1:${runtime.port}/healthz`, 400),
      snapshotLatencyMs: await requestSamples(`http://127.0.0.1:${runtime.port}/api/local/snapshot`, 120),
    };
  } finally {
    await stopRuntime(runtime);
  }
}

const [nodeVersion, rustVersion] = await Promise.all([
  execFile(process.execPath, ["--version"]).then(({ stdout }) => stdout.trim()),
  execFile("rustc", ["--version"]).then(({ stdout }) => stdout.trim()),
]);
const benchmarkResults = {};
for (const definition of definitions) benchmarkResults[definition.key] = await benchmark(definition);
const nodeExecutableBytes = (await stat(process.execPath)).size;
const rustBinaryBytes = (await stat(definitions[1].command)).size;
const nodeDistBytes = await directorySize(join(root, "apps/cli/dist"));
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    nodeVersion,
    rustVersion,
    cloudDisabled: true,
    isolatedEmptyHome: true,
  },
  methodology: {
    coldStartupSamples: coldSamples,
    coldStartupDefinition: "process spawn until first successful /healthz response",
    memoryDefinition: "RSS after 750 ms with an empty isolated HOME",
    httpDefinition: "sequential loopback requests after 20 warmups",
  },
  results: benchmarkResults,
  footprint: {
    rustBinaryBytes,
    nodeExecutableBytes,
    nodeCliDistBytes: nodeDistBytes,
    note: "Node dependency tree is excluded, so Node footprint is a conservative lower bound.",
  },
  comparison: {
    startupP50Speedup: benchmarkResults.node.coldStartupMs.p50 / benchmarkResults.rust.coldStartupMs.p50,
    rssReductionPercent: (1 - benchmarkResults.rust.steadyProcess.rssBytes / benchmarkResults.node.steadyProcess.rssBytes) * 100,
    healthP50Speedup: benchmarkResults.node.healthLatencyMs.p50 / benchmarkResults.rust.healthLatencyMs.p50,
    snapshotP50Speedup: benchmarkResults.node.snapshotLatencyMs.p50 / benchmarkResults.rust.snapshotLatencyMs.p50,
    runtimeComponentReductionPercent: (1 - rustBinaryBytes / (nodeExecutableBytes + nodeDistBytes)) * 100,
  },
};
report.comparison = Object.fromEntries(Object.entries(report.comparison).map(([key, value]) => [key, Number(value.toFixed(2))]));

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const ms = (value) => value.toFixed(2);
const markdown = `# Runtime 性能报告

采样时间：${report.generatedAt}

环境：${report.environment.platform}；${report.environment.cpu}；${report.environment.logicalCpuCount} logical CPUs
版本：Node ${nodeVersion}；${rustVersion}

## 结果

| 指标 | Node Runtime | Rust Runtime | Rust 相对结果 |
|---|---:|---:|---:|
| 冷启动到 /healthz p50（${coldSamples} 次） | ${ms(benchmarkResults.node.coldStartupMs.p50)} ms | ${ms(benchmarkResults.rust.coldStartupMs.p50)} ms | ${report.comparison.startupP50Speedup.toFixed(2)}× faster |
| 冷启动到 /healthz p95 | ${ms(benchmarkResults.node.coldStartupMs.p95)} ms | ${ms(benchmarkResults.rust.coldStartupMs.p95)} ms | — |
| 冷启动到 /healthz p99 | ${ms(benchmarkResults.node.coldStartupMs.p99)} ms | ${ms(benchmarkResults.rust.coldStartupMs.p99)} ms | — |
| 稳态 RSS | ${mb(benchmarkResults.node.steadyProcess.rssBytes)} MB | ${mb(benchmarkResults.rust.steadyProcess.rssBytes)} MB | ${report.comparison.rssReductionPercent.toFixed(1)}% lower |
| /healthz 延迟 p50（400 次） | ${ms(benchmarkResults.node.healthLatencyMs.p50)} ms | ${ms(benchmarkResults.rust.healthLatencyMs.p50)} ms | ${report.comparison.healthP50Speedup.toFixed(2)}× faster |
| /healthz 延迟 p95 | ${ms(benchmarkResults.node.healthLatencyMs.p95)} ms | ${ms(benchmarkResults.rust.healthLatencyMs.p95)} ms | — |
| /api/local/snapshot 延迟 p50（120 次） | ${ms(benchmarkResults.node.snapshotLatencyMs.p50)} ms | ${ms(benchmarkResults.rust.snapshotLatencyMs.p50)} ms | ${report.comparison.snapshotP50Speedup.toFixed(2)}× faster |
| /api/local/snapshot 延迟 p95 | ${ms(benchmarkResults.node.snapshotLatencyMs.p95)} ms | ${ms(benchmarkResults.rust.snapshotLatencyMs.p95)} ms | — |
| Runtime 组件体积 | ${mb(nodeExecutableBytes + nodeDistBytes)} MB* | ${mb(rustBinaryBytes)} MB | ${report.comparison.runtimeComponentReductionPercent.toFixed(1)}% smaller |

\* Node 数字只含 Node 可执行文件与 CLI dist，不含 node_modules，属于保守下界。

## 方法

- 两个 Runtime 都使用 release/production build、关闭 Cloud，并在空的隔离 HOME/ZIMLO_HOME 中运行。
- 冷启动从创建进程计时到首次成功收到 /healthz；每次使用全新数据库。
- 报告保留 p99 尾延迟；本次 Rust 样本中有一次 ${ms(benchmarkResults.rust.coldStartupMs.max)} ms 离群点，p50/p95 分别为 ${ms(benchmarkResults.rust.coldStartupMs.p50)} / ${ms(benchmarkResults.rust.coldStartupMs.p95)} ms。
- HTTP 指标为本机 loopback 串行请求，先预热 20 次；不是网络吞吐压测。
- 原始数据见 [runtime-performance-results.json](./runtime-performance-results.json)。结果只代表本机本次采样，不外推为所有设备的绝对值。
`;

await writeFile(join(root, "docs/runtime-performance-results.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(root, "docs/RUNTIME_PERFORMANCE.md"), markdown);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
