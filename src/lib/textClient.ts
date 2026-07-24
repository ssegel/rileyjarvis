import { RealtimeDiagnosticsBuffer } from "./realtimeDiagnostics";
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
  onAssistantText: (text: string) => void;
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

      // Drop late results after cancel/timeout supersession.
      if (generation !== this.generation || this.activeTurnId !== clientTurnId) {
        this.setState("cancelled");
        this.diag("warn", "text.turn.late_result_dropped", "Late text result ignored after cancel", clientTurnId);
        return {
          ok: false,
          clientTurnId,
          assistantText: "",
          artifacts: [],
          toolTrace: result?.toolTrace || [],
          usage: result?.usage || { inputTokens: 0, outputTokens: 0, model: "" },
          durationMs: result?.durationMs || 0,
          outcome: "cancelled",
          cancelled: true,
          error: { code: "session.error", message: "Text request cancelled." },
        };
      }

      if (result.cancelled || result.outcome === "cancelled") {
        this.setState("cancelled");
        this.callbacks.onStatus("Text request cancelled.");
        this.diag("warn", "text.turn.cancelled", "Text turn cancelled", clientTurnId, result);
        return result;
      }

      if (!result.ok) {
        this.setState("error");
        const message = result.error?.message || "The text request failed. Try again.";
        this.callbacks.onError(message, result.error?.code);
        this.diag("error", "text.turn.error", message, clientTurnId, result);
        return result;
      }

      if (result.toolTrace?.length) {
        this.setState("tool-running");
      }

      for (const artifact of result.artifacts || []) {
        this.callbacks.onArtifact(artifact);
      }
      if (result.assistantText) {
        this.callbacks.onAssistantText(result.assistantText);
      }
      this.setState("completed");
      this.diag("info", "text.turn.completed", "Text turn completed", clientTurnId, result);
      return result;
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
