"use strict";

/**
 * Independent text turns via OpenAI Responses API (main process).
 * Realtime voice (WebRTC / client_secrets) is a separate transport —
 * text turns do not mint Realtime secrets or open data channels.
 */
const DEFAULT_TEXT_MODEL = "gpt-4.1";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TOOL_LOOP_ITERATIONS = 8;
const MAX_HISTORY_ITEMS = 12;

function createTextSessionController(deps) {
  const {
    getApiKey,
    getTextModel,
    buildInstructions,
    getToolSpecs,
    executeTool,
    classifyHttpFailure,
    createTokenError,
    fetchImpl = fetch,
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxToolLoops = MAX_TOOL_LOOP_ITERATIONS,
  } = deps;

  /** @type {Map<string, { abort: AbortController, startedAt: number }>} */
  const activeTurns = new Map();

  function getTextModelName() {
    const configured = typeof getTextModel === "function" ? getTextModel() : getTextModel;
    return String(configured || DEFAULT_TEXT_MODEL).trim() || DEFAULT_TEXT_MODEL;
  }

  function cancelTextTurn(clientTurnId) {
    const id = String(clientTurnId || "");
    const active = activeTurns.get(id);
    if (!active) {
      return { ok: false, error: { code: "unknown", message: "No active text turn to cancel." } };
    }
    try {
      active.abort.abort("cancel");
    } catch {
      // Ignore abort races.
    }
    return { ok: true, cancelled: true };
  }

  async function runTextTurn(request) {
    const clientTurnId = String(request?.clientTurnId || "");
    const text = String(request?.text || "").trim();
    const history = Array.isArray(request?.history) ? request.history : [];
    const startedAt = now();

    if (!clientTurnId) {
      return failResult("unknown", "Missing text turn id.", startedAt, now);
    }
    if (!text) {
      return failResult("unknown", "Typed message was empty.", startedAt, now);
    }
    if (activeTurns.size > 0) {
      return failResult("session.error", "Jarvis is busy with another text turn.", startedAt, now, {
        outcome: "rejected",
        clientTurnId,
      });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return failResult(
        "config.missing_api_key",
        "Add your OpenAI API key in `.env.local`, then try again.",
        startedAt,
        now,
        { clientTurnId },
      );
    }

    const abort = new AbortController();
    activeTurns.set(clientTurnId, { abort, startedAt });
    const timeout = setTimeout(() => {
      try {
        abort.abort("timeout");
      } catch {
        // Ignore.
      }
    }, timeoutMs);

    const model = getTextModelName();
    const toolTrace = [];
    const artifacts = [];
    /** @type {Set<string>} */
    const executedCallIds = new Set();
    let usage = { inputTokens: 0, outputTokens: 0, model };

    try {
      const instructions = await buildInstructions();
      const tools = mapToolsForResponses(getToolSpecs());
      // Official Responses tool-loop pattern: accumulate output items + function_call_output.
      // Works with store:false (no reliance on previous_response_id server cache).
      let input = buildInitialInput(text, history);
      let assistantText = "";
      let loops = 0;

      while (loops < maxToolLoops) {
        loops += 1;
        if (abort.signal.aborted) {
          return abortedOutcome({
            abort,
            startedAt,
            now,
            usage,
            toolTrace,
            clientTurnId,
            model,
          });
        }

        const response = await callResponsesApi({
          fetchImpl,
          apiKey,
          model,
          instructions,
          tools,
          input,
          signal: abort.signal,
          classifyHttpFailure,
          createTokenError,
        });

        usage = mergeUsage(usage, response.usage, model);
        const output = Array.isArray(response.output) ? response.output : [];
        const functionCalls = output.filter((item) => item && item.type === "function_call");
        assistantText = extractOutputText(response, output) || assistantText;

        if (functionCalls.length === 0) {
          if (abort.signal.aborted) {
            return abortedOutcome({
              abort,
              startedAt,
              now,
              usage,
              toolTrace,
              clientTurnId,
              model,
            });
          }
          const durationMs = now() - startedAt;
          logTextUsage({
            clientTurnId,
            model,
            durationMs,
            outcome: "completed",
            usage,
            toolCalls: toolTrace.length,
          });
          return {
            ok: true,
            clientTurnId,
            assistantText: assistantText || "",
            artifacts,
            toolTrace,
            usage,
            durationMs,
            outcome: "completed",
            cancelled: false,
          };
        }

        // Preserve model output (including function_call items) for the next request.
        input = [...input, ...output];

        for (const call of functionCalls) {
          if (abort.signal.aborted) {
            return abortedOutcome({
              abort,
              startedAt,
              now,
              usage,
              toolTrace,
              clientTurnId,
              model,
            });
          }
          const name = String(call.name || "");
          const callId = String(call.call_id || "");
          if (!callId || executedCallIds.has(callId)) {
            continue;
          }
          executedCallIds.add(callId);
          let args = {};
          try {
            args = call.arguments ? JSON.parse(String(call.arguments)) : {};
          } catch {
            args = {};
          }
          const result = await executeTool({ name, arguments: args });
          if (abort.signal.aborted) {
            return abortedOutcome({
              abort,
              startedAt,
              now,
              usage,
              toolTrace,
              clientTurnId,
              model,
            });
          }
          toolTrace.push({
            name,
            ok: result?.ok !== false,
            requiresConfirmation: result?.requiresConfirmation === true,
          });
          if (result?.artifact) artifacts.push(result.artifact);
          input.push({
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(sanitizeToolResult(result)),
          });
        }
      }

      return failResult("session.error", "Jarvis hit the text tool-loop limit.", startedAt, now, {
        usage,
        toolTrace,
        clientTurnId,
        outcome: "error",
      });
    } catch (error) {
      if (abort.signal.aborted || (error && error.name === "AbortError")) {
        return abortedOutcome({
          abort,
          startedAt,
          now,
          usage,
          toolTrace,
          clientTurnId,
          model,
        });
      }
      const classified = classifyThrown(error, classifyHttpFailure);
      const durationMs = now() - startedAt;
      logTextUsage({
        clientTurnId,
        model,
        durationMs,
        outcome: "error",
        usage,
        toolCalls: toolTrace.length,
        errorCode: classified.code,
      });
      return {
        ok: false,
        clientTurnId,
        assistantText: "",
        artifacts: [],
        toolTrace,
        usage,
        durationMs,
        outcome: "error",
        cancelled: false,
        error: {
          code: classified.code,
          message: classified.userMessage,
          httpStatus: classified.httpStatus,
          retryable: classified.retryable,
        },
      };
    } finally {
      clearTimeout(timeout);
      activeTurns.delete(clientTurnId);
    }
  }

  return {
    runTextTurn,
    cancelTextTurn,
    getActiveTurnCount: () => activeTurns.size,
    DEFAULT_TEXT_MODEL,
    MAX_TOOL_LOOP_ITERATIONS: maxToolLoops,
  };
}

