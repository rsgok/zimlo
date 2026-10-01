import { z } from "zod";
import type { Material } from "./index.js";
export const HistorySearchSchema = z.object({
  type: z.literal("history.search"), requestId: z.string().min(1).max(128), query: z.string().max(200).default(""),
  projectId: z.string().max(256).optional(), sessionId: z.string().max(256).optional(), after: z.string().max(256).optional(),
  kind: z.enum(["all", "result", "failure", "image", "video", "pdf", "document"]).default("all"),
  cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(30),
});
export interface HistoryEntry {
  id: string; hostId: string; kind: string; title: string; summary: string; createdAt: string;
  projectId: string | null; sessionId: string | null; materialId: string | null; materialIds: string[];
  mimeType: string | null; sizeBytes: number | null; status: string;
}
export interface HistoryPage { requestId: string; hostId: string; items: HistoryEntry[]; materials: Material[]; nextCursor: string | null }
