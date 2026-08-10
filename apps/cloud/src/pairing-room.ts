interface PairingRegistration {
  installationId: string;
  tokenHash: string;
  expiresAt: string;
}

interface PendingPairingRequest {
  requestId: string;
  clientPublicKey: string;
  proof: string;
  name?: string;
}

interface PairingCompletion {
  requestId: string;
  status: number;
  response: unknown;
}

async function sha256URL(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export class PairingRoom implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/register") {
      return this.register(request);
    }

    const registration = await this.state.storage.get<PairingRegistration>("registration");
    if (!registration || new Date(registration.expiresAt).getTime() <= Date.now()) {
      await this.state.storage.deleteAll();
      return jsonError(410, "pairing_expired");
    }

    if (request.method === "POST" && url.pathname === "/device") {
      return this.acceptDeviceRequest(request, registration);
    }
    if (request.method === "GET" && url.pathname === "/device/result") {
      return this.deviceResult(request, registration);
    }
    if (request.method === "GET" && url.pathname === "/mac/request") {
      if (!this.authorizedMac(request, registration)) return jsonError(403, "wrong_installation");
      const pending = await this.state.storage.get<PendingPairingRequest>("pending");
      return pending ? Response.json(pending) : new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/mac/complete") {
      if (!this.authorizedMac(request, registration)) return jsonError(403, "wrong_installation");
      return this.complete(request);
    }
    if (request.method === "DELETE" && url.pathname === "/mac") {
      if (!this.authorizedMac(request, registration)) return jsonError(403, "wrong_installation");
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }
    return jsonError(404, "not_found");
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async register(request: Request): Promise<Response> {
    const body = await request.json<Partial<PairingRegistration>>().catch(() => null);
    if (
      !body?.installationId
      || !body.tokenHash
      || !body.expiresAt
      || new Date(body.expiresAt).getTime() <= Date.now()
    ) {
      return jsonError(400, "invalid_pairing");
    }
    const existing = await this.state.storage.get<PairingRegistration>("registration");
    if (existing && existing.installationId !== body.installationId) {
      return jsonError(409, "pairing_exists");
    }
    const registration: PairingRegistration = {
      installationId: body.installationId,
      tokenHash: body.tokenHash,
      expiresAt: body.expiresAt,
    };
    await this.state.storage.put("registration", registration);
    await this.state.storage.setAlarm(new Date(registration.expiresAt).getTime());
    return Response.json({ ok: true });
  }

  private async acceptDeviceRequest(
    request: Request,
    registration: PairingRegistration,
  ): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (
      !body
      || typeof body.pairingToken !== "string"
      || await sha256URL(body.pairingToken) !== registration.tokenHash
      || typeof body.clientPublicKey !== "string"
      || typeof body.proof !== "string"
    ) {
      return jsonError(403, "invalid_pairing_token");
    }
    const completion = await this.state.storage.get<PairingCompletion>("completion");
    if (completion) return jsonError(410, "pairing_used");
    const existing = await this.state.storage.get<PendingPairingRequest>("pending");
    if (existing) return Response.json({ requestId: existing.requestId }, { status: 202 });
    const pending: PendingPairingRequest = {
      requestId: crypto.randomUUID(),
      clientPublicKey: body.clientPublicKey,
      proof: body.proof,
      ...(typeof body.name === "string" ? { name: body.name.slice(0, 80) } : {}),
    };
    await this.state.storage.put("pending", pending);
    return Response.json({ requestId: pending.requestId }, { status: 202 });
  }

  private async deviceResult(
    request: Request,
    registration: PairingRegistration,
  ): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("pairingToken") ?? "";
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!token || await sha256URL(token) !== registration.tokenHash) {
      return jsonError(403, "invalid_pairing_token");
    }
    const completion = await this.state.storage.get<PairingCompletion>("completion");
    if (!completion || completion.requestId !== requestId) {
      const pending = await this.state.storage.get<PendingPairingRequest>("pending");
      if (!pending || pending.requestId !== requestId) return jsonError(410, "pairing_expired");
      return Response.json({ requestId }, { status: 202 });
    }
    await this.state.storage.deleteAll();
    return Response.json(completion.response, { status: completion.status });
  }

  private async complete(request: Request): Promise<Response> {
    const body = await request.json<Partial<PairingCompletion>>().catch(() => null);
    const pending = await this.state.storage.get<PendingPairingRequest>("pending");
    if (
      !pending
      || !body
      || body.requestId !== pending.requestId
      || typeof body.status !== "number"
      || body.response === undefined
    ) {
      return jsonError(409, "pairing_request_changed");
    }
    await this.state.storage.put("completion", {
      requestId: pending.requestId,
      status: body.status,
      response: body.response,
    } satisfies PairingCompletion);
    return Response.json({ ok: true });
  }

  private authorizedMac(request: Request, registration: PairingRegistration): boolean {
    return request.headers.get("x-zimlo-installation-id") === registration.installationId;
  }
}
