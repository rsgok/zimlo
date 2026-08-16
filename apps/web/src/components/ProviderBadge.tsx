import type { Provider, SessionSurface } from "@zimlo/protocol";
import { runtimeLabel, surfaceLabel } from "./sessionPresentation";

import codexIcon from "../../../shared/branding/providers/codex.png";
import claudeIcon from "../../../shared/branding/providers/claude.png";

interface ProviderBadgeProps {
  provider: Provider;
  surface?: SessionSurface | undefined;
  labelMode?: "icon" | "surface" | "full";
  className?: string | undefined;
}

export function ProviderIcon({ provider }: { provider: Provider }) {
  return <img className={`provider-icon provider-icon-image provider-icon-${provider}`} src={provider === "codex" ? codexIcon : claudeIcon} alt="" aria-hidden="true" />;
}

export function ProviderBadge({ provider, surface, labelMode = "surface", className }: ProviderBadgeProps) {
  const providerName = runtimeLabel(provider);
  const knownSurface = surface && surface !== "unknown" ? surface : undefined;
  const fullLabel = knownSurface ? `${providerName} · ${surfaceLabel(knownSurface)}` : providerName;
  const visibleLabel = labelMode === "full" ? fullLabel : labelMode === "surface" && knownSurface ? surfaceLabel(knownSurface) : null;
  return (
    <span className={`provider provider-${provider} provider-badge ${className ?? ""}`.trim()} aria-label={fullLabel} title={fullLabel}>
      <ProviderIcon provider={provider} />
      {visibleLabel && <span aria-hidden="true">{visibleLabel}</span>}
    </span>
  );
}
