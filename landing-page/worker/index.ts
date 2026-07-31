/** Cloudflare Worker entry point for the Zimlo landing page. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  createD1WaitlistStore,
  handleWaitlistPost,
  isWaitlistEnabled,
  parseBetaEndedAt,
  runWaitlistRetention,
} from "./waitlist.mjs";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  WAITLIST_ENABLED?: string;
  PRIVACY_CONTACT_VERIFIED?: string;
  WAITLIST_BETA_ENDED_AT?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

/** Minimal structural D1 surface used by worker/waitlist.mjs (JSDoc types). */
export interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first(): Promise<unknown>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/**
 * Header the worker uses to tell the RSC pages whether the waitlist is live.
 * Always stripped from inbound requests so clients cannot spoof it.
 */
export const WAITLIST_ENABLED_HEADER = "x-zimlo-waitlist-enabled";

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

function handleWaitlistRequest(request: Request, env: Env): Promise<Response> {
  if (!isWaitlistEnabled(env as unknown as Record<string, unknown>)) {
    // Gate closed: behave as if the route does not exist.
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  if (request.method !== "POST") {
    return Promise.resolve(new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    }));
  }
  return handleWaitlistPost(request, createD1WaitlistStore(env.DB as unknown as D1DatabaseLike));
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // The old /product-demo concept page is gone. Fragments never reach the
    // server, so redirect to `/` — the live demo section is `/#demo`.
    if (url.pathname === "/product-demo" || url.pathname === "/product-demo/") {
      return new Response(null, {
        status: 308,
        headers: { location: new URL("/", request.url).toString() },
      });
    }

    if (url.pathname === "/api/waitlist") {
      return handleWaitlistRequest(request, env);
    }

    const headers = new Headers(request.headers);
    headers.delete(WAITLIST_ENABLED_HEADER);
    if (isWaitlistEnabled(env as unknown as Record<string, unknown>)) {
      headers.set(WAITLIST_ENABLED_HEADER, "1");
    }
    return handler.fetch(new Request(request, { headers }), env, ctx);
  },

  /**
   * Daily waitlist retention sweep (configure a cron trigger on deploy).
   * Always purges inactive stragglers; active rows are swept only after the
   * configured Beta grace period. Logs counts only, never email addresses.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (!env.DB) return;
    const betaEndedAt = parseBetaEndedAt(env.WAITLIST_BETA_ENDED_AT);
    const result = await runWaitlistRetention(env.DB as unknown as D1DatabaseLike, { betaEndedAt });
    console.log(
      `[waitlist-retention] ${new Date().toISOString()}`
      + ` expired=${result.deletedExpired} inactive=${result.deletedInactive} swept=${result.sweepRan}`,
    );
  },
};

export default worker;
