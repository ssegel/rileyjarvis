import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Expand, History, Keyboard, Mic, MicOff, MonitorCog, PanelRight, Send, Square } from "lucide-react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { RickyFace } from "./components/RickyFace";
import {
  newEntry,
  RickyRealtimeClient,
  type ClassifiedRealtimeError,
  type MouthShape,
  type RickyConnectionState,
  type RickyMood,
  type SessionUiState,
  type TranscriptEntry,
} from "./lib/realtime";
import { RealtimeDiagnosticsBuffer } from "./lib/realtimeDiagnostics";
import { SessionOwnerLock } from "./lib/sessionOwner";
import {
  buildRunningResponseLogArtifact,
  isRunningResponseLogArtifact,
  responseLogContainsAssistant,
} from "./lib/responseLogArtifact";
import { buildTextHistoryFromTranscript } from "./lib/textHistory";
import { deliveryDiagMessage, readAssistantText } from "./lib/textDelivery";
import { TextClient, type TextClientErrorDetails, type TextTurnState } from "./lib/textClient";
import { planTextPanelActivation } from "./lib/textPanelActivation";
import {
  formatRetryAvailableAt,
  isTextManualRetryAllowed,
  showsTextRetryCountdown,
} from "./lib/realtimeErrors";
import {
  buildBaselineDeletePayload,
  buildDeleteConfirmMessage,
  closeBaselineNameForm,
  formatBaselineStatus,
  openBaselineNameForm,
  submitBaselineNameAction,
  type BaselineNameFormState,
  type PilotBaselineRow,
} from "./lib/pilotBaselines";
import type { JarvisBuildInfo, JarvisPendingConfirmationPublic, RickyArtifact } from "./vite-env";

type RickyMode = "display" | "computer";

const SESSION_LABELS: Record<SessionUiState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  reconnecting: "Reconnecting",
  error: "Error",
};

const TEXT_STATUS: Partial<Record<TextTurnState, string>> = {
  sending: "Sending…",
  waiting: "Waiting for Jarvis…",
  "tool-running": "Running tools…",
  cancelled: "Text request cancelled.",
};

