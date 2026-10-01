type ObjectValue = Record<string, unknown>;
const keys: Record<string, string> = { projects: "id", sessions: "id", posts: "id", materials: "id", tasks: "id", commands: "id", workspaces: "id", cards: "id", actions: "actionId", taskPreferences: "sessionId" };
function object(value: unknown): value is ObjectValue { return !!value && typeof value === "object" && !Array.isArray(value); }

export class SnapshotReplica {
  private snapshot: ObjectValue | null = null;
  private revision: string | null = null;
  private negotiated = false;
  constructor(private readonly hostId: string) {}

  receive(envelope: unknown): { message: ObjectValue; negotiateDelta: boolean } | null {
    if (!object(envelope)) return null;
    if (envelope.type === "session.snapshot") {
      if (!object(envelope.snapshot) || !object(envelope.snapshot.host) || envelope.snapshot.host.id !== this.hostId) return null;
      this.snapshot = envelope.snapshot;
      this.revision = typeof envelope.revision === "string" ? envelope.revision : null;
      const negotiateDelta = !this.negotiated && object(envelope.syncCapabilities) && envelope.syncCapabilities.delta === true;
      this.negotiated ||= negotiateDelta;
      return { message: envelope, negotiateDelta };
    }
    if (envelope.type !== "snapshot.delta") return { message: envelope, negotiateDelta: false };
    if (!this.snapshot || !this.revision || envelope.hostId !== this.hostId || envelope.baseRevision !== this.revision
      || typeof envelope.revision !== "string" || envelope.revision === this.revision || !object(envelope.replace)
      || !object(envelope.collections) || !Array.isArray(envelope.removedFields)) return null;
    const next = { ...this.snapshot, ...envelope.replace };
    for (const field of envelope.removedFields) { if (typeof field !== "string") return null; delete next[field]; }
    for (const [name, patch] of Object.entries(envelope.collections)) {
      const key = keys[name]; const old = next[name];
      if (!key || !object(patch) || patch.key !== key || !Array.isArray(old) || !Array.isArray(patch.upsert)
        || !Array.isArray(patch.remove) || !Array.isArray(patch.order) || new Set(patch.order).size !== patch.order.length) return null;
      const items = new Map<string, ObjectValue>();
      for (const item of old) { if (!object(item) || typeof item[key] !== "string") return null; items.set(item[key] as string, item); }
      for (const id of patch.remove) { if (typeof id !== "string") return null; items.delete(id); }
      for (const item of patch.upsert) { if (!object(item) || typeof item[key] !== "string") return null; items.set(item[key] as string, item); }
      if (items.size !== patch.order.length || patch.order.some((id) => typeof id !== "string" || !items.has(id))) return null;
      next[name] = patch.order.map((id) => items.get(id as string));
    }
    if (!object(next.host) || next.host.id !== this.hostId) return null;
    this.snapshot = next; this.revision = envelope.revision;
    return { message: { type: "session.snapshot", snapshot: next }, negotiateDelta: false };
  }
}
