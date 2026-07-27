import type { Snapshot } from "@zimlo/protocol";

export interface DeviceCredentials {
  deviceId: string;
  deviceKey: string;
  remoteRelayURL?: string;
  remoteAccessToken?: string;
}

const DATABASE = "zimlo";
const STORE = "credentials";
const RECORD = "bridge-device";
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
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(RECORD);
    request.onsuccess = () => resolve(request.result as DeviceCredentials | null ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveCredentials(credentials: DeviceCredentials): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(credentials, RECORD);
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
    transaction.objectStore(STATE_STORE).delete(SNAPSHOT_RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readCachedSnapshot(): Promise<Snapshot | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, "readonly");
    const request = transaction.objectStore(STATE_STORE).get(SNAPSHOT_RECORD);
    request.onsuccess = () => resolve(request.result as Snapshot | null ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveCachedSnapshot(snapshot: Snapshot): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, "readwrite");
    transaction.objectStore(STATE_STORE).put(snapshot, SNAPSHOT_RECORD);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
