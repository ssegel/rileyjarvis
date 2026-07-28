import { RealtimeDiagnosticsBuffer } from "./realtimeDiagnostics";
import {
  deliveryDiagMessage,
  planTextResultDelivery,
  readAssistantText,
} from "./textDelivery";
import { buildTurnArtifactDelivery, selectTurnArtifacts } from "./artifactSelection";
import { guardArtifactPanelNarration } from "./textPanelActivation";
import type {
  JarvisTextHistoryItem,
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

export type TextClientCallbacks = {
  onState: (state: TextTurnState) => void;
  onStatus: (message: string) => void;
  onUserText: (text: string) => void;
  onAssistantText: (text: string, clientTurnId: string) => void;
  onArtifact: (artifact: RickyArtifact) => void;
  onError: (message: string, code?: string) => void;
};

export class TextClient {
  private state: TextTurnState = "idle";
  private activeTurnId: string | null = null;
  private generation = 0;
  private callbacks: TextClientCallbacks;
  private diagnostics: RealtimeDiagnosticsBuffer;

  constructor(callbacks: TextClientCallbacks, diagnostics?: RealtimeDiagnosticsBuffer) {
    this.callbacks = callbacks;
    this.diagnostics = diagnostics || new RealtimeDiagnosticsBuffer();
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

  getDiagnosticReport(lastErrorCode?: string): string {
    return this.diagnostics.buildCopyableReport({
      appVersion: "1.0.0",
      platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      lastErrorCode,
    });
  }

  async submit(text: string, history: JarvisTextHistoryItem[] = []): Promise<JarvisTextTurnResult | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (this.isActive()) {
      this.callbacks.onError("Jarvis is busy with another text turn.", "session.error");
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
        error: { code: "session.error", message: "Jarvis is busy with another text turn." },
      };
    }

    const clientTurnId = crypto.randomUUID();
    const generation = ++this.generation;
    this.activeTurnId = clientTurnId;
    this.setState("sending");
    this.callbacks.onUserText(trimmed);
    this.diag("info", "text.turn.start", "Text turn started", clientTurnId);

    try {
      this.setState("waiting");
      const result = await window.jarvis.runTextTurn({
        clientTurnId,
        text: trimmed,
        history,
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
          error: { code: "session.error", message: "Text request cancelled." },
        };
      }

      if (plan.action === "reject" && plan.reason === "cancelled") {
        this.setState("cancelled");
        this.callbacks.onStatus("Text request cancelled.");
        this.diag("warn", "text.turn.cancelled", "Text turn cancelled", clientTurnId, result);
        return result!;
      }

      if (plan.action === "reject" && (plan.reason === "error" || plan.reason === "missing")) {
        this.setState("error");
        const message = result?.error?.message || "The text request failed. Try again.";
        this.callbacks.onError(message, result?.error?.code);
        this.diag("error", "text.turn.error", message, clientTurnId, result);
        return result;
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
          },
        };
        this.setState("error");
        this.callbacks.onError(emptyResult.error!.message, emptyResult.error!.code);
        this.diag("error", "text.turn.empty", emptyResult.error!.message, clientTurnId, emptyResult);
        return emptyResult;
      }

      if (plan.action !== "deliver") {
        this.setState("error");
        this.callbacks.onError("The text request failed. Try again.", "unknown");
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
      this.callbacks.onError(message, "unknown");
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
      // Ensure renderer lock can clear even if cancel IPC throws.
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
      this.setState("cancelled");
    }
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

export {
  deliveryDiagMessage,
  hasDeliverableTextResult,
  isCurrentTextGeneration,
  planTextResultDelivery,
  readAssistantText,
} from "./textDelivery";
