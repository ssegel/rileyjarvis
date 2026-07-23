const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/App.tsx sendTextPrompt gate behavior for focused regression tests.
 * Keep in sync with App.tsx when changing typed-prompt submit rules.
 */
function planTypedPromptSubmit(args) {
  const trimmed = String(args.text || "").trim();
  if (!trimmed) {
    return { nextText: args.text, hideInput: false, statusMessage: null, didSend: false, sendCalls: 0 };
  }

  let sendCalls = 0;
  if (!args.isConnected) {
    return {
      nextText: args.text,
      hideInput: false,
      statusMessage: "Connect voice first.",
      didSend: false,
      sendCalls: 0,
    };
  }

  sendCalls += 1;
  const sent = args.send(trimmed);
  if (!sent) {
    return {
      nextText: args.text,
      hideInput: false,
      statusMessage: "Connect voice first.",
      didSend: false,
      sendCalls,
    };
  }

  return {
    nextText: "",
    hideInput: true,
    statusMessage: null,
    didSend: true,
    sendCalls,
  };
}

test("disconnected submission preserves text", () => {
  const outcome = planTypedPromptSubmit({
    text: "  hello jarvis  ",
    isConnected: false,
    send: () => true,
  });
  assert.equal(outcome.nextText, "  hello jarvis  ");
  assert.equal(outcome.hideInput, false);
  assert.equal(outcome.didSend, false);
  assert.equal(outcome.sendCalls, 0);
});

test("disconnected submission shows Connect voice first.", () => {
  const outcome = planTypedPromptSubmit({
    text: "hello",
    isConnected: false,
    send: () => true,
  });
  assert.equal(outcome.statusMessage, "Connect voice first.");
});

test("disconnected submission performs no send", () => {
  let sendCalls = 0;
  planTypedPromptSubmit({
    text: "hello",
    isConnected: false,
    send: () => {
      sendCalls += 1;
      return true;
    },
  });
  assert.equal(sendCalls, 0);
});

test("connected successful submission clears the text", () => {
  let sent = null;
  const outcome = planTypedPromptSubmit({
    text: "  do the thing  ",
    isConnected: true,
    send: (text) => {
      sent = text;
      return true;
    },
  });
  assert.equal(sent, "do the thing");
  assert.equal(outcome.nextText, "");
  assert.equal(outcome.hideInput, true);
  assert.equal(outcome.didSend, true);
  assert.equal(outcome.statusMessage, null);
});

test("failed send preserves the text and displays an error", () => {
  const outcome = planTypedPromptSubmit({
    text: "still here",
    isConnected: true,
    send: () => false,
  });
  assert.equal(outcome.sendCalls, 1);
  assert.equal(outcome.nextText, "still here");
  assert.equal(outcome.hideInput, false);
  assert.equal(outcome.didSend, false);
  assert.equal(outcome.statusMessage, "Connect voice first.");
});

test("visible Jarvis branding in App and ArtifactPanel", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src", "components", "ArtifactPanel.tsx"), "utf8");
  const realtime = fs.readFileSync(path.join(root, "src", "lib", "realtime.ts"), "utf8");

  assert.match(app, /Type to Jarvis\.\.\./);
  assert.match(app, /Type to Jarvis/);
  assert.doesNotMatch(app, /Type to Ricky/);
  assert.match(app, /Connect voice first\./);
  assert.match(app, /const sent = clientRef\.current\?\.sendText\(trimmed\) \?\? false;/);

  assert.match(panel, /Ask Jarvis to show web results/);
  assert.match(panel, /Ask Jarvis:/);
  assert.doesNotMatch(panel, /Ask Ricky/);

  assert.match(realtime, /sendText\(text: string\): boolean/);
});