export default function App() {
  const [connectionState, setConnectionState] = useState<RickyConnectionState>("idle");
  const [sessionUiState, setSessionUiState] = useState<SessionUiState>("disconnected");
  const [mood, setMood] = useState<RickyMood>("idle");
  const [mode, setMode] = useState<RickyMode>("display");
  const [artifact, setArtifact] = useState<RickyArtifact | null>(null);
  const [artifactVisible, setArtifactVisible] = useState(true);
  const [artifactFullscreen, setArtifactFullscreen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [mouthShape, setMouthShape] = useState<MouthShape>({ open: 0, width: 0.18, round: 0, teeth: 0 });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    newEntry("system", "Jarvis is ready. Connect voice, then talk naturally."),
  ]);
  const [status, setStatus] = useState("Idle");
  const [lastError, setLastError] = useState<ClassifiedRealtimeError | null>(null);
  const [lastTextError, setLastTextError] = useState<TextClientErrorDetails | null>(null);
  const [textPrompt, setTextPrompt] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const [textCooldownUntilMs, setTextCooldownUntilMs] = useState<number | null>(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [pendingConfirmation, setPendingConfirmation] = useState<JarvisPendingConfirmationPublic | null>(
    null,
  );
  const [confirmPendingActive, setConfirmPendingActive] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [pilotNote, setPilotNote] = useState("");
  const [pilotStatus, setPilotStatus] = useState("");
  const [backupSummary, setBackupSummary] = useState("");
  const [backupRows, setBackupRows] = useState<{
    ordinary: Array<{ fileName: string; mtimeMs: number; size: number }>;
    baselines: PilotBaselineRow[];
  }>({ ordinary: [], baselines: [] });
  const [baselineNameForm, setBaselineNameForm] = useState<BaselineNameFormState>(
    closeBaselineNameForm(),
  );
  const [baselineNameError, setBaselineNameError] = useState("");
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [buildInfo, setBuildInfo] = useState<JarvisBuildInfo>({ version: "1.0.0" });
  const clientRef = useRef<RickyRealtimeClient | null>(null);
  const sessionOwnerRef = useRef(new SessionOwnerLock());
  const diagnosticsRef = useRef(new RealtimeDiagnosticsBuffer());
  const textClientRef = useRef<TextClient | null>(null);
  const transcriptRef = useRef(transcript);
  const artifactRef = useRef(artifact);
  const baselineNameInputRef = useRef<HTMLInputElement | null>(null);
  const baselineSubmitInFlightRef = useRef(false);
  const deliveredAssistantTurnRef = useRef<string | null>(null);
  const appendAssistantToLogRef = useRef<(text: string, clientTurnId: string) => boolean>(() => false);

  function commitTranscriptEntry(entry: TranscriptEntry): TranscriptEntry[] {
    const next = [entry, ...transcriptRef.current].slice(0, 80);
    transcriptRef.current = next;
    setTranscript(next);
    return next;
  }

  function activateRunningResponseLog(entries: TranscriptEntry[]): boolean {
    if (!responseLogContainsAssistant(entries)) return false;
    const logArtifact = buildRunningResponseLogArtifact(entries);
    artifactRef.current = logArtifact;
    setArtifact(logArtifact);
    setArtifactVisible(true);
    return isRunningResponseLogArtifact(logArtifact);
  }

  function appendAssistantToLog(text: string, clientTurnId: string): boolean {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    if (deliveredAssistantTurnRef.current === clientTurnId) return true;
    deliveredAssistantTurnRef.current = clientTurnId;
    // Legacy internal assistant role remains "ricky" for log/renderer compatibility.
    const entry = newEntry("ricky", trimmed);
    const next = commitTranscriptEntry(entry);
    diagnosticsRef.current.record({
      level: "info",
      event: "text.delivery.app",
      connectionId: `text:${clientTurnId}`,
      message: deliveryDiagMessage({
        appAppended: true,
        appTextLen: trimmed.length,
        transcriptCount: next.length,
        panelMode: isRunningResponseLogArtifact(artifactRef.current) ? "responseLog" : "pending",
        responseLogActive: isRunningResponseLogArtifact(artifactRef.current),
      }),
    });
    return true;
  }
  appendAssistantToLogRef.current = appendAssistantToLog;

  if (!textClientRef.current) {
    textClientRef.current = new TextClient(
      {
        onState: (state: TextTurnState) => {
          setTextBusy(state === "sending" || state === "waiting" || state === "tool-running");
          const label = TEXT_STATUS[state];
          if (label) setStatus(label);
        },
        onStatus: (message) => {
          setStatus(message);
          commitTranscriptEntry(newEntry("system", message));
        },
        onUserText: (text) => {
          commitTranscriptEntry(newEntry("user", text));
        },
        onAssistantText: (text, clientTurnId) => {
          appendAssistantToLogRef.current(text, clientTurnId);
        },
        onArtifact: (nextArtifact) => {
          artifactRef.current = nextArtifact;
          setArtifact(nextArtifact);
          setArtifactVisible(true);
          if (nextArtifact.fullscreen) setArtifactFullscreen(true);
        },
        onError: (message, code, details) => {
          // Text errors must not overwrite Realtime lastError / voice recovery UI.
          setStatus(message);
          commitTranscriptEntry(newEntry("system", message));
          const nextDetails: TextClientErrorDetails = details || {
            code,
            message,
            retryable: isTextManualRetryAllowed(code),
          };
          setLastTextError(nextDetails);
          if (
            typeof nextDetails.cooldownMs === "number" &&
            nextDetails.cooldownMs > 0 &&
            showsTextRetryCountdown(nextDetails.code, nextDetails.retryable)
          ) {
            setTextCooldownUntilMs(Date.now() + nextDetails.cooldownMs);
          } else {
            setTextCooldownUntilMs(null);
          }
        },
      },
      diagnosticsRef.current,
    );
  }

  useEffect(() => {
    let cancelled = false;
    async function hydrateContinuity() {
      try {
        const [continuity, info] = await Promise.all([
          window.jarvis.getContinuity(),
          window.jarvis.getBuildInfo(),
        ]);
        if (cancelled) return;
        setBuildInfo(info || continuity.buildInfo || { version: "1.0.0" });
        textClientRef.current?.setBuildInfo(info || continuity.buildInfo);
        setPendingConfirmation(continuity.pendingConfirmation || null);
        setMemoryBusy(Boolean(continuity.memoryBusy));
        setConfirmPendingActive(Boolean(continuity.confirmInFlight));
      } catch {
        // Continuity IPC may be unavailable in non-Electron test shells.
      }
    }
    void hydrateContinuity();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (textCooldownUntilMs == null) return;
    if (Date.now() >= textCooldownUntilMs) {
      setTextCooldownUntilMs(null);
      return;
    }
    const id = window.setInterval(() => {
      setCooldownTick((value) => value + 1);
      if (Date.now() >= (textCooldownUntilMs || 0)) {
        setTextCooldownUntilMs(null);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [textCooldownUntilMs]);

  useEffect(() => {
    if (!baselineNameForm.open) return;
    baselineNameInputRef.current?.focus();
    baselineNameInputRef.current?.select();
  }, [baselineNameForm.open, baselineNameForm.mode]);

  const isConnected = connectionState === "connected";
  const isBusy = connectionState === "connecting" || sessionUiState === "reconnecting";
  const showVoiceErrorControls = sessionUiState === "error" || connectionState === "error";
  const textTurnActive = textBusy;
  const textCooldownActive = textCooldownUntilMs != null && Date.now() < textCooldownUntilMs;
  void cooldownTick;
  const textRetryEnabled =
    Boolean(lastTextError) &&
    isTextManualRetryAllowed(lastTextError?.code, lastTextError?.retryable) &&
    !textTurnActive &&
    !textCooldownActive;
  const showTextErrorControls = Boolean(lastTextError) && !showVoiceErrorControls;
  const buildLabel = [buildInfo.version, buildInfo.gitSha ? buildInfo.gitSha.slice(0, 7) : null]
    .filter(Boolean)
    .join(" · ");

  async function refreshPendingFromMain() {
    try {
      const continuity = await window.jarvis.getContinuity();
      setPendingConfirmation(continuity.pendingConfirmation || null);
      setMemoryBusy(Boolean(continuity.memoryBusy));
      setConfirmPendingActive(Boolean(continuity.confirmInFlight));
      if (continuity.buildInfo) setBuildInfo(continuity.buildInfo);
    } catch {
      // Ignore.
    }
  }

  const confirmDisabled =
    !pendingConfirmation ||
    confirmPendingActive ||
    textTurnActive ||
    memoryBusy ||
    isBusy;

  async function confirmPendingBanner() {
    if (confirmDisabled) return;
    setConfirmPendingActive(true);
    try {
      const result = await window.jarvis.confirmPendingConfirmation();
      setStatus(result?.message || (result?.ok ? "Confirmed." : "Confirmation failed."));
      if (result?.ok && result.artifactDelivery?.selectedArtifact) {
        const nextArtifact = result.artifactDelivery.selectedArtifact;
        artifactRef.current = nextArtifact;
        setArtifact(nextArtifact);
        setArtifactVisible(true);
      }
      await refreshPendingFromMain();
    } catch {
      setStatus("Confirmation failed.");
    } finally {
      setConfirmPendingActive(false);
      await refreshPendingFromMain();
    }
  }

  async function recordPilotIssue() {
    try {
      const result = await window.jarvis.recordPilotIssue({
        note: pilotNote,
        errorCode: lastTextError?.code || lastError?.code || null,
        httpStatus: typeof lastTextError?.httpStatus === "number" ? lastTextError.httpStatus : null,
        cooldownUntilMs: textCooldownUntilMs,
        connectionState,
      });
      setPilotStatus(result?.ok ? `Issue recorded (${result.id}).` : result?.message || "Could not record issue.");
      if (result?.ok) setPilotNote("");
    } catch {
      setPilotStatus("Could not record issue.");
    }
  }

  function showBaselineNameForm(
    mode: BaselineNameFormState["mode"],
    row: PilotBaselineRow | null = null,
  ) {
    setBaselineNameError("");
    setBaselineNameForm(openBaselineNameForm(mode, row));
  }

  function cancelBaselineNameForm() {
    if (baselineSaving || baselineSubmitInFlightRef.current) return;
    setBaselineNameError("");
    setBaselineNameForm(closeBaselineNameForm());
  }

  async function submitBaselineName() {
    if (baselineSaving || baselineSubmitInFlightRef.current) return;
    baselineSubmitInFlightRef.current = true;
    setBaselineSaving(true);
    setBaselineNameError("");
    try {
      const outcome = await submitBaselineNameAction({
        mode: baselineNameForm.mode,
        row: baselineNameForm.row,
        name: baselineNameForm.name,
        createBaseline: (payload) => window.jarvis.createBaseline(payload),
        reregisterBaseline: (payload) => window.jarvis.reregisterBaseline(payload),
        refresh: refreshBackupList,
      });
      setBackupSummary(outcome.message);
      if (outcome.close) {
        setBaselineNameForm(closeBaselineNameForm());
      } else {
        setBaselineNameError(outcome.message);
      }
    } catch {
      const message = "Baseline save failed.";
      setBackupSummary(message);
      setBaselineNameError(message);
    } finally {
      baselineSubmitInFlightRef.current = false;
      setBaselineSaving(false);
    }
  }

  async function deleteBaselineRow(row: PilotBaselineRow) {
    const payload = buildBaselineDeletePayload(row);
    if (!payload.ok) {
      setBackupSummary(payload.message);
      return;
    }
    if (!window.confirm(buildDeleteConfirmMessage(row))) return;
    try {
      const result = await window.jarvis.deleteBaseline({
        id: payload.id,
        fileName: payload.fileName,
      });
      setBackupSummary(
        result?.ok
          ? `Deleted baseline: ${String(row.name || "").trim() || "(unnamed)"} (${payload.fileName})`
          : result?.message || "Delete failed.",
      );
      await refreshBackupList();
    } catch {
      setBackupSummary("Delete failed.");
    }
  }

  async function refreshBackupList() {
    try {
      const list = await window.jarvis.listBackups();
      const ordinary = Array.isArray(list.ordinary) ? list.ordinary : [];
      const baselines = Array.isArray(list.baselines) ? (list.baselines as PilotBaselineRow[]) : [];
      setBackupRows({ ordinary, baselines });
      setBackupSummary(`Backups: ${ordinary.length} recent ordinary · ${baselines.length} baselines`);
    } catch {
      setBackupSummary("Could not list backups.");
      setBackupRows({ ordinary: [], baselines: [] });
    }
  }

  function attachClient(): RickyRealtimeClient {
    // Prevent reconnect from retaining a prior client's audio path or peer connection.
    clientRef.current?.disconnect();
    clientRef.current = null;

    const client = new RickyRealtimeClient({
      onConnectionState: setConnectionState,
      onMood: setMood,
      onMouthShape: setMouthShape,
      onTranscript: (entry) => {
        const next = commitTranscriptEntry(entry);
        // Voice assistant replies activate the same Running Response Log panel as text.
        if (entry.role === "ricky") {
          activateRunningResponseLog(next);
        }
      },
      onArtifact: (nextArtifact) => {
        artifactRef.current = nextArtifact;
        setArtifact(nextArtifact);
        setArtifactVisible(true);
        if (nextArtifact.fullscreen) setArtifactFullscreen(true);
      },
      onMode: (nextMode) => {
        setMode(nextMode);
        if (nextMode === "computer") {
          setArtifactVisible(false);
          setArtifactFullscreen(false);
          setShowLog(false);
          setShowTypeInput(false);
        } else {
          setArtifactVisible(true);
        }
      },
      onStatus: (message) => {
        setStatus(message);
        commitTranscriptEntry(newEntry("system", message));
      },
      onSessionUiState: setSessionUiState,
      onError: setLastError,
      onThumbnailReady: playThumbnailReadySound,
      sessionOwner: sessionOwnerRef.current,
      diagnostics: diagnosticsRef.current,
    });
    clientRef.current = client;
    return client;
  }

  async function connect() {
    const client = attachClient();
    await client.connect();
  }

  async function retry() {
    const existing = clientRef.current;
    if (existing) {
      await existing.retry();
      return;
    }
    await connect();
  }

  function disconnect() {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setLastError(null);
    setSessionUiState("disconnected");
    setStatus("Disconnected");
  }

  function dismissError() {
    if (clientRef.current) {
      clientRef.current.dismissError();
    } else {
      setLastError(null);
      setConnectionState("idle");
      setSessionUiState("disconnected");
      setStatus("Disconnected");
    }
  }

  async function copyDiagnostics() {
    const report =
      (showTextErrorControls
        ? textClientRef.current?.getDiagnosticReport(lastTextError?.code, {
            connectionState,
            cooldownUntilMs: textCooldownUntilMs,
            pending: pendingConfirmation,
            composerChars: textPrompt.length,
          })
        : null) ||
      clientRef.current?.getDiagnosticReport() ||
      textClientRef.current?.getDiagnosticReport(lastError?.code || lastTextError?.code, {
        connectionState,
        cooldownUntilMs: textCooldownUntilMs,
        pending: pendingConfirmation,
        composerChars: textPrompt.length,
      }) ||
      [
        "Jarvis Realtime Diagnostics",
        JSON.stringify(
          {
            lastErrorCode: lastError?.code || lastTextError?.code || null,
            build: buildInfo,
          },
          null,
          2,
        ),
      ].join("\n");
    try {
      const result = await window.jarvis.copyTextToClipboard(report);
      setCopyStatus(result?.ok === true ? "Diagnostics copied." : "Could not copy diagnostics.");
    } catch {
      setCopyStatus("Could not copy diagnostics.");
    }
    window.setTimeout(() => setCopyStatus(""), 2000);
  }

  async function switchMode(nextMode: RickyMode) {
    setMode(nextMode);
    const result = await window.jarvis.executeTool({ name: "set_mode", arguments: { mode: nextMode } });
    if (result.artifact) {
      artifactRef.current = result.artifact;
      setArtifact(result.artifact);
    }
    if (nextMode === "computer") {
      setArtifactVisible(false);
      setArtifactFullscreen(false);
      setShowLog(false);
      setShowTypeInput(false);
    } else {
      setArtifactVisible(true);
    }
    commitTranscriptEntry(newEntry("system", `Mode switched to ${nextMode}.`));
  }

  async function sendTextPrompt(options: { isManualRetry?: boolean } = {}) {
    // Trim only to detect emptiness; submit the exact composer string unchanged.
    const exactText = textPrompt;
    if (!exactText.trim()) return;

    if (textCooldownActive) {
      const remaining = Math.max(1, Math.ceil(((textCooldownUntilMs || 0) - Date.now()) / 1000));
      const message = `You can retry in ${remaining}s.`;
      setStatus(message);
      return;
    }

    if (textTurnActive) {
      const message = "Jarvis is busy with another text turn.";
      setStatus(message);
      commitTranscriptEntry(newEntry("system", message));
      return;
    }

    const voiceBusy = clientRef.current?.isVoiceTurnBusy() === true || sessionOwnerRef.current.isVoiceBusy();
    if (voiceBusy) {
      const message = "Jarvis is busy with a voice response.";
      setStatus(message);
      commitTranscriptEntry(newEntry("system", message));
      return;
    }

    const acquire = sessionOwnerRef.current.tryAcquireText();
    if (!acquire.ok) {
      setStatus(acquire.message);
      commitTranscriptEntry(newEntry("system", acquire.message));
      return;
    }

    // Build sanitized history BEFORE TextClient appends the current user turn to the log.
    // Manual Retry reuses exact composer text; do not clear or alter it here.
    const history = buildTextHistoryFromTranscript(transcriptRef.current, exactText);

    try {
      const resumePendingConfirmation =
        options.isManualRetry === true &&
        textClientRef.current?.canResumePendingConfirmation(exactText) === true;
      const result = await textClientRef.current?.submit(exactText, history, {
        // Exact failed composer + explicit Retry only; token stays on main.
        resumePendingConfirmation,
      });
      await refreshPendingFromMain();
      const assistantText = readAssistantText(result);

      // Append successful assistant text BEFORE closing the field / releasing ownership.
      let appended = false;
      if (result?.ok && assistantText && result.clientTurnId) {
        appended = appendAssistantToLog(assistantText, result.clientTurnId);
      }

      // Panel activation uses returned/selected artifact metadata (and any tool artifact
      // already delivered via onArtifact). Do not open Running Response Log merely because
      // visible tool-event metadata is incomplete.
      const panelPlan = planTextPanelActivation({
        result,
        currentArtifact: artifactRef.current,
        appended,
      });
      const hasArtifact = panelPlan.hasToolArtifact;
      let responseLogActive = isRunningResponseLogArtifact(artifactRef.current);
      if (panelPlan.activateResponseLog) {
        responseLogActive = activateRunningResponseLog(transcriptRef.current);
      } else if (panelPlan.selectedArtifact && !isRunningResponseLogArtifact(panelPlan.selectedArtifact)) {
        artifactRef.current = panelPlan.selectedArtifact;
        setArtifact(panelPlan.selectedArtifact);
        setArtifactVisible(true);
        if (panelPlan.selectedArtifact.fullscreen) setArtifactFullscreen(true);
        responseLogActive = false;
      }

      diagnosticsRef.current.record({
        level: responseLogActive || hasArtifact ? "info" : "warn",
        event: "text.delivery.panel",
        connectionId: `text:${result?.clientTurnId || "unknown"}`,
        message: deliveryDiagMessage({
          appAppended: appended,
          appTextLen: assistantText.length,
          transcriptCount: transcriptRef.current.length,
          panelMode: panelPlan.panelMode,
          responseLogActive,
        }),
      });

      const delivered =
        Boolean(result?.ok) &&
        ((appended && (responseLogActive || hasArtifact)) || (hasArtifact && !assistantText));

      if (result?.ok && assistantText && (!appended || (!responseLogActive && !hasArtifact))) {
        const message = "Jarvis responded, but the reply could not be shown. Try again.";
        setStatus(message);
        commitTranscriptEntry(newEntry("system", message));
        diagnosticsRef.current.record({
          level: "error",
          event: "text.delivery.app_failed",
          connectionId: `text:${result.clientTurnId || "unknown"}`,
          message: deliveryDiagMessage({
            mainHasText: true,
            mainTextLen: assistantText.length,
            clientDelivered: deliveredAssistantTurnRef.current === result.clientTurnId,
            appAppended: appended,
            appTextLen: appended ? assistantText.length : 0,
            transcriptCount: transcriptRef.current.length,
            panelMode: "ready",
            responseLogActive: false,
          }),
        });
      } else if (delivered) {
        // Clear/close only after visible assistant text (log) or an artifact has been delivered.
        setTextPrompt("");
        setShowTypeInput(false);
        setLastError(null);
        setLastTextError(null);
        setTextCooldownUntilMs(null);
        textClientRef.current?.resetCooldownCounters();
        setStatus("Idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The text request failed. Try again.";
      setStatus(message);
      commitTranscriptEntry(newEntry("system", message));
    } finally {
      sessionOwnerRef.current.releaseText();
      setTextBusy(false);
    }
  }

  async function retryTextPrompt() {
    if (!textRetryEnabled) return;
    await sendTextPrompt({ isManualRetry: true });
  }

  async function dismissTextError() {
    setLastTextError(null);
    if (!textCooldownActive) setStatus("Idle");
  }

  async function dismissPendingBanner() {
    try {
      await window.jarvis.dismissPendingConfirmation();
    } catch {
      // Ignore.
    }
    setPendingConfirmation(null);
  }

  async function cancelTextPrompt() {
    await textClientRef.current?.cancel();
  }

  if (mode === "computer") {
    return (
      <main className="app-shell app-shell-mini">
        <section className="mini-companion" aria-label="Jarvis computer use mini mode">
          <RickyFace mood={mood} mouthShape={mouthShape} />
          <button
            className="mini-restore-button"
            onClick={() => void switchMode("display")}
            aria-label="Return to full Jarvis window"
            title="Return to full Jarvis window"
          >
            <Expand size={14} />
          </button>
        </section>
      </main>
    );
  }

  const cooldownRemainingSec =
    textCooldownActive && textCooldownUntilMs != null
      ? Math.max(1, Math.ceil((textCooldownUntilMs - Date.now()) / 1000))
      : null;
  const retryAvailableAt =
    textCooldownActive && textCooldownUntilMs != null ? formatRetryAvailableAt(textCooldownUntilMs) : null;
  const pendingExpiryLabel =
    pendingConfirmation && Number.isFinite(pendingConfirmation.expiresAt)
      ? new Date(pendingConfirmation.expiresAt).toLocaleTimeString()
      : null;

  const statusLine =
    status !== "Idle" ? status : lastError?.userMessage || SESSION_LABELS[sessionUiState];

  return (
    <main className="app-shell">
      <div className="window-drag-strip" aria-hidden="true" />
      <div className="window-drag-left-zone" aria-hidden="true" />
      <section className="companion-window">
        <section className="face-stage">
          <RickyFace mood={mood} mouthShape={mouthShape} />
        </section>

        <footer className="bottom-console">
          <section
            className={
              showVoiceErrorControls || showTextErrorControls
                ? "session-status session-status-error"
                : "session-status"
            }
            role="status"
            aria-live="polite"
          >
            <div className="session-status-row">
              <span className="session-state-label">{SESSION_LABELS[sessionUiState]}</span>
              <span className="session-status-message">{statusLine}</span>
            </div>
            <div className="session-meta-row">
              <span className="session-meta-item">conn:{connectionState}</span>
              <span className="session-meta-item">build:{buildLabel}</span>
              {lastTextError?.code ? (
                <span className="session-meta-item">err:{lastTextError.code}</span>
              ) : lastError?.code ? (
                <span className="session-meta-item">err:{lastError.code}</span>
              ) : null}
              {cooldownRemainingSec != null ? (
                <span className="session-meta-item">
                  retry in {cooldownRemainingSec}s
                  {retryAvailableAt ? ` (${retryAvailableAt})` : ""}
                </span>
              ) : null}
              {buildInfo.staleBuild ? <span className="session-meta-item">build stale</span> : null}
            </div>
            {pendingConfirmation ? (
              <div className="session-pending-banner">
                <span>
                  Pending: {pendingConfirmation.operation}
                  {pendingConfirmation.scope ? ` (${pendingConfirmation.scope})` : ""} —{" "}
                  {pendingConfirmation.redactedSummary}
                  {pendingExpiryLabel ? ` · expires ${pendingExpiryLabel}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => void confirmPendingBanner()}
                  disabled={confirmDisabled}
                >
                  Confirm
                </button>
                <button type="button" onClick={() => void dismissPendingBanner()}>
                  Dismiss
                </button>
              </div>
            ) : null}
            <div className="session-pilot-row">
              <button type="button" onClick={() => void refreshBackupList()}>
                List backups
              </button>
              <button type="button" onClick={() => showBaselineNameForm("create")}>
                Save baseline
              </button>
              <input
                value={pilotNote}
                onChange={(event) => setPilotNote(event.target.value)}
                placeholder="Optional issue note"
                aria-label="Pilot issue note"
              />
              <button type="button" onClick={() => void recordPilotIssue()}>
                Record issue
              </button>
            </div>
            {baselineNameForm.open ? (
              <form
                className="session-baseline-name-form"
                aria-label={
                  baselineNameForm.mode === "create"
                    ? "Save protected baseline"
                    : "Re-register protected baseline"
                }
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitBaselineName();
                }}
              >
                <input
                  ref={baselineNameInputRef}
                  value={baselineNameForm.name}
                  onChange={(event) => {
                    setBaselineNameError("");
                    setBaselineNameForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelBaselineNameForm();
                    }
                  }}
                  placeholder="Baseline name"
                  aria-label="Baseline name"
                  aria-invalid={Boolean(baselineNameError)}
                  aria-describedby={baselineNameError ? "baseline-name-error" : undefined}
                  disabled={baselineSaving}
                />
                <button type="submit" disabled={baselineSaving}>
                  {baselineSaving ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={cancelBaselineNameForm} disabled={baselineSaving}>
                  Cancel
                </button>
                {baselineNameError ? (
                  <small id="baseline-name-error" role="alert">
                    {baselineNameError}
                  </small>
                ) : null}
              </form>
            ) : null}
            {backupSummary ? <small className="session-copy-status">{backupSummary}</small> : null}
            {backupRows.ordinary.length > 0 || backupRows.baselines.length > 0 ? (
              <div className="session-backup-meta" aria-label="Backup metadata">
                {backupRows.ordinary.map((row) => (
                  <small key={`o-${row.fileName}`} className="session-backup-meta-row">
                    ordinary · {row.fileName} · {row.size}B
                  </small>
                ))}
                {backupRows.baselines.map((row, index) => (
                  <div
                    key={`b-${String(row.id || row.fileName || index)}`}
                    className="session-backup-meta-row session-baseline-row"
                  >
                    <small>
                      baseline · {String(row.name || row.fileName || "unnamed")}
                      {row.fileName ? ` · ${row.fileName}` : ""} · {formatBaselineStatus(row)}
                    </small>
                    <span className="session-baseline-actions">
                      {row.recovered === true || row.registered === false ? (
                        <button
                          type="button"
                          onClick={() => showBaselineNameForm("reregister", row)}
                        >
                          Re-register
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void deleteBaselineRow(row)}>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {pilotStatus ? <small className="session-copy-status">{pilotStatus}</small> : null}
            {showVoiceErrorControls ? (
              <div className="session-error-actions">
                <button type="button" onClick={() => void retry()} disabled={isBusy}>
                  Retry
                </button>
                <button type="button" onClick={dismissError}>
                  Dismiss
                </button>
                <button type="button" onClick={() => void copyDiagnostics()}>
                  Copy diagnostics
                </button>
              </div>
            ) : null}
            {showTextErrorControls ? (
              <div className="session-error-actions">
                {textRetryEnabled ? (
                  <button type="button" onClick={() => void retryTextPrompt()}>
                    Retry
                  </button>
                ) : null}
                <button type="button" onClick={() => void dismissTextError()}>
                  Dismiss
                </button>
                <button type="button" onClick={() => void copyDiagnostics()}>
                  Copy diagnostics
                </button>
              </div>
            ) : null}
            {copyStatus ? <small className="session-copy-status">{copyStatus}</small> : null}
          </section>

          {showTypeInput ? (
            <section className="prompt-box">
              <input
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendTextPrompt();
                }}
                autoFocus
                placeholder="Type to Jarvis..."
                disabled={textTurnActive}
              />
              {textTurnActive ? (
                <button
                  onClick={() => void cancelTextPrompt()}
                  aria-label="Cancel text request"
                  title="Cancel text request"
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  onClick={() => void sendTextPrompt()}
                  aria-label="Send typed prompt"
                  title="Send typed prompt"
                  disabled={textCooldownActive}
                >
                  <Send size={15} />
                </button>
              )}
            </section>
          ) : null}

          <section className="control-strip">
            <button
              className={isConnected ? "simple-button active" : "simple-button"}
              onClick={
                isConnected ? disconnect : showVoiceErrorControls ? () => void retry() : () => void connect()
              }
              disabled={isBusy}
              aria-label={
                isConnected ? "Disconnect voice" : showVoiceErrorControls ? "Retry voice" : "Connect voice"
              }
              title={
                isConnected ? "Disconnect voice" : showVoiceErrorControls ? "Retry voice" : "Connect voice"
              }
            >
              {isConnected ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button
              className={showTypeInput ? "simple-button active" : "simple-button"}
              onClick={() => setShowTypeInput((value) => !value)}
              aria-label="Type to Jarvis"
              title="Type to Jarvis"
            >
              <Keyboard size={16} />
            </button>
            <button
              className={mode === "display" ? "simple-button active" : "simple-button"}
              onClick={() => void switchMode("display")}
              aria-label="Display mode"
              title="Display mode"
            >
              <PanelRight size={16} />
            </button>
            <button
              className="simple-button danger"
              onClick={() => void switchMode("computer")}
              aria-label="Computer use mode"
              title="Computer use mode"
            >
              <MonitorCog size={16} />
            </button>
            <button
              className={artifactVisible ? "simple-button active" : "simple-button"}
              onClick={() => setArtifactVisible((value) => !value)}
              aria-label="Toggle artifacts"
              title="Toggle artifacts"
            >
              <BrainCircuit size={16} />
            </button>
            <button
              className={showLog ? "simple-button active" : "simple-button"}
              onClick={() => setShowLog((value) => !value)}
              aria-label="Toggle live log"
              title="Toggle live log"
            >
              <History size={16} />
            </button>
          </section>
        </footer>

        {showLog ? (
          <section className="transcript">
            <div className="section-title">
              <span>Live Log</span>
              <small>{transcript.length} events</small>
            </div>
            <div className="transcript-list">
              {transcript.map((entry) => (
                <article className={`entry entry-${entry.role}`} key={entry.id}>
                  <div>
                    <strong>{entry.role === "ricky" ? "Jarvis" : entry.role}</strong>
                    <time>{entry.at}</time>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <ArtifactPanel
        artifact={artifact}
        visible={artifactVisible}
        fullscreen={artifactFullscreen}
        onToggleVisible={() => setArtifactVisible((value) => !value)}
        onToggleFullscreen={() => setArtifactFullscreen((value) => !value)}
      />
    </main>
  );
}

function playThumbnailReadySound() {
  try {
    const AudioContextClass = window.AudioContext;
    const audio = new AudioContextClass();
    const gain = audio.createGain();
    const osc = audio.createOscillator();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, audio.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.13);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.14);
    window.setTimeout(() => void audio.close(), 220);
  } catch {
    // Audio cues are optional; ignore browsers that block short sounds.
  }
}
