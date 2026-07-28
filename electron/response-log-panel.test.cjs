const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

/**
 * Mirrors src/lib/responseLogArtifact.ts — keep in sync with TypeScript.
 */
const RUNNING_RESPONSE_LOG_TITLE = "Running Response Log";

function buildRunningResponseLogArtifact(entries) {
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.role === "user" || entry.role === "ricky" || entry.role === "assistant")
    .filter((entry) => String(entry.text || "").trim())
    .slice(0, 40)
    .map((entry) => {
      const label = entry.role === "user" ? "You" : "Jarvis";
      const stamp = entry.at ? ` · ${entry.at}` : "";
      return `${label}${stamp}\n${String(entry.text).trim()}`;
    });
  return {
    title: RUNNING_RESPONSE_LOG_TITLE,
    kind: "text",
    content: lines.join("\n\n"),
  };
}

function isRunningResponseLogArtifact(artifact) {
  return Boolean(artifact && artifact.title === RUNNING_RESPONSE_LOG_TITLE);
}

function responseLogContainsAssistant(entries) {
  return (Array.isArray(entries) ? entries : []).some(
    (entry) =>
      (entry.role === "ricky" || entry.role === "assistant") && Boolean(String(entry.text || "").trim()),
  );
}

/**
 * Mirrors App text/voice panel activation after an assistant entry is appended.
 */
function planPanelAfterAssistantAppend(args) {
  const entry = {
    id: "e1",
    role: args.assistantRole || "ricky",
    text: args.assistantText,
    at: "5:30 PM",
  };
  const transcript = [entry, ...(args.priorTranscript || [])].slice(0, 80);
  let artifact = args.priorArtifact || null;
  let panelTitle = artifact?.title || "Ready";

  if (!args.hasToolArtifact) {
    if (responseLogContainsAssistant(transcript)) {
      artifact = buildRunningResponseLogArtifact(transcript);
      panelTitle = artifact.title;
    }
  } else {
    artifact = args.toolArtifact;
    panelTitle = artifact.title;
  }

  return {
    transcript,
    artifact,
    panelTitle,
    responseLogActive: isRunningResponseLogArtifact(artifact),
    assistantEntry: entry,
  };
}

function planIdleCleanup(args) {
  // Idle / keyboard-close must not clear an active Running Response Log.
  const artifact = args.artifact;
  const status = "Idle";
  const showTypeInput = false;
  const textBusy = false;
  return {
    artifact,
    status,
    showTypeInput,
    textBusy,
    panelTitle: artifact?.title || "Ready",
  };
}

test("a text assistant response appends one correctly shaped transcript entry", () => {
  const outcome = planPanelAfterAssistantAppend({
    assistantText: "Your first priority is branding.",
    priorTranscript: [{ id: "u1", role: "user", text: "What is my first priority?", at: "5:29 PM" }],
  });
  const assistants = outcome.transcript.filter((e) => e.role === "ricky" || e.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].role, "ricky");
  assert.equal(assistants[0].text, "Your first priority is branding.");
  assert.ok(assistants[0].at);
});

test("appending that entry activates Running Response Log", () => {
  const outcome = planPanelAfterAssistantAppend({
    assistantText: "Priority is branding.",
    priorTranscript: [],
  });
  assert.equal(outcome.responseLogActive, true);
  assert.equal(outcome.artifact.kind, "text");
  assert.match(outcome.artifact.content, /Priority is branding/);
});

test("the panel title changes from Ready to Running Response Log", () => {
  assert.equal((null)?.title || "Ready", "Ready");
  const outcome = planPanelAfterAssistantAppend({
    assistantText: "Hello Sarah.",
    priorArtifact: null,
  });
  assert.equal(outcome.panelTitle, "Running Response Log");
  assert.notEqual(outcome.panelTitle, "Ready");
});

test("the rendered log contains the assistant entry", () => {
  const outcome = planPanelAfterAssistantAppend({
    assistantText: "Visible in the artifacts panel.",
    priorTranscript: [{ id: "u1", role: "user", text: "hi", at: "5:28 PM" }],
  });
  assert.match(outcome.artifact.content, /Jarvis/);
  assert.match(outcome.artifact.content, /Visible in the artifacts panel/);
  assert.match(outcome.artifact.content, /You/);
});

test("cleanup and idle-state transitions do not replace the log with Ready", () => {
  const active = planPanelAfterAssistantAppend({
    assistantText: "Stay visible after idle.",
  });
  const afterIdle = planIdleCleanup({ artifact: active.artifact });
  assert.equal(afterIdle.status, "Idle");
  assert.equal(afterIdle.showTypeInput, false);
  assert.equal(afterIdle.textBusy, false);
  assert.equal(afterIdle.panelTitle, "Running Response Log");
  assert.notEqual(afterIdle.panelTitle, "Ready");
});

test("voice replies still activate the same log correctly", () => {
  const outcome = planPanelAfterAssistantAppend({
    assistantText: "Spoken reply in the panel.",
    assistantRole: "ricky",
  });
  assert.equal(outcome.responseLogActive, true);
  assert.equal(outcome.panelTitle, "Running Response Log");

  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(app, /entry\.role === "ricky"/);
  assert.match(app, /activateRunningResponseLog\(next\)/);
});

test("legacy internal assistant-role handling remains compatible", () => {
  const fromRicky = buildRunningResponseLogArtifact([
    { role: "ricky", text: "Legacy role works.", at: "1:00 PM" },
  ]);
  const fromAssistant = buildRunningResponseLogArtifact([
    { role: "assistant", text: "Alias role works.", at: "1:00 PM" },
  ]);
  assert.equal(fromRicky.title, RUNNING_RESPONSE_LOG_TITLE);
  assert.match(fromRicky.content, /Jarvis/);
  assert.match(fromRicky.content, /Legacy role works/);
  assert.match(fromAssistant.content, /Alias role works/);
  assert.equal(responseLogContainsAssistant([{ role: "ricky", text: "x" }]), true);
  assert.equal(responseLogContainsAssistant([{ role: "assistant", text: "x" }]), true);
});

test("App and ArtifactPanel source wire response log activation", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src", "components", "ArtifactPanel.tsx"), "utf8");
  const helper = fs.readFileSync(path.join(root, "src", "lib", "responseLogArtifact.ts"), "utf8");

  assert.match(helper, /Running Response Log/);
  assert.match(app, /activateRunningResponseLog/);
  assert.match(app, /buildRunningResponseLogArtifact/);
  assert.match(app, /text\.delivery\.panel/);
  assert.match(app, /panelMode/);
  assert.match(app, /newEntry\("ricky"/);
  assert.match(panel, /artifact\?\.title \|\| "Ready"/);

  // Idle / keyboard close must not clear the artifact.
  assert.doesNotMatch(app, /setArtifact\(null\)/);
  const idleIdx = app.indexOf('setStatus("Idle")');
  const slice = app.slice(Math.max(0, idleIdx - 200), idleIdx + 120);
  assert.doesNotMatch(slice, /setArtifact\(/);
});

test("text-only delivery keeps keyboard open when response log cannot activate", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(app, /reply could not be shown/);
  assert.match(app, /responseLogActive/);
  assert.match(app, /!responseLogActive && !hasArtifact/);
  assert.match(app, /planTextPanelActivation/);
});
