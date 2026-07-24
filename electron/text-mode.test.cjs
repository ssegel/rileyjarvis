"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const {
  createTextSessionController,
  buildInitialInput,
  mapToolsForResponses,
  MAX_TOOL_LOOP_ITERATIONS,
  DEFAULT_TEXT_MODEL,
} = require("./text-session.cjs");
const { buildSessionInstructions } = require("./session-instructions.cjs");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("typed submission path uses independent text IPC while disconnected", () => {
  const app = read("src/App.tsx");
  assert.match(app, /runTextTurn|textClientRef\.current\?\.submit/);
  assert.doesNotMatch(app, /Connect voice first\./);
  assert.doesNotMatch(app, /clientRef\.current\?\.sendText/);
  assert.match(app, /tryAcquireText/);
  assert.match(app, /sessionOwnerRef/);
});

test("typed submission does not call Realtime voice plumbing", () => {
  const app = read("src/App.tsx");
  const textClient = read("src/lib/textClient.ts");
  const textSession = read("electron/text-session.cjs");
  const main = read("electron/main.cjs");

  assert.doesNotMatch(app, /getUserMedia/);
  assert.doesNotMatch(textClient, /getUserMedia/);
  assert.doesNotMatch(textClient, /RTCPeerConnection/);
  assert.doesNotMatch(textClient, /createRealtimeToken/);
  assert.doesNotMatch(textClient, /sendText/);
  assert.doesNotMatch(textSession, /realtime\/client_secrets/);
  assert.doesNotMatch(textSession, /RTCPeerConnection/);
  assert.match(main, /ipcMain\.handle\("text:run"/);
  assert.match(main, /ipcMain\.handle\("text:cancel"/);
  assert.match(textSession, /api\.openai\.com\/v1\/responses/);
});

test("connected typed submission still uses independent text IPC", () => {
  const app = read("src/App.tsx");
  assert.match(app, /textClientRef\.current\?\.submit/);
  assert.doesNotMatch(app, /\.sendText\(/);
});

test("shared instructions builder supplies Jarvis + personal memory for text and realtime", async () => {
  let memoryCalls = 0;
  const instructions = await buildSessionInstructions({
    jarvisInstructions: "You are Jarvis for Sarah.",
    memoryStore: {
      async buildPersonalContextForSession() {
        memoryCalls += 1;
        return { text: "Personal context block for Sarah." };
      },
    },
    async readDb() {
      return { thumbnailBoard: null };
    },
    buildThumbnailBoardInstructions() {
      return "Thumbnail board instructions.";
    },
  });
  assert.equal(memoryCalls, 1);
  assert.match(instructions, /You are Jarvis for Sarah/);
  assert.match(instructions, /Personal context block for Sarah/);
  assert.match(instructions, /Thumbnail board instructions/);

  const main = read("electron/main.cjs");
  assert.match(main, /buildSharedSessionInstructions/);
  assert.match(main, /buildInstructions:\s*buildSharedSessionInstructions/);
});

test("read-only tool can return an artifact through text mode", async () => {
  const fetches = [];
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "Jarvis instructions with memory.",
    getToolSpecs: () => [
      {
        type: "function",
        name: "show_menu",
        description: "Show menu",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeTool: async (toolCall) => {
      assert.equal(toolCall.name, "show_menu");
      return {
        ok: true,
        artifact: { title: "Jarvis Menu", kind: "markdown", content: "# Menu" },
      };
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
              id: "resp_1",
              output: [
                {
                  type: "function_call",
                  name: "show_menu",
                  call_id: "call_1",
                  arguments: "{}",
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
            id: "resp_2",
            output_text: "Here is the menu.",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Here is the menu." }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 4 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({
    clientTurnId: "turn-artifact",
    text: "show the menu",
    history: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].title, "Jarvis Menu");
  assert.equal(result.assistantText, "Here is the menu.");
  assert.equal(result.toolTrace[0].name, "show_menu");
  assert.match(fetches[0].instructions, /Jarvis instructions with memory/);
  assert.equal(fetches[0].model, "gpt-4.1");
  assert.equal(fetches[0].store, false);
  // Official accumulation: second request includes prior output + function_call_output.
  assert.ok(Array.isArray(fetches[1].input));
  assert.ok(fetches[1].input.some((item) => item.type === "function_call"));
  assert.ok(fetches[1].input.some((item) => item.type === "function_call_output"));
  assert.equal(fetches[1].previous_response_id, undefined);
});

test("confirmation-required tools retain requiresConfirmation in tool trace", async () => {
  let call = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [
      {
        type: "function",
        name: "memory_clear",
        description: "Clear",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeTool: async () => ({
      ok: false,
      requiresConfirmation: true,
      error: "Confirmation required.",
    }),
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              id: "resp_c1",
              output: [
                {
                  type: "function_call",
                  name: "memory_clear",
                  call_id: "call_c",
                  arguments: "{}",
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return {
            id: "resp_c2",
            output_text: "I need confirmation.",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({ clientTurnId: "turn-confirm", text: "clear memory" });
  assert.equal(result.ok, true);
  assert.equal(result.toolTrace[0].requiresConfirmation, true);
});

test("tool loops are bounded", async () => {
  let loops = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [{ type: "function", name: "noop", description: "n", parameters: {} }],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    maxToolLoops: 3,
    fetchImpl: async () => {
      loops += 1;
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return {
            id: `resp_${loops}`,
            output: [
              {
                type: "function_call",
                name: "noop",
                call_id: `call_${loops}`,
                arguments: "{}",
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    },
  });

  const result = await controller.runTextTurn({ clientTurnId: "turn-loop", text: "loop" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /tool-loop limit/i);
  assert.equal(loops, 3);
  assert.ok(MAX_TOOL_LOOP_ITERATIONS >= 3);
});

test("cancellation aborts the request and releases the active-turn lock", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });

  const pending = controller.runTextTurn({ clientTurnId: "turn-cancel", text: "hello" });
  await new Promise((r) => setTimeout(r, 20));
  const cancel = controller.cancelTextTurn("turn-cancel");
  assert.equal(cancel.ok, true);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.outcome, "cancelled");
  assert.equal(controller.getActiveTurnCount(), 0);
});

test("timeout produces readable sanitized error and releases the lock", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    timeoutMs: 40,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });

  const result = await controller.runTextTurn({ clientTurnId: "turn-timeout", text: "slow" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "error");
  assert.match(result.error.message, /timed out/i);
  assert.doesNotMatch(result.error.message, /sk-/);
  assert.equal(controller.getActiveTurnCount(), 0);
});

test("concurrent text submissions are rejected without duplicate responses", async () => {
  let resolveFirst;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    fetchImpl: () =>
      new Promise((resolve) => {
        resolveFirst = () =>
          resolve({
            ok: true,
            headers: { get: () => null },
            async json() {
              return {
                id: "resp_ok",
                output_text: "one",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            },
          });
      }),
  });

  const first = controller.runTextTurn({ clientTurnId: "a", text: "one" });
  await new Promise((r) => setTimeout(r, 10));
  const second = await controller.runTextTurn({ clientTurnId: "b", text: "two" });
  assert.equal(second.ok, false);
  assert.equal(second.outcome, "rejected");
  assert.match(second.error.message, /busy/i);
  resolveFirst();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.assistantText, "one");
});

test("text-versus-voice ownership prevents overlapping model work", () => {
  // Mirror src/lib/sessionOwner.ts for Node without ts compile.
  class SessionOwnerLock {
    constructor() {
      this.owner = "idle";
      this.voiceBusy = false;
    }
    getOwner() {
      return this.owner;
    }
    isVoiceBusy() {
      return this.voiceBusy;
    }
    setVoiceBusy(busy) {
      this.voiceBusy = busy;
      if (busy && this.owner === "idle") this.owner = "voice";
      if (!busy && this.owner === "voice") this.owner = "idle";
    }
    tryAcquireText() {
      if (this.owner === "voice" || this.voiceBusy) {
        return { ok: false, message: "Jarvis is busy with a voice response." };
      }
      if (this.owner === "text") {
        return { ok: false, message: "Jarvis is busy with another text turn." };
      }
      this.owner = "text";
      return { ok: true };
    }
    releaseText() {
      if (this.owner === "text") this.owner = this.voiceBusy ? "voice" : "idle";
    }
    canStartVoiceResponse() {
      return this.owner !== "text";
    }
  }

  const lock = new SessionOwnerLock();
  assert.equal(lock.tryAcquireText().ok, true);
  assert.equal(lock.canStartVoiceResponse(), false);
  assert.equal(lock.tryAcquireText().ok, false);
  lock.releaseText();
  lock.setVoiceBusy(true);
  assert.equal(lock.tryAcquireText().ok, false);
  assert.match(lock.tryAcquireText().message, /voice response/);
  lock.setVoiceBusy(false);
  assert.equal(lock.tryAcquireText().ok, true);

  const realtime = read("src/lib/realtime.ts");
  assert.match(realtime, /sessionOwner/);
  assert.match(realtime, /canStartVoiceResponse/);
  assert.match(realtime, /skip voice tools; text turn owns session|text turn owns session/);
});

test("text diagnostics contain mode, turn id, duration, outcome, and sanitized usage", () => {
  const textClient = read("src/lib/textClient.ts");
  assert.match(textClient, /mode=text/);
  assert.match(textClient, /turnId=/);
  assert.match(textClient, /durationMs=/);
  assert.match(textClient, /outcome=/);
  assert.match(textClient, /inputTokens=/);
  assert.match(textClient, /outputTokens=/);
  assert.doesNotMatch(textClient, /OPENAI_API_KEY/);
  assert.doesNotMatch(textClient, /Bearer /);
});

test("preload exposes only narrow text IPC methods", () => {
  const preload = read("electron/preload.cjs");
  assert.match(preload, /runTextTurn:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("text:run"/);
  assert.match(preload, /cancelTextTurn:\s*\(clientTurnId\)\s*=>\s*ipcRenderer\.invoke\("text:cancel"/);
  assert.doesNotMatch(preload, /require\("fs"\)/);
  assert.doesNotMatch(preload, /require\("child_process"\)/);
});

test("Realtime model unchanged; text model configured separately", () => {
  const main = read("electron/main.cjs");
  const envExample = read(".env.example");
  assert.match(main, /model:\s*"gpt-realtime-2"/);
  assert.match(main, /OPENAI_TEXT_MODEL \|\| "gpt-4\.1"/);
  assert.match(envExample, /OPENAI_TEXT_MODEL=gpt-4\.1/);
  assert.equal(DEFAULT_TEXT_MODEL, "gpt-4.1");
});

test("duplicate function call_id is executed once per text turn", async () => {
  let executeCount = 0;
  let call = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [{ type: "function", name: "show_menu", description: "m", parameters: {} }],
    executeTool: async () => {
      executeCount += 1;
      return { ok: true, artifact: { title: "Menu", kind: "markdown", content: "#" } };
    },
    classifyHttpFailure: () => ({ code: "unknown", userMessage: "fail", retryable: true }),
    createTokenError: (c) => new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage })}`),
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              id: "resp_dup",
              output: [
                { type: "function_call", name: "show_menu", call_id: "same", arguments: "{}" },
                { type: "function_call", name: "show_menu", call_id: "same", arguments: "{}" },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return { id: "resp_dup2", output_text: "done", output: [], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      };
    },
  });

  const result = await controller.runTextTurn({ clientTurnId: "turn-dedupe", text: "menu" });
  assert.equal(result.ok, true);
  assert.equal(executeCount, 1);
});

test("unavailable text model surfaces a readable Phase 9-style error", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "not-a-real-model",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: () => ({
      code: "unknown",
      userMessage: "Something went wrong connecting Jarvis.",
      retryable: true,
      httpStatus: 404,
    }),
    createTokenError: (c) =>
      new Error(`JARVIS_TOKEN_ERROR:${JSON.stringify({ code: c.code, message: c.userMessage, httpStatus: c.httpStatus })}`),
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({ error: { message: "The model `not-a-real-model` does not exist", code: "model_not_found" } });
      },
    }),
  });

  const result = await controller.runTextTurn({ clientTurnId: "turn-model", text: "hi" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /text model is unavailable/i);
  assert.doesNotMatch(result.error.message, /sk-test|not-a-real-model`/);
});

test("history builder excludes tool roles and bounds recent transcript", () => {
  const items = buildInitialInput("follow up", [
    { role: "user", text: "hi" },
    { role: "tool", text: "secret tool" },
    { role: "ricky", text: "hello" },
    { role: "system", text: "diag" },
  ]);
  const serialized = JSON.stringify(items);
  assert.match(serialized, /follow up/);
  assert.match(serialized, /"hello"/);
  assert.doesNotMatch(serialized, /secret tool/);
  assert.doesNotMatch(serialized, /diag/);
  const mapped = mapToolsForResponses([{ type: "function", name: "show_menu", description: "m", parameters: {} }]);
  assert.equal(mapped[0].type, "function");
});

test("Responses request bodies omit tracing; Realtime tracing unchanged", () => {
  const textSession = read("electron/text-session.cjs");
  const main = read("electron/main.cjs");
  assert.match(textSession, /v1\/responses/);
  assert.doesNotMatch(textSession, /\btracing\s*:/);
  assert.doesNotMatch(textSession, /workflow_name:\s*"Jarvis Text"/);
  assert.match(textSession, /\[jarvis-text\] usage/);
  assert.match(main, /v1\/realtime\/client_secrets/);
  assert.match(main, /workflow_name:\s*"Jarvis Desktop Companion"/);
  assert.match(main, /tracing:\s*\{/);
});

test("simulated 400 unknown_parameter preserves structured fields and text-specific message", async () => {
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const controller = createTextSessionController({
      getApiKey: () => "sk-test",
      getTextModel: () => "gpt-4.1",
      buildInstructions: async () => "instructions",
      getToolSpecs: () => [],
      executeTool: async () => ({ ok: true }),
      classifyHttpFailure: () => ({
        code: "unknown",
        userMessage: "Something went wrong connecting Jarvis.",
        retryable: true,
        httpStatus: 400,
      }),
      createTokenError: (c) => {
        const err = new Error(
          `JARVIS_TOKEN_ERROR:${JSON.stringify({
            code: c.code,
            message: c.userMessage,
            httpStatus: c.httpStatus,
          })}`,
        );
        err.code = c.code;
        err.httpStatus = c.httpStatus;
        return err;
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(Object.prototype.hasOwnProperty.call(body, "tracing"), false);
        return {
          ok: false,
          status: 400,
          headers: { get: () => null },
          async text() {
            return JSON.stringify({
              error: {
                message: "Unknown parameter: 'tracing'.",
                type: "invalid_request_error",
                param: "tracing",
                code: "unknown_parameter",
              },
            });
          },
        };
      },
    });

    const result = await controller.runTextTurn({ clientTurnId: "turn-tracing", text: "hello" });
    assert.equal(result.ok, false);
    assert.equal(result.error.httpStatus, 400);
    assert.equal(result.error.apiErrorType, "invalid_request_error");
    assert.equal(result.error.apiErrorCode, "unknown_parameter");
    assert.equal(result.error.apiErrorParam, "tracing");
    assert.match(result.error.message, /Text request configuration was rejected/i);
    assert.doesNotMatch(result.error.message, /connecting Jarvis/i);
    assert.doesNotMatch(JSON.stringify(result), /sk-test/);
    assert.doesNotMatch(JSON.stringify(result), /Unknown parameter: 'tracing'\./);

    const usageLog = logs.find((line) => line.includes("[jarvis-text] usage"));
    assert.ok(usageLog);
    assert.match(usageLog, /"httpStatus":400/);
    assert.match(usageLog, /"apiErrorCode":"unknown_parameter"/);
    assert.match(usageLog, /"apiErrorParam":"tracing"/);
    assert.doesNotMatch(usageLog, /sk-test/);
    assert.doesNotMatch(usageLog, /Authorization/);
  } finally {
    console.info = originalInfo;
  }
});

test("Realtime and Responses transports remain separate", () => {
  const textSession = read("electron/text-session.cjs");
  const main = read("electron/main.cjs");
  assert.match(textSession, /v1\/responses/);
  assert.match(main, /v1\/realtime\/client_secrets/);
  assert.match(textSession, /\[jarvis-text\]/);
  assert.match(main, /Jarvis Desktop Companion/);
});
