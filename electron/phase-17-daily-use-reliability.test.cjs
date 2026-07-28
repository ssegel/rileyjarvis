"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const errors = require("./realtime-errors.cjs");
const continuity = require("./session-continuity.cjs");
const { createMemoryStore } = require("./memory.cjs");
const { createTextSessionController } = require("./text-session.cjs");
const { createSingleInstanceController } = require("./single-instance.cjs");
const launchHelpers = require("../scripts/launch-helpers.cjs");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

async function withTempMemory(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-p17-"));
  try {
    const store = createMemoryStore({ rootDir: dir });
    await store.ensureMemory();
    await run(store, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function createTokenError(classified) {
  return errors.createTokenError(classified);
}

// --- §17.1 Classification and cooldown ---

test("17.1 429 rate limit vs quota; Retry-After capped at 60s for text", () => {
  const rate = errors.classifyHttpFailure({
    httpStatus: 429,
    bodyText: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
    retryAfterHeader: "90",
  });
  assert.equal(rate.code, "rate_limited");
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 90_000);
  assert.equal(errors.computeTextCooldownMs(0, rate.retryAfterMs), 60_000);
  assert.equal(errors.showsTextRetryCountdown(rate.code), true);
  assert.equal(errors.isTextManualRetryAllowed(rate.code), true);

  const quota = errors.classifyHttpFailure({
    httpStatus: 429,
    bodyText: JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
  });
  assert.equal(quota.code, "quota.exhausted");
  assert.equal(quota.retryable, false);
  assert.equal(errors.showsTextRetryCountdown(quota.code), false);
  assert.equal(errors.isTextManualRetryAllowed(quota.code), false);
});

test("17.1 missing Retry-After uses fallback schedule by attempt index", () => {
  assert.deepEqual([...errors.TEXT_COOLDOWN_FALLBACK_MS], [1000, 2000, 4000, 8000]);
  assert.equal(errors.computeTextCooldownMs(0, undefined), 1000);
  assert.equal(errors.computeTextCooldownMs(1, undefined), 2000);
  assert.equal(errors.computeTextCooldownMs(2, undefined), 4000);
  assert.equal(errors.computeTextCooldownMs(3, undefined), 8000);
  assert.equal(errors.computeTextCooldownMs(9, undefined), 8000);
});

test("17.1 consecutive 429 floor 30s after 3", () => {
  const ms = errors.computeTextCooldownMs(0, undefined, 3);
  assert.equal(ms, 30_000);
  const msg = errors.textCooldownUserMessage("rate_limited", ms, 3);
  assert.match(msg, /You can retry in/);
  assert.match(msg, /Wait longer|try later/i);
  assert.doesNotMatch(msg, /Retrying in/i);
});

test("17.1 quota has no countdown / Retry disabled policy", () => {
  assert.equal(errors.showsTextRetryCountdown("quota.exhausted"), false);
  assert.equal(errors.isTextManualRetryAllowed("quota.exhausted"), false);
  const msg = errors.textCooldownUserMessage("quota.exhausted", 5000, 0);
  assert.doesNotMatch(msg, /You can retry in/);
});

test("17.1 5xx retryable manual and honors Retry-After", () => {
  const classified = errors.classifyHttpFailure({
    httpStatus: 503,
    bodyText: "unavailable",
    retryAfterHeader: "12",
  });
  assert.equal(classified.code, "server.unavailable");
  assert.equal(classified.retryable, true);
  assert.equal(classified.retryAfterMs, 12_000);
  assert.equal(errors.computeTextCooldownMs(0, classified.retryAfterMs), 12_000);
  assert.equal(errors.isTextManualRetryAllowed(classified.code), true);
});

// --- §17.2 Auto network retry safety ---

test("17.2 fetch throw before response sets safeForAutoNetworkRetry and allows one auto retry", async () => {
  let fetches = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: errors.classifyHttpFailure,
    createTokenError,
    timeoutMs: 5000,
    fetchImpl: async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    },
  });
  const result = await controller.runTextTurn({ clientTurnId: "t1", text: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network.offline");
  assert.equal(result.error.safeForAutoNetworkRetry, true);
  assert.equal(fetches, 1);
});

test("17.2 after 2xx with tool call flag is false", async () => {
  let fetches = 0;
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [{ type: "function", name: "show_menu", description: "menu", parameters: {} }],
    executeTool: async () => ({ ok: true, artifact: { title: "Menu", kind: "markdown", content: "# x" } }),
    classifyHttpFailure: errors.classifyHttpFailure,
    createTokenError,
    timeoutMs: 5000,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return {
              output: [
                { type: "function_call", name: "show_menu", call_id: "c1", arguments: "{}" },
              ],
            };
          },
        };
      }
      throw new TypeError("fetch failed");
    },
  });
  const result = await controller.runTextTurn({ clientTurnId: "t2", text: "show menu" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network.offline");
  assert.equal(result.error.safeForAutoNetworkRetry, false);
  assert.ok(result.toolTrace.length >= 1);
});

