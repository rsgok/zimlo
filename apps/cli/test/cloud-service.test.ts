import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudService } from "../src/cloud-service.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const originalCloudURL = process.env.ZIMLO_CLOUD_URL;
const originalCloudDisabled = process.env.ZIMLO_CLOUD_DISABLED;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCloudURL === undefined) delete process.env.ZIMLO_CLOUD_URL;
  else process.env.ZIMLO_CLOUD_URL = originalCloudURL;
  if (originalCloudDisabled === undefined) delete process.env.ZIMLO_CLOUD_DISABLED;
  else process.env.ZIMLO_CLOUD_DISABLED = originalCloudDisabled;
});

describe("CloudService health capabilities", () => {
  it("exposes push notifications only when the cloud reports APNs configured", async () => {
    process.env.ZIMLO_CLOUD_URL = "https://cloud.example";
    delete process.env.ZIMLO_CLOUD_DISABLED;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      protocolVersion: 2,
      pushConfigured: true,
    })));
    const store = new ZimloStore(":memory:");
    const cloud = new CloudService(store);

    await expect(cloud.refreshHealth()).resolves.toBe(true);
    expect(cloud.pushNotificationsAvailable).toBe(true);
    expect(new RuntimeHub(store, cloud).snapshot().features).toMatchObject({
      pushNotifications: true,
      remoteSync: true,
    });
    store.close();
  });

  it("fails closed when cloud health is unavailable or APNs is not configured", async () => {
    process.env.ZIMLO_CLOUD_URL = "https://cloud.example";
    delete process.env.ZIMLO_CLOUD_DISABLED;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      protocolVersion: 2,
      pushConfigured: false,
    })));
    const store = new ZimloStore(":memory:");
    const cloud = new CloudService(store);

    await expect(cloud.refreshHealth()).resolves.toBe(true);
    expect(new RuntimeHub(store, cloud).snapshot().features.pushNotifications).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(cloud.refreshHealth()).resolves.toBe(false);
    expect(cloud.pushNotificationsAvailable).toBe(false);
    store.close();
  });

  it("does not attempt registration after the cloud health check fails", async () => {
    process.env.ZIMLO_CLOUD_URL = "https://cloud.example";
    delete process.env.ZIMLO_CLOUD_DISABLED;
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new ZimloStore(":memory:");
    const cloud = new CloudService(store);

    await expect(cloud.ensureReady()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cloud.example/healthz");
    store.close();
  });
});
