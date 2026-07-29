import { RealtimeDiagnosticsBuffer } from "./realtimeDiagnostics";
import {
  deliveryDiagMessage,
  planTextResultDelivery,
  readAssistantText,
} from "./textDelivery";
import { buildTurnArtifactDelivery, selectTurnArtifacts } from "./artifactSelection";
import { guardArtifactPanelNarration } from "./textPanelActivation";
import {
  autoNetworkRetryOptions,
  PendingResumeEligibility,
  type PendingResumeSubmitOptions,
} from "./pendingResume";
import {
  TEXT_AUTO_NETWORK_RETRY_DELAY_MS,
  advanceTextCooldownChain,
  computeTextCooldownMs,
  isTextManualRetryAllowed,
  textCooldownUserMessage,
  type TextCooldownChainState,
} from "./realtimeErrors";
import type {
  JarvisTextHistoryItem,
  JarvisTextTurnError,
  JarvisTextTurnResult,
  RickyArtifact,
} from "../vite-env";

export type TextTurnState =
  | "idle"
  | "sending"
  | "waiting"
  | "tool-running"
  | "completed"
  | "cancelled"
  | "error";

export type TextClientErrorDetails = {
  code?: string;
  message: string;
  retryable?: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  cooldownMs?: number;
  safeForAutoNetworkRetry?: boolean;
  consecutiveRateLimited?: number;
};

export type TextClientCallbacks = {
  onState: (state: TextTurnState) => void;
  onStatus: (message: string) => void;
  onUserText: (text: string) => void;
  onAssistantText: (text: string, clientTurnId: string) => void;
  onArtifact: (artifact: RickyArtifact) => void;
  onError: (message: string, code?: string, details?: TextClientErrorDetails) => void;
};

export class TextClient {
  private state: TextTurnState = "idle";
  private activeTurnId: string | null = null;
  private generation = 0;
  private callbacks: TextClientCallbacks;
  private diagnostics: RealtimeDiagnosticsBuffer;
  private autoNetworkRetriesUsed = 0;
  private cooldownChain: TextCooldownChainState = {
    chainCode: null,
    attemptIndex: 0,
    consecutiveRateLimited: 0,
  };
  private pendingResumeEligibility = new PendingResumeEligibility();
  private buildInfo: { version?: string; gitSha?: string; branch?: string } = { version: "1.0.0" };

  constructor(callbacks: TextClientCallbacks, diagnostics?: RealtimeDiagnosticsBuffer) {
    this.callbacks = callbacks;
    this.diagnostics = diagnostics || new RealtimeDiagnosticsBuffer();
  }

  setBuildInfo(info: { version?: string; gitSha?: string | null; branch?: string | null } | null | undefined): void {
    this.buildInfo = {
      version: info?.version || "1.0.0",
      gitSha: info?.gitSha || undefined,
      branch: info?.branch || undefined,
    };
  }

  getState(): TextTurnState {
    return this.state;
  }

  getActiveTurnId(): string | null {
    return this.activeTurnId;
  }

  getGeneration(): number {
    return this.generation;
  }

  isActive(): boolean {
    return (
      this.activeTurnId !== null &&
      (this.state === "sending" || this.state === "waiting" || this.state === "tool-running")
    );
  }

  canResumePendingConfirmation(composerText: string): boolean {
    return this.pendingResumeEligibility.canResume(composerText);
  }

  resetCooldownCounters(): void {
    this.autoNetworkRetriesUsed = 0;
    this.cooldownChain = {
      chainCode: null,
      attemptIndex: 0,
      consecutiveRateLimited: 0,
    };
  }

  getDiagnosticReport(
    lastErrorCode?: string,
    extras?: {
      connectionState?: string;
      cooldownUntilMs?: number | null;
      pending?: { toolName?: string; operation?: string; scope?: string | null; expiresAt?: number } | null;
      composerChars?: number;
    },
  ): string {
    const base = this.diagnostics.buildCopyableReport({
      appVersion: this.buildInfo.version || "1.0.0",
      branch: this.buildInfo.branch || this.buildInfo.gitSha || "unknown",
      platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      lastErrorCode,
    });
    const continuityLines = [
      "",
      "Daily-use status:",
      JSON.stringify(
        {
          connectionState: extras?.connectionState || null,
          gitSha: this.buildInfo.gitSha || null,
          cooldownUntilMs: extras?.cooldownUntilMs ?? null,
          pendingOperation: extras?.pending
            ? {
                toolName: extras.pending.toolName || null,
                operation: extras.pending.operation || null,
                scope: extras.pending.scope ?? null,
                expiresAt: extras.pending.expiresAt ?? null,
              }
            : null,
          composerChars: typeof extras?.composerChars === "number" ? extras.composerChars : undefined,
          restartPolicyNote: "Pending confirmations do not survive restart.",
        },
        null,
        2,
      ),
    ];
    return `${base}\n${continuityLines.join("\n")}`;
  }