test("17.2 HTTP 429 response never safe for auto retry", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: errors.classifyHttpFailure,
    createTokenError,
    timeoutMs: 5000,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? "5" : null) },
      async text() {
        return JSON.stringify({ error: { message: "Rate limit" } });
      },
    }),
  });
  const result = await controller.runTextTurn({ clientTurnId: "t3", text: "hello" });
  assert.equal(result.error.code, "rate_limited");
  assert.equal(result.error.safeForAutoNetworkRetry, false);
  assert.equal(result.error.retryAfterMs, 5000);
});

test("17.2 timeout after send never safe for auto retry", async () => {
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: errors.classifyHttpFailure,
    createTokenError,
    timeoutMs: 20,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });
  const result = await controller.runTextTurn({ clientTurnId: "t4", text: "hello" });
  assert.equal(result.error.code, "session.error");
  assert.match(result.error.message, /timed out/i);
  assert.equal(result.error.safeForAutoNetworkRetry, false);
});

// --- §17.3 Duplicate submission / composer (source + client guards) ---

test("17.3 cooldown and in-flight guards present in App/TextClient", () => {
  const app = read("src/App.tsx");
  const textClient = read("src/lib/textClient.ts");
  assert.match(app, /textCooldownActive/);
  // Composer stays editable during cooldown; only Send/Retry are gated (§3.3 / §5.2).
  assert.match(app, /disabled=\{textTurnActive\}/);
  assert.doesNotMatch(app, /disabled=\{textTurnActive \|\| textCooldownActive\}/);
  assert.match(app, /disabled=\{textCooldownActive\}/);
  assert.match(app, /textRetryEnabled/);
  assert.match(app, /You can retry in/);
  assert.doesNotMatch(app, /Retrying in/);
  assert.match(textClient, /isActive\(\)/);
  assert.match(textClient, /autoNetworkRetriesUsed/);
  assert.match(textClient, /TEXT_AUTO_NETWORK_RETRY_DELAY_MS/);
});

test("17.3 second in-flight text turn rejected", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = createTextSessionController({
    getApiKey: () => "sk-test",
    getTextModel: () => "gpt-4.1",
    buildInstructions: async () => "instructions",
    getToolSpecs: () => [],
    executeTool: async () => ({ ok: true }),
    classifyHttpFailure: errors.classifyHttpFailure,
    createTokenError,
    timeoutMs: 5000,
    fetchImpl: async () => {
      await gate;
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return {
            output_text: "ok",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          };
        },
      };
    },
  });
  const firstPromise = controller.runTextTurn({ clientTurnId: "a", text: "one" });
  const second = await controller.runTextTurn({ clientTurnId: "b", text: "two" });
  assert.equal(second.ok, false);
  assert.equal(second.outcome, "rejected");
  assert.equal(second.error.retryable, false);
  release();
  const first = await firstPromise;
  assert.equal(first.ok, true);
});

// --- §17.4 Pending confirmation ---

test("17.4 mint preview sets pending projection with expiry; remint suppressed; confirm clears", async () => {
  await withTempMemory(async (store) => {
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Phase 17 disposable" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Phase 17 disposable" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.ok(preview.previewToken);
    const pending = store.getPendingConfirmation();
    assert.ok(pending);
    assert.equal(pending.operation, "remove");
    assert.ok(pending.expiresAt > Date.now());
    assert.doesNotMatch(JSON.stringify(pending), /previewToken/);
    assert.doesNotMatch(pending.redactedSummary || "", /sk-/);

    const remint = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Phase 17 disposable" },
    });
    assert.equal(remint.code, "CONFIRMATION_REQUIRED");
    assert.equal(remint.previewToken, preview.previewToken);

    const confirmed = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Phase 17 disposable" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(store.getPendingConfirmation(), null);
    assert.equal(store._test.getPreviewStoreSize(), 0);
  });
});

test("17.4 TTL expiry clears pending and confirm returns STALE_PREVIEW", async () => {
  await withTempMemory(async (store) => {
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "TTL target" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "TTL target" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    const entry = store._test.getPreviewEntry(preview.previewToken);
    assert.ok(entry);
    entry.expiresAt = Date.now() - 1;
    assert.equal(store.getPendingConfirmation(), null);
    const confirm = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "TTL target" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirm.code, "STALE_PREVIEW");
  });
});

