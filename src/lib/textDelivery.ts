import type { JarvisTextTurnResult } from "../vite-env";

/**
 * Pure helpers for Phase 11 text-result delivery.
 * Length/metadata only — never log or return response content from diagnostics helpers.
 */

export function readAssistantText(result: JarvisTextTurnResult | null | undefined): string {
  if (!result) return "";
  return String(result.assistantText ?? "").trim();
}

export function hasDeliverableTextResult(result: JarvisTextTurnResult | null | undefined): boolean {
  if (!result?.ok) return false;
  return Boolean(readAssistantText(result)) || (result.artifacts?.length ?? 0) > 0;
}

/** Accept the in-flight turn when its submit generation is still current. */
export function isCurrentTextGeneration(submitGeneration: number, currentGeneration: number): boolean {
  return submitGeneration === currentGeneration;
}

export type TextDeliveryPlan =
  | { action: "deliver"; assistantText: string; assistantTextLen: number; artifactCount: number }
  | { action: "empty_error"; assistantTextLen: 0; artifactCount: number }
  | { action: "reject"; reason: "stale" | "cancelled" | "error" | "missing" };

/**
 * Plan renderer delivery for a main-process text result.
 * Stale generations are rejected; completed results with text must deliver.
 */
export function planTextResultDelivery(
  result: JarvisTextTurnResult | null | undefined,
  submitGeneration: number,
  currentGeneration: number,
): TextDeliveryPlan {
  if (!isCurrentTextGeneration(submitGeneration, currentGeneration)) {
    return { action: "reject", reason: "stale" };
  }
  if (!result) {
    return { action: "reject", reason: "missing" };
  }
  if (result.cancelled || result.outcome === "cancelled") {
    return { action: "reject", reason: "cancelled" };
  }
  if (!result.ok) {
    return { action: "reject", reason: "error" };
  }
  const assistantText = readAssistantText(result);
  const artifactCount = result.artifacts?.length ?? 0;
  if (!assistantText && artifactCount === 0) {
    return { action: "empty_error", assistantTextLen: 0, artifactCount: 0 };
  }
  return {
    action: "deliver",
    assistantText,
    assistantTextLen: assistantText.length,
    artifactCount,
  };
}

export function deliveryDiagMessage(parts: {
  mainHasText?: boolean;
  mainTextLen?: number;
  clientDelivered?: boolean;
  appAppended?: boolean;
  appTextLen?: number;
  transcriptCount?: number;
  panelMode?: string;
  responseLogActive?: boolean;
}): string {
  return [
    parts.mainHasText != null ? `mainHasText=${parts.mainHasText ? 1 : 0}` : null,
    parts.mainTextLen != null ? `mainTextLen=${parts.mainTextLen}` : null,
    parts.clientDelivered != null ? `clientDelivered=${parts.clientDelivered ? 1 : 0}` : null,
    parts.appAppended != null ? `appAppended=${parts.appAppended ? 1 : 0}` : null,
    parts.appTextLen != null ? `appTextLen=${parts.appTextLen}` : null,
    parts.transcriptCount != null ? `transcriptCount=${parts.transcriptCount}` : null,
    parts.panelMode ? `panelMode=${parts.panelMode}` : null,
    parts.responseLogActive != null ? `responseLogActive=${parts.responseLogActive ? 1 : 0}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
