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

test("17.5 instruction maps that one/that/the recent one to by recent", () => {
  const main = read("electron/main.cjs");
  assert.match(main, /that one/);
  assert.match(main, /the recent one/);
  assert.match(main, /"by":"recent"/);
  assert.match(main, /Do not ask which item she meant while a valid recent reference exists/);
  assert.match(main, /Complete that one/);
  assert.match(main, /memory_priorities \{"operation":"complete","reference":\{"by":"recent"\}\}/);
});

test("17.5 memory_priorities schema accepts by recent", () => {
  const main = read("electron/main.cjs");
  const prioritiesToolStart = main.indexOf('name: "memory_priorities"');
  assert.ok(prioritiesToolStart > 0);
  const nextTool = main.indexOf('name: "', prioritiesToolStart + 10);
  const toolBlock = main.slice(prioritiesToolStart, nextTool > prioritiesToolStart ? nextTool : prioritiesToolStart + 4000);
  assert.match(toolBlock, /reference:/);
  assert.match(toolBlock, /"by":"recent"/);
  assert.match(toolBlock, /that one/);
});

test("17.5 persisted recent priority resolves after simulated restart", async () => {
  await withTempMemory(async (store, dir) => {
    const added = await store.memoryPriorities({
      operation: "add",
      items: [{ text: "P17 restart continuity check" }],
    });
    assert.equal(added.ok, true);
    const recentId = store._test.getRecentPriorityId();
    assert.ok(recentId);
    await store._test.forcePersistContinuity();

    const restarted = createMemoryStore({ rootDir: dir });
    await restarted.ensureMemory();
    assert.equal(restarted._test.getRecentPriorityId(), recentId);
    assert.equal(restarted.getPendingConfirmation(), null);

    const resolved = await restarted.memoryPriorities({
      operation: "complete",
      reference: { by: "recent" },
    });
    assert.equal(resolved.ok, true);
    const hit = (resolved.priorities || []).find((item) => item.id === recentId);
    assert.ok(hit);
    assert.equal(hit.text, "P17 restart continuity check");
    assert.equal(hit.status, "done");
  });
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
  assert.match(ps1, /Resolve-NpmStartExecutable/);
  assert.match(ps1, /Get-Command "npm\.cmd"/);
  assert.match(ps1, /node_modules\\electron\\dist\\electron\.exe/);
  assert.match(ps1, /Start-JarvisElectronProcess/);
  assert.match(ps1, /ProcessStartInfo/);
  assert.match(ps1, /\$psi\.Arguments\s*=\s*'"'\s*\+\s*\(\$RepoRoot/);
  assert.match(ps1, /Wait-JarvisProcessIdentity/);
  assert.match(ps1, /Test-IsJarvisProcessCommandLine/);
  assert.match(ps1, /default_app\\\.asar/);
  assert.match(ps1, /process identity confirmed/);
  assert.doesNotMatch(ps1, /VITE_DEV_SERVER_URL\s*=/);
  assert.doesNotMatch(ps1, /Start-Process -FilePath \$npmPath/);
  assert.doesNotMatch(ps1, /Start-Process -FilePath \$npmExe -ArgumentList @\("start"\)/);
  assert.doesNotMatch(ps1, /ArgumentList @\("start"\)/);
  assert.doesNotMatch(ps1, /ArgumentList @\(\$RepoRoot\)/);
  assert.match(bat, /start-jarvis\.ps1/);

  const main = read("electron/main.cjs");
  assert.match(main, /isJarvisApplicationPath/);
  assert.match(main, /default_app\\\.asar/);
  assert.match(main, /\[jarvis-launch\] ready/);
  assert.match(main, /refused non-Jarvis app path/);
  assert.match(main, /show:\s*false/);
  assert.match(main, /ready-to-show/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /did-finish-load/);
  assert.match(main, /renderer-load-failed/);
  assert.match(main, /evaluateJarvisUiReadiness/);
  // Ready must not be printed in whenReady before createWindow visibility path.
  assert.doesNotMatch(
    main,
    /refused non-Jarvis app path[\s\S]*console\.info\("\[jarvis-launch\] ready"[\s\S]*void createWindow/,
  );
});

test("17.7 Windows npm.cmd is preferred over npm.ps1 for builds", () => {
  const exists = new Set([
    String.raw`C:\Program Files\nodejs\npm.ps1`,
    String.raw`C:\Program Files\nodejs\npm.cmd`,
  ]);
  const resolved = launchHelpers.resolveNpmStartExecutable(
    [String.raw`C:\Program Files\nodejs\npm.ps1`],
    {
      platform: "win32",
      exists: (p) => exists.has(p),
    },
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, String.raw`C:\Program Files\nodejs\npm.cmd`);
  assert.doesNotMatch(resolved.path, /\.ps1$/i);

  const directCmd = launchHelpers.resolveNpmStartExecutable(
    [String.raw`C:\Program Files\nodejs\npm.cmd`, String.raw`C:\Program Files\nodejs\npm.ps1`],
    {
      platform: "win32",
      exists: (p) => exists.has(p),
    },
  );
  assert.equal(directCmd.path, String.raw`C:\Program Files\nodejs\npm.cmd`);
});

test("17.7 explicit electron.exe absolute app path for spaced repository roots", () => {
  const repoRoot = String.raw`C:\Users\Sarah Segel\OneDrive\Cursor\rileyjarvis`;
  const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  const plan = launchHelpers.buildLaunchPlan(
    {
      nodeAvailable: true,
      npmAvailable: true,
      packageJsonPresent: true,
      electronInstalled: true,
      envLocalPresent: true,
      openAiKeyPresent: true,
      distPresent: true,
      willRebuild: false,
      repoRoot,
    },
    {
      platform: "win32",
      npmCandidates: [String.raw`C:\Program Files\nodejs\npm.ps1`],
      exists: (p) =>
        p === String.raw`C:\Program Files\nodejs\npm.ps1` ||
        p === String.raw`C:\Program Files\nodejs\npm.cmd` ||
        p === electronExe,
    },
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.workingDirectory, repoRoot);
  assert.match(plan.workingDirectory, /Sarah Segel/);
  assert.equal(plan.startCommand, electronExe);
  assert.deepEqual(plan.startArgs, [repoRoot]);
  assert.equal(plan.absoluteAppPath, repoRoot);
  assert.equal(plan.usesExplicitAppPath, true);
  assert.equal(plan.avoidsNpmStartDot, true);
  assert.equal(plan.rejectsDefaultApp, true);
  assert.equal(plan.setViteDevServerUrl, false);
  assert.doesNotMatch(plan.startArgs.join(" "), /(^|\s)\.(\s|$)/);
  assert.doesNotMatch(plan.startCommand, /default_app/i);
  assert.equal(launchHelpers.shouldSetViteDevServerUrl(), false);
});

test("17.7 Windows quoting keeps Sarah Segel repository root as one app argument", () => {
  const repoRoot = String.raw`C:\Users\Sarah Segel\OneDrive\Cursor\rileyjarvis`;
  const truncated = String.raw`C:\Users\Sarah`;

  assert.equal(launchHelpers.wouldTruncateSpacedPathIfUnquoted(repoRoot), true);
  assert.equal(truncated, repoRoot.split(/\s+/)[0]);

  const quoted = launchHelpers.quoteWindowsProcessArgument(repoRoot);
  assert.equal(quoted, `"${repoRoot}"`);
  assert.match(quoted, /Sarah Segel/);
  assert.doesNotMatch(quoted, /^"C:\\Users\\Sarah"$/);

  const argList = launchHelpers.buildWindowsStartProcessArgumentList(repoRoot);
  assert.equal(argList.length, 1);
  assert.equal(argList[0], `"${repoRoot}"`);

  const decoded = launchHelpers.decodeWindowsStartProcessArgumentList(argList);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0], repoRoot);
  assert.match(decoded[0], /Sarah Segel/);
  assert.notEqual(decoded[0], truncated);
  assert.doesNotMatch(decoded[0], /^C:\\Users\\Sarah$/);

  const psiArgs = launchHelpers.buildWindowsProcessStartInfoArguments(repoRoot);
  assert.equal(psiArgs, `"${repoRoot}"`);
  assert.equal(launchHelpers.tokenizeCommandLineArgs(psiArgs).length, 1);
  assert.equal(launchHelpers.tokenizeCommandLineArgs(psiArgs)[0], repoRoot);

  // Unquoted spaced path would become multiple tokens; quoting must prevent that.
  assert.ok(launchHelpers.tokenizeCommandLineArgs(repoRoot).length > 1);
  assert.equal(launchHelpers.tokenizeCommandLineArgs(repoRoot)[0], truncated);

  const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  const plan = launchHelpers.buildLaunchPlan(
    {
      nodeAvailable: true,
      npmAvailable: true,
      packageJsonPresent: true,
      electronInstalled: true,
      envLocalPresent: true,
      openAiKeyPresent: true,
      distPresent: true,
      willRebuild: false,
      repoRoot,
    },
    {
      platform: "win32",
      npmCandidates: [String.raw`C:\Program Files\nodejs\npm.cmd`],
      exists: (p) => p.endsWith("npm.cmd") || p === electronExe,
    },
  );
  assert.equal(plan.appArgumentCount, 1);
  assert.deepEqual(plan.decodedAppArguments, [repoRoot]);
  assert.equal(plan.startProcessArgumentList.length, 1);
  assert.equal(plan.startProcessArguments, `"${repoRoot}"`);
  assert.equal(plan.rejectsDefaultApp, true);
  assert.doesNotMatch(plan.startProcessArguments, /default_app/i);
  assert.doesNotMatch(plan.decodedAppArguments.join("\0"), /^C:\\Users\\Sarah$/);
});

