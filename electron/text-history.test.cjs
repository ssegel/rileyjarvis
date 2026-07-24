const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const {
  buildInitialInput,
  normalizeTextHistory,
  shouldExcludeHistoryText,
  createTextSessionController,
} = require("./text-session.cjs");

/**
 * Mirrors src/lib/textHistory.ts buildTextHistoryFromTranscript for Node tests.
 * Keep in sync with the TypeScript helper.
 */
function buildTextHistoryFromTranscript(transcript, currentPrompt, limit = 12) {
  const current = String(currentPrompt || "").trim();
  const chronological = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry.role === "user" || entry.role === "ricky" || entry.role === "assistant")
    .filter((entry) => !shouldExcludeHistoryText(entry.text))
    .map((entry) => ({
      role: entry.role === "ricky" || entry.role === "assistant" ? "assistant" : "user",
      text: String(entry.text || "").trim(),
    }))
    .filter((entry) => entry.text)
    .reverse();

  const deduped = [];
  for (const entry of chronological) {
    const prev = deduped[deduped.length - 1];
    if (entry.role === "user" && prev && prev.role === "user" && prev.text === entry.text) continue;
    deduped.push(entry);
  }
  while (
    deduped.length > 0 &&
    deduped[deduped.length - 1].role === "user" &&
    deduped[deduped.length - 1].text === current
  ) {
    deduped.pop();
  }
  return deduped.slice(-limit);
}

function userTexts(items) {
  return items
    .filter((item) => item.role === "user")
    .map((item) => item.content?.[0]?.text || "");
}

test("history is built before current prompt is appended to the request", () => {
  const items = buildInitialInput("What is my first priority?", [
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello Sarah." },
  ]);
  const texts = userTexts(items);
  assert.deepEqual(texts, ["hi", "What is my first priority?"]);
  assert.equal(items[items.length - 1].content[0].text, "What is my first priority?");
});

test("current prompt appears exactly once in Responses input", () => {
  const prompt = "What is my first priority?";
  const items = buildInitialInput(prompt, [
    { role: "user", text: "earlier" },
    { role: "assistant", text: "ok" },
    { role: "user", text: prompt },
  ]);
  const texts = userTexts(items);
  assert.equal(texts.filter((t) => t === prompt).length, 1);
  assert.equal(texts[texts.length - 1], prompt);
});

test("history normalization removes consecutive duplicate user messages", () => {
  const normalized = normalizeTextHistory(
    [
      { role: "user", text: "hello" },
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi." },
      { role: "user", text: "next" },
    ],
    "fresh prompt",
  );
  assert.deepEqual(
    normalized.map((e) => `${e.role}:${e.text}`),
    ["user:hello", "assistant:Hi.", "user:next"],
  );
});

test("history excludes tool system diagnostic status confirmation artifact error and empty entries", () => {
  const normalized = normalizeTextHistory(
    [
      { role: "user", text: "real question" },
      { role: "tool", text: "tool payload" },
      { role: "system", text: "Mode switched to display." },
      { role: "ricky", text: "Listening" },
      { role: "ricky", text: "Waiting for Jarvis…" },
      { role: "ricky", text: "Confirmation required before continuing." },
      { role: "ricky", text: "Jarvis menu is open in the artifacts panel." },
      { role: "ricky", text: "Something went wrong connecting Jarvis." },
      { role: "user", text: "   " },
      { role: "ricky", text: "Your first priority is branding." },
      { role: "user", text: "Append to memory: note" },
    ],
    "What is my first priority?",
  );
  assert.deepEqual(
    normalized.map((e) => `${e.role}:${e.text}`),
    ["user:real question", "assistant:Your first priority is branding."],
  );
});

test("history normalization preserves chronological ordering", () => {
  const newestFirst = [
    { role: "user", text: "third" },
    { role: "ricky", text: "second reply" },
    { role: "user", text: "first" },
  ];
  const history = buildTextHistoryFromTranscript(newestFirst, "current");
  assert.deepEqual(
    history.map((e) => e.text),
    ["first", "second reply", "third"],
  );
});

test("App builds history before TextClient submit appends the current user turn", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const textClient = fs.readFileSync(path.join(root, "src", "lib", "textClient.ts"), "utf8");
  assert.match(app, /buildTextHistoryFromTranscript\(transcriptRef\.current,\s*trimmed\)/);
  assert.match(app, /const history = buildTextHistoryFromTranscript/);
  const historyIdx = app.indexOf("buildTextHistoryFromTranscript(transcriptRef.current, trimmed)");
  const submitIdx = app.indexOf("textClientRef.current?.submit(trimmed, history)");
  assert.ok(historyIdx >= 0 && submitIdx > historyIdx);
  assert.match(textClient, /this\.callbacks\.onUserText\(trimmed\)/);
});

test("successful assistant text is delivered before completed/idle state", () => {
  const textClient = fs.readFileSync(path.join(root, "src", "lib", "textClient.ts"), "utf8");
  const assistantIdx = textClient.indexOf("this.callbacks.onAssistantText(plan.assistantText, clientTurnId)");
  const completedIdx = textClient.indexOf('this.setState("completed")');
  assert.ok(assistantIdx >= 0 && completedIdx > assistantIdx);
});

test("ok true with no assistant text and no artifact becomes a readable text error", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return {
          id: "resp_empty",
          output: [{ type: "message", role: "assistant", content: [] }],
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      },
    }),
  });
  const result = await controller.runTextTurn({ clientTurnId: "turn-empty", text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "error");
  assert.equal(result.error.code, "api.bad_response");
  assert.match(result.error.message, /no visible response/i);

  const textClient = fs.readFileSync(path.join(root, "src", "lib", "textClient.ts"), "utf8");
  assert.match(textClient, /Jarvis returned no visible response/);
  assert.match(textClient, /empty_error|planTextResultDelivery/);
});

test("App clears and closes the input only after visible assistant text or artifact", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(app, /const delivered =/);
  assert.match(app, /appendAssistantToLog\(assistantText/);
  assert.match(app, /hasArtifact/);
  assert.match(app, /if \(delivered\) \{/);
  assert.match(app, /setTextPrompt\(""\)/);
  assert.match(app, /setShowTypeInput\(false\)/);
  assert.doesNotMatch(app, /outcome !== "rejected"/);
});

test("priority question history drops confirmation and menu artifact dialogue", () => {
  const newestFirst = [
    { role: "ricky", text: "Confirmation required before continuing." },
    { role: "ricky", text: "Jarvis menu is open in the artifacts panel." },
    { role: "user", text: "show menu" },
    { role: "ricky", text: "Your branding work is first." },
    { role: "user", text: "What should I focus on?" },
  ];
  const prompt = "What is my first priority?";
  const history = buildTextHistoryFromTranscript(newestFirst, prompt);
  const items = buildInitialInput(prompt, history);
  const serialized = JSON.stringify(items);
  assert.match(serialized, /What is my first priority\?/);
  assert.match(serialized, /Your branding work is first/);
  assert.match(serialized, /What should I focus on/);
  assert.doesNotMatch(serialized, /Confirmation required/);
  assert.doesNotMatch(serialized, /artifacts panel/);
  assert.equal(userTexts(items).filter((t) => t === prompt).length, 1);
});