  async submit(
    text: string,
    history: JarvisTextHistoryItem[] = [],
    options: PendingResumeSubmitOptions = {},
  ): Promise<JarvisTextTurnResult | null> {
    // Trim only for emptiness; submit the exact composer string unchanged.
    const exactText = text == null ? "" : String(text);
    if (!exactText.trim()) return null;
    if (this.isActive()) {
      this.callbacks.onError("Jarvis is busy with another text turn.", "session.error", {
        code: "session.error",
        message: "Jarvis is busy with another text turn.",
        retryable: false,
        safeForAutoNetworkRetry: false,
      });
      return {
        ok: false,
        clientTurnId: "",
        assistantText: "",
        artifacts: [],
        toolNames: [],
        artifactCount: 0,
        selectedArtifact: null,
        hasSubstantiveArtifact: false,
        toolTrace: [],
        usage: { inputTokens: 0, outputTokens: 0, model: "" },
        durationMs: 0,
        outcome: "rejected",
        cancelled: false,
        error: { code: "session.error", message: "Jarvis is busy with another text turn.", retryable: false },
      };
    }

    options = {
      ...options,
      // Defense in depth: explicit resume is accepted only for the exact current
      // failed composer tracked by this client.
      resumePendingConfirmation:
        options.resumePendingConfirmation === true &&
        this.pendingResumeEligibility.canResume(exactText),
    };
    if (!options.isAutoNetworkRetry) {
      this.autoNetworkRetriesUsed = 0;
    }
    this.pendingResumeEligibility.beginTurn(exactText, options);

    const clientTurnId = crypto.randomUUID();
    const generation = ++this.generation;
    this.activeTurnId = clientTurnId;
    this.setState("sending");
    if (!options.isAutoNetworkRetry) {
      this.callbacks.onUserText(exactText);
    }
    this.diag("info", "text.turn.start", "Text turn started", clientTurnId);

    try {
      this.setState("waiting");
      const result = await window.jarvis.runTextTurn({
        clientTurnId,
        text: exactText,
        history,
        // Token stays main-process-only; flag requests resume injection when set.
        resumePendingConfirmation: options.resumePendingConfirmation === true,
      });

      const mainText = readAssistantText(result);
      this.diag(
        "info",
        "text.delivery.main",
        deliveryDiagMessage({
          mainHasText: Boolean(mainText),
          mainTextLen: mainText.length,
        }),
        clientTurnId,
        result,
      );

      const plan = planTextResultDelivery(result, generation, this.generation);

      // Drop late results after cancel/timeout supersession (generation only).
      if (plan.action === "reject" && plan.reason === "stale") {
        this.pendingResumeEligibility.clear();
        this.setState("cancelled");
        this.diag("warn", "text.turn.late_result_dropped", "Late text result ignored after cancel", clientTurnId);
        return {
          ok: false,
          clientTurnId,
          assistantText: "",
          artifacts: [],
          toolNames: [],
          artifactCount: 0,
          selectedArtifact: null,
          hasSubstantiveArtifact: false,
          toolTrace: result?.toolTrace || [],
          usage: result?.usage || { inputTokens: 0, outputTokens: 0, model: "" },
          durationMs: result?.durationMs || 0,
          outcome: "cancelled",
          cancelled: true,
          error: { code: "session.error", message: "Text request cancelled.", retryable: false },
        };
      }

      if (plan.action === "reject" && plan.reason === "cancelled") {
        this.pendingResumeEligibility.clear();
        this.setState("cancelled");
        this.callbacks.onStatus("Text request cancelled.");
        this.diag("warn", "text.turn.cancelled", "Text turn cancelled", clientTurnId, result);
        return result!;
      }

      if (plan.action === "reject" && (plan.reason === "error" || plan.reason === "missing")) {
        return await this.handleTurnFailure(result, clientTurnId, exactText, history, options);
      }

      if (plan.action === "empty_error") {
        const emptyResult: JarvisTextTurnResult = {
          ...(result as JarvisTextTurnResult),
          ok: false,
          outcome: "error",
          cancelled: false,
          assistantText: "",
          error: {
            code: "api.bad_response",
            message: "Jarvis returned no visible response.",
            retryable: true,
            safeForAutoNetworkRetry: false,
          },
        };
        return await this.handleTurnFailure(emptyResult, clientTurnId, exactText, history, options);
      }

      if (plan.action !== "deliver") {
        this.pendingResumeEligibility.recordFailure(
          exactText,
          options.resumePendingConfirmation === true,
        );
        this.setState("error");
        this.emitFailure({
          code: "unknown",
          message: "The text request failed. Try again.",
          retryable: true,
          safeForAutoNetworkRetry: false,
        });
        return result;
      }

      // Successful visible delivery path.
      if (result!.toolTrace?.length) {
        this.setState("tool-running");
      }

      const delivery = buildTurnArtifactDelivery(result!.artifacts || [], result!.toolTrace || []);
      const selectedArtifacts = selectTurnArtifacts(result!.artifacts || []);
      for (const artifact of selectedArtifacts) {
        this.callbacks.onArtifact(artifact);
      }

      const guardedText = guardArtifactPanelNarration(
        plan.assistantText,
        delivery.hasSubstantiveArtifact || Boolean(result!.hasSubstantiveArtifact),
      );

      let clientDelivered = false;
      if (guardedText) {
        this.callbacks.onAssistantText(guardedText, clientTurnId);
        clientDelivered = true;
      }

      this.diag(
        "info",
        "text.delivery.client",
        deliveryDiagMessage({
          mainHasText: Boolean(guardedText.length),
          mainTextLen: guardedText.length,
          clientDelivered,
        }),
        clientTurnId,
        result,
      );

      this.setState("completed");
      this.pendingResumeEligibility.clear();
      this.resetCooldownCounters();
      this.diag("info", "text.turn.completed", "Text turn completed", clientTurnId, result);
      // Preserve nonempty assistantText on the returned result for App verification.
      return {
        ...result!,
        assistantText: guardedText || result!.assistantText || "",
        artifacts: selectedArtifacts,
        toolNames: result!.toolNames?.length ? result!.toolNames : delivery.toolNames,
        artifactCount:
          typeof result!.artifactCount === "number" ? result!.artifactCount : delivery.artifactCount,
        selectedArtifact: result!.selectedArtifact ?? delivery.selectedArtifact,
        hasSubstantiveArtifact:
          typeof result!.hasSubstantiveArtifact === "boolean"
            ? result!.hasSubstantiveArtifact
            : delivery.hasSubstantiveArtifact,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The text request failed. Try again.";
      this.setState("error");
      this.pendingResumeEligibility.recordFailure(
        exactText,
        options.resumePendingConfirmation === true,
      );
      this.emitFailure({
        code: "unknown",
        message,
        retryable: true,
        safeForAutoNetworkRetry: false,
      });
      this.diag("error", "text.turn.exception", message, clientTurnId);
      return null;
    } finally {
      if (this.activeTurnId === clientTurnId) {
        this.activeTurnId = null;
      }
    }
  }

  async cancel(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.generation += 1;
    this.diag("warn", "text.turn.cancel_requested", "Cancel requested", turnId);
    try {
      await window.jarvis.cancelTextTurn(turnId);
    } finally {
      this.pendingResumeEligibility.clear();
      // Ensure renderer lock can clear even if cancel IPC throws.
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
      this.setState("cancelled");
    }
  }

  private async handleTurnFailure(
    result: JarvisTextTurnResult | null | undefined,
    clientTurnId: string,
    exactText: string,
    history: JarvisTextHistoryItem[],
    options: PendingResumeSubmitOptions,
  ): Promise<JarvisTextTurnResult | null> {
    const raw = result?.error;
    const canAuto =
      raw?.safeForAutoNetworkRetry === true &&
      raw?.code === "network.offline" &&
      this.autoNetworkRetriesUsed < 1 &&
      !options.isAutoNetworkRetry;

    if (canAuto) {
      this.autoNetworkRetriesUsed += 1;
      this.diag("warn", "text.turn.auto_network_retry", "One safe network auto-retry", clientTurnId, result);
      this.activeTurnId = null;
      await sleep(TEXT_AUTO_NETWORK_RETRY_DELAY_MS);
      return this.submit(exactText, history, autoNetworkRetryOptions(options));
    }

    const advanced = advanceTextCooldownChain(this.cooldownChain, raw?.code);
    this.cooldownChain = {
      chainCode: advanced.chainCode,
      attemptIndex: advanced.nextAttemptIndex,
      consecutiveRateLimited: advanced.consecutiveRateLimited,
    };
    const error = enrichTextError(raw, advanced.attemptIndex, advanced.consecutiveRateLimited);
    const associatedWithPendingConfirmation =
      options.resumePendingConfirmation === true ||
      Boolean(result?.toolTrace?.some((item) => item.requiresConfirmation === true));
    this.pendingResumeEligibility.recordFailure(exactText, associatedWithPendingConfirmation);

    this.setState("error");
    this.emitFailure(error);
    this.diag("error", "text.turn.error", error.message, clientTurnId, result);
    return result
      ? {
          ...result,
          error: {
            ...result.error,
            ...error,
          },
        }
      : null;
  }

  private emitFailure(error: JarvisTextTurnError & TextClientErrorDetails): void {
    const manualRetry = isTextManualRetryAllowed(error.code, error.retryable);
    const cooldownMs =
      typeof error.cooldownMs === "number"
        ? error.cooldownMs
        : manualRetry
          ? computeTextCooldownMs(
              Math.max(0, this.cooldownChain.attemptIndex - 1),
              error.retryAfterMs,
              error.code === "rate_limited" ? this.cooldownChain.consecutiveRateLimited : 0,
            )
          : undefined;
    const message =
      cooldownMs != null && manualRetry
        ? textCooldownUserMessage(
            error.code || "unknown",
            cooldownMs,
            error.code === "rate_limited" ? this.cooldownChain.consecutiveRateLimited : 0,
          )
        : error.message || "The text request failed. Try again.";
    this.callbacks.onError(message, error.code, {
      ...error,
      message,
      cooldownMs,
      consecutiveRateLimited:
        error.code === "rate_limited" ? this.cooldownChain.consecutiveRateLimited : undefined,
    });
  }

  private setState(state: TextTurnState): void {
    this.state = state;
    this.callbacks.onState(state);
  }

  private diag(
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    turnId: string,
    result?: JarvisTextTurnResult | null,
  ): void {
    this.diagnostics.record({
      level,
      event,
      connectionId: `text:${turnId}`,
      message,
      errorCode: result?.error?.code,
      httpStatus: result?.error?.httpStatus,
    });
    this.diagnostics.record({
      level,
      event: `${event}.meta`,
      connectionId: `text:${turnId}`,
      message: [
        `mode=text`,
        `turnId=${turnId}`,
        result?.durationMs != null ? `durationMs=${result.durationMs}` : null,
        result?.outcome ? `outcome=${result.outcome}` : null,
        result?.usage ? `model=${result.usage.model}` : null,
        result?.usage ? `inputTokens=${result.usage.inputTokens}` : null,
        result?.usage ? `outputTokens=${result.usage.outputTokens}` : null,
        result?.error?.httpStatus != null ? `httpStatus=${result.error.httpStatus}` : null,
        result?.error?.retryAfterMs != null ? `retryAfterMs=${result.error.retryAfterMs}` : null,
        result?.error?.safeForAutoNetworkRetry != null
          ? `safeForAutoNetworkRetry=${result.error.safeForAutoNetworkRetry}`
          : null,
        result?.error?.apiErrorType ? `apiErrorType=${result.error.apiErrorType}` : null,
        result?.error?.apiErrorCode ? `apiErrorCode=${result.error.apiErrorCode}` : null,
        result?.error?.apiErrorParam ? `apiErrorParam=${result.error.apiErrorParam}` : null,
      ]
        .filter(Boolean)
        .join(" "),
      errorCode: result?.error?.code,
    });
  }
}

export function enrichTextError(
  error: JarvisTextTurnError | undefined,
  attemptIndex: number,
  consecutiveRateLimited: number,
): JarvisTextTurnError & TextClientErrorDetails {
  const code = error?.code || "unknown";
  const retryAfterMs = error?.retryAfterMs;
  const retryable =
    typeof error?.retryable === "boolean" ? error.retryable : isTextManualRetryAllowed(code);
  const cooldownMs = isTextManualRetryAllowed(code, retryable)
    ? computeTextCooldownMs(attemptIndex, retryAfterMs, consecutiveRateLimited)
    : undefined;
  return {
    code,
    message: error?.message || "The text request failed. Try again.",
    httpStatus: error?.httpStatus,
    retryable,
    retryAfterMs,
    cooldownMs,
    safeForAutoNetworkRetry: error?.safeForAutoNetworkRetry === true,
    consecutiveRateLimited: code === "rate_limited" ? consecutiveRateLimited : undefined,
    apiErrorType: error?.apiErrorType,
    apiErrorCode: error?.apiErrorCode,
    apiErrorParam: error?.apiErrorParam,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  deliveryDiagMessage,
  hasDeliverableTextResult,
  isCurrentTextGeneration,
  planTextResultDelivery,
  readAssistantText,
} from "./textDelivery";
