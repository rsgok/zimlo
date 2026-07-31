// Stable error shape for every local API route: { code, message, recoverable, action? }.
// The macOS app decodes this structure (see ServiceRecovery.swift); messages
// are user-facing Chinese and `action` is the next step the user can take.
// Route handlers must never leak Fastify's default "Internal Server Error".
import type { FastifyReply } from "fastify";

export interface StableErrorBody {
  code: string;
  message: string;
  recoverable: boolean;
  action?: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly recoverable: boolean,
    readonly action?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  body(): StableErrorBody {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.action ? { action: this.action } : {}),
    };
  }
}

export function sendApiError(reply: FastifyReply, error: ApiError): FastifyReply {
  return reply.code(error.httpStatus).send(error.body());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Maps any error thrown while installing or inspecting CLI integrations to a
// stable, user-actionable failure. Ordering matters: configuration corruption
// and missing agent executables are more specific than the generic install
// failure.
export function classifyIntegrationError(error: unknown): ApiError {
  const message = errorMessage(error);
  if (/尚未发现 Codex 或 Claude Code/u.test(message)) {
    return new ApiError("no_integrations", message, 400, false, "请先安装 Codex 或 Claude Code，再重试。");
  }
  if (/无法解析|SyntaxError|Unexpected token|in JSON/u.test(message)) {
    return new ApiError("config_corrupt", message, 500, false, "备份并修复该 JSON 文件后重试；zimlo doctor 可协助定位。");
  }
  if (/ENOENT/u.test(message)) {
    return new ApiError("runtime_missing", message, 500, false, "Agent 或插件文件缺失，请重新安装对应程序后重试。");
  }
  return new ApiError("integration_install_failed", message, 500, true, "运行 zimlo doctor 检查环境后重试。");
}

// Generic classifier for read-only local endpoints (status/bootstrap): keeps
// configuration corruption distinguishable from a transient probe failure.
export function classifyLocalApiError(error: unknown, fallbackCode: string, fallbackMessage: string): ApiError {
  const message = errorMessage(error);
  if (/无法解析|SyntaxError|Unexpected token|in JSON/u.test(message)) {
    return new ApiError("config_corrupt", message, 500, false, "备份并修复该 JSON 文件后重试；zimlo doctor 可协助定位。");
  }
  return new ApiError(fallbackCode, fallbackMessage, 500, true, "运行 zimlo doctor 查看详情后重试。");
}
