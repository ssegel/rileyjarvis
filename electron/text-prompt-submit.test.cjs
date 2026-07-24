const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/App.tsx Phase 11 typed-prompt submit planner for focused regression tests.
 * Keyboard submits use independent text IPC (not Realtime sendText).
 */
function planTypedPromptSubmit(args) {
  const trimmed = String(args.text || "").trim();
  if (!trimmed) {
    return { nextText: args.text, hideInput: false, statusMessage: null, didSend: false, sendCalls: 0, textIpcCalls: 0 };
  }

  if (args.voiceBusy) {
    return {
      nextText: args.text,
      hideInput: false,
      statusMessage: "Jarvis is busy with a voice response.",
      didSend: false,
      sendCalls: 0,
      textIpcCalls: 0,
    };
  }

  if (args.textBusy) {
    return {
      nextText: args.text,
      hideInput: false,
      statusMessage: "Jarvis is busy with another text turn.",
      didSend: false,
      sendCalls: 0,
      textIpcCalls: 0,
    };
  }

  const textIpcCalls = 1;
  const accepted = args.runText(trimmed);
  if (!accepted) {
    return {
      nextText: args.text,
      hideInput: false,
      statusMessage: "Something went wrong connecting Jarvis.",
      didSend: false,
      sendCalls: 0,
      textIpcCalls,
    };
  }

  return {
    nextText: "",
    hideInput: true,
    statusMessage: null,
    didSend: true,
    sendCalls: 0,
    textIpcCalls,
  };
}

test("disconnected submission uses text IPC and clears text when accepted", () => {
  let sent = null;
  const outcome = planTypedPromptSubmit({
    text: "  hello jarvis  ",
    isConnected: false,
    voiceBusy: false,
    textBusy: false,
    runText: (text) => {
      sent = text;
      return true;
    },
  });
  assert.equal(sent, "hello jarvis");
  assert.equal(outcome.nextText, "");
  assert.equal(outcome.hideInput, true);
  assert.equal(outcome.didSend, true);
  assert.equal(outcome.textIpcCalls, 1);
  assert.equal(outcome.sendCalls, 0);
});

test("disconnected submission does not require Connect voice first.", () => {
  const outcome = planTypedPromptSubmit({
    text: "hello",
    isConnected: false,
    voiceBusy: false,
    textBusy: false,
    runText: () => true,
  });
  assert.notEqual(outcome.statusMessage, "Connect voice first.");
  assert.equal(outcome.didSend, true);
});

test("disconnected submission does not call Realtime sendText", () => {
  let sendCalls = 0;
  planTypedPromptSubmit({
    text: "hello",
    isConnected: false,
    voiceBusy: false,
    textBusy: false,
    runText: () => true,
    send: () => {
      sendCalls += 1;
      return true;
    },
  });
  assert.equal(sendCalls, 0);
});

test("connected successful submission still uses text IPC only", () => {
  let sent = null;
  let sendCalls = 0;
  const outcome = planTypedPromptSubmit({
    text: "  do the thing  ",
    isConnected: true,
    voiceBusy: false,
    textBusy: false,
    runText: (text) => {
      sent = text;
      return true;
    },
    send: () => {
      sendCalls += 1;
      return true;
    },
  });
  assert.equal(sent, "do the thing");
  assert.equal(sendCalls, 0);
  assert.equal(outcome.nextText, "");
  assert.equal(outcome.hideInput, true);
  assert.equal(outcome.didSend, true);
});

test("voice-busy submission preserves text and shows busy message", () => {
  const outcome = planTypedPromptSubmit({
    text: "still here",
    isConnected: true,
    voiceBusy: true,
    textBusy: false,
    runText: () => true,
  });
  assert.equal(outcome.textIpcCalls, 0);
  assert.equal(outcome.nextText, "still here");
  assert.equal(outcome.hideInput, false);
  assert.equal(outcome.didSend, false);
  assert.equal(outcome.statusMessage, "Jarvis is busy with a voice response.");
});

test("App routes keyboard through independent text mode", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src", "components", "ArtifactPanel.tsx"), "utf8");
  const realtime = fs.readFileSync(path.join(root, "src", "lib", "realtime.ts"), "utf8");

  assert.match(app, /Type to Jarvis\.\.\./);
  assert.match(app, /Type to Jarvis/);
  assert.doesNotMatch(app, /Type to Ricky/);
  assert.doesNotMatch(app, /Connect voice first\./);
  assert.match(app, /textClientRef\.current\?\.submit/);
  assert.doesNotMatch(app, /clientRef\.current\?\.sendText/);

  assert.match(panel, /Ask Jarvis to show web results/);
  assert.match(panel, /Ask Jarvis:/);
  assert.doesNotMatch(panel, /Ask Ricky/);

  // sendText remains available on the Realtime client but is not used for keyboard.
  assert.match(realtime, /sendText\(text: string\): boolean/);
});
