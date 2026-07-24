const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const errors = require("./realtime-errors.cjs");

/**
 * Mirrors src/lib/realtimeDiagnostics.ts for Node tests.
 */
function sanitizeDiagnosticText(raw, maxLength = 160) {
  return errors.sanitizeDiagnosticText(raw, maxLength);
}

class RealtimeDiagnosticsBuffer {
  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity);
    this.events = [];
  }

  clear() {
    this.events = [];
  }

  size() {
    return this.events.length;
  }

  getEvents() {
    return [...this.events];
  }

  record(input) {
    const entry = {
      ts: new Date().toISOString(),
      level: input.level,
      event: sanitizeDiagnosticText(input.event, 80),
      connectionId: sanitizeDiagnosticText(input.connectionId, 64),
      message: sanitizeDiagnosticText(input.message, 240),
    };
    if (input.responseId) entry.responseId = sanitizeDiagnosticText(input.responseId, 80);
    if (typeof input.httpStatus === "number") entry.httpStatus = input.httpStatus;
    if (input.errorCode) entry.errorCode = sanitizeDiagnosticText(String(input.errorCode), 64);
    if (input.resourceCounts) entry.resourceCounts = { ...input.resourceCounts };
    this.events.push(entry);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return entry;
  }

  buildCopyableReport(meta = {}, limit = 40) {
    const slice = this.events.slice(-Math.max(1, limit));
    const lastError = [...this.events].reverse().find((entry) => entry.errorCode || entry.level === "error");
    const header = {
      generatedAt: new Date().toISOString(),
      appVersion: meta.appVersion || "unknown",
      branch: meta.branch || "unknown",
      platform: meta.platform || "unknown",
      userAgent: sanitizeDiagnosticText(meta.userAgent || "", 120),
      lastErrorCode: meta.lastErrorCode || lastError?.errorCode || null,
      eventCount: this.events.length,
      includedEvents: slice.length,
    };
    const lines = [
      "Jarvis Realtime Diagnostics",
      JSON.stringify(header, null, 2),
      "",
      "Events:",
      ...slice.map((entry) => JSON.stringify(entry)),
    ];
    return sanitizeReportSecrets(lines.join("\n"));
  }
}

