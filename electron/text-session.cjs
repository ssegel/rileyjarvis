"use strict";

/**
 * Independent text turns via OpenAI Responses API (main process).
 * Realtime voice (WebRTC / client_secrets) is a separate transport —
 * text turns do not mint Realtime secrets or open data channels.
 */
const { buildTurnArtifactDelivery } = require("./artifact-selection.cjs");

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
        retryable: false,
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
    /**
     * Phase 17: auto network retry only when fetch threw before any HTTP response
     * and before any tool/parsed response work.
     */
    let obtainedHttpResponse = false;
    let parsedSuccessfulResponse = false;
    let invokedToolCall = false;

    try {
      const instructions = await buildInstructions();
      const tools = mapToolsForResponses(getToolSpecs());
      // Official Responses tool-loop pattern: accumulate output items + function_call_output.
      // Works with store:false (no reliance on previous_response_id server cache).
      let input = buildInitialInput(text, history);
      let assistantText = "";
      let loops = 0;
      const pendingHint =
        request?.pendingConfirmation && typeof request.pendingConfirmation === "object"
          ? request.pendingConfirmation
          : null;
      if (pendingHint && pendingHint.previewToken && pendingHint.toolName && pendingHint.operation) {
        // Attach a structured hint so the model reuses the same preview token (never log the token).
        const hintLines = [
          "PENDING CONFIRMATION (same-process; reuse — do not remint while valid):",
          `toolName=${String(pendingHint.toolName)}`,
          `operation=${String(pendingHint.operation)}`,
          pendingHint.scope ? `scope=${String(pendingHint.scope)}` : null,
          `previewToken=${String(pendingHint.previewToken)}`,
          "Call the same tool with confirmed=true and this exact previewToken. Do not request a new preview for the same operation while this token remains valid.",
        ].filter(Boolean);
        input = [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: hintLines.join("\n") }],
          },
          ...input,
        ];
      }

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
            safeForAutoNetworkRetry: false,
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
          onHttpResponseReceived: () => {
            obtainedHttpResponse = true;
          },
        });
        obtainedHttpResponse = true;
        parsedSuccessfulResponse = true;

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
              safeForAutoNetworkRetry: false,
            });
          }
          const durationMs = now() - startedAt;
          const visibleText = String(assistantText || "").trim();
          const delivery = buildTurnArtifactDelivery(artifacts, toolTrace);
          const hasVisibleOutput = Boolean(visibleText) || delivery.artifactCount > 0;
          if (!hasVisibleOutput) {
            logTextUsage({
              clientTurnId,
              model,
              durationMs,
              outcome: "error",
              usage,
              toolCalls: toolTrace.length,
              toolNames: delivery.toolNames,
              artifactCount: delivery.artifactCount,
              hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
            });
            return {
              ok: false,
              clientTurnId,
              assistantText: "",
              artifacts: delivery.artifacts,
              toolNames: delivery.toolNames,
              artifactCount: delivery.artifactCount,
              selectedArtifact: delivery.selectedArtifact,
              hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
              toolTrace,
              usage,
              durationMs,
              outcome: "error",
              cancelled: false,
              error: {
                code: "api.bad_response",
                message: "Jarvis returned no visible response.",
                retryable: true,
                safeForAutoNetworkRetry: false,
              },
            };
          }
          logTextUsage({
            clientTurnId,
            model,
            durationMs,
            outcome: "completed",
            usage,
            toolCalls: toolTrace.length,
            toolNames: delivery.toolNames,
            artifactCount: delivery.artifactCount,
            hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
            selectedArtifactTitle: delivery.selectedArtifact?.title,
            assistantTextLen: visibleText.length,
          });
          return {
            ok: true,
            clientTurnId,
            assistantText: visibleText || assistantText || "",
            artifacts: delivery.artifacts,
            toolNames: delivery.toolNames,
            artifactCount: delivery.artifactCount,
            selectedArtifact: delivery.selectedArtifact,
            hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
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
              safeForAutoNetworkRetry: false,
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
          invokedToolCall = true;
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
              safeForAutoNetworkRetry: false,
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
        safeForAutoNetworkRetry: false,
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
          safeForAutoNetworkRetry: false,
        });
      }
      const classified = classifyThrown(error, classifyHttpFailure);
      const durationMs = now() - startedAt;
      // Audit §4.2: safe only if fetch threw before any HTTP response and before tools/parse.
      const finalSafe =
        classified.code === "network.offline" &&
        !obtainedHttpResponse &&
        !parsedSuccessfulResponse &&
        !invokedToolCall;
      logTextUsage({
        clientTurnId,
        model,
        durationMs,
        outcome: "error",
        usage,
        toolCalls: toolTrace.length,
        errorCode: classified.code,
        httpStatus: classified.httpStatus,
        apiErrorType: classified.apiErrorType,
        apiErrorCode: classified.apiErrorCode,
        apiErrorParam: classified.apiErrorParam,
      });
      return {
        ok: false,
        clientTurnId,
        assistantText: "",
        artifacts: [],
        toolNames: [],
        artifactCount: 0,
        selectedArtifact: null,
        hasSubstantiveArtifact: false,
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
          retryAfterMs: classified.retryAfterMs,
          safeForAutoNetworkRetry: finalSafe,
          apiErrorType: classified.apiErrorType,
          apiErrorCode: classified.apiErrorCode,
          apiErrorParam: classified.apiErrorParam,
        },
      };
    } finally {
      clearTimeout(timeout);
      activeTurns.delete(clientTurnId);
    }
  }

  function cancelAllActiveTurns() {
    const ids = [...activeTurns.keys()];
    for (const id of ids) {
      cancelTextTurn(id);
    }
    return { ok: true, cancelled: ids.length };
  }

  return {
    runTextTurn,
    cancelTextTurn,
    cancelAllActiveTurns,
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
      toolNames: [],
      artifactCount: 0,
      selectedArtifact: null,
      hasSubstantiveArtifact: false,
      toolTrace: options.toolTrace,
      usage: options.usage,
      durationMs,
      outcome: "error",
      cancelled: false,
      error: {
        code: "session.error",
        message: "Text request timed out.",
        retryable: true,
        safeForAutoNetworkRetry: false,
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
  const current = String(text || "").trim();
  const normalized = normalizeTextHistory(history, current);
  const items = [];
  for (const entry of normalized) {
    const role = entry.role === "assistant" || entry.role === "ricky" ? "assistant" : "user";
    const content = String(entry.text || "").trim();
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
    content: [{ type: "input_text", text: current }],
  });
  return items;
}

