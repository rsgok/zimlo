import { z } from "zod";
import {
  CARD_CATALOG,
  CARD_DENSITIES,
  CARD_LAYOUTS,
  CARD_MEDIA_PLACEMENTS,
  CARD_SYSTEMS,
  CARD_THEMES,
  CARD_TYPOGRAPHY,
} from "./card-system.generated.js";

export {
  CARD_CATALOG,
  CARD_DENSITIES,
  CARD_LAYOUTS,
  CARD_MEDIA_PLACEMENTS,
  CARD_SYSTEMS,
  CARD_THEMES,
  CARD_TYPOGRAPHY,
} from "./card-system.generated.js";

const AUTO = "auto" as const;
const CARD_SYSTEM_INPUTS = [AUTO, ...CARD_SYSTEMS] as const;
const CARD_THEME_INPUTS = [AUTO, ...CARD_THEMES] as const;
const CARD_LAYOUT_INPUTS = [AUTO, ...CARD_LAYOUTS] as const;
const CARD_TYPOGRAPHY_INPUTS = [AUTO, ...CARD_TYPOGRAPHY] as const;
const CARD_DENSITY_INPUTS = [AUTO, ...CARD_DENSITIES] as const;
const CARD_MEDIA_PLACEMENT_INPUTS = [AUTO, ...CARD_MEDIA_PLACEMENTS] as const;
const RESOLVED_MEDIA_PLACEMENTS = ["none", ...CARD_MEDIA_PLACEMENTS] as const;

export const CardSystemSchema = z.enum(CARD_SYSTEMS);
export const CardThemeSchema = z.enum(CARD_THEMES);
export const CardLayoutSchema = z.enum(CARD_LAYOUTS);
export const CardTypographySchema = z.enum(CARD_TYPOGRAPHY);
export const CardDensitySchema = z.enum(CARD_DENSITIES);
export const CardMediaPlacementSchema = z.enum(RESOLVED_MEDIA_PLACEMENTS);

export const CardPresentationInputSchema = z.object({
  system: z.enum(CARD_SYSTEM_INPUTS),
  theme: z.enum(CARD_THEME_INPUTS),
  layout: z.enum(CARD_LAYOUT_INPUTS),
  typography: z.enum(CARD_TYPOGRAPHY_INPUTS),
  density: z.enum(CARD_DENSITY_INPUTS),
  mediaPlacement: z.enum(CARD_MEDIA_PLACEMENT_INPUTS),
}).strict();

export const ResolvedCardPresentationSchema = z.object({
  system: CardSystemSchema,
  theme: CardThemeSchema,
  layout: CardLayoutSchema,
  typography: CardTypographySchema,
  density: CardDensitySchema,
  mediaPlacement: CardMediaPlacementSchema,
}).strict();

const ComparisonItemSchema = z.object({
  label: z.string().min(1).max(32),
  value: z.string().min(1).max(48),
  detail: z.string().min(1).max(100).optional(),
}).strict();

export const CardBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fact"),
    label: z.string().min(1).max(32),
    detail: z.string().min(1).max(120),
    value: z.string().min(1).max(32).optional(),
  }).strict(),
  z.object({
    type: z.literal("metric"),
    label: z.string().min(1).max(24),
    value: z.string().min(1).max(24),
    unit: z.string().min(1).max(12).optional(),
    caption: z.string().min(1).max(80).optional(),
  }).strict(),
  z.object({
    type: z.literal("step"),
    label: z.string().min(1).max(48),
    detail: z.string().min(1).max(120).optional(),
    phase: z.enum(["done", "current", "next"]),
  }).strict(),
  z.object({
    type: z.literal("quote"),
    text: z.string().min(1).max(240),
    attribution: z.string().min(1).max(80).optional(),
  }).strict(),
  z.object({
    type: z.literal("comparison"),
    label: z.string().min(1).max(48).optional(),
    left: ComparisonItemSchema,
    right: ComparisonItemSchema,
  }).strict(),
]);

export type CardSystem = z.infer<typeof CardSystemSchema>;
export type CardTheme = z.infer<typeof CardThemeSchema>;
export type CardLayout = z.infer<typeof CardLayoutSchema>;
export type CardTypography = z.infer<typeof CardTypographySchema>;
export type CardDensity = z.infer<typeof CardDensitySchema>;
export type CardMediaPlacement = z.infer<typeof CardMediaPlacementSchema>;
export type CardPresentationInput = z.infer<typeof CardPresentationInputSchema>;
export type ResolvedCardPresentation = z.infer<typeof ResolvedCardPresentationSchema>;
export type CardBlock = z.infer<typeof CardBlockSchema>;

type CardSemanticKind = "progress" | "decision" | "attention" | "result" | "failure";
type CardContentKind = "text" | "image_album" | "video" | "document";

export interface CardPresentationResolutionInput {
  kind: CardSemanticKind;
  presentation: CardPresentationInput;
  blocks: CardBlock[];
  content?: { type: CardContentKind } | undefined;
}

export class CardPresentationError extends Error {}

const themeSystem = new Map(CARD_CATALOG.themes.map((theme) => [theme.id, theme.system]));
const layoutSystem = new Map(CARD_CATALOG.layouts.map((layout) => [layout.id, layout.system]));
const layoutRequirements = new Map(CARD_CATALOG.layouts.map((layout) => [layout.id, layout.requires]));

function blockCount(blocks: CardBlock[], type: CardBlock["type"]): number {
  return blocks.filter((block) => block.type === type).length;
}

