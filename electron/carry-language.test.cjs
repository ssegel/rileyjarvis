"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore } = require("./memory.cjs");
const { createTextSessionController } = require("./text-session.cjs");
const { buildSessionInstructions } = require("./session-instructions.cjs");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function jarvisInstructionsFromMain() {
  const main = read("electron/main.cjs");
  const marker = "const JARVIS_INSTRUCTIONS = `";
  const start = main.indexOf(marker);
  assert.ok(start >= 0);
  const contentStart = start + marker.length;
  const end = main.indexOf("`;", contentStart);
  assert.ok(end > contentStart);
  return main.slice(contentStart, end);
}

function memoryPrioritiesSchemaBlock() {
  const main = read("electron/main.cjs");
  const start = main.indexOf('name: "memory_priorities"');
  const end = main.indexOf('name: "memory_set_preference"');
  assert.ok(start >= 0 && end > start);
  return main.slice(start, end);
}

/**
 * Instruction-compliant carry args for the documented NL examples.
 * Used by the mocked text-session model in these tests only.
 */
function carryArgsFromUserText(userText) {
  const lower = String(userText || "").toLowerCase();
  const explicitMove =
    /\bmove\b/.test(lower) ||
    /\btransfer\b/.test(lower) ||
    (/remove from today/.test(lower) && /tomorrow/.test(lower));
  return {
    operation: "carry",
    reference: { by: "text", value: "Call Cecilia" },
    targetDate: "tomorrow",
    move: explicitMove,
  };
}

async function withSeededStore(run) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-carry-lang-"));
  const store = createMemoryStore({
    rootDir,
    now: () => new Date("2026-07-22T15:00:00.000Z"),
    randomUUID: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  });
  try {
    await store.ensureMemory();
    const items = [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
      { text: "Review scanner options", status: "open" },
    ];
    const preview = await store.memoryPriorities({ operation: "replace", items });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    await store.memoryPriorities({
      operation: "replace",
      items,
      confirmed: true,
      previewToken: preview.previewToken,
    });
    return await run(store);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

function createCarryLoopController(store, userText, options = {}) {
  const fetches = [];
  let capturedArgs = null;
  let lastToolResult = null;
  let call = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => jarvisInstructionsFromMain(),
    getToolSpecs: () => [
      {
        type: "function",
        name: "memory_priorities",
        description: memoryPrioritiesSchemaBlock(),
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    ],
    executeTool: async (toolCall) => {
      assert.equal(toolCall.name, "memory_priorities");
      capturedArgs = toolCall.arguments;
      lastToolResult = await store.memoryPriorities(toolCall.arguments);
      return lastToolResult;
    },
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) =>
      new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    timeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      fetches.push(body);
      call += 1;
      if (call === 1) {
        const args = carryArgsFromUserText(userText);
        if (typeof options.assertFirstRequest === "function") {
          options.assertFirstRequest(body);
        }
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              id: "resp_carry_1",
              output: [
                {
                  type: "function_call",
                  name: "memory_priorities",
                  call_id: "call_carry_1",
                  arguments: JSON.stringify(args),
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
            id: "resp_carry_2",
            output_text: "Please confirm.",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Please confirm." }],
              },
            ],
            usage: { input_tokens: 22, output_tokens: 6 },
          };
        },
      };
    },
  });
  return {
    controller,
    getCapturedArgs: () => capturedArgs,
    getLastToolResult: () => lastToolResult,
    getFetches: () => fetches,
  };
}

test("instructions and schema contain exact carry copy and move examples", () => {
  const instructions = jarvisInstructionsFromMain();
  const schema = memoryPrioritiesSchemaBlock();

  assert.match(instructions, /"carry", "carry forward", "carry into tomorrow", or "copy" means COPY/);
  assert.match(instructions, /Never send move:true when Sarah only says carry/);
  assert.match(
    instructions,
    /Example COPY — User: "Carry Call Cecilia into tomorrow\." → \{"operation":"carry","reference":\{"by":"text","value":"Call Cecilia"\},"targetDate":"tomorrow","move":false\}/,
  );
  assert.match(
    instructions,
    /Example MOVE — User: "Move Call Cecilia to tomorrow\." → \{"operation":"carry","reference":\{"by":"text","value":"Call Cecilia"\},"targetDate":"tomorrow","move":true\}/,
  );
  // No rule that tells the model to use move:true for ordinary carry wording.
  assert.doesNotMatch(instructions, /says carry[^\n]*move:true/i);
  assert.doesNotMatch(instructions, /for carry[^\n]*set move:true/i);

  assert.match(schema, /Carry Call Cecilia into tomorrow/);
  assert.match(schema, /\\"move\\":false/);
  assert.match(schema, /Move Call Cecilia to tomorrow/);
  assert.match(schema, /\\"move\\":true/);
  assert.match(
    schema,
    /Omitted or false: copy to the target date and preserve today\. true: remove from today and add to the target date\. Never set true for ordinary carry wording\./,
  );
  assert.match(schema, /never move:true for carry-only wording/);
});

