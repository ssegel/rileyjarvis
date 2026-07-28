"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isModeSwitchArtifact,
  selectTurnArtifacts,
  pickWinningTurnArtifact,
  buildTurnArtifactDelivery,
} = require("./artifact-selection.cjs");
const { createTextSessionController } = require("./text-session.cjs");
const { BRIEFING_SECTION_HEADINGS, buildBriefingArtifact, composeDayBriefing } = require("./day-briefing.cjs");

const modeArtifact = {
  title: "Jarvis Mode",
  kind: "progress",
  content: "Mode switched to display mode.",
};

function briefingArtifactFor(date = "2026-07-28") {
  const composed = composeDayBriefing({
    date,
    summary: "Ship Phase 16",
    priorities: [{ text: "First priority", status: "open" }],
    commitments: [],
    followUps: [],
    unresolved: [],
    activeProjects: [{ name: "Jarvis", note: "" }],
  });
  return buildBriefingArtifact(date, "today", composed);
}

test("mode-switch artifact detection", () => {
  assert.equal(isModeSwitchArtifact(modeArtifact), true);
  assert.equal(
    isModeSwitchArtifact({
      title: "Other",
      kind: "progress",
      content: "Mode switched to computer use mode.",
    }),
    true,
  );
  assert.equal(isModeSwitchArtifact(briefingArtifactFor()), false);
  assert.equal(
    isModeSwitchArtifact({ title: "Active Projects", kind: "markdown", content: "# Active Projects" }),
    false,
  );
});

test("selectTurnArtifacts keeps substantive and drops trailing mode artifact", () => {
  const briefing = briefingArtifactFor();
  const selected = selectTurnArtifacts([briefing, modeArtifact]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].title, "Day briefing — 2026-07-28");
  assert.equal(pickWinningTurnArtifact([briefing, modeArtifact]).title, "Day briefing — 2026-07-28");
});

test("selectTurnArtifacts keeps mode artifact when it is the only artifact", () => {
  const selected = selectTurnArtifacts([modeArtifact]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].title, "Jarvis Mode");
  assert.equal(pickWinningTurnArtifact([modeArtifact]).title, "Jarvis Mode");
});

test("selectTurnArtifacts preserves order of multiple substantive artifacts", () => {
  const first = { title: "Commitments", kind: "markdown", content: "# C" };
  const second = briefingArtifactFor();
  const selected = selectTurnArtifacts([modeArtifact, first, second, modeArtifact]);
  assert.deepEqual(
    selected.map((item) => item.title),
    ["Commitments", "Day briefing — 2026-07-28"],
  );
  assert.equal(pickWinningTurnArtifact([modeArtifact, first, second, modeArtifact]).title, "Day briefing — 2026-07-28");
});

test("buildTurnArtifactDelivery exposes toolNames, artifactCount, selectedArtifact, hasSubstantiveArtifact", () => {
  const briefing = briefingArtifactFor();
  const delivery = buildTurnArtifactDelivery([briefing, modeArtifact], [
    { name: "memory_day_briefing", ok: true },
    { name: "set_mode", ok: true },
  ]);
  assert.deepEqual(delivery.toolNames, ["memory_day_briefing", "set_mode"]);
  assert.equal(delivery.artifactCount, 1);
  assert.equal(delivery.hasSubstantiveArtifact, true);
  assert.equal(delivery.selectedArtifact.title, "Day briefing — 2026-07-28");
  assert.equal(delivery.artifacts.length, 1);
});

test("text turn: memory_day_briefing then set_mode keeps Day briefing artifact", async () => {
  const briefing = briefingArtifactFor();
  const toolTraceNames = [];
  const fetches = [];
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "Use memory_day_briefing for briefings.",
    getToolSpecs: () => [
      {
        type: "function",
        name: "memory_day_briefing",
        description: "Day briefing",
        parameters: { type: "object", properties: { operation: { type: "string" } } },
      },
      {
        type: "function",
        name: "set_mode",
        description: "Switch mode",
        parameters: { type: "object", properties: { mode: { type: "string" } } },
      },
    ],
    executeTool: async (toolCall) => {
      toolTraceNames.push(toolCall.name);
      if (toolCall.name === "memory_day_briefing") {
        return {
          ok: true,
          operation: "brief",
          message: "Day briefing for today (2026-07-28).",
          artifact: briefing,
        };
      }
      if (toolCall.name === "set_mode") {
        return { ok: true, mode: "display", artifact: modeArtifact };
      }
      return { ok: false, error: `unexpected tool ${toolCall.name}` };
    },
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => {
      const err = new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`);
      return err;
    },
    timeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      fetches.push(JSON.parse(init.body));
      if (fetches.length === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              id: "resp_brief_mode",
              output: [
                {
                  type: "function_call",
                  name: "memory_day_briefing",
                  call_id: "call_brief",
                  arguments: JSON.stringify({ operation: "brief" }),
                },
                {
                  type: "function_call",
                  name: "set_mode",
                  call_id: "call_mode",
                  arguments: JSON.stringify({ mode: "display" }),
                },
              ],
              usage: { input_tokens: 20, output_tokens: 8 },
            };
          },
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return {
            id: "resp_brief_mode_2",
            output_text: "Day briefing for today (2026-07-28).",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Day briefing for today (2026-07-28)." }],
              },
            ],
            usage: { input_tokens: 24, output_tokens: 12 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({
    clientTurnId: "turn-brief-mode",
    text: "Brief me on today.",
    history: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(toolTraceNames, ["memory_day_briefing", "set_mode"]);
  assert.ok(result.toolTrace.some((item) => item.name === "memory_day_briefing"));
  assert.ok(result.toolNames.includes("memory_day_briefing"));
  assert.ok(result.artifactCount > 0);
  assert.equal(result.hasSubstantiveArtifact, true);
  assert.equal(result.selectedArtifact.title, "Day briefing — 2026-07-28");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].title, "Day briefing — 2026-07-28");
  for (const heading of BRIEFING_SECTION_HEADINGS) {
    assert.match(result.artifacts[0].content, new RegExp(`## ${heading}\\n`));
  }
  assert.doesNotMatch(JSON.stringify(result.artifacts), /Jarvis Mode/);
});

test("text turn: mode-only set_mode still returns Jarvis Mode artifact", async () => {
  const fetches = [];
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [
      {
        type: "function",
        name: "set_mode",
        description: "Switch mode",
        parameters: { type: "object", properties: { mode: { type: "string" } } },
      },
    ],
    executeTool: async (toolCall) => {
      assert.equal(toolCall.name, "set_mode");
      return { ok: true, mode: "display", artifact: modeArtifact };
    },
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => {
      const err = new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`);
      return err;
    },
    timeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      fetches.push(JSON.parse(init.body));
      if (fetches.length === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              id: "resp_mode_only",
              output: [
                {
                  type: "function_call",
                  name: "set_mode",
                  call_id: "call_mode_only",
                  arguments: JSON.stringify({ mode: "display" }),
                },
              ],
              usage: { input_tokens: 10, output_tokens: 2 },
            };
          },
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return {
            id: "resp_mode_only_2",
            output_text: "Switched to display mode.",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Switched to display mode." }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 4 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({
    clientTurnId: "turn-mode-only",
    text: "Switch to display mode.",
    history: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].title, "Jarvis Mode");
  assert.equal(result.hasSubstantiveArtifact, false);
  assert.equal(result.selectedArtifact.title, "Jarvis Mode");
  assert.equal(result.artifactCount, 1);
  assert.deepEqual(result.toolNames, ["set_mode"]);
});