function sanitizeReportSecrets(report) {
  return String(report || "")
    .replace(/(sk-[a-zA-Z0-9_-]{10,})/g, "[redacted-key]")
    .replace(/(ek_[a-zA-Z0-9_-]{10,})/g, "[redacted-token]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted-token]")
    .replace(/(password["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]")
    .replace(/JARVIS_TOKEN_ERROR:[^\n]+/g, "JARVIS_TOKEN_ERROR:[redacted]")
    .replace(/<!doctype[\s\S]*$/gi, "[html-omitted]")
    .replace(/<html[\s\S]*$/gi, "[html-omitted]");
}

const MAX_CONNECT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const RETRY_AFTER_CAP_MS = 30_000;
const RETRY_JITTER_MS = 250;

function computeRetryDelayMs(attemptIndex, retryAfterMs, random = Math.random) {
  if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const base = RETRY_BACKOFF_MS[Math.min(attemptIndex, RETRY_BACKOFF_MS.length - 1)] ?? 4000;
  const jitter = Math.floor(random() * (RETRY_JITTER_MS + 1));
  return base + jitter;
}

function classifyThrownValue(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("JARVIS_TOKEN_ERROR:")) {
    const payload = JSON.parse(message.slice("JARVIS_TOKEN_ERROR:".length));
    return errors.buildError(payload.code, {
      httpStatus: payload.httpStatus,
      retryAfterMs: payload.retryAfterMs,
      userMessage: payload.message,
    });
  }
  const name = error instanceof Error ? error.name : "";
  const lower = message.toLowerCase();
  if (name === "NotAllowedError" || lower.includes("permission denied")) {
    return errors.buildError("mic.permission_denied");
  }
  if (name === "NotFoundError" || lower.includes("requested device not found")) {
    return errors.buildError("mic.unavailable");
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return errors.buildError("network.offline");
  }
  if (error && typeof error === "object" && error.code && errors.USER_MESSAGES[error.code]) {
    return errors.buildError(error.code, {
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
      userMessage: error.userMessage,
    });
  }
  return errors.buildError("unknown");
}

/**
 * Minimal state machine covering durable error vs idle collapse.
 */
function createSessionController() {
  let connectionState = "idle";
  let mood = "idle";
  let sessionUiState = "disconnected";
  let lastError = null;
  let userCancelled = false;
  let retryAttempt = 0;
  let intentionalClose = false;
  const resources = { pc: 0, mic: 0, dc: 0, audio: 0, analyser: 0 };

  function releaseAll(emitIdle) {
    resources.pc = 0;
    resources.mic = 0;
    resources.dc = 0;
    resources.audio = 0;
    resources.analyser = 0;
    if (emitIdle) {
      connectionState = "idle";
      mood = "idle";
      sessionUiState = "disconnected";
    }
  }

  function settleError(classified) {
    lastError = classified;
    connectionState = "error";
    mood = "error";
    sessionUiState = "error";
  }

  return {
    get state() {
      return { connectionState, mood, sessionUiState, lastError, retryAttempt, resources: { ...resources } };
    },
    async connectOnce(factory) {
      intentionalClose = false;
      userCancelled = false;
      resources.pc = 1;
      resources.mic = 1;
      resources.dc = 1;
      resources.audio = 1;
      resources.analyser = 1;
      connectionState = "connecting";
      sessionUiState = retryAttempt > 0 ? "reconnecting" : "connecting";
      await factory();
      connectionState = "connected";
      sessionUiState = "listening";
      mood = "idle";
      lastError = null;
      retryAttempt = 0;
    },
    async connectWithRetry(factory) {
      while (!userCancelled) {
        const attemptIndex = retryAttempt;
        try {
          await this.connectOnce(factory);
          return;
        } catch (error) {
          const classified = classifyThrownValue(error);
          intentionalClose = true;
          releaseAll(false);
          intentionalClose = false;
          if (userCancelled) {
            releaseAll(true);
            return;
          }
          const canRetry = classified.retryable && attemptIndex < MAX_CONNECT_ATTEMPTS - 1;
          if (!canRetry) {
            settleError(classified);
            return;
          }
          retryAttempt = attemptIndex + 1;
          sessionUiState = "reconnecting";
          // Tests inject zero-delay factories; backoff is asserted separately.
        }
      }
      releaseAll(true);
    },
    disconnect() {
      userCancelled = true;
      intentionalClose = true;
      lastError = null;
      releaseAll(true);
    },
    dismissError() {
      userCancelled = true;
      intentionalClose = true;
      lastError = null;
      releaseAll(true);
    },
    simulateTransportLoss() {
      if (intentionalClose) return null;
      const classified = errors.buildError("webrtc.disconnected");
      intentionalClose = true;
      releaseAll(false);
      intentionalClose = false;
      return classified;
    },
  };
}

test("missing API key is non-retryable and sanitized", () => {
  const err = errors.missingApiKeyError();
  assert.match(err.message, /^JARVIS_TOKEN_ERROR:/);
  assert.doesNotMatch(err.message, /<html/i);
  const classified = classifyThrownValue(err);
  assert.equal(classified.code, "config.missing_api_key");
  assert.equal(classified.retryable, false);
  assert.equal(classified.userMessage, errors.USER_MESSAGES["config.missing_api_key"]);
});

test("invalid API key classification", () => {
  const classified = errors.classifyHttpFailure({
    httpStatus: 401,
    bodyText: JSON.stringify({ error: { message: "Incorrect API key provided: sk-secret-value-here" } }),
  });
  assert.equal(classified.code, "config.invalid_api_key");
  assert.equal(classified.retryable, false);
  assert.doesNotMatch(classified.userMessage, /sk-secret/);
  assert.doesNotMatch(classified.userMessage, /Incorrect API key/);
});

test("quota exhaustion versus rate limiting", () => {
  const quota = errors.classifyHttpFailure({
    httpStatus: 429,
    bodyText: JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
  });
  const rate = errors.classifyHttpFailure({
    httpStatus: 429,
    bodyText: JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }),
    retryAfterHeader: "2",
  });
  assert.equal(quota.code, "quota.exhausted");
  assert.equal(quota.retryable, false);
  assert.equal(rate.code, "rate_limited");
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 2000);
});

test("500/502/503/504 map to server.unavailable", () => {
  for (const status of [500, 502, 503, 504]) {
    const classified = errors.classifyHttpFailure({
      httpStatus: status,
      bodyText: "<html><body>Bad Gateway</body></html>",
    });
    assert.equal(classified.code, "server.unavailable");
    assert.equal(classified.retryable, true);
    assert.doesNotMatch(classified.userMessage, /<html/i);
    assert.doesNotMatch(classified.userMessage, /Bad Gateway/);
  }
});

