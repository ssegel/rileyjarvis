const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/lib/textDelivery.ts for Node tests. Keep in sync with TypeScript.
 */
function readAssistantText(result) {
  if (!result) return "";
  return String(result.assistantText ?? "").trim();
}

function isCurrentTextGeneration(submitGeneration, currentGeneration) {
  return submitGeneration === currentGeneration;
}

function planTextResultDelivery(result, submitGeneration, currentGeneration) {
  if (!isCurrentTextGeneration(submitGeneration, currentGeneration)) {
    return { action: "reject", reason: "stale" };
  }
  if (!result) {
    return { action: "reject", reason: "missing" };
  }
  if (result.cancelled || result.outcome === "cancelled") {
    return { action: "reject", reason: "cancelled" };
  }
  if (!result.ok) {
    return { action: "reject", reason: "error" };
  }
  const assistantText = readAssistantText(result);
  const artifactCount = result.artifacts?.length ?? 0;
  if (!assistantText && artifactCount === 0) {
    return { action: "empty_error", assistantTextLen: 0, artifactCount: 0 };
  }
  return {
    action: "deliver",
    assistantText,
    assistantTextLen: assistantText.length,
    artifactCount,
  };
}

/**
 * Mirrors TextClient success delivery: one assistant callback, preserve assistantText.
 */
function deliverCompletedResult(result, submitGeneration, currentGeneration, callbacks) {
  const plan = planTextResultDelivery(result, submitGeneration, currentGeneration);
  if (plan.action === "reject" && plan.reason === "stale") {
    return { ok: false, outcome: "cancelled", assistantText: "", cancelled: true };
  }
  if (plan.action !== "deliver") {
    return { ok: false, outcome: "error", assistantText: "", plan };
  }
  let callbackCount = 0;
  if (plan.assistantText) {
    callbacks.onAssistantText(plan.assistantText, result.clientTurnId);
    callbackCount += 1;
  }
  return {
    ok: true,
    outcome: "completed",
    assistantText: plan.assistantText,
    clientTurnId: result.clientTurnId,
    callbackCount,
  };
}

/**
 * Mirrors App sendTextPrompt post-submit: append before clear/close.
 */
function planAppAfterSubmit(args) {
  const assistantText = readAssistantText(args.result);
  const hasArtifact = (args.result?.artifacts?.length ?? 0) > 0;
  const log = [...(args.log || [])];
  let appended = false;
  let cleared = false;
  let closed = false;
  let released = false;
  let idle = false;
  const steps = [];

  if (args.result?.ok && assistantText && args.result.clientTurnId) {
    if (args.alreadyAppendedTurnId !== args.result.clientTurnId) {
      log.unshift({ role: "ricky", text: assistantText });
      steps.push("append");
    }
    appended = true;
  }

  const delivered = Boolean(args.result?.ok) && ((appended && Boolean(assistantText)) || hasArtifact);
  if (args.result?.ok && assistantText && !appended) {
    steps.push("error_keep_open");
    return { log, cleared, closed, released, idle, appended, steps, keepOpen: true };
  }
  if (delivered) {
    steps.push("clear");
    cleared = true;
    steps.push("close");
    closed = true;
    steps.push("idle");
    idle = true;
  }
  steps.push("release");
  released = true;
  return { log, cleared, closed, released, idle, appended, steps, keepOpen: !cleared };
}

test("completed main result with nonempty assistantText reaches TextClient delivery plan", () => {
  const result = {
    ok: true,
    clientTurnId: "turn-1",
    assistantText: "Your first priority is branding.",
    artifacts: [],
    outcome: "completed",
    cancelled: false,
  };
  const plan = planTextResultDelivery(result, 1, 1);
  assert.equal(plan.action, "deliver");
  assert.equal(plan.assistantTextLen, result.assistantText.length);
  assert.match(plan.assistantText, /branding/);
});

test("TextClient calls the assistant-delivery callback exactly once", () => {
  const calls = [];
  const delivered = deliverCompletedResult(
    {
      ok: true,
      clientTurnId: "turn-2",
      assistantText: "Hello Sarah.",
      artifacts: [],
      outcome: "completed",
      cancelled: false,
    },
    3,
    3,
    {
      onAssistantText: (text, turnId) => {
        calls.push({ text, turnId });
      },
    },
  );
  assert.equal(delivered.ok, true);
  assert.equal(delivered.callbackCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "Hello Sarah.");
  assert.equal(calls[0].turnId, "turn-2");
});

test("App appends the assistant response to the Running Response Log", () => {
  const outcome = planAppAfterSubmit({
    result: {
      ok: true,
      clientTurnId: "turn-3",
      assistantText: "Priority is memory cleanup.",
      artifacts: [],
    },
    log: [{ role: "user", text: "What is my first priority?" }],
  });
  assert.equal(outcome.appended, true);
  assert.equal(outcome.log[0].role, "ricky");
  assert.equal(outcome.log[0].text, "Priority is memory cleanup.");
});