function abortedOutcome(options) {
  const reason = String(options.abort.signal.reason || "cancel");
  if (reason === "timeout") {
    const durationMs = Math.max(0, options.now() - options.startedAt);
    logTextUsage({
      clientTurnId: options.clientTurnId,
      model: options.model,
      durationMs,
      outcome: "error",
      usage: options.usage,
      toolCalls: options.toolTrace.length,
      errorCode: "session.error",
    });
    return {
      ok: false,
      clientTurnId: options.clientTurnId,
      assistantText: "",
      artifacts: [],
      toolTrace: options.toolTrace,
      usage: options.usage,
      durationMs,
      outcome: "error",
      cancelled: false,
      error: {
        code: "session.error",
        message: "Text request timed out.",
        retryable: true,
      },
    };
  }
  return cancelledResult(
    options.startedAt,
    options.usage,
    options.toolTrace,
    options.clientTurnId,
    options.model,
    options.now,
  );
}

function buildInitialInput(text, history) {
  const items = [];
  const permitted = Array.isArray(history) ? history : [];
  for (const entry of permitted.slice(-MAX_HISTORY_ITEMS)) {
    const roleRaw = entry?.role;
    if (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "ricky") continue;
    const role = roleRaw === "assistant" || roleRaw === "ricky" ? "assistant" : "user";
    const content = String(entry?.text || "").trim();
    if (!content) continue;
    if (role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      });
    } else {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      });
    }
  }
  items.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  return items;
}

function mapToolsForResponses(toolSpecs) {
  return (Array.isArray(toolSpecs) ? toolSpecs : []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters || { type: "object", properties: {} },
  }));
}

async function callResponsesApi(options) {
  const {
    fetchImpl,
    apiKey,
    model,
    instructions,
    tools,
    input,
    signal,
    classifyHttpFailure,
    createTokenError,
  } = options;

  const body = {
    model,
    instructions,
    tools,
    tool_choice: "auto",
    store: false,
    tracing: {
      workflow_name: "Jarvis Text",
    },
    input,
  };

  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": require("node:crypto")
          .createHash("sha256")
          .update("riley-local-ricky")
          .digest("hex"),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || signal?.aborted)) throw error;
    throw createTokenError({
      code: "network.offline",
      userMessage: "Network connection looks down.",
      retryable: true,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    const lower = String(text || "").toLowerCase();
    const classified = classifyHttpFailure({
      httpStatus: response.status,
      bodyText: text,
      retryAfterHeader: response.headers.get("retry-after"),
    });
    if (
      lower.includes("model") &&
      (lower.includes("not found") ||
        lower.includes("does not exist") ||
        lower.includes("invalid model") ||
        lower.includes("model_not_found"))
    ) {
      throw createTokenError({
        ...classified,
        userMessage: "The configured text model is unavailable. Check OPENAI_TEXT_MODEL in `.env.local`.",
        retryable: false,
      });
    }
    throw createTokenError(classified);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw createTokenError({
      code: "api.bad_response",
      userMessage: "OpenAI returned an unreadable response.",
      retryable: true,
    });
  }
  return data;
}