/**
 * Sanitize transcript history for Responses input.
 * Permits only user/assistant (incl. legacy ricky) text; excludes tool/system/status/
 * confirmation/artifact/error/empty lines; dedupes consecutive user messages and
 * drops a trailing user message identical to the current prompt.
 */
function normalizeTextHistory(history, currentPrompt) {
  const current = String(currentPrompt || "").trim();
  const permitted = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const roleRaw = entry?.role;
    if (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "ricky") continue;
    const text = String(entry?.text || "").trim();
    if (!text) continue;
    if (shouldExcludeHistoryText(text)) continue;
    const role = roleRaw === "assistant" || roleRaw === "ricky" ? "assistant" : "user";
    const prev = permitted[permitted.length - 1];
    if (role === "user" && prev && prev.role === "user" && prev.text === text) continue;
    permitted.push({ role, text });
  }
  // Ensure current prompt appears exactly once: strip trailing identical user turn.
  while (
    permitted.length > 0 &&
    permitted[permitted.length - 1].role === "user" &&
    permitted[permitted.length - 1].text === current
  ) {
    permitted.pop();
  }
  return permitted.slice(-MAX_HISTORY_ITEMS);
}

function shouldExcludeHistoryText(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  return [
    /^sending/i,
    /^waiting for jarvis/i,
    /^running tools/i,
    /^running [a-z0-9_]+/i,
    /^disconnected$/i,
    /^idle$/i,
    /^connecting$/i,
    /^listening$/i,
    /^thinking$/i,
    /^speaking$/i,
    /^reconnecting$/i,
    /^error$/i,
    /connect voice first/i,
    /jarvis is busy/i,
    /text request/i,
    /something went wrong connecting jarvis/i,
    /the text request failed/i,
    /confirmation required/i,
    /requires confirmation/i,
    /i need confirmation/i,
    /confirm(ed)?\s*=\s*true/i,
    /menu is open in the artifacts? panel/i,
    /rendered in the ui/i,
    /generating image/i,
    /thumbnail board/i,
    /ask jarvis to show/i,
    /mode switched to/i,
    /diagnostics copied/i,
    /could not copy diagnostics/i,
    /^append to memory:/i,
  ].some((pattern) => pattern.test(value));
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
    onHttpResponseReceived,
  } = options;

  const body = {
    model,
    instructions,
    tools,
    tool_choice: "auto",
    store: false,
    // Responses API rejects the Realtime-style tracing object (unknown_parameter).
    // Text identity is logged via [jarvis-text] usage only.
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

  if (typeof onHttpResponseReceived === "function") {
    onHttpResponseReceived(response);
  }

  if (!response.ok) {
    const text = await response.text();
    throw createResponsesHttpError({
      httpStatus: response.status,
      bodyText: text,
      retryAfterHeader: response.headers.get("retry-after"),
      classifyHttpFailure,
      createTokenError,
    });
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

function parseOpenAiErrorBody(bodyText) {
  try {
    const parsed = JSON.parse(String(bodyText || ""));
    const err = parsed && parsed.error && typeof parsed.error === "object" ? parsed.error : null;
    if (!err) return null;
    return {
      type: typeof err.type === "string" ? err.type.slice(0, 80) : undefined,
      code: typeof err.code === "string" ? err.code.slice(0, 80) : undefined,
      param: typeof err.param === "string" ? err.param.slice(0, 80) : undefined,
      message: typeof err.message === "string" ? err.message.slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}

function createResponsesHttpError(options) {
  const { httpStatus, bodyText, retryAfterHeader, classifyHttpFailure, createTokenError } = options;
  const apiError = parseOpenAiErrorBody(bodyText);
  const lower = String(bodyText || "").toLowerCase();
  const classified = classifyHttpFailure({
    httpStatus,
    bodyText,
    retryAfterHeader,
  });

  let userMessage = classified.userMessage;
  let code = classified.code;
  let retryable = classified.retryable !== false;

  if (
    lower.includes("model") &&
    (lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("invalid model") ||
      lower.includes("model_not_found"))
  ) {
    code = classified.code || "unknown";
    userMessage = "The configured text model is unavailable. Check OPENAI_TEXT_MODEL in `.env.local`.";
    retryable = false;
  } else if (
    apiError?.code === "unknown_parameter" ||
    apiError?.param === "tracing" ||
    (apiError?.type === "invalid_request_error" && /unknown parameter/i.test(apiError.message || ""))
  ) {
    code = "api.bad_response";
    userMessage = "Text request configuration was rejected. Check the text-mode settings and try again.";
    retryable = false;
  } else if (classified.code === "unknown" && httpStatus >= 400 && httpStatus < 500) {
    code = "api.bad_response";
    userMessage = "The text request failed. Try again, or check OPENAI_TEXT_MODEL in `.env.local`.";
  }

  const error = createTokenError({
    ...classified,
    code,
    userMessage,
    retryable,
  });
  error.apiErrorType = apiError?.type;
  error.apiErrorCode = apiError?.code;
  error.apiErrorParam = apiError?.param;
  error.userMessage = userMessage;
  error.retryable = retryable;
  return error;
}

function classifyThrown(error, classifyHttpFailure) {
  const message = error instanceof Error ? error.message : String(error || "");
  const apiMeta = {
    apiErrorType: error && error.apiErrorType,
    apiErrorCode: error && error.apiErrorCode,
    apiErrorParam: error && error.apiErrorParam,
  };
  if (message.startsWith("JARVIS_TOKEN_ERROR:")) {
    try {
      const payload = JSON.parse(message.slice("JARVIS_TOKEN_ERROR:".length));
      return {
        code: payload.code || "unknown",
        userMessage:
          (error && error.userMessage) ||
          payload.message ||
          "The text request failed. Try again.",
        retryable:
          typeof error?.retryable === "boolean"
            ? error.retryable
            : payload.code !== "quota.exhausted" &&
              payload.code !== "config.missing_api_key" &&
              payload.code !== "config.invalid_api_key" &&
              payload.code !== "api.bad_response",
        httpStatus: payload.httpStatus || error?.httpStatus,
        retryAfterMs:
          typeof payload.retryAfterMs === "number"
            ? payload.retryAfterMs
            : typeof error?.retryAfterMs === "number"
              ? error.retryAfterMs
              : undefined,
        ...apiMeta,
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
      retryAfterMs: error.retryAfterMs,
      ...apiMeta,
    };
  }
  const statusMatch = message.match(/\b(401|403|429|500|502|503|504)\b/);
  if (statusMatch) {
    return {
      ...classifyHttpFailure({ httpStatus: Number(statusMatch[1]), bodyText: message }),
      ...apiMeta,
    };
  }
  return {
    code: "unknown",
    userMessage: "The text request failed. Try again.",
    retryable: true,
    ...apiMeta,
  };
}

function failResult(code, message, startedAt, nowFn, extra = {}) {
  const durationMs = Math.max(0, nowFn() - startedAt);
  const delivery = buildTurnArtifactDelivery(extra.artifacts || [], extra.toolTrace || []);
  return {
    ok: false,
    clientTurnId: extra.clientTurnId || "",
    assistantText: "",
    artifacts: delivery.artifacts,
    toolNames: delivery.toolNames,
    artifactCount: delivery.artifactCount,
    selectedArtifact: delivery.selectedArtifact,
    hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
    toolTrace: extra.toolTrace || [],
    usage: extra.usage || { inputTokens: 0, outputTokens: 0, model: DEFAULT_TEXT_MODEL },
    durationMs,
    outcome: extra.outcome || "error",
    cancelled: false,
    error: {
      code,
      message,
      retryable:
        typeof extra.retryable === "boolean"
          ? extra.retryable
          : !["config.missing_api_key", "config.invalid_api_key", "quota.exhausted"].includes(code),
      retryAfterMs: extra.retryAfterMs,
      safeForAutoNetworkRetry: extra.safeForAutoNetworkRetry === true,
    },
  };
}

function cancelledResult(startedAt, usage, toolTrace, clientTurnId, model, nowFn = () => Date.now()) {
  const durationMs = Math.max(0, nowFn() - startedAt);
  const delivery = buildTurnArtifactDelivery([], toolTrace);
  logTextUsage({
    clientTurnId,
    model,
    durationMs,
    outcome: "cancelled",
    usage,
    toolCalls: toolTrace.length,
    toolNames: delivery.toolNames,
    artifactCount: delivery.artifactCount,
    hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
  });
  return {
    ok: false,
    clientTurnId,
    assistantText: "",
    artifacts: delivery.artifacts,
    toolNames: delivery.toolNames,
    artifactCount: delivery.artifactCount,
    selectedArtifact: delivery.selectedArtifact,
    hasSubstantiveArtifact: delivery.hasSubstantiveArtifact,
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
      toolNames: Array.isArray(details.toolNames) ? details.toolNames : undefined,
      artifactCount: typeof details.artifactCount === "number" ? details.artifactCount : undefined,
      hasSubstantiveArtifact:
        typeof details.hasSubstantiveArtifact === "boolean" ? details.hasSubstantiveArtifact : undefined,
      // Title only — never log artifact body content.
      selectedArtifactTitle: details.selectedArtifactTitle || undefined,
      // Length only — never log assistant response content.
      assistantTextLen:
        typeof details.assistantTextLen === "number" ? details.assistantTextLen : undefined,
      errorCode: details.errorCode || undefined,
      httpStatus: details.httpStatus || undefined,
      apiErrorType: details.apiErrorType || undefined,
      apiErrorCode: details.apiErrorCode || undefined,
      apiErrorParam: details.apiErrorParam || undefined,
    }),
  );
}

module.exports = {
  createTextSessionController,
  buildInitialInput,
  normalizeTextHistory,
  shouldExcludeHistoryText,
  mapToolsForResponses,
  extractOutputText,
  sanitizeToolResult,
  parseOpenAiErrorBody,
  createResponsesHttpError,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TOOL_LOOP_ITERATIONS,
  MAX_HISTORY_ITEMS,
};