test("malformed HTML or non-JSON response maps to api.bad_response for non-5xx", () => {
  const html = errors.classifyHttpFailure({
    httpStatus: 418,
    bodyText: "<!DOCTYPE html><html><body>teapot</body></html>",
  });
  const plain = errors.classifyHttpFailure({
    httpStatus: 400,
    bodyText: "not-json-at-all",
  });
  assert.equal(html.code, "api.bad_response");
  assert.equal(plain.code, "api.bad_response");
  assert.equal(html.retryable, true);
});

test("microphone permission denial is non-retryable", () => {
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  const classified = classifyThrownValue(error);
  assert.equal(classified.code, "mic.permission_denied");
  assert.equal(classified.retryable, false);
});

test("missing microphone is non-retryable", () => {
  const error = new Error("Requested device not found");
  error.name = "NotFoundError";
  const classified = classifyThrownValue(error);
  assert.equal(classified.code, "mic.unavailable");
  assert.equal(classified.retryable, false);
});

test("mid-session peer-connection or data-channel closure classifies as webrtc.disconnected", () => {
  const session = createSessionController();
  let connects = 0;
  // Establish connected state once.
  return session
    .connectWithRetry(async () => {
      connects += 1;
    })
    .then(() => {
      assert.equal(session.state.connectionState, "connected");
      const classified = session.simulateTransportLoss();
      assert.equal(classified.code, "webrtc.disconnected");
      assert.equal(classified.retryable, true);
      assert.equal(session.state.resources.pc, 0);
      assert.equal(session.state.resources.mic, 0);
      assert.equal(session.state.resources.dc, 0);
      assert.notEqual(session.state.connectionState, "idle");
    });
});

test("retry budget stops after three attempts with backoff schedule", async () => {
  const delays = [0, 1, 2].map((index) => computeRetryDelayMs(index, undefined, () => 0));
  assert.deepEqual(delays, [1000, 2000, 4000]);

  const capped = computeRetryDelayMs(0, 60_000, () => 0);
  assert.equal(capped, RETRY_AFTER_CAP_MS);

  const session = createSessionController();
  let attempts = 0;
  await session.connectWithRetry(async () => {
    attempts += 1;
    const err = errors.createTokenError(
      errors.classifyHttpFailure({ httpStatus: 503, bodyText: "unavailable" }),
    );
    throw err;
  });
  assert.equal(attempts, MAX_CONNECT_ATTEMPTS);
  assert.equal(session.state.connectionState, "error");
  assert.equal(session.state.sessionUiState, "error");
  assert.equal(session.state.lastError.code, "server.unavailable");
  assert.equal(session.state.resources.pc, 0);
});

test("manual disconnect cancels further retries", async () => {
  const session = createSessionController();
  let attempts = 0;
  const pending = session.connectWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      session.disconnect();
    }
    throw errors.createTokenError(errors.classifyHttpFailure({ httpStatus: 503, bodyText: "unavailable" }));
  });
  await pending;
  assert.ok(attempts <= 2);
  assert.equal(session.state.connectionState, "idle");
  assert.equal(session.state.sessionUiState, "disconnected");
  assert.equal(session.state.lastError, null);
});

test("diagnostics sanitization strips secrets and HTML", () => {
  const buffer = new RealtimeDiagnosticsBuffer(5);
  buffer.record({
    level: "error",
    event: "token.fail",
    connectionId: "conn-1",
    message: "Authorization: Bearer sk-abc1234567890xyz and <html><body>nope</body></html>",
    httpStatus: 502,
    errorCode: "server.unavailable",
  });
  const report = buffer.buildCopyableReport({ appVersion: "1.0.0", lastErrorCode: "server.unavailable" });
  assert.match(report, /Jarvis Realtime Diagnostics/);
  assert.doesNotMatch(report, /sk-abc1234567890xyz/);
  assert.doesNotMatch(report, /<html/i);
  assert.doesNotMatch(report, /<body/i);
  assert.match(report, /server\.unavailable/);
});

test("copied diagnostics exclude passwords and private memory content patterns", () => {
  const buffer = new RealtimeDiagnosticsBuffer();
  buffer.record({
    level: "info",
    event: "connect.start",
    connectionId: "c1",
    message: "password=super-secret",
  });
  const report = buffer.buildCopyableReport();
  assert.doesNotMatch(report, /super-secret/);
  assert.match(report, /password=\[redacted\]/i);
  assert.doesNotMatch(report, /durableEntries|personalContext|OPENAI_API_KEY\s*=/);
});

