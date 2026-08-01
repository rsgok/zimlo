import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { redactText, stableSessionId, uuidV7 } from "@zimlo/adapters";
import {
  EMPTY_CAPABILITIES,
  FeedPostInputSchema,
  FeedSkipInputSchema,
  MaterialPublishInputSchema,
  SignalTransitionInputSchema,
  type FeedPost,
  type Material,
  type Provider,
  type Session,
} from "@zimlo/protocol";
import { detectHookSurface } from "./hook-surface.js";
import { RuntimeHub } from "./runtime.js";
import { MATERIAL_LIMITS, validateMaterialContent } from "./material-service.js";

export interface AgentToolRequest {
  type: "agent_tool";
  id: string;
  provider: Provider;
  parentPid: number;
  cwd: string;
  name: "feed.post" | "feed.skip" | "signal.transition" | "material.publish";
  arguments: unknown;
}

export interface AgentToolResult {
  id: string;
  ok: boolean;
  message: string;
  data?: unknown;
}

const EDITORIAL_POLICY = `只在信息会改变用户判断、行动或信心时发布。每帖按“结论 → 用户影响 → 关键事实 → 证据 → 下一步”编辑；不要发布普通工具调用、文件读取、编译过程、原始日志、心跳或重复状态。`;

const MATERIAL_FORMATS: Record<string, { kind: Material["kind"]; mimeType: string; label: string }> = {
  ".jpg": { kind: "image", mimeType: "image/jpeg", label: "图片" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg", label: "图片" },
  ".png": { kind: "image", mimeType: "image/png", label: "图片" },
  ".webp": { kind: "image", mimeType: "image/webp", label: "图片" },
  ".heic": { kind: "image", mimeType: "image/heic", label: "图片" },
  ".heif": { kind: "image", mimeType: "image/heif", label: "图片" },
  ".mp4": { kind: "video", mimeType: "video/mp4", label: "视频" },
  ".mov": { kind: "video", mimeType: "video/quicktime", label: "视频" },
  ".m4v": { kind: "video", mimeType: "video/x-m4v", label: "视频" },
  ".pdf": { kind: "pdf", mimeType: "application/pdf", label: "PDF" },
  ".txt": { kind: "document", mimeType: "text/plain", label: "文件" },
  ".md": { kind: "document", mimeType: "text/markdown", label: "文件" },
  ".csv": { kind: "document", mimeType: "text/csv", label: "文件" },
  ".json": { kind: "document", mimeType: "application/json", label: "文件" },
  ".doc": { kind: "document", mimeType: "application/msword", label: "文件" },
  ".docx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "文件" },
  ".xls": { kind: "document", mimeType: "application/vnd.ms-excel", label: "文件" },
  ".xlsx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "文件" },
  ".ppt": { kind: "document", mimeType: "application/vnd.ms-powerpoint", label: "文件" },
  ".pptx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "文件" },
};

function toolDefinitions() {
  return [
    {
      name: "feed.post",
      description: `向 Zimlo 发布一条由你主动编辑、给人看的 Feed 帖子。平台不会替你 scrape 日志或生成摘要。${EDITORIAL_POLICY} 普通轮次没有值得说的内容时可以直接保持沉默；关键状态由 signal.transition 校验。`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "kind", "template", "headline", "takeaway", "highlights", "dedupe_key"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160, description: "本次任务的稳定标识；同一任务后续帖子保持一致。" },
          kind: { type: "string", enum: ["progress", "decision", "attention", "result", "failure"] },
          template: { type: "string", enum: ["paper", "grid", "sticky", "marker", "poster"], description: "选择有限的文字卡模板；不能传颜色、字体或 CSS。" },
          headline: { type: "string", minLength: 1, maxLength: 72, description: "直接表达已经发生的结果，禁止使用“阶段进展”等空标题。" },
          takeaway: { type: "string", minLength: 1, maxLength: 320, description: "用一到两句话解释为什么这件事值得用户现在读。" },
          highlights: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 100 }, description: "最多三条可验证事实，每条只表达一件事。" },
          proof: { type: "string", minLength: 1, maxLength: 160, description: "可选的一项测试、检查或一手证据，不得粘贴原始日志。" },
          content: {
            description: "可选的独立媒体卡。文本卡省略或传 {type:'text'}；图片组、视频、文档只引用已注册 material id。",
            oneOf: [
              { type: "object", required: ["type"], properties: { type: { const: "text" } }, additionalProperties: false },
              { type: "object", required: ["type", "materialIds"], properties: { type: { const: "image_album" }, materialIds: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } }, caption: { type: "string", maxLength: 240 } }, additionalProperties: false },
              { type: "object", required: ["type", "materialId"], properties: { type: { const: "video" }, materialId: { type: "string" }, posterMaterialId: { type: "string" }, caption: { type: "string", maxLength: 240 } }, additionalProperties: false },
              { type: "object", required: ["type", "materialId"], properties: { type: { const: "document" }, materialId: { type: "string" }, coverMaterialId: { type: "string" }, summary: { type: "string", maxLength: 320 } }, additionalProperties: false },
            ],
          },
          dedupe_key: { type: "string", minLength: 1, maxLength: 240, description: "同一语义帖重试时保持不变，避免重复发布。" },
        },
      },
    },
    {
      name: "material.publish",
      description: "把当前可信 workspace 中已生成的图片、视频、PDF 或文档注册为 Zimlo 物料。先调用本工具取得 material_id，再让 feed.post 的 content 引用它。不要把文件内容塞进 Feed 文本或 WebSocket。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 2000, description: "物料文件路径；必须位于当前 workspace 内。" },
          name: { type: "string", minLength: 1, maxLength: 180, description: "可选展示文件名。" },
        },
      },
    },
    {
      name: "feed.skip",
      description: `显式记录当前受控检查点没有值得发布的新增信息。${EDITORIAL_POLICY} 这不是心跳帖，不会出现在 Timeline；普通聊天轮次无需为了结束而调用。`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "reason"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160 },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    {
      name: "signal.transition",
      description: "更新可靠的机器任务状态。它是 source of truth，和给人看的 Feed 分开。waiting_input、user_review、failed 等关键状态会校验本轮是否已有匹配的 feed.post。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "state", "reason"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160 },
          state: { type: "string", enum: ["running", "waiting_input", "reviewing", "user_review", "failed", "completed"] },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  ];
}

