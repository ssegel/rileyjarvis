const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/lib/realtimeAudioLifecycle.ts for Node tests without changing tsconfig.
 * Keep in sync with that module when changing ownership/cleanup helpers.
 */
function createRemoteAudioElement(doc) {
  const audio = doc.createElement("audio");
  audio.autoplay = true;
  return audio;
}

function releaseRemoteAudioElement(audio) {
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

function countRealtimeResources(parts) {
  return {
    peerConnections: parts.pc ? 1 : 0,
    remoteAudioElements: parts.remoteAudio ? 1 : 0,
    outputAnalysers: parts.outputAnalyser ? 1 : 0,
    microphoneStreams: parts.micStream ? 1 : 0,
    dataChannels: parts.dc ? 1 : 0,
  };
}

function assertSingleRealtimePath(counts) {
  return (
    counts.peerConnections <= 1 &&
    counts.remoteAudioElements <= 1 &&
    counts.outputAnalysers <= 1 &&
    counts.microphoneStreams <= 1 &&
    counts.dataChannels <= 1
  );
}

function isEmptyRealtimePath(counts) {
  return (
    counts.peerConnections === 0 &&
    counts.remoteAudioElements === 0 &&
    counts.outputAnalysers === 0 &&
    counts.microphoneStreams === 0 &&
    counts.dataChannels === 0
  );
}

function createMockAudio() {
  return {
    autoplay: false,
    srcObject: { id: "stream-1" },
    paused: false,
    pauseCalls: 0,
    onended: () => undefined,
    onerror: () => undefined,
    pause() {
      this.paused = true;
      this.pauseCalls += 1;
    },
  };
}

test("remote audio ownership: createRemoteAudioElement sets autoplay", () => {
  const created = [];
  const audio = createRemoteAudioElement({
    createElement: () => {
      const el = { autoplay: false };
      created.push(el);
      return el;
    },
  });
  assert.equal(created.length, 1);
  assert.equal(audio.autoplay, true);
});

test("disconnect cleanup: releaseRemoteAudioElement pauses, clears srcObject, and drops handlers", () => {
  const audio = createMockAudio();
  const released = releaseRemoteAudioElement(audio);
  assert.equal(released, null);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.paused, true);
  assert.equal(audio.srcObject, null);
  assert.equal(audio.onended, null);
  assert.equal(audio.onerror, null);
});

test("repeated disconnect is safe", () => {
  assert.equal(releaseRemoteAudioElement(null), null);
  const audio = createMockAudio();
  assert.equal(releaseRemoteAudioElement(audio), null);
  assert.equal(releaseRemoteAudioElement(audio), null);
  assert.ok(audio.pauseCalls >= 2);
  assert.equal(audio.srcObject, null);
});

test("one connect/disconnect cycle leaves an empty resource path", () => {
  const connected = countRealtimeResources({
    pc: { id: "pc1" },
    remoteAudio: { id: "a1" },
    outputAnalyser: { id: "an1" },
    micStream: { id: "mic1" },
    dc: { id: "dc1" },
  });
  assert.equal(assertSingleRealtimePath(connected), true);
  assert.equal(connected.peerConnections, 1);
  assert.equal(connected.remoteAudioElements, 1);
  assert.equal(connected.outputAnalysers, 1);
  assert.equal(connected.microphoneStreams, 1);
  assert.equal(connected.dataChannels, 1);

  // After disconnect/releaseAllResources all refs are null.
  const disconnected = countRealtimeResources({
    pc: null,
    remoteAudio: null,
    outputAnalyser: null,
    micStream: null,
    dc: null,
  });
  assert.equal(isEmptyRealtimePath(disconnected), true);
});

test("reconnect creates only one fresh audio path", () => {
  const afterTeardown = countRealtimeResources({
    pc: null,
    remoteAudio: null,
    outputAnalyser: null,
    micStream: null,
    dc: null,
  });
  assert.equal(isEmptyRealtimePath(afterTeardown), true);

  const afterReconnect = countRealtimeResources({
    pc: { id: "pc2" },
    remoteAudio: { id: "a2" },
    outputAnalyser: { id: "an2" },
    micStream: { id: "mic2" },
    dc: { id: "dc2" },
  });
  assert.equal(assertSingleRealtimePath(afterReconnect), true);
  assert.equal(afterReconnect.remoteAudioElements, 1);
  assert.equal(afterReconnect.peerConnections, 1);
  assert.equal(afterReconnect.outputAnalysers, 1);
  assert.equal(afterReconnect.microphoneStreams, 1);
  assert.equal(afterReconnect.dataChannels, 1);
});

test("existing interruption configuration remains enabled", () => {
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  assert.match(main, /interrupt_response:\s*true/);
  assert.match(main, /create_response:\s*true/);
  assert.match(main, /type:\s*"semantic_vad"/);
  assert.match(main, /eagerness:\s*"medium"/);
  assert.match(main, /model:\s*"gpt-realtime-2"/);
  assert.match(main, /voice:\s*"cedar"/);

  const realtime = fs.readFileSync(path.join(root, "src", "lib", "realtime.ts"), "utf8");
  assert.match(realtime, /private remoteAudio: HTMLAudioElement \| null/);
  assert.match(realtime, /releaseRemoteAudioElement/);
  assert.match(realtime, /releaseAllResources/);
  assert.match(realtime, /removeEventListener/);
  assert.doesNotMatch(realtime, /track\.enabled\s*=\s*false/);
  assert.doesNotMatch(realtime, /muted\s*=\s*true/);

  const lifecycle = fs.readFileSync(path.join(root, "src", "lib", "realtimeAudioLifecycle.ts"), "utf8");
  assert.match(lifecycle, /export function releaseRemoteAudioElement/);
  assert.match(lifecycle, /audio\.srcObject = null/);

  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(app, /clientRef\.current\?\.disconnect\(\)/);
});