test("17.7 missing Electron executable and nonzero child exit are reported clearly", () => {
  const repoRoot = String.raw`C:\Users\Sarah Segel\OneDrive\Cursor\rileyjarvis`;
  const missingExe = launchHelpers.resolveElectronExecutable(repoRoot, {
    platform: "win32",
    exists: () => false,
  });
  assert.equal(missingExe.ok, false);
  assert.match(missingExe.message, /Electron executable was not found/i);

  const missingNpm = launchHelpers.resolveNpmStartExecutable([], {
    platform: "win32",
    exists: () => false,
  });
  assert.equal(missingNpm.ok, false);
  assert.match(missingNpm.message, /npm was not found/i);

  const onlyPs1 = launchHelpers.resolveNpmStartExecutable(
    [String.raw`C:\Program Files\nodejs\npm.ps1`],
    {
      platform: "win32",
      exists: (p) => p.endsWith("npm.ps1"),
    },
  );
  assert.equal(onlyPs1.ok, false);

  const planMissingExe = launchHelpers.buildLaunchPlan(
    {
      nodeAvailable: true,
      npmAvailable: true,
      packageJsonPresent: true,
      electronInstalled: true,
      envLocalPresent: true,
      openAiKeyPresent: true,
      distPresent: true,
      willRebuild: false,
      repoRoot,
    },
    {
      platform: "win32",
      npmCandidates: [String.raw`C:\Program Files\nodejs\npm.cmd`],
      exists: (p) => p.endsWith("npm.cmd"),
    },
  );
  assert.equal(planMissingExe.ok, false);
  assert.ok(planMissingExe.failures.some((f) => f.code === "electron_exe_missing"));

  const nonzero = launchHelpers.interpretLaunchChildExit(7, { alreadyRunning: false });
  assert.equal(nonzero.ok, false);
  assert.equal(nonzero.exitCode, 7);
  assert.match(nonzero.message, /code 7/);

  const clean = launchHelpers.interpretLaunchChildExit(0, { alreadyRunning: false });
  assert.equal(clean.ok, true);
  assert.equal(clean.action, "clean_exit");

  const focused = launchHelpers.interpretLaunchChildExit(0, { alreadyRunning: true });
  assert.equal(focused.ok, true);
  assert.equal(focused.action, "already_running_focused");
});

