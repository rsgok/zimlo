import type { ClientCommand, ServerMessage } from "@zimlo/protocol";

type CommandError = Extract<ServerMessage, { type: "error" }>;

// Durable mobile commands need a correlation key in terminal errors, just as
// successful acknowledgements do. commandType is useful diagnostic context;
// idempotencyKey lets the client stop retrying exactly the rejected entry.
export function commandError(command: ClientCommand, code: string, message: string): CommandError {
  const idempotencyKey = "idempotencyKey" in command && typeof command.idempotencyKey === "string"
    ? command.idempotencyKey
    : undefined;
  return {
    type: "error",
    code,
    message,
    commandType: command.type,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
