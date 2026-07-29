import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Beta waitlist signups.
 *
 * Privacy constraints (mirrored in worker/waitlist.mjs and /privacy):
 * - `email` is stored normalized (trimmed + lower-cased) and unique.
 * - No IP addresses, user agents, or referrer data are ever persisted.
 * - Rows with status "converted"/"unsubscribed" are deleted at the moment of
 *   the action; the daily sweep only keeps this table to: active rows during
 *   the Beta, and nothing later than 90 days after the Beta ends.
 */
export const waitlistSignups = sqliteTable("waitlist_signups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  // active | converted | unsubscribed (non-active rows are deleted on sight)
  status: text("status").notNull().default("active"),
  // Coarse signup surface tag: hero | beta | privacy | landing
  source: text("source").notNull().default("landing"),
  // Version of the consent copy the user agreed to (see /privacy)
  consentVersion: text("consent_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
