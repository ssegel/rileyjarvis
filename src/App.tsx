import { useRef, useState } from "react";
import { BrainCircuit, Expand, History, Keyboard, Mic, MicOff, MonitorCog, PanelRight, Send } from "lucide-react";
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
    newEntry("system", "Ricky is ready. Connect voice, then talk naturally."),
  ]);
  const [status, setStatus] = useState("Idle");
  const [lastError, setLastError] = useState<ClassifiedRealtimeError | null>(null);
  const [textPrompt, setTextPrompt] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const clientRef = useRef<RickyRealtimeClient | null>(null);

  const isConnected = connectionState === "connected";
  const isBusy = connectionState === "connecting" || sessionUiState === "reconnecting";
  const showErrorControls = sessionUiState === "error" || connectionState === "error";

  function attachClient(): RickyRealtimeClient {
    // Prevent reconnect from retaining a prior client's audio path or peer connection.
    clientRef.current?.disconnect();
    clientRef.current = null;

    const client = new RickyRealtimeClient({
      onConnectionState: setConnectionState,
      onMood: setMood,
      onMouthShape: setMouthShape,
      onTranscript: (entry) => setTranscript((items) => [entry, ...items].slice(0, 80)),
      onArtifact: (nextArtifact) => {
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
        setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
      },
      onSessionUiState: setSessionUiState,
      onError: setLastError,
      onThumbnailReady: playThumbnailReadySound,
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
      ["Jarvis Realtime Diagnostics", JSON.stringify({ lastErrorCode: lastError?.code || null }, null, 2)].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Diagnostics copied.");
    } catch {
      setCopyStatus("Could not copy diagnostics.");
    }
    window.setTimeout(() => setCopyStatus(""), 2000);
  }

  async function switchMode(nextMode: RickyMode) {
    setMode(nextMode);
    const result = await window.ricky.executeTool({ name: "set_mode", arguments: { mode: nextMode } });
    if (result.artifact) setArtifact(result.artifact);
    if (nextMode === "computer") {
      setArtifactVisible(false);
      setArtifactFullscreen(false);
      setShowLog(false);
      setShowTypeInput(false);
    } else {
      setArtifactVisible(true);
    }
    setTranscript((items) => [newEntry("system", `Mode switched to ${nextMode}.`), ...items].slice(0, 80));
  }

  function sendTextPrompt() {
    const trimmed = textPrompt.trim();
    if (!trimmed) return;

    if (!isConnected) {
      const message = "Connect voice first.";
      setStatus(message);
      setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
      return;
    }

    const sent = clientRef.current?.sendText(trimmed) ?? false;
    if (!sent) {
      const message = "Connect voice first.";
      setStatus(message);
      setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
      return;
    }

    setTextPrompt("");
    setShowTypeInput(false);
  }

  if (mode === "computer") {
    return (
      <main className="app-shell app-shell-mini">
        <section className="mini-companion" aria-label="Ricky computer use mini mode">
          <RickyFace mood={mood} mouthShape={mouthShape} />
          <button
            className="mini-restore-button"
            onClick={() => void switchMode("display")}
            aria-label="Return to full Ricky window"
            title="Return to full Ricky window"
          >
            <Expand size={14} />
          </button>
        </section>
      </main>
    );
  }

  const statusLine = lastError?.userMessage || (status !== "Idle" ? status : SESSION_LABELS[sessionUiState]);

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
                  if (event.key === "Enter") sendTextPrompt();
                }}
                autoFocus
                placeholder="Type to Jarvis..."
              />
              <button onClick={sendTextPrompt} aria-label="Send typed prompt" title="Send typed prompt">
                <Send size={15} />
              </button>
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
                    <strong>{entry.role === "ricky" ? "Ricky" : entry.role}</strong>
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