test("error state survives cleanup instead of collapsing to idle", async () => {
  const session = createSessionController();
  await session.connectWithRetry(async () => {
    throw errors.missingApiKeyError();
  });
  assert.equal(session.state.connectionState, "error");
  assert.equal(session.state.mood, "error");
  assert.equal(session.state.sessionUiState, "error");
  assert.equal(session.state.resources.pc, 0);
  assert.equal(session.state.lastError.code, "config.missing_api_key");

  session.dismissError();
  assert.equal(session.state.connectionState, "idle");
  assert.equal(session.state.sessionUiState, "disconnected");
  assert.equal(session.state.lastError, null);
});

test("happy-path connect reaches connected/listening", async () => {
  const session = createSessionController();
  await session.connectWithRetry(async () => {
    // success
  });
  assert.equal(session.state.connectionState, "connected");
  assert.equal(session.state.sessionUiState, "listening");
  assert.equal(session.state.lastError, null);
  assert.equal(session.state.resources.pc, 1);
});

test("token error payload never includes raw HTML body", () => {
  const classified = errors.classifyHttpFailure({
    httpStatus: 502,
    bodyText: "<html><head><title>Error</title></head><body>Cloudflare</body></html>",
  });
  const encoded = errors.encodeTokenErrorPayload(classified);
  assert.doesNotMatch(encoded, /Cloudflare/);
  assert.doesNotMatch(encoded, /<html/i);
  assert.match(encoded, /server\.unavailable/);
  assert.ok(classified.bodyHash);
});

test("quota, invalid key, missing key, and mic errors never auto-retry", async () => {
  const cases = [
    errors.missingApiKeyError(),
    errors.createTokenError(errors.classifyHttpFailure({ httpStatus: 401, bodyText: "{}" })),
    errors.createTokenError(
      errors.classifyHttpFailure({
        httpStatus: 429,
        bodyText: JSON.stringify({ error: { code: "insufficient_quota" } }),
      }),
    ),
  ];
  for (const thrown of cases) {
    const session = createSessionController();
    let attempts = 0;
    await session.connectWithRetry(async () => {
      attempts += 1;
      throw thrown;
    });
    assert.equal(attempts, 1);
    assert.equal(session.state.connectionState, "error");
    assert.equal(session.state.lastError.retryable, false);
  }

  for (const mic of [
    Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }),
  ]) {
    const session = createSessionController();
    let attempts = 0;
    await session.connectWithRetry(async () => {
      attempts += 1;
      throw mic;
    });
    assert.equal(attempts, 1);
    assert.equal(session.state.lastError.retryable, false);
  }
});

test("each failed attempt clears resources before the next retry", async () => {
  const session = createSessionController();
  const resourceSnapshots = [];
  let attempts = 0;
  await session.connectWithRetry(async () => {
    attempts += 1;
    resourceSnapshots.push({ ...session.state.resources });
    throw errors.createTokenError(errors.classifyHttpFailure({ httpStatus: 503, bodyText: "unavailable" }));
  });
  assert.equal(attempts, MAX_CONNECT_ATTEMPTS);
  // After each failure the controller releases to empty before deciding retry/error.
  assert.equal(session.state.resources.pc, 0);
  assert.equal(session.state.resources.mic, 0);
  assert.equal(session.state.resources.dc, 0);
  assert.equal(session.state.resources.audio, 0);
  assert.equal(session.state.resources.analyser, 0);
  assert.ok(resourceSnapshots.every((snapshot) => snapshot.pc === 1));
});

test("source files define Phase 9 modules and durable error settlement", () => {
  const realtime = fs.readFileSync(path.join(root, "src/lib/realtime.ts"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  assert.equal(fs.existsSync(path.join(root, "src/lib/realtimeErrors.ts")), true);
  assert.equal(fs.existsSync(path.join(root, "src/lib/realtimeDiagnostics.ts")), true);
  assert.match(realtime, /settleError/);
  assert.match(realtime, /emitIdle: false/);
  assert.match(realtime, /connectionstatechange/);
  assert.match(realtime, /boundDcCloseHandler/);
  assert.match(realtime, /MAX_CONNECT_ATTEMPTS/);
  assert.match(realtime, /interrupt_response|planBargeIn|shouldAcceptResponseScopedEvent/);
  assert.match(app, /sessionUiState/);
  assert.match(app, /Copy diagnostics/);
  assert.match(app, /Dismiss/);
  assert.match(main, /realtime-errors\.cjs/);
  assert.match(main, /createTokenError|missingApiKeyError/);
  assert.doesNotMatch(main, /Realtime token request failed: \$\{response\.status\} \$\{text\}/);
});
