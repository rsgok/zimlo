// TTL cache with in-flight request coalescing for subprocess-backed status
// probes (`codex mcp get zimlo`, `codex plugin list --json`). The macOS wizard
// polls /api/local/status about once per second, and each probe used to spawn
// a fresh Codex process; a short cache plus single-flight keeps polling cheap
// while stays fresh enough for humans clicking "recheck".
export class ProbeCache {
  private readonly values = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = compute()
      .then((value) => {
        this.values.set(key, { expiresAt: this.now() + this.ttlMs, value });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidateAll(): void {
    this.values.clear();
  }
}

export const INTEGRATION_PROBE_TTL_MS = 10_000;

export const integrationProbeCache = new ProbeCache(INTEGRATION_PROBE_TTL_MS);

// Called after any mutation (hooks/MCP install, Codex plugin install) so the
// next status read observes the new reality instead of a pre-install cache.
export function invalidateIntegrationProbes(): void {
  integrationProbeCache.invalidateAll();
}
