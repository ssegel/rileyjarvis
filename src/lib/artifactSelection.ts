/**
 * Shared turn-artifact selection (mirrors electron/artifact-selection.cjs).
 * Mode-switch / "Jarvis Mode" progress artifacts must not clobber substantive ones.
 */

import type { JarvisTextToolTraceItem, RickyArtifact } from "../vite-env";

export function isModeSwitchArtifact(artifact: RickyArtifact | null | undefined): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  const title = String(artifact.title || "");
  const content = String(artifact.content || "");
  if (title === "Jarvis Mode") return true;
  if (artifact.kind === "progress" && /^Mode switched to\b/.test(content)) return true;
  return false;
}

export function selectTurnArtifacts(artifacts: Array<RickyArtifact | null | undefined> | null | undefined): RickyArtifact[] {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter((item): item is RickyArtifact => Boolean(item));
  const substantive = list.filter((item) => !isModeSwitchArtifact(item));
  return substantive.length > 0 ? substantive : list;
}

export function pickWinningTurnArtifact(
  artifacts: Array<RickyArtifact | null | undefined> | null | undefined,
): RickyArtifact | null {
  const selected = selectTurnArtifacts(artifacts);
  if (!selected.length) return null;
  return selected[selected.length - 1];
}

export type TurnArtifactDelivery = {
  artifacts: RickyArtifact[];
  toolNames: string[];
  artifactCount: number;
  selectedArtifact: RickyArtifact | null;
  hasSubstantiveArtifact: boolean;
};

/** Centralized text-turn artifact delivery metadata (mirrors electron/artifact-selection.cjs). */
export function buildTurnArtifactDelivery(
  artifacts: Array<RickyArtifact | null | undefined> | null | undefined,
  toolTrace: Array<JarvisTextToolTraceItem | null | undefined> | null | undefined,
): TurnArtifactDelivery {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter((item): item is RickyArtifact => Boolean(item));
  const selected = selectTurnArtifacts(list);
  const substantive = list.filter((item) => !isModeSwitchArtifact(item));
  const toolNames = (Array.isArray(toolTrace) ? toolTrace : [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  const selectedArtifact = selected.length ? selected[selected.length - 1] : null;
  return {
    artifacts: selected,
    toolNames,
    artifactCount: selected.length,
    selectedArtifact,
    hasSubstantiveArtifact: substantive.length > 0,
  };
}