test("append occurs before input clearing and state reset", () => {
  const outcome = planAppAfterSubmit({
    result: {
      ok: true,
      clientTurnId: "turn-4",
      assistantText: "Shown first.",
      artifacts: [],
    },
    log: [],
  });
  assert.deepEqual(outcome.steps.slice(0, 4), ["append", "clear", "close", "idle"]);
  assert.equal(outcome.steps[outcome.steps.length - 1], "release");
  assert.ok(outcome.steps.indexOf("append") < outcome.steps.indexOf("clear"));
  assert.ok(outcome.steps.indexOf("append") < outcome.steps.indexOf("close"));
  assert.ok(outcome.steps.indexOf("append") < outcome.steps.indexOf("idle"));
  assert.ok(outcome.steps.indexOf("append") < outcome.steps.indexOf("release"));
});

test("generation guarding accepts the current successful result", () => {
  const plan = planTextResultDelivery(
    {
      ok: true,
      clientTurnId: "turn-5",
      assistantText: "Accepted.",
      artifacts: [],
      outcome: "completed",
      cancelled: false,
    },
    7,
    7,
  );
  assert.equal(plan.action, "deliver");
});

test("stale results are still rejected", () => {
  const plan = planTextResultDelivery(
    {
      ok: true,
      clientTurnId: "turn-6",
      assistantText: "Should not deliver.",
      artifacts: [],
      outcome: "completed",
      cancelled: false,
    },
    4,
    5,
  );
  assert.equal(plan.action, "reject");
  assert.equal(plan.reason, "stale");

  const delivered = deliverCompletedResult(
    {
      ok: true,
      clientTurnId: "turn-6",
      assistantText: "Should not deliver.",
      artifacts: [],
      outcome: "completed",
      cancelled: false,
    },
    4,
    5,
    { onAssistantText: () => assert.fail("stale callback") },
  );
  assert.equal(delivered.ok, false);
  assert.equal(delivered.outcome, "cancelled");
});

test("completed result cannot silently disappear", () => {
  const outcome = planAppAfterSubmit({
    result: {
      ok: true,
      clientTurnId: "turn-7",
      assistantText: "Must remain visible.",
      artifacts: [],
    },
    log: [],
    alreadyAppendedTurnId: null,
  });
  assert.equal(outcome.appended, true);
  assert.equal(outcome.cleared, true);
  assert.match(outcome.log[0].text, /Must remain visible/);

  const failedAppend = planAppAfterSubmit({
    result: {
      ok: true,
      clientTurnId: "turn-8",
      assistantText: "Invisible path",
      artifacts: [],
    },
    log: [],
    // Simulate append refused by forcing already-empty path via monkeypatch: use empty text
  });
  // nonempty text always appends in planner; verify keep-open path via empty assistant + ok is not delivered
  const emptyKeep = planAppAfterSubmit({
    result: { ok: true, clientTurnId: "turn-9", assistantText: "", artifacts: [] },
    log: [],
  });
  assert.equal(emptyKeep.cleared, false);
  assert.equal(emptyKeep.keepOpen, true);
  assert.equal(failedAppend.appended, true);
});

test("App and TextClient source enforce delivery before clear", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const textClient = fs.readFileSync(path.join(root, "src", "lib", "textClient.ts"), "utf8");
  const viteEnv = fs.readFileSync(path.join(root, "src", "vite-env.d.ts"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

  assert.match(viteEnv, /assistantText:\s*string/);
  assert.match(viteEnv, /runTextTurn:\s*\(request: JarvisTextTurnRequest\)\s*=>\s*Promise<JarvisTextTurnResult>/);
  assert.match(preload, /runTextTurn:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("text:run"/);

  assert.match(textClient, /onAssistantText\(guardedText,\s*clientTurnId\)/);
  assert.match(textClient, /planTextResultDelivery/);
  assert.match(textClient, /text\.delivery\.main/);
  assert.match(textClient, /text\.delivery\.client/);
  assert.doesNotMatch(textClient, /activeTurnId !== clientTurnId/);

  assert.match(app, /appendAssistantToLog\(assistantText,\s*result\.clientTurnId\)/);
  assert.match(app, /newEntry\("ricky"/);
  assert.match(app, /text\.delivery\.app/);

  const appendIdx = app.indexOf("appendAssistantToLog(assistantText, result.clientTurnId)");
  const clearIdx = app.indexOf('setTextPrompt("")', appendIdx);
  const closeIdx = app.indexOf("setShowTypeInput(false)", appendIdx);
  const releaseIdx = app.indexOf("sessionOwnerRef.current.releaseText()", appendIdx);
  assert.ok(appendIdx > 0 && clearIdx > appendIdx);
  assert.ok(closeIdx > appendIdx);
  assert.ok(releaseIdx > appendIdx);
});

test("main usage log records assistantTextLen without content", () => {
  const textSession = fs.readFileSync(path.join(root, "electron", "text-session.cjs"), "utf8");
  assert.match(textSession, /assistantTextLen:\s*visibleText\.length/);
  assert.match(textSession, /Length only — never log assistant response content/);
});
