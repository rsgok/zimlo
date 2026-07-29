import { headers } from "next/headers";

/**
 * Set by worker/index.ts after it verifies the full waitlist gate
 * (WAITLIST_ENABLED + D1 binding + PRIVACY_CONTACT_VERIFIED). The worker
 * strips this header from inbound requests, so pages can trust it.
 */
const WAITLIST_ENABLED_HEADER = "x-zimlo-waitlist-enabled";

/**
 * Server-side gate check for rendering the waitlist form. When false, pages
 * render the classic BetaDownload flow instead.
 */
export async function isWaitlistLive(): Promise<boolean> {
  return (await headers()).get(WAITLIST_ENABLED_HEADER) === "1";
}