test("text and Realtime share the same carry instruction and schema source", async () => {
  const main = read("electron/main.cjs");
  assert.match(main, /buildInstructions:\s*buildSharedSessionInstructions/);
  assert.match(main, /const instructions = await buildSharedSessionInstructions\(\)/);
  assert.match(main, /tools:\s*toolSpecs/);
  assert.match(main, /getToolSpecs:\s*\(\) => toolSpecs/);

  const built = await buildSessionInstructions({
    jarvisInstructions: jarvisInstructionsFromMain(),
    memoryStore: {
      async buildPersonalContextForSession() {
        return { text: "ctx" };
      },
    },
    async readDb() {
      return {};
    },
    buildThumbnailBoardInstructions() {
      return "thumb";
    },
  });
  assert.match(built, /means COPY/);
  assert.match(built, /Carry Call Cecilia into tomorrow/);
  assert.match(built, /"move":false/);
});

test("text-session: Carry Call Cecilia into tomorrow yields copy preview", async () => {
  await withSeededStore(async (store) => {
    const userText = "Carry Call Cecilia into tomorrow.";
    assert.equal(carryArgsFromUserText(userText).move, false);

    const loop = createCarryLoopController(store, userText, {
      assertFirstRequest(body) {
        assert.match(body.instructions, /means COPY/);
        assert.match(body.instructions, /"move":false/);
      },
    });
    const result = await loop.controller.runTextTurn({
      clientTurnId: "turn-carry-copy",
      text: userText,
      history: [],
    });
    assert.equal(result.ok, true);

    const args = loop.getCapturedArgs();
    assert.equal(args.operation, "carry");
    assert.equal(args.move, false);
    assert.equal(args.targetDate, "tomorrow");

    const toolResult = loop.getLastToolResult();
    assert.equal(toolResult.code, "CONFIRMATION_REQUIRED");
    assert.equal(toolResult.mode, "copy");
    assert.equal(toolResult.move, false);
    assert.equal(toolResult.artifact.title, "Carry preview (copy)");
    assert.equal(toolResult.todayAfter.some((item) => item.text === "Call Cecilia"), true);
    assert.equal(toolResult.tomorrowAfter.some((item) => item.text === "Call Cecilia"), true);
    assert.equal(result.artifacts[0].title, "Carry preview (copy)");
    assert.match(result.artifacts[0].content, /Carry preview \(copy\)/);
  });
});

test("text-session: Move Call Cecilia to tomorrow yields move preview", async () => {
  await withSeededStore(async (store) => {
    const userText = "Move Call Cecilia to tomorrow.";
    assert.equal(carryArgsFromUserText(userText).move, true);

    const loop = createCarryLoopController(store, userText);
    const result = await loop.controller.runTextTurn({
      clientTurnId: "turn-carry-move",
      text: userText,
      history: [],
    });
    assert.equal(result.ok, true);

    const args = loop.getCapturedArgs();
    assert.equal(args.operation, "carry");
    assert.equal(args.move, true);

    const toolResult = loop.getLastToolResult();
    assert.equal(toolResult.mode, "move");
    assert.equal(toolResult.move, true);
    assert.equal(toolResult.artifact.title, "Carry preview (move)");
    assert.equal(toolResult.todayAfter.some((item) => item.text === "Call Cecilia"), false);
    assert.equal(toolResult.tomorrowAfter.some((item) => item.text === "Call Cecilia"), true);
    assert.equal(result.artifacts[0].title, "Carry preview (move)");
  });
});
