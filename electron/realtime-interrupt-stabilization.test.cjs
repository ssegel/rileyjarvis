const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/lib/realtimeInterruptGate.ts for Node tests.
 * Keep in sync when changing barge-in / response-id gating.
 */
function extractResponseId(event) {
  if (typeof event.response_id === "string" && event.response_id) return event.response_id;
  if (typeof event.responseId === "string" && event.responseId) return event.responseId;
  if (event.response && typeof event.response.id === "string" && event.response.id) return event.response.id;
  return null;
}

function isSupersededResponseId(responseId, supersededIds) {
  if (!responseId) return false;
  const set = supersededIds instanceof Set ? supersededIds : new Set(supersededIds);
  return set.has(responseId);
}

function shouldAcceptResponseScopedEvent(args) {
  const { eventType, responseId, activeResponseId, supersededIds } = args;
  if (eventType === "response.created") return true;
  if (isSupersededResponseId(responseId, supersededIds)) return false;
  if (activeResponseId && responseId && responseId !== activeResponseId) return false;
  return true;
}

function planBargeIn(args) {
  const shouldInvalidate =
    Boolean(args.activeResponseId) || args.responseAudioStarted || args.responseInFlight;
  return {
    shouldInvalidate,
    supersededId: args.activeResponseId,
    clearAssistantText: shouldInvalidate,
    clearAudioStarted: shouldInvalidate,
    clearInFlight: shouldInvalidate,
    flushPlayback: shouldInvalidate,
  };
}

function canClientCreateResponse(responseInFlight) {
  return !responseInFlight;
}

function afterResponseCreated(responseId) {
  return {
    activeResponseId: responseId,
    responseInFlight: true,
  };
}

function afterActiveResponseFinished(args) {
  if (!args.responseId || args.responseId === args.activeResponseId) {
    return { clearActive: true, clearInFlight: true };
  }
  return { clearActive: false, clearInFlight: false };
}

test("stale audio deltas ignored after interruption", () => {
  const superseded = new Set(["resp-old"]);
  const accept = shouldAcceptResponseScopedEvent({
    eventType: "response.output_audio.delta",
    responseId: "resp-old",
    activeResponseId: "resp-new",
    supersededIds: superseded,
  });
  assert.equal(accept, false);
});

test("stale transcript deltas ignored", () => {
  const accept = shouldAcceptResponseScopedEvent({
    eventType: "response.output_audio_transcript.delta",
    responseId: "resp-old",
    activeResponseId: null,
    supersededIds: ["resp-old"],
  });
  assert.equal(accept, false);
});

test("cancelled response completion does not reset the replacement response", () => {
  const finish = afterActiveResponseFinished({
    responseId: "resp-old",
    activeResponseId: "resp-new",
  });
  assert.equal(finish.clearActive, false);
  assert.equal(finish.clearInFlight, false);

  const acceptDone = shouldAcceptResponseScopedEvent({
    eventType: "response.done",
    responseId: "resp-old",
    activeResponseId: "resp-new",
    supersededIds: ["resp-old"],
  });
  assert.equal(acceptDone, false);
});

test("duplicate response.create is prevented", () => {
  assert.equal(canClientCreateResponse(false), true);
  assert.equal(canClientCreateResponse(true), false);
});

test("repeated interruption leaves one active response", () => {
  let active = "resp-1";
  const superseded = new Set();

  const first = planBargeIn({
    activeResponseId: active,
    responseAudioStarted: true,
    responseInFlight: true,
  });
  assert.equal(first.shouldInvalidate, true);
  superseded.add(first.supersededId);
  active = null;

  const created = afterResponseCreated("resp-2");
  active = created.activeResponseId;
  assert.equal(active, "resp-2");

  const second = planBargeIn({
    activeResponseId: active,
    responseAudioStarted: true,
    responseInFlight: true,
  });
  superseded.add(second.supersededId);
  active = null;

  const replacement = afterResponseCreated("resp-3");
  active = replacement.activeResponseId;

  assert.equal(active, "resp-3");
  assert.equal(superseded.has("resp-1"), true);
  assert.equal(superseded.has("resp-2"), true);
  assert.equal(
    shouldAcceptResponseScopedEvent({
      eventType: "response.output_audio.delta",
      responseId: "resp-3",
      activeResponseId: active,
      supersededIds: superseded,
    }),
    true,
  );
  assert.equal(
    shouldAcceptResponseScopedEvent({
      eventType: "response.output_audio.delta",
      responseId: "resp-1",
      activeResponseId: active,
      supersededIds: superseded,
    }),
    false,
  );
});

test("uninterrupted responses still work", () => {
  const created = afterResponseCreated("resp-ok");
  assert.equal(created.activeResponseId, "resp-ok");
  assert.equal(created.responseInFlight, true);
  assert.equal(
    shouldAcceptResponseScopedEvent({
      eventType: "response.output_audio.delta",
      responseId: "resp-ok",
      activeResponseId: "resp-ok",
      supersededIds: [],
    }),
    true,
  );
  const finish = afterActiveResponseFinished({
    responseId: "resp-ok",
    activeResponseId: "resp-ok",
  });
  assert.equal(finish.clearActive, true);
  assert.equal(finish.clearInFlight, true);
});

test("Phase 8B wiring and Phase 8 lifecycle remain intact", () => {
  const realtime = fs.readFileSync(path.join(root, "src", "lib", "realtime.ts"), "utf8");
  assert.match(realtime, /private activeResponseId/);
  assert.match(realtime, /supersededResponseIds/);
  assert.match(realtime, /flushAssistantPlayback/);
  assert.match(realtime, /enqueueServerEvent/);
  assert.match(realtime, /requestClientResponseCreate/);
  assert.match(realtime, /planBargeIn/);
  assert.match(realtime, /private remoteAudio: HTMLAudioElement \| null/);
  assert.match(realtime, /releaseAllResources/);
  assert.doesNotMatch(realtime, /track\.enabled\s*=\s*false/);

  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  assert.match(main, /interrupt_response:\s*true/);
  assert.match(main, /type:\s*"semantic_vad"/);
  assert.match(main, /eagerness:\s*"medium"/);

  assert.equal(extractResponseId({ response: { id: "abc" } }), "abc");
  assert.equal(extractResponseId({ response_id: "xyz" }), "xyz");
});
