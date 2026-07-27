interface SocketAttachment {
  role: "mac" | "device";
  connectionId: string;
  deviceId?: string;
}

interface MacRelayFrame {
  type: "data" | "close";
  connectionId: string;
  data?: string;
}

export class RelayRoom implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_required" }, { status: 426 });
    }
    const role = request.headers.get("x-zimlo-relay-role");
    if (role !== "mac" && role !== "device") {
      return Response.json({ error: "invalid_role" }, { status: 403 });
    }
    const existingMac = this.state.getWebSockets("mac");
    if (role === "device" && existingMac.length === 0) {
      return Response.json({ error: "mac_offline" }, { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = crypto.randomUUID();
    const attachment: SocketAttachment = {
      role,
      connectionId,
    };
    const deviceId = request.headers.get("x-zimlo-device-id");
    if (role === "device" && deviceId) attachment.deviceId = deviceId;
    if (role === "mac") {
      for (const socket of existingMac) socket.close(1012, "Mac relay replaced");
    }
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment(attachment);
    if (role === "device") this.sendToMac({ type: "open", connectionId });
    const protocol = request.headers.get("x-zimlo-websocket-protocol");
    const init: ResponseInit = { status: 101, webSocket: client };
    if (protocol) init.headers = { "sec-websocket-protocol": protocol };
    return new Response(null, init);
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return socket.close(1008, "Missing relay identity");
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (attachment.role === "device") {
      this.sendToMac({ type: "data", connectionId: attachment.connectionId, data });
      return;
    }
    let frame: MacRelayFrame;
    try {
      frame = JSON.parse(data) as MacRelayFrame;
    } catch {
      return socket.close(1003, "Invalid relay frame");
    }
    if (!frame.connectionId || !["data", "close"].includes(frame.type)) {
      return socket.close(1008, "Invalid relay frame");
    }
    const target = this.deviceSocket(frame.connectionId);
    if (!target) return;
    if (frame.type === "close") target.close(1000, "Mac closed local bridge");
    else if (typeof frame.data === "string") target.send(frame.data);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    if (attachment.role === "device") {
      this.sendToMac({ type: "close", connectionId: attachment.connectionId });
      return;
    }
    for (const device of this.state.getWebSockets("device")) {
      device.close(code === 1000 ? 1013 : code, reason || "Mac offline");
    }
  }

  webSocketError(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role === "device") {
      this.sendToMac({ type: "close", connectionId: attachment.connectionId });
    }
  }

  private sendToMac(value: Record<string, unknown>): void {
    const data = JSON.stringify(value);
    for (const socket of this.state.getWebSockets("mac")) socket.send(data);
  }

  private deviceSocket(connectionId: string): WebSocket | null {
    for (const socket of this.state.getWebSockets("device")) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.connectionId === connectionId) return socket;
    }
    return null;
  }
}