function isVisualMedia(type: CardContentKind): boolean {
  return type === "image_album" || type === "video";
}

function resolveSystem(input: CardPresentationResolutionInput): CardSystem {
  if (input.presentation.system !== AUTO) return input.presentation.system;
  const requestedThemeSystem = input.presentation.theme === AUTO ? undefined : themeSystem.get(input.presentation.theme);
  const requestedLayoutSystem = input.presentation.layout === AUTO ? undefined : layoutSystem.get(input.presentation.layout);
  if (requestedThemeSystem && requestedLayoutSystem && requestedThemeSystem !== requestedLayoutSystem) {
    throw new CardPresentationError(`theme=${input.presentation.theme} 与 layout=${input.presentation.layout} 不属于同一 system。`);
  }
  if (requestedLayoutSystem) return requestedLayoutSystem;
  if (requestedThemeSystem) return requestedThemeSystem;
  const contentType = input.content?.type ?? "text";
  if (contentType === "document" || blockCount(input.blocks, "quote") > 0) return "editorial";
  if (
    input.kind === "attention"
    || input.kind === "failure"
    || input.kind === "progress"
    || blockCount(input.blocks, "metric") > 0
    || blockCount(input.blocks, "step") > 0
    || blockCount(input.blocks, "comparison") > 0
  ) return "swiss";
  return "editorial";
}

function resolveLayout(input: CardPresentationResolutionInput, system: CardSystem): CardLayout {
  if (input.presentation.layout !== AUTO) {
    if (layoutSystem.get(input.presentation.layout) !== system) {
      throw new CardPresentationError(`layout=${input.presentation.layout} 不属于 system=${system}。`);
    }
    return input.presentation.layout;
  }
  const contentType = input.content?.type ?? "text";
  if (system === "editorial") {
    if (contentType === "document") return "document_excerpt";
    if (isVisualMedia(contentType)) return "media_quiet_zone";
    if (blockCount(input.blocks, "quote") > 0) return "quote";
    if (input.blocks.length >= 4) return "story_split";
    if (input.kind === "result" || input.kind === "decision") return "field_note";
    return "feature";
  }
  if (input.kind === "attention" || input.kind === "failure") return "alert";
  if (blockCount(input.blocks, "comparison") > 0) return "comparison";
  if (blockCount(input.blocks, "step") > 0) return "steps";
  if (isVisualMedia(contentType)) return "evidence_top";
  if (blockCount(input.blocks, "metric") > 0) return "metric_grid";
  return "status_board";
}

function validateLayoutRequirements(input: CardPresentationResolutionInput, layout: CardLayout): void {
  const requirements = layoutRequirements.get(layout) ?? [];
  const contentType = input.content?.type ?? "text";
  for (const requirement of requirements) {
    if (requirement === "media" && !isVisualMedia(contentType)) throw new CardPresentationError(`layout=${layout} 需要 image_album 或 video content。`);
    if (requirement === "document" && contentType !== "document") throw new CardPresentationError(`layout=${layout} 需要 document content。`);
    if (requirement === "attention" && input.kind !== "attention" && input.kind !== "failure") throw new CardPresentationError(`layout=${layout} 只适用于 attention 或 failure。`);
    if (["quote", "metric", "comparison", "step"].includes(requirement) && blockCount(input.blocks, requirement as CardBlock["type"]) === 0) {
      throw new CardPresentationError(`layout=${layout} 需要至少一个 ${requirement} block。`);
    }
  }
}

function resolveTheme(input: CardPresentationResolutionInput, system: CardSystem): CardTheme {
  if (input.presentation.theme !== AUTO) {
    if (themeSystem.get(input.presentation.theme) !== system) {
      throw new CardPresentationError(`theme=${input.presentation.theme} 不属于 system=${system}。`);
    }
    return input.presentation.theme;
  }
  if (system === "swiss") return input.kind === "attention" || input.kind === "failure" ? "safety_orange" : "lemon_green";
  return "ink_classic";
}

function resolveMediaPlacement(input: CardPresentationResolutionInput, layout: CardLayout): CardMediaPlacement {
  const contentType = input.content?.type ?? "text";
  const requested = input.presentation.mediaPlacement;
  if (requested !== AUTO) {
    if (contentType === "text") throw new CardPresentationError(`mediaPlacement=${requested} 需要非 text content。`);
    if (contentType === "document" && requested !== "inline") throw new CardPresentationError("document content 只支持 mediaPlacement=inline。");
    if (isVisualMedia(contentType) && requested === "inline") throw new CardPresentationError("image_album/video 不支持 mediaPlacement=inline。");
    return requested;
  }
  if (contentType === "text") return "none";
  if (contentType === "document") return "inline";
  if (layout === "media_quiet_zone") return "full_bleed";
  if (layout === "evidence_top") return "evidence";
  if (layout === "story_split") return "split";
  return "hero";
}

export function resolveCardPresentation(input: CardPresentationResolutionInput): ResolvedCardPresentation {
  const system = resolveSystem(input);
  const layout = resolveLayout(input, system);
  validateLayoutRequirements(input, layout);
  return {
    system,
    theme: resolveTheme(input, system),
    layout,
    typography: input.presentation.typography === AUTO ? system === "editorial" ? "serif" : "sans" : input.presentation.typography,
    density: input.presentation.density === AUTO ? input.blocks.length <= 2 ? "airy" : input.blocks.length >= 6 ? "compact" : "balanced" : input.presentation.density,
    mediaPlacement: resolveMediaPlacement(input, layout),
  };
}