test("17.7 process identity rejects bare/default Electron and accepts Jarvis app path", () => {
  const repoRoot = String.raw`C:\Users\Sarah Segel\OneDrive\Cursor\rileyjarvis`;
  const bare = `"${repoRoot}\\node_modules\\electron\\dist\\electron.exe" `;
  const defaultRenderer =
    `"${repoRoot}\\node_modules\\electron\\dist\\electron.exe" --type=renderer --app-path="${repoRoot}\\node_modules\\electron\\dist\\resources\\default_app.asar"`;
  const jarvisMain = `"${repoRoot}\\node_modules\\electron\\dist\\electron.exe" "${repoRoot}"`;
  const jarvisRenderer =
    `"${repoRoot}\\node_modules\\electron\\dist\\electron.exe" --type=renderer --user-data-dir="C:\\Users\\Sarah Segel\\AppData\\Roaming\\rileyjarvis" --app-path="${repoRoot}"`;

  assert.equal(launchHelpers.isDefaultElectronAppCommandLine(bare), true);
  assert.equal(launchHelpers.isDefaultElectronAppCommandLine(defaultRenderer), true);
  assert.equal(launchHelpers.isJarvisProcessCommandLine(bare, repoRoot), false);
  assert.equal(launchHelpers.isJarvisProcessCommandLine(defaultRenderer, repoRoot), false);
  assert.equal(launchHelpers.isJarvisProcessCommandLine(jarvisMain, repoRoot), true);
  assert.equal(launchHelpers.isJarvisProcessCommandLine(jarvisRenderer, repoRoot), true);

  const withheld = launchHelpers.evaluateJarvisLaunchReadiness({
    repoRoot,
    commandLines: [bare, defaultRenderer],
  });
  assert.equal(withheld.ready, false);
  assert.match(withheld.reason, /electron_without_jarvis_identity|jarvis_identity_not_confirmed/);
  assert.doesNotMatch(withheld.message || "", /\[jarvis-launch\] ready/);

  const ready = launchHelpers.evaluateJarvisLaunchReadiness({
    repoRoot,
    commandLines: [bare, jarvisMain],
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.message, "[jarvis-launch] ready");

  const defaultAppPath = launchHelpers.evaluateJarvisLaunchReadiness({
    repoRoot,
    appPath: `${repoRoot}\\node_modules\\electron\\dist\\resources\\default_app.asar`,
  });
  assert.equal(defaultAppPath.ready, false);

  const jarvisAppPath = launchHelpers.evaluateJarvisLaunchReadiness({
    repoRoot,
    appPath: repoRoot,
  });
  assert.equal(jarvisAppPath.ready, true);
  assert.equal(launchHelpers.isJarvisApplicationPath(repoRoot, repoRoot), true);
  assert.equal(
    launchHelpers.isJarvisApplicationPath(
      `${repoRoot}\\node_modules\\electron\\dist\\resources\\default_app.asar`,
      repoRoot,
    ),
    false,
  );
});

test("17.7 relative production asset URLs for Electron file:// loading", () => {
  const viteConfig = read("vite.config.ts");
  assert.match(viteConfig, /base:\s*["']\.\/["']/);

  const distHtml = read("dist/index.html");
  assert.match(distHtml, /src="\.\/assets\//);
  assert.match(distHtml, /href="\.\/assets\//);
  assert.doesNotMatch(distHtml, /src="\/assets\//);
  assert.doesNotMatch(distHtml, /href="\/assets\//);
});

test("17.7 UI readiness emitted only after successful show/visibility", () => {
  const windowLaunch = require("./window-launch.cjs");
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.equal(
    windowLaunch.isBoundsOnScreen({ x: 100, y: 100, width: 1120, height: 760 }, displays),
    true,
  );
  assert.equal(
    windowLaunch.isBoundsOnScreen({ x: -8000, y: -8000, width: 1120, height: 760 }, displays),
    false,
  );

  const notShown = windowLaunch.evaluateJarvisUiReadiness({
    loadFailed: false,
    destroyed: false,
    loaded: true,
    shown: false,
    minimized: false,
    visible: false,
    boundsOnScreen: true,
  });
  assert.equal(notShown.ready, false);
  assert.equal(notShown.message, null);

  const visible = windowLaunch.evaluateJarvisUiReadiness({
    loadFailed: false,
    destroyed: false,
    loaded: true,
    shown: true,
    minimized: false,
    visible: true,
    boundsOnScreen: true,
  });
  assert.equal(visible.ready, true);
  assert.equal(visible.message, "[jarvis-launch] ready");
  assert.equal(visible.reason, "visible_ui");

  const main = read("electron/main.cjs");
  const readyIdx = main.indexOf('console.info("[jarvis-launch] ready"');
  const evalIdx = main.indexOf("evaluateJarvisUiReadiness");
  const showFalseIdx = main.indexOf("show: false");
  assert.ok(readyIdx > 0 && evalIdx > 0 && showFalseIdx > 0);
  assert.ok(evalIdx < readyIdx, "ready log must follow visibility evaluation");
  assert.ok(showFalseIdx < readyIdx, "window must start hidden before ready");
});

test("17.7 no UI readiness after renderer load failure", () => {
  const windowLaunch = require("./window-launch.cjs");
  const errors = require("./realtime-errors.cjs");
  const failed = windowLaunch.evaluateJarvisUiReadiness({
    loadFailed: true,
    destroyed: false,
    loaded: true,
    shown: true,
    minimized: false,
    visible: true,
    boundsOnScreen: true,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.reason, "renderer_load_failed");
  assert.equal(failed.message, null);

  const detail = windowLaunch.sanitizeRendererLoadFailure(
    {
      errorCode: -6,
      errorDescription: "ERR_FILE_NOT_FOUND sk-abcdefghijklmnopqrstuvwxyz",
      validatedURL: "file:///C:/Users/Sarah%20Segel/app/dist/index.html?token=secret",
    },
    errors.sanitizeDiagnosticText,
  );
  assert.equal(detail.errorCode, -6);
  assert.doesNotMatch(detail.errorDescription, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(String(detail.url || ""), /token=secret/);
  assert.match(String(detail.url || ""), /file:/);

  const main = read("electron/main.cjs");
  assert.match(main, /did-fail-load/);
  assert.match(main, /renderer-load-failed/);
  assert.match(main, /sanitizeRendererLoadFailure/);
});

test("17.7 long-running child start is not treated as immediate failure", async () => {
  // Simulate a child that stays alive briefly (Electron daily path), then exits 0.
  const child = launchHelpers.spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid > 0);
  assert.equal(child.exitCode, null);
  const stillRunning = launchHelpers.interpretLaunchChildExit(child.exitCode, {
    alreadyRunning: false,
  });
  assert.equal(stillRunning.ok, true);
  assert.equal(stillRunning.action, "still_running_or_unknown");

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode ?? 0));
  });
  const after = launchHelpers.interpretLaunchChildExit(code, { alreadyRunning: false });
  assert.equal(after.ok, true);
  assert.equal(after.exitCode, 0);
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
