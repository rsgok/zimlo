import type { Host, Snapshot } from "@zimlo/protocol";

export interface DeviceCredentials {
  host: Host;
  deviceId: string;
  deviceKey: string;
  bridgeURL?: string;
  remoteRelayURL?: string;
  remoteAccessToken?: string;
}

const DATABASE = "zimlo";
const STORE = "credentials";
const LEGACY_RECORD = "bridge-device";
const RECORD = "bridge-hosts-v1";
const STATE_STORE = "state";
const SNAPSHOT_RECORD = "latest-snapshot";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(STATE_STORE)) request.result.createObjectStore(STATE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCredentials(): Promise<DeviceCredentials | null> {
  return (await readAllCredentials())[0] ?? null;
}

export async function readAllCredentials(): Promise<DeviceCredentials[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(RECORD);
    request.onsuccess = () => {
      const current = Array.isArray(request.result) ? request.result as DeviceCredentials[] : [];
      if (current.length) return resolve(current);
      const legacy = store.get(LEGACY_RECORD);
      legacy.onsuccess = () => {
        const value = legacy.result as Partial<DeviceCredentials> | null;
        if (!value?.deviceId || !value.deviceKey) return resolve([]);
        const migrated = [{
          ...value,
          host: value.host ?? {
            id: `legacy_${value.deviceId}`,
            name: "Mac",
            platform: "macos",
            lastSeenAt: "",
          },
        } as DeviceCredentials];
        store.put(migrated, RECORD);
        store.delete(LEGACY_RECORD);
        resolve(migrated);
      };
      legacy.onerror = () => reject(legacy.error);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveCredentials(credentials: DeviceCredentials): Promise<void> {
  const values = await readAllCredentials();
  const next = [credentials, ...values.filter((value) => value.host.id !== credentials.host.id)];
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(next, RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function clearCredentials(): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE, STATE_STORE], "readwrite");
    transaction.objectStore(STORE).delete(RECORD);
    transaction.objectStore(STORE).delete(LEGACY_RECORD);
    transaction.objectStore(STATE_STORE).delete(SNAPSHOT_RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function removeCredentials(hostId: string): Promise<void> {
  const values = (await readAllCredentials()).filter((value) => value.host.id !== hostId);
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(values, RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export interface CachedSnapshot {
  snapshot: Snapshot;
  /** 落盘时间（ISO）。旧裸格式没有该字段，读取时为 null。 */
  savedAt: string | null;
}

// 兼容旧格式：v1 直接存裸 Snapshot；v2 存 { snapshot, savedAt }。
export function parseCachedSnapshot(value: unknown): CachedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.snapshot && typeof record.snapshot === "object") {
    return { snapshot: record.snapshot as Snapshot, savedAt: typeof record.savedAt === "string" ? record.savedAt : null };
  }
  if (typeof record.sequence === "number") return { snapshot: value as Snapshot, savedAt: null };
  return null;
}

export async function readCachedSnapshot(): Promise<CachedSnapshot | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, "readonly");
    const request = transaction.objectStore(STATE_STORE).get(SNAPSHOT_RECORD);
    request.onsuccess = () => resolve(parseCachedSnapshot(request.result));
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveCachedSnapshot(snapshot: Snapshot, savedAt = new Date().toISOString()): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, "readwrite");
    transaction.objectStore(STATE_STORE).put({ snapshot, savedAt } satisfies CachedSnapshot, SNAPSHOT_RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
