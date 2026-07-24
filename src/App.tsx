import { useRef, useState } from "react";
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
import { TextClient, type TextTurnState } from "./lib/textClient";
import type { RickyArtifact } from "./vite-env";

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
  const [textPrompt, setTextPrompt] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const clientRef = useRef<RickyRealtimeClient | null>(null);
  const sessionOwnerRef = useRef(new SessionOwnerLock());
  const diagnosticsRef = useRef(new RealtimeDiagnosticsBuffer());
  const textClientRef = useRef<TextClient | null>(null);
  const transcriptRef = useRef(transcript);
  const artifactRef = useRef(artifact);
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
        onError: (message) => {
          // Text errors must not overwrite Realtime lastError / voice recovery UI.
          setStatus(message);
          commitTranscriptEntry(newEntry("system", message));
        },
      },
      diagnosticsRef.current,
    );
  }

  const isConnected = connectionState === "connected";
  const isBusy = connectionState === "connecting" || sessionUiState === "reconnecting";
  const showErrorControls = sessionUiState === "error" || connectionState === "error";
  const textTurnActive = textBusy;

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
      clientRef.current?.getDiagnosticReport() ||
      textClientRef.current?.getDiagnosticReport(lastError?.code) ||
      ["Jarvis Realtime Diagnostics", JSON.stringify({ lastErrorCode: lastError?.code || null }, null, 2)].join("\n");
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

  async function sendTextPrompt() {
    const trimmed = textPrompt.trim();
    if (!trimmed) return;

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
    const history = buildTextHistoryFromTranscript(transcriptRef.current, trimmed);

    try {
      const result = await textClientRef.current?.submit(trimmed, history);
      const assistantText = readAssistantText(result);
      const hasArtifact = (result?.artifacts?.length ?? 0) > 0;

      // Append successful assistant text BEFORE closing the field / releasing ownership.
      let appended = false;
      if (result?.ok && assistantText && result.clientTurnId) {
        appended = appendAssistantToLog(assistantText, result.clientTurnId);
      }

      // Text-only replies must switch the artifacts panel from Ready → Running Response Log.
      // Tool artifacts already activate the panel via onArtifact; do not clobber them.
      let responseLogActive = isRunningResponseLogArtifact(artifactRef.current);
      if (appended && !hasArtifact) {
        responseLogActive = activateRunningResponseLog(transcriptRef.current);
      }

      diagnosticsRef.current.record({
        level: responseLogActive || hasArtifact ? "info" : "warn",
        event: "text.delivery.panel",
        connectionId: `text:${result?.clientTurnId || "unknown"}`,
        message: deliveryDiagMessage({
          appAppended: appended,
          appTextLen: assistantText.length,
          transcriptCount: transcriptRef.current.length,
          panelMode: hasArtifact
            ? "toolArtifact"
            : responseLogActive
              ? "responseLog"
              : artifactRef.current
                ? "other"
                : "ready",
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
            className={showErrorControls ? "session-status session-status-error" : "session-status"}
            role="status"
            aria-live="polite"
          >
            <div className="session-status-row">
              <span className="session-state-label">{SESSION_LABELS[sessionUiState]}</span>
              <span className="session-status-message">{statusLine}</span>
            </div>
            {showErrorControls ? (
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
                isConnected ? disconnect : showErrorControls ? () => void retry() : () => void connect()
              }
              disabled={isBusy}
              aria-label={isConnected ? "Disconnect voice" : showErrorControls ? "Retry voice" : "Connect voice"}
              title={isConnected ? "Disconnect voice" : showErrorControls ? "Retry voice" : "Connect voice"}
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