export class AgentToolService {
  constructor(private readonly runtime: RuntimeHub) {}

  handle(request: AgentToolRequest): AgentToolResult {
    try {
      if (request.name === "feed.post") return this.post(request);
      if (request.name === "material.publish") return this.publishMaterial(request);
      if (request.name === "feed.skip") return this.skip(request);
      return this.transition(request);
    } catch (error) {
      return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private post(request: AgentToolRequest): AgentToolResult {
    const parsed = FeedPostInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`feed.post 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const input = parsed.data;
    const referenced = input.content?.type === "image_album"
      ? input.content.materialIds
      : input.content?.type === "video" || input.content?.type === "document"
        ? [input.content.materialId]
        : [];
    for (const id of referenced) {
      const material = this.runtime.store.getMaterial(id);
      if (!material || material.status !== "ready") throw new Error(`Feed 引用了尚未就绪的物料：${id}`);
      if (input.content?.type === "image_album" && material.kind !== "image") throw new Error("图片组只能引用图片物料。");
      if (input.content?.type === "video" && material.kind !== "video") throw new Error("视频卡只能引用视频物料。");
      if (input.content?.type === "document" && !["pdf", "document"].includes(material.kind)) throw new Error("文档卡只能引用 PDF 或文档物料。");
    }
    const coverIds = input.content?.type === "video"
      ? [input.content.posterMaterialId].filter((id): id is string => Boolean(id))
      : input.content?.type === "document"
        ? [input.content.coverMaterialId].filter((id): id is string => Boolean(id))
        : [];
    for (const id of coverIds) {
      const cover = this.runtime.store.getMaterial(id);
      if (!cover || cover.status !== "ready" || cover.kind !== "image") {
        throw new Error(`封面引用了尚未就绪的图片物料：${id}`);
      }
    }
    const session = this.resolveSession(request, input.task_id);
    const now = new Date().toISOString();
    const post: FeedPost = {
      id: uuidV7(),
      projectId: session.projectId ?? null,
      taskId: input.task_id,
      runId: session.providerSessionId,
      agentId: request.provider,
      sessionId: session.id,
      kind: input.kind,
      template: input.template,
      headline: redactText(input.headline, 72),
      takeaway: redactText(input.takeaway, 320),
      highlights: input.highlights.map((highlight) => redactText(highlight, 100)),
      ...(input.proof ? { proof: redactText(input.proof, 160) } : {}),
      ...(input.content ? { content: input.content } : {}),
      dedupeKey: input.dedupe_key,
      source: "agent" as const,
      createdAt: now,
    };
    const stored = this.runtime.postFeed(post);
    this.runtime.store.recordFeedDecision({
      agentId: request.provider,
      runId: session.providerSessionId,
      taskId: input.task_id,
      kind: "post",
      at: now,
      ref: stored.post.id,
    });
    return {
      id: request.id,
      ok: true,
      message: stored.inserted ? "Feed 已发布。" : "重复调用已去重，返回原帖。",
      data: { post_id: stored.post.id, created_at: stored.post.createdAt, deduplicated: !stored.inserted },
    };
  }

  private skip(request: AgentToolRequest): AgentToolResult {
    const parsed = FeedSkipInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`feed.skip 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const session = this.resolveSession(request, parsed.data.task_id);
    const now = new Date().toISOString();
    this.runtime.store.recordFeedDecision({
      agentId: request.provider,
      runId: session.providerSessionId,
      taskId: parsed.data.task_id,
      kind: "skip",
      at: now,
      ref: redactText(parsed.data.reason, 500),
    });
    return { id: request.id, ok: true, message: "本轮已记录为不发帖，可以结束。" };
  }

  private publishMaterial(request: AgentToolRequest): AgentToolResult {
    const parsed = MaterialPublishInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`material.publish 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const workspace = realpathSync(request.cwd);
    const source = realpathSync(resolve(workspace, parsed.data.path));
    const contained = relative(workspace, source);
    if (!contained || contained.startsWith("..") || isAbsolute(contained)) throw new Error("物料必须位于当前可信 workspace 内。");
    const stats = statSync(source);
    if (!stats.isFile() || stats.size <= 0) throw new Error("物料文件为空或不是普通文件。");
    const extension = extname(source).toLowerCase();
    const format = MATERIAL_FORMATS[extension];
    if (!format) throw new Error("暂不支持这种物料格式。");
    if (stats.size > MATERIAL_LIMITS[format.kind]) throw new Error(`${format.label}不能超过 ${MATERIAL_LIMITS[format.kind] / 1024 / 1024}MB。`);
    const data = readFileSync(source);
    if (format.kind === "pdf") {
      const detectedPages = data.toString("latin1").match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
      if (detectedPages > 200) throw new Error("PDF 不能超过 200 页。");
    }
    const id = `material_${uuidV7().replaceAll("-", "")}`;
    const material: Material = {
      id, kind: format.kind, name: parsed.data.name ?? basename(source),
      mimeType: format.mimeType, sizeBytes: stats.size,
      sha256: createHash("sha256").update(data).digest("hex"), origin: "agent", status: "ready",
      createdAt: new Date().toISOString(),
    };
    const invalidContent = validateMaterialContent(data, material);
    if (invalidContent) throw new Error(invalidContent);
    const materialsPath = this.runtime.store.materialStoragePaths().materials;
    mkdirSync(materialsPath, { recursive: true, mode: 0o700 });
    const destination = join(materialsPath, `${id}${extension}`);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    const stored = this.runtime.store.upsertMaterial(material, destination);
    this.runtime.send({ type: "material.updated", material: stored });
    return { id: request.id, ok: true, message: "物料已注册，可以在 Feed 媒体卡中引用。", data: { material_id: stored.id, kind: stored.kind, name: stored.name } };
  }

  private transition(request: AgentToolRequest): AgentToolResult {
    const parsed = SignalTransitionInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`signal.transition 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const input = parsed.data;
    const session = this.resolveSession(request, input.task_id);
    const checkpoint = this.runtime.store.getFeedCheckpoint(request.provider, session.providerSessionId);
    const requiredKind = input.state === "waiting_input"
      ? "attention"
      : input.state === "user_review"
        ? "result"
        : input.state === "failed"
          ? "failure"
          : null;
    if (requiredKind) {
      const latest = this.runtime.store.latestFeedPost(request.provider, session.providerSessionId, checkpoint?.startedAt ?? "");
      if (!latest || latest.kind !== requiredKind) {
        throw new Error(`进入 ${input.state} 前必须先 feed.post(kind=${requiredKind})。`);
      }
    }
    if (input.state === "completed" && !checkpoint?.decisionKind) {
      throw new Error("任务完成前必须先调用 feed.post 或 feed.skip。");
    }
    const task = this.runtime.updateTask({
      id: input.task_id,
      runId: session.providerSessionId,
      agentId: request.provider,
      sessionId: session.id,
      state: input.state,
      reason: redactText(input.reason, 500),
      updatedAt: new Date().toISOString(),
    });
    return { id: request.id, ok: true, message: `任务状态已更新为 ${task.state}。`, data: task };
  }

  private resolveSession(request: AgentToolRequest, taskId: string): Session {
    const found = this.runtime.store.findSessionForAgentTool(request.provider, request.parentPid, request.cwd, taskId);
    if (found) {
      if (found.surface !== "unknown") return found;
      const detectedSurface = detectHookSurface(request.parentPid);
      return detectedSurface === "unknown" ? found : this.runtime.upsertSession({ ...found, surface: detectedSurface });
    }
    const providerSessionId = `tool:${taskId}`;
    const sessionId = stableSessionId(request.provider, providerSessionId);
    return this.runtime.upsertSession({
      id: sessionId,
      provider: request.provider,
      surface: detectHookSurface(request.parentPid),
      providerSessionId,
      title: `${request.provider === "codex" ? "Codex" : "Claude"} · ${taskId}`,
      cwd: request.cwd || null,
      transcriptPath: null,
      status: "running",
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      activePid: request.parentPid > 0 ? request.parentPid : null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: true,
      capabilities: { ...EMPTY_CAPABILITIES, liveObserved: true },
    });
  }
}

async function callBridge(socketPath: string, request: AgentToolRequest): Promise<AgentToolResult> {
  return new Promise<AgentToolResult>((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ id: request.id, ok: false, message: "Zimlo Bridge 未响应；请先运行 zimlo start。" });
    }, 5_000);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as AgentToolResult);
      } catch {
        resolve({ id: request.id, ok: false, message: "Zimlo Bridge 返回了无效响应。" });
      }
      socket.end();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ id: request.id, ok: false, message: "无法连接 Zimlo Bridge；请先运行 zimlo start。" });
    });
  });
}

