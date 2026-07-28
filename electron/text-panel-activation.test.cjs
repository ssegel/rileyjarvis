"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  planTextPanelActivation,
  guardArtifactPanelNarration,
  RUNNING_RESPONSE_LOG_TITLE,
} = require("./text-panel-activation.cjs");
const { buildTurnArtifactDelivery } = require("./artifact-selection.cjs");
const { createTextSessionController } = require("./text-session.cjs");
const { BRIEFING_SECTION_HEADINGS, buildBriefingArtifact, composeDayBriefing } = require("./day-briefing.cjs");

const root = path.join(__dirname, "..");

const modeArtifact = {
  title: "Jarvis Mode",
  kind: "progress",
  content: "Mode switched to display mode.",
};

function briefingArtifactFor(date = "2026-07-28") {
  const composed = composeDayBriefing({
    date,
    summary: "Ship Phase 16",
    priorities: [{ text: "finish website homepage", status: "open" }],
    commitments: [],
    followUps: [],
    unresolved: [],
    activeProjects: [{ name: "Jarvis", note: "" }],
  });
  return buildBriefingArtifact(date, "today", composed);
}

/**
 * Mirrors App sendTextPrompt panel handling after TextClient.submit returns.
 */
function simulateAppPanelAfterSubmit(args) {
  let artifact = args.currentArtifact || null;
  let artifactVisible = Boolean(artifact);
  const deliveredArtifacts = [];

  // TextClient delivers selected artifacts via onArtifact before returning.
  for (const item of args.result?.artifacts || []) {
    deliveredArtifacts.push(item);
    artifact = item;
    artifactVisible = true;
  }

  const assistantText = String(args.result?.assistantText || "").trim();
  const appended = Boolean(args.result?.ok && assistantText);
  const panelPlan = planTextPanelActivation({
    result: args.result,
    currentArtifact: artifact,
    appended,
  });

  let responseLogActive = artifact?.title === RUNNING_RESPONSE_LOG_TITLE;
  if (panelPlan.activateResponseLog) {
    artifact = {
      title: RUNNING_RESPONSE_LOG_TITLE,
      kind: "text",
      content: `Jarvis\n${assistantText}`,
    };
    artifactVisible = true;
    responseLogActive = true;
  } else if (panelPlan.selectedArtifact && panelPlan.selectedArtifact.title !== RUNNING_RESPONSE_LOG_TITLE) {
    artifact = panelPlan.selectedArtifact;
    artifactVisible = true;
    responseLogActive = false;
  }

  return {
    artifact,
    artifactVisible,
    panelTitle: artifact?.title || "Ready",
    responseLogActive,
    panelPlan,
    deliveredArtifacts,
  };
}

test("live path: briefing + set_mode keeps Day briefing and never opens Running Response Log", async () => {
  const briefing = briefingArtifactFor();
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
              id: "resp_live_brief",
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
            id: "resp_live_brief_2",
            output_text:
              "Today’s open priorities: finish website homepage. Full details are in the artifact panel.",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Today’s open priorities: finish website homepage. Full details are in the artifact panel.",
                  },
                ],
              },
            ],
            usage: { input_tokens: 24, output_tokens: 12 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({
    clientTurnId: "turn-live-brief-panel",
    text: "Brief me on today.",
    history: [],
  });

  assert.equal(result.ok, true);
  assert.ok(result.toolNames.includes("memory_day_briefing"));
  assert.ok(result.toolNames.includes("set_mode"));
  assert.ok(result.artifactCount > 0);
  assert.equal(result.hasSubstantiveArtifact, true);
  assert.equal(result.selectedArtifact.title, "Day briefing — 2026-07-28");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].title, "Day briefing — 2026-07-28");
  for (const heading of BRIEFING_SECTION_HEADINGS) {
    assert.match(result.artifacts[0].content, new RegExp(`## ${heading}\\n`));
  }

  const appOutcome = simulateAppPanelAfterSubmit({ result, currentArtifact: null });
  assert.equal(appOutcome.panelTitle, "Day briefing — 2026-07-28");
  assert.equal(appOutcome.responseLogActive, false);
  assert.equal(appOutcome.panelPlan.activateResponseLog, false);
  assert.equal(appOutcome.panelPlan.hasSubstantiveArtifact, true);
  assert.equal(appOutcome.artifactVisible, true);
  assert.notEqual(appOutcome.panelTitle, RUNNING_RESPONSE_LOG_TITLE);
  assert.notEqual(appOutcome.panelTitle, "Jarvis Mode");
});