test("17.4 dailyUpdatedAt drift yields STALE_PREVIEW and clears pending", async () => {
  await withTempMemory(async (store) => {
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Drift target" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Drift target" },
    });
    const entry = store._test.getPreviewEntry(preview.previewToken);
    entry.dailyUpdatedAt = "1999-01-01T00:00:00.000Z";
    const confirm = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Drift target" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirm.code, "STALE_PREVIEW");
    assert.equal(store.getPendingConfirmation(), null);
  });
});

// --- §17.5 Recent continuity ---

test("17.5 save/load round-trip of recent IDs", async () => {
  await withTempMemory(async (store, dir) => {
    store._test.setRecentPriorityId("11111111-1111-1111-1111-111111111111");
    store._test.setRecentActiveProjectId("22222222-2222-2222-2222-222222222222");
    store._test.setRecentWcId("commitments", "33333333-3333-3333-3333-333333333333");
    await store._test.forcePersistContinuity();
    const filePath = path.join(dir, "session-continuity.json");
    const raw = JSON.parse(await fsp.readFile(filePath, "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.recent.priorityId, "11111111-1111-1111-1111-111111111111");
    assert.equal(Object.prototype.hasOwnProperty.call(raw, "pendingConfirmation"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(raw.recent, "previewToken"), false);

    const store2 = createMemoryStore({ rootDir: dir });
    await store2.ensureMemory();
    assert.equal(store2._test.getRecentPriorityId(), "11111111-1111-1111-1111-111111111111");
    assert.equal(store2._test.getRecentActiveProjectId(), "22222222-2222-2222-2222-222222222222");
    assert.equal(store2._test.getRecentWcId("commitments"), "33333333-3333-3333-3333-333333333333");
    assert.equal(store2.getPendingConfirmation(), null);
  });
});

test("17.5 corrupt JSON safely resets", async () => {
  await withTempMemory(async (_store, dir) => {
    const filePath = path.join(dir, "session-continuity.json");
    await fsp.writeFile(filePath, "{not-json", "utf8");
    const store2 = createMemoryStore({ rootDir: dir });
    await store2.ensureMemory();
    assert.equal(store2._test.getRecentPriorityId(), null);
    const snap = store2.getRecentContinuitySnapshot();
    assert.equal(snap.recent.priorityId, null);
  });
});

test("17.5 stale recent id resolve clears and persists", async () => {
  await withTempMemory(async (store, dir) => {
    store._test.setRecentPriorityId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    await store._test.forcePersistContinuity();
    const missing = await store.memoryPriorities({
      operation: "complete",
      reference: { by: "recent" },
    });
    assert.equal(missing.code, "NOT_FOUND");
    assert.equal(store._test.getRecentPriorityId(), null);
    await store._test.forcePersistContinuity();
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "session-continuity.json"), "utf8"));
    assert.equal(raw.recent.priorityId, null);
  });
});

test("17.5 attacker-crafted preview keys ignored on load/write", () => {
  const validated = continuity.validateContinuityDocument({
    schemaVersion: 1,
    updatedAt: "2026-07-28T00:00:00.000Z",
    recent: { priorityId: null, activeProjectId: null, workingContext: {} },
    previewToken: "secret-token",
    pendingConfirmation: { previewToken: "x" },
  });
  assert.equal(validated.ok, true);
  const written = continuity.sanitizeForWrite(validated.doc.recent, "2026-07-28T00:00:00.000Z");
  assert.equal(Object.prototype.hasOwnProperty.call(written, "previewToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(written, "pendingConfirmation"), false);
  assert.deepEqual(Object.keys(written).sort(), ["recent", "schemaVersion", "updatedAt"]);
});

// --- §17.6 Restart policy ---

test("17.6 pending not in continuity writer; restart drops pending; recent loads", async () => {
  await withTempMemory(async (store, dir) => {
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Restart item" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Restart item" },
    });
    assert.ok(store.getPendingConfirmation());
    await store._test.forcePersistContinuity();
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "session-continuity.json"), "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(raw, "pendingConfirmation"), false);

    const restarted = createMemoryStore({ rootDir: dir });
    await restarted.ensureMemory();
    assert.equal(restarted.getPendingConfirmation(), null);
    assert.ok(restarted._test.getRecentPriorityId());
    const confirm = await restarted.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Restart item" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirm.code, "STALE_PREVIEW");
  });
});

// --- §17.7 Launch / single-instance ---