export async function runMcpServer(provider: Provider, socketPath: string): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  const respond = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const handle = async (message: Record<string, unknown>) => {
    const id = message.id;
    const method = String(message.method ?? "");
    if (id === undefined) return;
    if (method === "initialize") {
      respond({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "zimlo", version: "0.2.0" } } });
      return;
    }
    if (method === "ping") {
      respond({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      respond({ jsonrpc: "2.0", id, result: { tools: toolDefinitions() } });
      return;
    }
    if (method === "tools/call") {
      const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
      const name = String(params.name ?? "") as AgentToolRequest["name"];
      if (!(["feed.post", "feed.skip", "signal.transition", "material.publish"] as string[]).includes(name)) {
        respond({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "未知的 Zimlo 工具。" }] } });
        return;
      }
      const result = await callBridge(socketPath, {
        type: "agent_tool",
        id: uuidV7(),
        provider,
        parentPid: process.ppid,
        cwd: process.cwd(),
        name,
        arguments: params.arguments ?? {},
      });
      respond({
        jsonrpc: "2.0",
        id,
        result: {
          isError: !result.ok,
          content: [{ type: "text", text: JSON.stringify({ ok: result.ok, message: result.message, data: result.data ?? null }) }],
        },
      });
      return;
    }
    respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  };
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        process.stderr.write(`Zimlo MCP error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}