function extractOutputText(response, output) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && part.text) parts.push(String(part.text));
      if (part?.type === "text" && part.text) parts.push(String(part.text));
    }
  }
  return parts.join("\n").trim();
}

function mergeUsage(current, next, model) {
  const inputTokens = Number(current.inputTokens || 0) + Number(next?.input_tokens || next?.inputTokens || 0);
  const outputTokens = Number(current.outputTokens || 0) + Number(next?.output_tokens || next?.outputTokens || 0);
  return { inputTokens, outputTokens, model };
}

function sanitizeToolResult(result) {
  if (!result || typeof result !== "object") return { ok: false, error: "Invalid tool result." };
  const { artifact, ...rest } = result;
  if (!artifact) return rest;
  return {
    ...rest,
    artifact: {
      title: artifact.title,
      kind: artifact.kind,
      content:
        artifact.kind === "thumbnailBoard"
          ? "Thumbnail board rendered in the UI."
          : artifact.kind === "image" || artifact.kind === "imageLoading"
            ? "Image rendered in the UI."
            : String(artifact.content || "").length > 1200
              ? `${String(artifact.content).slice(0, 1200)}...`
              : artifact.content,
      language: artifact.language,
      fullscreen: artifact.fullscreen,
    },
  };
}

function classifyThrown(error, classifyHttpFailure) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("JARVIS_TOKEN_ERROR:")) {
    try {
      const payload = JSON.parse(message.slice("JARVIS_TOKEN_ERROR:".length));
      return {
        code: payload.code || "unknown",
        userMessage: payload.message || "Something went wrong connecting Jarvis.",
        retryable:
          payload.code !== "quota.exhausted" &&
          payload.code !== "config.missing_api_key" &&
          payload.code !== "config.invalid_api_key",
        httpStatus: payload.httpStatus,
      };
    } catch {
      // fall through
    }
  }
  if (error && error.code && error.userMessage) {
    return {
      code: error.code,
      userMessage: error.userMessage,
      retryable: Boolean(error.retryable),
      httpStatus: error.httpStatus,
    };
  }
  const statusMatch = message.match(/\b(401|403|429|500|502|503|504)\b/);
  if (statusMatch) {
    return classifyHttpFailure({ httpStatus: Number(statusMatch[1]), bodyText: message });
  }
  return {
    code: "unknown",
    userMessage: "Something went wrong connecting Jarvis.",
    retryable: true,
  };
}

function failResult(code, message, startedAt, nowFn, extra = {}) {
  const durationMs = Math.max(0, nowFn() - startedAt);
  return {
    ok: false,
    clientTurnId: extra.clientTurnId || "",
    assistantText: "",
    artifacts: extra.artifacts || [],
    toolTrace: extra.toolTrace || [],
    usage: extra.usage || { inputTokens: 0, outputTokens: 0, model: DEFAULT_TEXT_MODEL },
    durationMs,
    outcome: extra.outcome || "error",
    cancelled: false,
    error: {
      code,
      message,
      retryable: !["config.missing_api_key", "config.invalid_api_key", "quota.exhausted"].includes(code),
    },
  };
}

function cancelledResult(startedAt, usage, toolTrace, clientTurnId, model, nowFn = () => Date.now()) {
  const durationMs = Math.max(0, nowFn() - startedAt);
  logTextUsage({
    clientTurnId,
    model,
    durationMs,
    outcome: "cancelled",
    usage,
    toolCalls: toolTrace.length,
  });
  return {
    ok: false,
    clientTurnId,
    assistantText: "",
    artifacts: [],
    toolTrace,
    usage,
    durationMs,
    outcome: "cancelled",
    cancelled: true,
    error: {
      code: "session.error",
      message: "Text request cancelled.",
      retryable: false,
    },
  };
}

function logTextUsage(details) {
  console.info(
    "[jarvis-text] usage",
    JSON.stringify({
      clientTurnId: details.clientTurnId,
      model: details.model,
      durationMs: details.durationMs,
      outcome: details.outcome,
      inputTokens: details.usage?.inputTokens || 0,
      outputTokens: details.usage?.outputTokens || 0,
      toolCalls: details.toolCalls || 0,
      errorCode: details.errorCode || undefined,
    }),
  );
}

module.exports = {
  createTextSessionController,
  buildInitialInput,
  mapToolsForResponses,
  extractOutputText,
  sanitizeToolResult,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TOOL_LOOP_ITERATIONS,
  MAX_HISTORY_ITEMS,
};