test("17.7 launch prerequisite messaging for missing deps/dist", () => {
  const missingDeps = launchHelpers.checkLaunchPrerequisites({
    nodeAvailable: true,
    npmAvailable: true,
    packageJsonPresent: true,
    electronInstalled: false,
    envLocalPresent: true,
    openAiKeyPresent: true,
    distPresent: true,
    willRebuild: false,
  });
  assert.equal(missingDeps.ok, false);
  assert.match(missingDeps.failures[0].message, /npm install/i);

  const missingDist = launchHelpers.checkLaunchPrerequisites({
    nodeAvailable: true,
    npmAvailable: true,
    packageJsonPresent: true,
    electronInstalled: true,
    envLocalPresent: true,
    openAiKeyPresent: true,
    distPresent: false,
    willRebuild: false,
  });
  assert.equal(missingDist.ok, false);
  assert.match(missingDist.failures.some((f) => /dist\/index\.html/i.test(f.message)).toString(), /true/);

  const rebuildOk = launchHelpers.checkLaunchPrerequisites({
    nodeAvailable: true,
    npmAvailable: true,
    packageJsonPresent: true,
    electronInstalled: true,
    envLocalPresent: true,
    openAiKeyPresent: true,
    distPresent: false,
    willRebuild: true,
  });
  assert.equal(rebuildOk.ok, true);

  assert.equal(launchHelpers.parseEnvLocalHasOpenAiKey("OPENAI_API_KEY=sk-test\n"), true);
  assert.equal(launchHelpers.parseEnvLocalHasOpenAiKey("OPENAI_API_KEY=\n"), false);
  assert.equal(launchHelpers.parseEnvLocalHasOpenAiKey("# OPENAI_API_KEY=sk-test\n"), false);

  const ps1 = read("scripts/start-jarvis.ps1");
  const bat = read("scripts/start-jarvis.bat");
  assert.match(ps1, /Starting Jarvis \(built UI\)/);
  assert.match(ps1, /Jarvis is already running/);
  assert.match(ps1, /taskkill\.exe/);
  assert.doesNotMatch(ps1, /VITE_DEV_SERVER_URL\s*=/);
  assert.match(bat, /start-jarvis\.ps1/);
});

test("17.7 single-instance lock false quits; second-instance focuses", () => {
  let quitCalled = false;
  const denied = createSingleInstanceController({
    requestSingleInstanceLock: () => false,
    quit: () => {
      quitCalled = true;
    },
    getMainWindow: () => null,
  });
  assert.equal(denied.gotLock, false);
  assert.equal(quitCalled, true);

  const calls = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  const allowed = createSingleInstanceController({
    requestSingleInstanceLock: () => true,
    quit: () => {
      throw new Error("should not quit");
    },
    getMainWindow: () => win,
  });
  assert.equal(allowed.gotLock, true);
  assert.equal(allowed.focusExisting(), true);
  assert.deepEqual(calls, ["restore", "show", "focus"]);

  const main = read("electron/main.cjs");
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /second-instance/);
  assert.match(main, /Jarvis is already running/);
  assert.match(main, /before-quit/);
  assert.match(main, /continuity:get/);
  assert.match(main, /app:get-build-info/);
});

// --- §17.8 Diagnostics ---

test("17.8 diagnostics copy excludes tokens/keys/plans; includes code + cooldown + build", () => {
  const app = read("src/App.tsx");
  const textClient = read("src/lib/textClient.ts");
  assert.match(textClient, /Daily-use status/);
  assert.match(textClient, /composerChars/);
  assert.match(textClient, /Pending confirmations do not survive restart/);
  assert.match(app, /Copy diagnostics/);
  assert.match(app, /getDiagnosticReport\(lastTextError/);
  assert.doesNotMatch(textClient, /previewToken/);
  assert.match(errors.sanitizeDiagnosticText("Bearer sk-abcdefghijklmnopqrstuvwxyz", 200), /redacted/);
  assert.doesNotMatch(
    errors.sanitizeDiagnosticText("sk-abcdefghijklmnopqrstuvwxyz123456", 200),
    /sk-abcdefghijklmnopqrstuvwxyz123456/,
  );
});

// --- Source contract checks ---

test("Phase 17 wiring: text session pending hint and error enrichment", () => {
  const textSession = read("electron/text-session.cjs");
  assert.match(textSession, /safeForAutoNetworkRetry/);
  assert.match(textSession, /pendingConfirmation/);
  assert.match(textSession, /onHttpResponseReceived/);
  assert.match(textSession, /retryAfterMs/);
});

test("Realtime connect policy remains 30s capped", () => {
  assert.equal(errors.RETRY_AFTER_CAP_MS, 30_000);
  assert.equal(errors.TEXT_RETRY_AFTER_CAP_MS, 60_000);
  // Realtime parse default still caps at 30s for backward compatible callers.
  assert.equal(errors.parseRetryAfterMs("90"), 30_000);
  assert.equal(errors.parseRetryAfterMs("90", null), 90_000);
});
