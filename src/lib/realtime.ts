import type { RickyArtifact, RickyToolCall, RickyToolResult, RickyToolSpec } from "../vite-env";
import {
  assertSingleRealtimePath,
  countRealtimeResources,
  createRemoteAudioElement,
  releaseRemoteAudioElement,
  type RealtimeResourceCounts,
} from "./realtimeAudioLifecycle";

export type RickyConnectionState = "idle" | "connecting" | "connected" | "error";
export type RickyMood = "idle" | "listening" | "thinking" | "speaking" | "working" | "error";

export type MouthShape = {
  open: number;
  width: number;
  round: number;
  teeth: number;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "ricky" | "system" | "tool";
  text: string;
  at: string;
};

export type RealtimeCallbacks = {
  onConnectionState: (state: RickyConnectionState) => void;
  onMood: (mood: RickyMood) => void;
  onMouthShape: (shape: MouthShape) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onArtifact: (artifact: RickyArtifact) => void;
  onMode: (mode: "display" | "computer") => void;
  onStatus: (message: string) => void;
  onThumbnailReady: () => void;
};

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  response?: {
    output?: ResponseOutputItem[];
  };
  item?: {
    type?: string;
    role?: string;
    content?: Array<{ transcript?: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ transcript?: string; text?: string }>;
};

const realtimeUrl = "https://api.openai.com/v1/realtime/calls";
const LOG_PREFIX = "[jarvis-realtime]";