test("live path regression: incomplete artifacts array still preserves onArtifact briefing", () => {
  const briefing = briefingArtifactFor();
  // Reproduce the diagnosed App failure shape: tool succeeded and briefing was delivered
  // via onArtifact, but App formerly keyed only on result.artifacts.length.
  const result = {
    ok: true,
    clientTurnId: "turn-incomplete-meta",
    assistantText:
      "Today’s open priorities: finish website homepage. Full details are in the artifact panel.",
    artifacts: [],
    toolNames: ["memory_day_briefing", "set_mode"],
    artifactCount: 0,
    selectedArtifact: null,
    hasSubstantiveArtifact: true,
    toolTrace: [
      { name: "memory_day_briefing", ok: true },
      { name: "set_mode", ok: true },
    ],
  };

  const panelPlan = planTextPanelActivation({
    result,
    currentArtifact: briefing,
    appended: true,
  });
  assert.equal(panelPlan.activateResponseLog, false);
  assert.equal(panelPlan.hasSubstantiveArtifact, true);
  assert.equal(panelPlan.selectedArtifact.title, "Day briefing — 2026-07-28");
  assert.ok(panelPlan.toolNames.includes("memory_day_briefing"));

  const appOutcome = simulateAppPanelAfterSubmit({
    result: { ...result, artifacts: [] },
    currentArtifact: briefing,
  });
  // simulateAppPanelAfterSubmit starts from currentArtifact when artifacts empty
  assert.equal(appOutcome.panelTitle, "Day briefing — 2026-07-28");
  assert.equal(appOutcome.responseLogActive, false);
});

test("text-only turn still activates Running Response Log", () => {
  const plan = planTextPanelActivation({
    result: {
      ok: true,
      assistantText: "Hello Sarah.",
      artifacts: [],
      toolNames: [],
      artifactCount: 0,
      selectedArtifact: null,
      hasSubstantiveArtifact: false,
      toolTrace: [],
    },
    currentArtifact: null,
    appended: true,
  });
  assert.equal(plan.activateResponseLog, true);
  assert.equal(plan.panelMode, "responseLog");
  assert.equal(plan.hasSubstantiveArtifact, false);
});

test("mode-only turn retains Jarvis Mode and does not open Running Response Log", () => {
  const delivery = buildTurnArtifactDelivery([modeArtifact], [{ name: "set_mode", ok: true }]);
  const result = {
    ok: true,
    assistantText: "Switched to display mode.",
    ...delivery,
    toolTrace: [{ name: "set_mode", ok: true }],
  };
  const plan = planTextPanelActivation({
    result,
    currentArtifact: modeArtifact,
    appended: true,
  });
  assert.equal(plan.activateResponseLog, false);
  assert.equal(plan.panelMode, "mode");
  assert.equal(plan.selectedArtifact.title, "Jarvis Mode");
  assert.equal(plan.hasSubstantiveArtifact, false);
  assert.equal(plan.hasToolArtifact, true);
});

test("guard strips unsupported artifact-panel narration without substantive artifact", () => {
  const raw =
    "Today’s open priorities: finish website homepage, call Cecilia. Full details are in the artifact panel.";
  const guarded = guardArtifactPanelNarration(raw, false);
  assert.match(guarded, /finish website homepage/);
  assert.doesNotMatch(guarded, /artifact panel/i);

  const kept = guardArtifactPanelNarration(raw, true);
  assert.match(kept, /artifact panel/i);
});

test("App source uses planTextPanelActivation instead of raw artifacts.length", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(app, /planTextPanelActivation/);
  assert.match(app, /panelPlan\.activateResponseLog/);
  assert.doesNotMatch(app, /appended && !hasArtifact/);
  assert.match(
    fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8"),
    /Never say that full details are in the artifact panel/,
  );
});
