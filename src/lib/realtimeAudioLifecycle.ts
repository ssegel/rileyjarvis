/**
 * Pure helpers for Realtime remote-audio ownership and resource accounting.
 * Used by RickyRealtimeClient and focused Node tests (no DOM required for cleanup tests).
 */

export type RealtimeResourceCounts = {
  peerConnections: number;
  remoteAudioElements: number;
  outputAnalysers: number;
  microphoneStreams: number;
  dataChannels: number;
};

export type RemoteAudioLike = {
  pause: () => void;
  srcObject: MediaProvider | null;
  onended: ((this: HTMLAudioElement, ev: Event) => unknown) | null;
  onerror: OnErrorEventHandler;
  autoplay?: boolean;
};

export function createRemoteAudioElement(
  doc: Pick<Document, "createElement"> = document,
): HTMLAudioElement {
  const audio = doc.createElement("audio");
  audio.autoplay = true;
  return audio;
}

/** Pause, detach stream, clear handlers, and drop ownership. Returns null for assignment. */
export function releaseRemoteAudioElement(audio: RemoteAudioLike | null): null {
  if (!audio) return null;
  try {
    audio.pause();
  } catch {
    // Ignore pause races during teardown.
  }
  audio.onended = null;
  audio.onerror = null;
  audio.srcObject = null;
  return null;
}

export function countRealtimeResources(parts: {
  pc: unknown | null;
  remoteAudio: unknown | null;
  outputAnalyser: unknown | null;
  micStream: unknown | null;
  dc: unknown | null;
}): RealtimeResourceCounts {
  return {
    peerConnections: parts.pc ? 1 : 0,
    remoteAudioElements: parts.remoteAudio ? 1 : 0,
    outputAnalysers: parts.outputAnalyser ? 1 : 0,
    microphoneStreams: parts.micStream ? 1 : 0,
    dataChannels: parts.dc ? 1 : 0,
  };
}

export function assertSingleRealtimePath(counts: RealtimeResourceCounts): boolean {
  return (
    counts.peerConnections <= 1 &&
    counts.remoteAudioElements <= 1 &&
    counts.outputAnalysers <= 1 &&
    counts.microphoneStreams <= 1 &&
    counts.dataChannels <= 1
  );
}

export function isEmptyRealtimePath(counts: RealtimeResourceCounts): boolean {
  return (
    counts.peerConnections === 0 &&
    counts.remoteAudioElements === 0 &&
    counts.outputAnalysers === 0 &&
    counts.microphoneStreams === 0 &&
    counts.dataChannels === 0
  );
}