export class RickyRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private callbacks: RealtimeCallbacks;
  private currentAssistantText = "";
  private toolSpecs: RickyToolSpec[] = [];
  private toolRunning = false;
  private audioContext: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMeterFrame = 0;
  private smoothedMouthShape: MouthShape = silentMouthShape();
  private responseAudioStarted = false;
  private boundTrackHandler: ((event: RTCTrackEvent) => void) | null = null;
  private boundDcOpenHandler: (() => void) | null = null;
  private boundDcMessageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks;
  }

  getResourceCounts(): RealtimeResourceCounts {
    return countRealtimeResources({
      pc: this.pc,
      remoteAudio: this.remoteAudio,
      outputAnalyser: this.outputAnalyser,
      micStream: this.micStream,
      dc: this.dc,
    });
  }

  async connect(): Promise<void> {
    this.log("connect start", this.getResourceCounts());
    // Drop any leftover resources from a failed or partial prior connect on this instance.
    this.releaseAllResources({ emitIdle: false });

    this.callbacks.onConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Minting a Realtime client secret.");

    try {
      this.toolSpecs = await window.ricky.getToolSpecs();
      const token = await window.ricky.createRealtimeToken();
      const pc = new RTCPeerConnection();
      const audio = createRemoteAudioElement();
      this.remoteAudio = audio;

      this.boundTrackHandler = (event: RTCTrackEvent) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.log("remote track received", {
          trackKind: event.track.kind,
          streamId: stream.id,
          hasRemoteAudio: Boolean(this.remoteAudio),
        });
        if (!this.remoteAudio) return;
        this.remoteAudio.srcObject = stream;
        // Exactly one analyser per successful connection.
        if (!this.outputAnalyser) {
          this.startOutputMeter(stream);
        }
      };
      pc.addEventListener("track", this.boundTrackHandler);

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      pc.addTrack(this.micStream.getAudioTracks()[0], this.micStream);

      const dc = pc.createDataChannel("oai-events");
      this.boundDcOpenHandler = () => {
        this.callbacks.onConnectionState("connected");
        this.callbacks.onMood("idle");
        this.callbacks.onStatus("Ricky is live. Start talking naturally.");
        this.log("connect success", this.getResourceCounts());
      };
      this.boundDcMessageHandler = (event: MessageEvent) => {
        void this.handleServerEvent(String(event.data));
      };
      dc.addEventListener("open", this.boundDcOpenHandler);
      dc.addEventListener("message", this.boundDcMessageHandler);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(realtimeUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(`Realtime WebRTC call failed: ${sdpResponse.status} ${await sdpResponse.text()}`);
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });

      this.pc = pc;
      this.dc = dc;

      const counts = this.getResourceCounts();
      if (!assertSingleRealtimePath(counts)) {
        this.log("connect warning: resource path not singular", counts);
      }
    } catch (error) {
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
      this.disconnect();
    }
  }

  disconnect(): void {
    this.log("disconnect start", this.getResourceCounts());
    this.releaseAllResources({ emitIdle: true });
    this.log("disconnect complete", this.getResourceCounts());
  }

  sendText(text: string): boolean {
    if (!this.dc || this.dc.readyState !== "open") {
      return false;
    }
    this.callbacks.onTranscript(newEntry("user", text));
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.log("response creation", { source: "sendText" });
    this.sendEvent({ type: "response.create" });
    return true;
  }

  private releaseAllResources(options: { emitIdle: boolean }): void {
    if (this.dc && this.boundDcOpenHandler) {
      this.dc.removeEventListener("open", this.boundDcOpenHandler);
    }
    if (this.dc && this.boundDcMessageHandler) {
      this.dc.removeEventListener("message", this.boundDcMessageHandler);
    }
    if (this.pc && this.boundTrackHandler) {
      this.pc.removeEventListener("track", this.boundTrackHandler);
    }

    this.boundDcOpenHandler = null;
    this.boundDcMessageHandler = null;
    this.boundTrackHandler = null;

    try {
      this.dc?.close();
    } catch {
      // Ignore close races.
    }
    try {
      this.pc?.close();
    } catch {
      // Ignore close races.
    }

    this.micStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore stop races.
      }
    });

    this.stopOutputMeter();
    this.remoteAudio = releaseRemoteAudioElement(this.remoteAudio);

    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.currentAssistantText = "";
    this.responseAudioStarted = false;
    this.toolRunning = false;

    if (options.emitIdle) {
      this.callbacks.onConnectionState("idle");
      this.callbacks.onMood("idle");
      this.callbacks.onMouthShape(silentMouthShape());
    }
  }

  private async handleServerEvent(raw: string): Promise<void> {
    const event = safeParseEvent(raw);
    if (!event.type) return;

    if (event.type === "error") {
      this.callbacks.onMood("error");
      this.callbacks.onStatus(event.error?.message || "Realtime API returned an error.");
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.log("speech started");
      this.callbacks.onMood("listening");
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.log("speech stopped");
      this.callbacks.onMood("thinking");
      return;
    }

    if (
      event.type === "response.created" ||
      event.type === "response.created.completed" ||
      event.type === "response.create"
    ) {
      this.log("response creation", { type: event.type });
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      if (!this.responseAudioStarted) {
        this.responseAudioStarted = true;
        this.log("response audio start");
      }
      this.callbacks.onMood("speaking");
      return;
    }

    if (event.type === "response.output_audio.done" || event.type === "response.audio.done") {
      this.log("response audio completion", { type: event.type });
      this.responseAudioStarted = false;
      if (!this.toolRunning) this.callbacks.onMood("idle");
      return;
    }

    if (
      event.type === "response.cancelled" ||
      event.type === "response.canceled" ||
      event.type === "output_audio_buffer.cleared"
    ) {
      this.log("interruption or cancellation", { type: event.type });
      this.responseAudioStarted = false;
      return;
    }

    if (
      event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.output_text.delta"
    ) {
      this.currentAssistantText += event.delta || "";
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event.transcript || collectItemText(event.item);
      if (transcript) this.callbacks.onTranscript(newEntry("user", transcript));
      return;
    }

    if (event.type === "response.done") {
      const output = event.response?.output || [];
      const spoken = this.currentAssistantText || output.map(collectOutputText).filter(Boolean).join("\n");
      if (spoken) this.callbacks.onTranscript(newEntry("ricky", spoken));
      this.currentAssistantText = "";
      this.responseAudioStarted = false;

      const functionCalls = output.filter((item) => item.type === "function_call" && item.name && item.call_id);
      if (functionCalls.length > 0) {
        await this.executeFunctionCalls(functionCalls);
      } else if (!this.toolRunning) {
        this.callbacks.onMood("idle");
      }
    }
  }

  private async executeFunctionCalls(items: ResponseOutputItem[]): Promise<void> {
    this.toolRunning = true;
    this.callbacks.onMood("working");
    let shouldCreateResponse = false;

    for (const item of items) {
      const callId = item.call_id;
      const name = item.name;
      if (!callId || !name) continue;

      const parsedArgs = parseToolArguments(item.arguments || "{}");
      const knownTool = this.toolSpecs.some((tool) => tool.name === name);
      if (!knownTool) {
        await this.returnToolOutput(callId, {
          ok: false,
          error: `Tool is not available: ${name}`,
        });
        shouldCreateResponse = true;
        continue;
      }

      this.callbacks.onTranscript(newEntry("tool", `Running ${name}`));
      if (name === "image_generate") {
        this.callbacks.onArtifact({
          title: "Generating Image",
          kind: "imageLoading",
          content: typeof parsedArgs.prompt === "string" ? parsedArgs.prompt : "Ricky is generating an image.",
        });
      }
      if (name === "thumbnail_generate" || name === "thumbnail_edit") {
        const loadingResult = await window.ricky.executeTool({
          name: "thumbnail_loading_prepare",
          arguments: {
            ...parsedArgs,
            mode: name === "thumbnail_edit" ? "edit" : "generate",
          },
        } satisfies RickyToolCall);
        if (typeof loadingResult.runId === "string") parsedArgs.runId = loadingResult.runId;
        if (typeof loadingResult.targetId === "string") parsedArgs.targetId = loadingResult.targetId;
        if (loadingResult.artifact) this.callbacks.onArtifact(loadingResult.artifact);
      }
      const result = await window.ricky.executeTool({ name, arguments: parsedArgs } satisfies RickyToolCall);
      if (result.mode === "display" || result.mode === "computer") {
        this.callbacks.onMode(result.mode);
      }
      if (result.artifact) this.callbacks.onArtifact(result.artifact);
      if (result.thumbnailReady === true) this.callbacks.onThumbnailReady();
      if (result.silent !== true) shouldCreateResponse = true;
      await this.returnToolOutput(callId, result);
    }

    if (shouldCreateResponse) {
      this.log("response creation", { source: "tool_followup" });
      this.sendEvent({ type: "response.create" });
    }
    this.toolRunning = false;
  }

  private async returnToolOutput(callId: string, result: RickyToolResult): Promise<void> {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(sanitizeToolResult(result)),
      },
    });
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(event));
    }
  }

  private startOutputMeter(stream: MediaStream): void {
    this.stopOutputMeter();

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    this.audioContext = audioContext;
    this.outputAnalyser = analyser;

    const samples = new Uint8Array(analyser.fftSize);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(frequencies);
      let total = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        total += centered * centered;
      }
      const rms = Math.sqrt(total / samples.length);
      const energy = clamp01(rms * 10.5);
      const bands = getSpeechBands(frequencies);

      // Simple realtime viseme approximation: low energy rounds the mouth,
      // mid energy opens it, high energy stretches it for consonants/ee sounds.
      const target: MouthShape = {
        open: clamp01(energy * 0.75 + bands.mid * 0.45 - bands.high * 0.16),
        width: clamp01(0.28 + bands.mid * 0.55 + bands.high * 0.74 - bands.low * 0.28),
        round: clamp01(0.08 + bands.low * 0.95 + energy * 0.1 - bands.high * 0.42),
        teeth: clamp01(bands.high * 1.4 + bands.mid * 0.25 - bands.low * 0.35),
      };

      this.smoothedMouthShape = smoothMouthShape(this.smoothedMouthShape, target, 0.36);
      this.callbacks.onMouthShape(this.smoothedMouthShape);
      this.outputMeterFrame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  private stopOutputMeter(): void {
    if (this.outputMeterFrame) {
      window.cancelAnimationFrame(this.outputMeterFrame);
      this.outputMeterFrame = 0;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.outputAnalyser = null;
    this.smoothedMouthShape = silentMouthShape();
  }

  private log(message: string, detail?: unknown): void {
    if (detail !== undefined) {
      console.debug(LOG_PREFIX, message, detail);
    } else {
      console.debug(LOG_PREFIX, message);
    }
  }
}

