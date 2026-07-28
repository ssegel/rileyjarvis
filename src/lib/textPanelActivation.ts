/**
 * App-level text-turn panel activation (artifacts vs Running Response Log).
 * Mirrors electron/text-panel-activation.cjs — keep in sync.
 */

import {
  buildTurnArtifactDelivery,
  isModeSwitchArtifact,
  type TurnArtifactDelivery,
} from "./artifactSelection";
import { isRunningResponseLogArtifact } from "./responseLogArtifact";
import type { JarvisTextTurnResult, RickyArtifact } from "../vite-env";

export type TextPanelActivationPlan = {
  toolNames: string[];
  artifactCount: number;
  selectedArtifact: RickyArtifact | null;
  hasSubstantiveArtifact: boolean;
  hasToolArtifact: boolean;
  activateResponseLog: boolean;
  panelMode: "toolArtifact" | "responseLog" | "mode" | "other" | "ready";
};

function readDelivery(result: JarvisTextTurnResult | null | undefined): TurnArtifactDelivery {
  if (!result) {
    return {
      artifacts: [],
      toolNames: [],
      artifactCount: 0,
      selectedArtifact: null,
      hasSubstantiveArtifact: false,
    };
  }
  const rebuilt = buildTurnArtifactDelivery(result.artifacts, result.toolTrace);
  const hasExplicitMeta =
    typeof result.hasSubstantiveArtifact === "boolean" ||
    typeof result.artifactCount === "number" ||
    result.selectedArtifact != null ||
    Array.isArray(result.toolNames);
  if (!hasExplicitMeta) return rebuilt;
  return {
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.filter(Boolean) : rebuilt.artifacts,
    toolNames: Array.isArray(result.toolNames) && result.toolNames.length ? result.toolNames : rebuilt.toolNames,
    artifactCount: typeof result.artifactCount === "number" ? result.artifactCount : rebuilt.artifactCount,
    selectedArtifact: result.selectedArtifact ?? rebuilt.selectedArtifact,
    hasSubstantiveArtifact:
      typeof result.hasSubstantiveArtifact === "boolean"
        ? result.hasSubstantiveArtifact
        : rebuilt.hasSubstantiveArtifact,
  };
}

/**
 * Decide whether Running Response Log may replace the Artifacts panel after a text turn.
 * Prefer returned/selected substantive artifacts (and any already-delivered tool artifact on
 * the panel) over incomplete tool-visibility metadata or a later generic mode artifact.
 */
export function planTextPanelActivation(args: {
  result: JarvisTextTurnResult | null | undefined;
  currentArtifact: RickyArtifact | null | undefined;
  appended: boolean;
}): TextPanelActivationPlan {
  const delivery = readDelivery(args.result);
  const current = args.currentArtifact || null;
  const currentIsResponseLog = isRunningResponseLogArtifact(current);
  const currentIsMode = isModeSwitchArtifact(current);
  const currentIsSubstantive = Boolean(current && !currentIsResponseLog && !currentIsMode);

  const hasSubstantiveArtifact = delivery.hasSubstantiveArtifact || currentIsSubstantive;
  let selectedArtifact = delivery.selectedArtifact;
  if (hasSubstantiveArtifact) {
    if (selectedArtifact && isModeSwitchArtifact(selectedArtifact)) {
      selectedArtifact = currentIsSubstantive ? current : null;
    } else if (!selectedArtifact && currentIsSubstantive) {
      selectedArtifact = current;
    }
  }

  if (hasSubstantiveArtifact) {
    return {
      toolNames: delivery.toolNames,
      artifactCount: Math.max(delivery.artifactCount, 1),
      selectedArtifact,
      hasSubstantiveArtifact: true,
      hasToolArtifact: true,
      activateResponseLog: false,
      panelMode: "toolArtifact",
    };
  }

  // Mode-only turn: keep Jarvis Mode; do not open Running Response Log.
  if (delivery.artifactCount > 0 || (currentIsMode && !currentIsResponseLog)) {
    return {
      toolNames: delivery.toolNames,
      artifactCount: delivery.artifactCount || 1,
      selectedArtifact: delivery.selectedArtifact || (currentIsMode ? current : null),
      hasSubstantiveArtifact: false,
      hasToolArtifact: true,
      activateResponseLog: false,
      panelMode: "mode",
    };
  }

  if (args.appended) {
    return {
      toolNames: delivery.toolNames,
      artifactCount: delivery.artifactCount,
      selectedArtifact: null,
      hasSubstantiveArtifact: false,
      hasToolArtifact: false,
      activateResponseLog: true,
      panelMode: "responseLog",
    };
  }

  return {
    toolNames: delivery.toolNames,
    artifactCount: delivery.artifactCount,
    selectedArtifact: delivery.selectedArtifact,
    hasSubstantiveArtifact: false,
    hasToolArtifact: false,
    activateResponseLog: false,
    panelMode: current ? "other" : "ready",
  };
}

const UNSUPPORTED_PANEL_CLAIM =
  /\b(?:full details are in the artifact panel|details are in the artifact panel|see (?:the )?(?:full )?details in the artifact panel)\b/i;

/**
 * Drop unsupported "details are in the artifact panel" narration when no substantive
 * artifact was actually delivered/selected for the turn.
 */
export function guardArtifactPanelNarration(text: string, hasSubstantiveArtifact: boolean): string {
  const raw = String(text || "").trim();
  if (!raw || hasSubstantiveArtifact) return raw;
  if (!UNSUPPORTED_PANEL_CLAIM.test(raw)) return raw;
  const cleaned = raw
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !UNSUPPORTED_PANEL_CLAIM.test(sentence))
    .join(" ")
    .trim();
  return cleaned || raw.replace(UNSUPPORTED_PANEL_CLAIM, "").replace(/\s{2,}/g, " ").trim();
}