export {
  assertSingleRealtimePath,
  countRealtimeResources,
  createRemoteAudioElement,
  releaseRemoteAudioElement,
};
export type { RealtimeResourceCounts };
export { isEmptyRealtimePath } from "./realtimeAudioLifecycle";

function silentMouthShape(): MouthShape {
  return { open: 0, width: 0.18, round: 0, teeth: 0 };
}

function smoothMouthShape(current: MouthShape, target: MouthShape, amount: number): MouthShape {
  return {
    open: lerp(current.open, target.open, amount),
    width: lerp(current.width, target.width, amount),
    round: lerp(current.round, target.round, amount),
    teeth: lerp(current.teeth, target.teeth, amount),
  };
}

function getSpeechBands(frequencies: Uint8Array): { low: number; mid: number; high: number } {
  const low = averageRange(frequencies, 2, 14) / 255;
  const mid = averageRange(frequencies, 14, 48) / 255;
  const high = averageRange(frequencies, 48, 110) / 255;
  return { low: clamp01(low * 2.2), mid: clamp01(mid * 2.1), high: clamp01(high * 2.8) };
}

function averageRange(values: Uint8Array, start: number, end: number): number {
  const cappedEnd = Math.min(end, values.length);
  if (start >= cappedEnd) return 0;
  let total = 0;
  for (let index = start; index < cappedEnd; index += 1) {
    total += values[index];
  }
  return total / (cappedEnd - start);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function newEntry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}

function safeParseEvent(raw: string): ServerEvent {
  try {
    return JSON.parse(raw) as ServerEvent;
  } catch {
    return {};
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sanitizeToolResult(result: RickyToolResult): RickyToolResult {
  if (!result.artifact) return result;

  const { artifact, ...rest } = result;
  return {
    ...rest,
    artifact: {
      title: artifact.title,
      kind: artifact.kind,
      content:
        artifact.kind === "thumbnailBoard"
          ? "Thumbnail board rendered in the UI. Use the compact board field for exact numbers, selected state, and loading state."
          : artifact.kind === "image" || artifact.kind === "imageLoading"
            ? "Image rendered in the UI."
            : artifact.content.length > 1200
              ? `${artifact.content.slice(0, 1200)}...`
              : artifact.content,
      language: artifact.language,
      fullscreen: artifact.fullscreen,
    },
  };
}

function collectItemText(item: ServerEvent["item"]): string {
  return item?.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}

function collectOutputText(item: ResponseOutputItem): string {
  return item.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}
