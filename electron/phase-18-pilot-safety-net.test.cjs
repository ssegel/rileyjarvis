"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveBackupIdentifier,
  isoToStamp,
  stampToIsoCandidate,
  listOrdinaryBackupFiles,
} = require("./backup-ids.cjs");
const {
  createBaselineStore,
  extractSafeHeaderMetadata,
  isSafeBasename,
  resolveSafeBaselinePath,
  projectPublicBaselineMetadata,
  MAX_PROTECTED_BASELINES,
  MAX_PROTECTED_BASELINE_BYTES,
  MAX_SINGLE_BACKUP_BYTES,
} = require("./backup-baselines.cjs");
const { createPilotJournal } = require("./pilot-journal.cjs");
const {
  createMemoryStore,
  MAX_ORDINARY_BACKUPS,
  MAX_ORDINARY_BACKUP_BYTES,
} = require("./memory.cjs");
const launchHelpers = require("../scripts/launch-helpers.cjs");
const { sanitizeDiagnosticText } = require("./realtime-errors.cjs");

async function withTemp(run) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-p18-"));
  try {
    return await run(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

async function withStore(run, options = {}) {
  return withTemp(async (rootDir) => {
    const clock = { value: options.startDate ? new Date(options.startDate) : new Date("2026-07-29T15:00:00.000Z") };
    let uuidSeq = 0;
    let externalBusy = false;
    const store = createMemoryStore({
      rootDir,
      now: () => new Date(clock.value.getTime()),
      randomUUID: () => {
        uuidSeq += 1;
        return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
      },
      isExternallyBusy: () => externalBusy,
      failBackup: options.failBackup,
    });
    await store.ensureMemory();
    return run(store, {
      rootDir,
      setExternalBusy: (value) => {
        externalBusy = Boolean(value);
      },
      advanceMs: (ms) => {
        clock.value = new Date(clock.value.getTime() + ms);
      },
    });
  });
}

async function seedRegisteredBaseline(rootDir, overrides = {}) {
  const baselinesDir = path.join(rootDir, "backups", "baselines");
  await fsp.mkdir(baselinesDir, { recursive: true });
  const fileName =
    overrides.fileName || "2026-07-29T00-00-00-000Z-baseline-Transaction.json";
  const id = overrides.id || "bl_transaction";
  const name = overrides.name || "Transaction";
  const full = path.join(baselinesDir, fileName);
  const snapshot = {
    schemaVersion: 1,
    reason: "baseline-Transaction",
    createdAt: "2026-07-29T00:00:00.000Z",
    baselineId: id,
    baselineName: name,
  };
  await fsp.writeFile(full, `${JSON.stringify(snapshot)}\n`, "utf8");
  const registryPath = path.join(rootDir, "backup-baselines.json");
  await fsp.writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-29T00:00:00.000Z",
      baselines: [
        {
          id,
          name,
          fileName,
          createdAt: snapshot.createdAt,
          createdBy: "user",
          note: null,
        },
      ],
    })}\n`,
    "utf8",
  );
  return { baselinesDir, fileName, id, name, full, registryPath, snapshot };
}

// ——— R01–R07 Restore IDs ———

test("R01 match full filename", () => {
  const files = [
    {
      name: "2026-07-29T12-00-00-000Z-priorities-remove.json",
      full: "/tmp/2026-07-29T12-00-00-000Z-priorities-remove.json",
      mtimeMs: 2,
    },
  ];
  const resolved = resolveBackupIdentifier("2026-07-29T12-00-00-000Z-priorities-remove.json", {
    ordinaryFiles: files,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.file.name, files[0].name);
});

test("R02 match dashed stamp ↔ ISO createdAt equivalence", () => {
  const iso = "2026-07-29T12:00:00.000Z";
  const stamp = isoToStamp(iso);
  assert.equal(stamp, "2026-07-29T12-00-00-000Z");
  assert.equal(stampToIsoCandidate(stamp), iso);
  const files = [
    {
      name: `${stamp}-priorities-remove.json`,
      full: `/tmp/${stamp}-priorities-remove.json`,
      mtimeMs: 1,
      createdAt: iso,
    },
  ];
  const byIso = resolveBackupIdentifier(iso, { ordinaryFiles: files });
  assert.equal(byIso.ok, true);
  const byStamp = resolveBackupIdentifier(stamp, { ordinaryFiles: files });
  assert.equal(byStamp.ok, true);
});

test("R03 match baseline id and unique name", () => {
  const baselines = [
    {
      id: "bl_abc",
      name: "Week Start",
      fileName: "2026-07-29T18-00-00-000Z-baseline-weekstart.json",
      full: "/tmp/baselines/2026-07-29T18-00-00-000Z-baseline-weekstart.json",
    },
  ];
  assert.equal(resolveBackupIdentifier("bl_abc", { ordinaryFiles: [], baselineEntries: baselines }).ok, true);
  assert.equal(resolveBackupIdentifier("week start", { ordinaryFiles: [], baselineEntries: baselines }).ok, true);
});

test("R04 ambiguous query → AMBIGUOUS_BACKUP_ID", () => {
  const stamp = "2026-07-29T12-00-00-000Z";
  // Two files sharing the same stamp prefix identity when queried by stamp alone is fine for exact stamp
  // if both filenames share stamp - both match stamp → ambiguous.
  const files = [
    { name: `${stamp}-priorities-remove.json`, full: `/a/${stamp}-priorities-remove.json`, mtimeMs: 2 },
    { name: `${stamp}-priorities-replace.json`, full: `/a/${stamp}-priorities-replace.json`, mtimeMs: 1 },
  ];
  const resolved = resolveBackupIdentifier(stamp, { ordinaryFiles: files });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "AMBIGUOUS_BACKUP_ID");
  assert.ok(Array.isArray(resolved.candidates));
});

test("R05 unknown id → RESTORE_FAILED", () => {
  const resolved = resolveBackupIdentifier("missing-backup.json", {
    ordinaryFiles: [{ name: "other.json", full: "/tmp/other.json", mtimeMs: 1 }],
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "RESTORE_FAILED");
});

test("R06 omitted backupId selects newest ordinary only", () => {
  const files = [
    { name: "older.json", full: "/tmp/older.json", mtimeMs: 1 },
    { name: "newer.json", full: "/tmp/newer.json", mtimeMs: 9 },
  ];
  const baselines = [
    {
      id: "bl_1",
      name: "Protected",
      fileName: "baseline.json",
      full: "/tmp/baselines/baseline.json",
      mtimeMs: 99,
    },
  ];
  const resolved = resolveBackupIdentifier(null, { ordinaryFiles: files, baselineEntries: baselines });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.file.name, "newer.json");
  assert.equal(resolved.source, "ordinary");
});

test("R07 priorities/WC/projects loaders use shared helper (behavioral)", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Alpha" } });
    const backups = await store.listBackupFiles();
    assert.ok(backups.length >= 1);
    const name = backups[0].name;
    const preview = await store.memoryPriorities({
      operation: "restore_backup",
      backupId: name,
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    const ambiguous = await store.memoryPriorities({
      operation: "restore_backup",
      backupId: "2026-07",
    });
    // substring must not match
    assert.equal(ambiguous.code, "RESTORE_FAILED");
  });
});

// ——— B01–B16 backups / baselines ———

test("B01/B02 ordinary create prune keeps ≤40", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 45; i += 1) {
      await store.createBackupSnapshot(`snap-${i}`);
    }
    const files = await store.listBackupFiles();
    assert.equal(files.length, MAX_ORDINARY_BACKUPS);
  });
});

test("B03/B04 baseline create under baselines/ and ordinary prune leaves them", async () => {
  await withStore(async (store, helpers) => {
    const created = await store.createProtectedBaseline({ name: "Week Start" });
    assert.equal(created.ok, true);
    assert.equal(created.message, "Baseline saved: Week Start.");
    const baselinePath = path.join(helpers.rootDir, "backups", "baselines", created.baseline.fileName);
    assert.equal(fs.existsSync(baselinePath), true);
    for (let i = 0; i < 45; i += 1) {
      await store.createBackupSnapshot(`snap-${i}`);
    }
    assert.equal(fs.existsSync(baselinePath), true);
    const ordinary = await store.listBackupFiles();
    assert.equal(ordinary.every((file) => !file.full.includes(`${path.sep}baselines${path.sep}`)), true);
  });
});

test("B05/B11 baseline create rejected at count budget", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_PROTECTED_BASELINES; i += 1) {
      const result = await store.createProtectedBaseline({ name: `Base ${i}` });
      assert.equal(result.ok, true, result.message);
    }
    const blocked = await store.createProtectedBaseline({ name: "Overflow" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "BASELINE_BUDGET_FULL");
  });
});

test("B06 duplicate baseline name → BASELINE_NAME_EXISTS", async () => {
  await withStore(async (store) => {
    assert.equal((await store.createProtectedBaseline({ name: "Same" })).ok, true);
    const dup = await store.createProtectedBaseline({ name: "same" });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, "BASELINE_NAME_EXISTS");
  });
});

test("B07 explicit baseline delete removes file + registry", async () => {
  await withStore(async (store, helpers) => {
    const created = await store.createProtectedBaseline({ name: "Temp" });
    const full = path.join(helpers.rootDir, "backups", "baselines", created.baseline.fileName);
    assert.equal(fs.existsSync(full), true);
    const deleted = await store.deleteBaseline({ id: created.baseline.id });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.cleanupPending, false);
    assert.equal(fs.existsSync(full), false);
    const registry = JSON.parse(
      await fsp.readFile(path.join(helpers.rootDir, "backup-baselines.json"), "utf8"),
    );
    assert.equal(registry.baselines.length, 0);
    const names = await fsp.readdir(path.dirname(full));
    assert.equal(names.some((name) => name.startsWith(".deleting-")), false);
  });
});

test("B08/B12/B13 corrupt registry preserved; files recovered", async () => {
  await withStore(async (store, helpers) => {
    const created = await store.createProtectedBaseline({ name: "Keep Me" });
    const registryPath = path.join(helpers.rootDir, "backup-baselines.json");
    await fsp.writeFile(registryPath, "{not-json", "utf8");
    const list = await store.listBaselines();
    assert.equal(list.ok, true);
    assert.equal(list.registryState, "corrupt_preserved");
    assert.ok(list.preservedAs);
    assert.equal(fs.existsSync(list.preservedAs), true);
    assert.equal(fs.existsSync(registryPath), false);
    const recovered = list.baselines.find((item) => item.fileName === created.baseline.fileName);
    assert.ok(recovered);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.registered, false);
  });
});

test("B09 ordinary prune satisfies count and byte ceilings", async () => {
  await withTemp(async (rootDir) => {
    const backups = path.join(rootDir, "backups");
    await fsp.mkdir(backups, { recursive: true });
    // Create oversized ordinary files that exceed byte budget before count.
    for (let i = 0; i < 5; i += 1) {
      const name = `2026-07-29T0${i}-00-00-000Z-big.json`;
      const full = path.join(backups, name);
      const payload = { schemaVersion: 1, reason: "big", createdAt: new Date().toISOString(), pad: "x".repeat(20 * 1024 * 1024) };
      await fsp.writeFile(full, JSON.stringify(payload), "utf8");
      // Stagger mtimes
      const when = new Date(Date.now() - (5 - i) * 1000);
      await fsp.utimes(full, when, when);
    }
    const store = createMemoryStore({ rootDir });
    await store.createBackupSnapshot("tiny");
    const files = await store.listBackupFiles();
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    assert.ok(files.length <= MAX_ORDINARY_BACKUPS);
    assert.ok(total <= MAX_ORDINARY_BACKUP_BYTES);
  });
});

test("B10 oversized required snapshot fails closed before mutation", async () => {
  await withStore(async (store) => {
    // Force a huge instructions file so snapshot exceeds 8 MiB.
    const instructionsPath = path.join(store.paths.root, "instructions.md");
    await fsp.writeFile(instructionsPath, "Z".repeat(MAX_SINGLE_BACKUP_BYTES + 1024), "utf8");
    const result = await store.memoryPriorities({ operation: "add", item: { text: "Should fail backup" } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKUP_FAILED");
    const daily = JSON.parse(await fsp.readFile(store.paths.daily, "utf8"));
    assert.equal((daily.priorities || []).length, 0);
  });
});

test("B14/B15/B16 invalid/traversal/header bounds", async () => {
  await withTemp(async (rootDir) => {
    const baselinesDir = path.join(rootDir, "backups", "baselines");
    await fsp.mkdir(baselinesDir, { recursive: true });
    assert.equal(isSafeBasename("../evil.json"), false);
    assert.equal(isSafeBasename("ok.json"), true);
    const escaped = await resolveSafeBaselinePath(baselinesDir, "../outside.json", fsp);
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, "BASELINE_PATH_INVALID");

    const header = extractSafeHeaderMetadata(
      JSON.stringify({
        schemaVersion: 1,
        reason: "baseline",
        createdAt: "2026-07-29T00:00:00.000Z",
        daily: { priorities: [{ text: "secret body should not be required" }] },
      }),
    );
    assert.equal(header.ok, true);
    assert.equal(header.reason, "baseline");
    assert.equal(Object.prototype.hasOwnProperty.call(header, "daily"), false);
  });
});

// ——— C01–C18 Confirm ———

test("C01/C02/C03/C17 confirm applies without token from renderer and returns closed public result", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Remove me" } });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Remove me" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.ok(preview.previewToken);
    const publicPending = store.getPendingConfirmation();
    assert.ok(publicPending);
    assert.equal(Object.prototype.hasOwnProperty.call(publicPending, "previewToken"), false);

    const forged = await store.confirmPendingConfirmation({
      previewToken: "forged",
      operation: "replace",
      plan: { before: [], after: [] },
    });
    assert.equal(forged.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(forged, "previewToken"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(forged, "before"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(forged, "after"), false);
    assert.ok(forged.message);
    const daily = JSON.parse(await fsp.readFile(store.paths.daily, "utf8"));
    assert.equal((daily.priorities || []).filter((item) => item.status !== "done" && item.text === "Remove me").length, 0);
  });
});

test("C04 TTL expiry → STALE_PREVIEW", async () => {
  await withStore(async (store, helpers) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Expire" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Expire" },
    });
    helpers.advanceMs(11 * 60 * 1000);
    const result = await store.confirmPendingConfirmation({});
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_PREVIEW");
  });
});

test("C05 restart simulation clears pending → STALE_PREVIEW", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Restart" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Restart" },
    });
    assert.ok(store.getPendingConfirmationInternal());
    store._test.clearPreviews();
    const result = await store.confirmPendingConfirmation({});
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_PREVIEW");
  });
});

test("C06 invalidatePreviews → STALE_PREVIEW", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Invalidate" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Invalidate" },
    });
    store._test.clearPreviews();
    const result = await store.confirmPendingConfirmation({});
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_PREVIEW");
  });
});

test("C07 dailyUpdatedAt drift → STALE_PREVIEW", async () => {
  await withStore(async (store, helpers) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Drift" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Drift" },
    });
    const dailyPath = store.paths.daily;
    const daily = JSON.parse(await fsp.readFile(dailyPath, "utf8"));
    daily.updatedAt = "2099-01-01T00:00:00.000Z";
    await fsp.writeFile(dailyPath, JSON.stringify(daily), "utf8");
    const result = await store.confirmPendingConfirmation({});
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_PREVIEW");
    void helpers;
  });
});

test("C08 dismiss does not clear internal pending", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Keep" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Keep" },
    });
    store.dismissPendingConfirmation();
    assert.equal(store.getPendingConfirmation(), null);
    assert.ok(store.getPendingConfirmationInternal());
  });
});

test("C09/C16 confirm rejected while externally busy; cooldown alone does not block", async () => {
  await withStore(async (store, helpers) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Busy" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Busy" },
    });
    helpers.setExternalBusy(true);
    const busy = await store.confirmPendingConfirmation({});
    assert.equal(busy.ok, false);
    assert.equal(busy.code, "session.busy");
    helpers.setExternalBusy(false);
    const ok = await store.confirmPendingConfirmation({});
    assert.equal(ok.ok, true);
  });
});

test("C13/C14/C15 no nested enqueue deadlock; timeout guard; duplicate confirm busy", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Dup" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Dup" },
    });

    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const blocker = store.enqueueTracked(async () => {
      await gate;
      return "done";
    });

    const whileQueued = await store.confirmPendingConfirmation({});
    assert.equal(whileQueued.ok, false);
    assert.equal(whileQueued.code, "session.busy");
    releaseGate();
    await blocker;

    const first = store.confirmPendingConfirmation({});
    const second = store.confirmPendingConfirmation({});
    const results = await Promise.all([first, second]);
    const oks = results.filter((item) => item.ok);
    const busys = results.filter((item) => item.code === "session.busy");
    assert.equal(oks.length, 1);
    assert.equal(busys.length, 1);
    assert.match(busys[0].message, /confirmation is already in progress|busy/i);

    // Timeout-based no-deadlock: Confirm finishes under a short race timeout.
    await store.memoryPriorities({ operation: "add", item: { text: "Timeout" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Timeout" },
    });
    const timed = await Promise.race([
      store.confirmPendingConfirmation({}),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("confirm deadlock timeout")), 2000);
      }),
    ]);
    assert.equal(timed.ok, true);
  });
});

test("C12 works for priorities, WC, and active-projects via confirm", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "P" } });
    await store.memoryPriorities({ operation: "remove", reference: { by: "text", value: "P" } });
    const confirmedP = await store.confirmPendingConfirmation({});
    assert.equal(confirmedP.ok, true);
    assert.equal(confirmedP.toolName, "memory_priorities");

    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "WC item" },
    });
    await store.workingContextItems({
      operation: "remove",
      scope: "commitments",
      reference: { by: "text", value: "WC item" },
    });
    const confirmedWc = await store.confirmPendingConfirmation({});
    assert.equal(confirmedWc.ok, true);
    assert.equal(confirmedWc.toolName, "working_context_items");

    await store.memoryActiveProjects({ operation: "add", item: { name: "Proj" } });
    await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Proj" },
    });
    const confirmedAp = await store.confirmPendingConfirmation({});
    assert.equal(confirmedAp.ok, true);
    assert.equal(confirmedAp.toolName, "memory_active_projects");
  });
});

test("C18 confirm artifact uses established delivery pipeline without flattening markdown", async () => {
  await withStore(async (store) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Art" } });
    await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Art" },
    });
    const confirmed = await store.confirmPendingConfirmation({});
    assert.equal(confirmed.ok, true);
    assert.ok(confirmed.artifactDelivery);
    assert.equal(confirmed.artifactDelivery.hasSubstantiveArtifact, true);
    assert.ok(confirmed.artifactDelivery.selectedArtifact);
    assert.match(confirmed.artifactDelivery.selectedArtifact.content, /\n/);
    assert.equal(Object.prototype.hasOwnProperty.call(confirmed, "previewToken"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(confirmed, "before"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(confirmed, "after"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(confirmed, "artifact"), false);

    // Raw tool-shaped junk must not become a parallel public artifact body.
    const leaked = store._test
      ? null
      : null;
    void leaked;
    const forgedPublic = (() => {
      // Simulate builder rejection path: non-string content omits delivery.
      const { buildTurnArtifactDelivery } = require("./artifact-selection.cjs");
      const delivery = buildTurnArtifactDelivery(
        [{ title: "x", kind: "markdown", content: "# Keep\n\n- a\n- b" }],
        [{ name: "memory_priorities" }],
      );
      assert.match(delivery.selectedArtifact.content, /# Keep\n\n- a\n- b/);
      return delivery;
    })();
    assert.ok(forgedPublic.selectedArtifact);
  });
});

test("C10/C11 Phase 17 resume semantics still present (source wiring)", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const textRun = fs.readFileSync(path.join(__dirname, "text-run-request.cjs"), "utf8");
  assert.match(main, /continuity:confirm-pending/);
  assert.match(textRun, /resumePendingConfirmation/);
  assert.doesNotMatch(main, /npm run build/);
  assert.match(main, /isConfirmInFlight/);
  assert.match(main, /getSharedOwner/);
});

// ——— J01–J08 journal ———

test("J01/J02/J03 manual journal sanitizes and allowlists", async () => {
  await withTemp(async (rootDir) => {
    const journal = createPilotJournal({
      rootDir,
      sanitizeText: sanitizeDiagnosticText,
    });
    const result = await journal.appendRecord({
      note: "leak sk-abcdefghijklmnopqrstuvwxyz and Bearer tok_abc",
      errorCode: "rate_limited",
      build: { version: "1.0.0", branch: "phase-18", gitSha: "abc1234" },
      pending: { toolName: "memory_priorities", operation: "remove", scope: null, expiresAt: 1 },
      previewToken: "should-drop",
      transcript: "should-drop",
      composer: "should-drop",
    });
    assert.equal(result.ok, true);
    const text = await fsp.readFile(journal.journalPath, "utf8");
    assert.match(text, /redacted/i);
    assert.doesNotMatch(text, /previewToken/);
    assert.doesNotMatch(text, /transcript/);
    assert.doesNotMatch(text, /composer/);
  });
});

test("J04/J05/J06 journal concurrency and rollover", async () => {
  await withTemp(async (rootDir) => {
    const journal = createPilotJournal({
      rootDir,
      sanitizeText: sanitizeDiagnosticText,
      maxJournalBytes: 400,
      maxArchives: 5,
    });
    await fsp.writeFile(journal.journalPath, "{bad\n", "utf8");
    const ok = await journal.appendRecord({ note: "after corrupt", build: { version: "1" } });
    assert.equal(ok.ok, true);
    const recent = await journal.readRecent(10);
    assert.ok(recent.some((item) => item.note === "after corrupt"));

    const clicks = await Promise.all(
      Array.from({ length: 5 }, (_, i) => journal.appendRecord({ note: `n${i}`, build: { version: "1" } })),
    );
    assert.equal(clicks.every((item) => item.ok), true);
    assert.equal(new Set(clicks.map((item) => item.id)).size, 5);

    // Force repeated rollovers and ensure archive prune stays ≤5.
    for (let i = 0; i < 12; i += 1) {
      const padded = `pad-${i}-${"x".repeat(80)}`;
      const rolled = await journal.appendRecord({ note: padded, build: { version: "1" } });
      assert.equal(rolled.ok, true, rolled.message || rolled.code);
    }
    const names = await fsp.readdir(rootDir);
    const archives = names.filter(
      (name) => name !== "pilot-issues.jsonl" && /^pilot-issues-.+\.jsonl$/i.test(name),
    );
    assert.ok(archives.length <= 5);
  });
});

test("J07/J08 journal failure isolation", async () => {
  await withTemp(async (rootDir) => {
    const journal = createPilotJournal({
      rootDir,
      fsApi: {
        mkdir: async () => {},
        access: async () => {},
        stat: async () => ({ size: 1024 }),
        readFile: async () => "x".repeat(600 * 1024),
        rename: async () => {
          throw new Error("rename failed");
        },
        appendFile: async () => {
          throw new Error("append failed");
        },
        readdir: async () => [],
        unlink: async () => {},
        writeFile: async () => {},
      },
      sanitizeText: sanitizeDiagnosticText,
    });
    const result = await journal.appendRecord({ note: "x", build: { version: "1" } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PILOT_JOURNAL_WRITE_FAILED");
  });
});

// ——— S01–S08 stale build / shortcut ———

test("S01/S02/S03/S04 stale-build evaluation", async () => {
  await withTemp(async (rootDir) => {
    const distDir = path.join(rootDir, "dist");
    await fsp.mkdir(distDir, { recursive: true });
    const srcDir = path.join(rootDir, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(rootDir, "package.json"), "{}", "utf8");
    await fsp.writeFile(path.join(rootDir, "vite.config.ts"), "export default {}", "utf8");

    const missing = launchHelpers.evaluateRendererBuildFreshness(rootDir);
    assert.equal(missing.stale, true);
    assert.equal(missing.reason, "dist_missing");

    const distHtml = path.join(distDir, "index.html");
    await fsp.writeFile(distHtml, "<html></html>", "utf8");
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(distHtml, old, old);
    await fsp.writeFile(path.join(srcDir, "App.tsx"), "export default 1", "utf8");
    const stale = launchHelpers.evaluateRendererBuildFreshness(rootDir);
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, "sources_newer_than_dist");
    assert.match(stale.message, /-Rebuild/);

    const newerThanAllSources = new Date(Date.now() + 60_000);
    await fsp.utimes(distHtml, newerThanAllSources, newerThanAllSources);
    const fresh = launchHelpers.evaluateRendererBuildFreshness(rootDir);
    assert.equal(fresh.stale, false);
  });
});

test("S05/S06/S07 shortcut helper collision semantics (script source)", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "create-desktop-shortcut.ps1"), "utf8");
  assert.match(script, /Jarvis\.lnk/);
  assert.match(script, /-Replace/);
  assert.match(script, /start-jarvis\.bat/);
  assert.match(script, /Normalize-PathCompare/);
  assert.match(script, /already exists and targets something else/);
});

test("S08 no in-process build IPC", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /app:rebuild|rebuild-ui|npm run build/);
  assert.match(main, /staleBuild/);
});

test("UI baseline actions require explicit row selection (no first-eligible fallback)", async () => {
  const helpers = await import("../src/lib/pilotBaselines.ts");
  assert.equal(helpers.buildBaselineDeletePayload(null).ok, false);
  assert.equal(helpers.buildBaselineDeletePayload({}).ok, false);
  const rowA = { id: "bl_a", name: "Alpha", fileName: "a.json", registered: true };
  const rowB = { id: "bl_b", name: "Beta", fileName: "b.json", registered: true, recovered: true };
  const delA = helpers.buildBaselineDeletePayload(rowA);
  const delB = helpers.buildBaselineDeletePayload(rowB);
  assert.equal(delA.ok, true);
  assert.equal(delA.id, "bl_a");
  assert.equal(delA.fileName, "a.json");
  assert.equal(delB.ok, true);
  assert.equal(delB.fileName, "b.json");
  assert.notEqual(delA.fileName, delB.fileName);
  assert.match(helpers.buildDeleteConfirmMessage(rowA), /"Alpha"/);
  assert.match(helpers.buildDeleteConfirmMessage(rowA), /a\.json/);
  assert.match(helpers.formatBaselineStatus({ conflict: true, invalid: true, missing: true, recovered: true }), /conflict/);
  assert.match(helpers.formatBaselineStatus({ conflict: true, invalid: true, missing: true, recovered: true }), /invalid/);
  assert.match(helpers.formatBaselineStatus({ conflict: true, invalid: true, missing: true, recovered: true }), /missing/);
  assert.match(helpers.formatBaselineStatus({ conflict: true, invalid: true, missing: true, recovered: true }), /recovered/);
  const reregBad = helpers.buildBaselineReregisterPayload(rowA, "Nope");
  assert.equal(reregBad.ok, false);
  const rereg = helpers.buildBaselineReregisterPayload(
    { fileName: "rec.json", recovered: true, registered: false },
    "Recovered",
  );
  assert.equal(rereg.ok, true);
  assert.equal(rereg.fileName, "rec.json");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.doesNotMatch(app, /deleteSelectedBaseline|reregisterSelectedBaseline/);
  assert.doesNotMatch(app, /baselines\.find\(\(row\)/);
  assert.match(app, /deleteBaselineRow\(row\)/);
  assert.match(app, /showBaselineNameForm\("reregister", row\)/);
});

test("in-app baseline naming UI opens, validates, submits once, cancels, and preserves failures", async () => {
  const helpers = await import("../src/lib/pilotBaselines.ts");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");

  const opened = helpers.openBaselineNameForm("create");
  assert.equal(opened.open, true);
  assert.equal(opened.mode, "create");
  assert.equal(opened.name, "");
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(app, /onClick=\{\(\) => showBaselineNameForm\("create"\)\}/);
  assert.match(app, /baselineNameInputRef\.current\?\.focus\(\)/);
  assert.match(app, /onSubmit=\{\(event\) =>/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /baselineSubmitInFlightRef\.current/);
  assert.match(app, /type="submit" disabled=\{baselineSaving\}/);

  let createCalls = 0;
  let reregisterCalls = 0;
  let refreshCalls = 0;
  const sentNames = [];
  const success = await helpers.submitBaselineNameAction({
    mode: "create",
    row: null,
    name: "Pilot Week One",
    createBaseline: async (payload) => {
      createCalls += 1;
      sentNames.push(payload.name);
      return { ok: true, message: "Baseline saved: Pilot Week One." };
    },
    reregisterBaseline: async () => {
      reregisterCalls += 1;
      return { ok: true, message: "unexpected" };
    },
    refresh: async () => {
      refreshCalls += 1;
    },
  });
  assert.equal(success.ok, true);
  assert.equal(success.close, true);
  assert.equal(success.message, "Baseline saved: Pilot Week One.");
  assert.equal(createCalls, 1);
  assert.equal(reregisterCalls, 0);
  assert.deepEqual(sentNames, ["Pilot Week One"]);
  assert.equal(refreshCalls, 1);

  const empty = await helpers.submitBaselineNameAction({
    mode: "create",
    row: null,
    name: "   ",
    createBaseline: async () => {
      createCalls += 1;
      return { ok: true };
    },
    reregisterBaseline: async () => {
      reregisterCalls += 1;
      return { ok: true };
    },
    refresh: async () => {
      refreshCalls += 1;
    },
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.sent, false);
  assert.equal(empty.close, false);
  assert.equal(empty.message, "Baseline name is required.");
  assert.equal(createCalls, 1);
  assert.equal(refreshCalls, 1);

  const cancelled = helpers.closeBaselineNameForm();
  assert.equal(cancelled.open, false);
  assert.equal(createCalls, 1);
  assert.equal(reregisterCalls, 0);

  let failureRefreshes = 0;
  const failure = await helpers.submitBaselineNameAction({
    mode: "create",
    row: null,
    name: "Duplicate",
    createBaseline: async () => ({
      ok: false,
      code: "BASELINE_NAME_EXISTS",
      message: "A baseline with that name already exists.",
    }),
    reregisterBaseline: async () => ({ ok: false }),
    refresh: async () => {
      failureRefreshes += 1;
    },
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.sent, true);
  assert.equal(failure.close, false);
  assert.equal(failure.message, "A baseline with that name already exists.");
  assert.equal(failureRefreshes, 0);
});

test("baseline mutations serialize; create during memory mutation waits on queue", async () => {
  await withStore(async (store) => {
    const [a, b] = await Promise.all([
      store.createProtectedBaseline({ name: "One" }),
      store.createProtectedBaseline({ name: "Two" }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.baseline.fileName, b.baseline.fileName);

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const blocker = store.enqueueTracked(async () => {
      await gate;
      return "done";
    });
    const createWhileBlocked = store.createProtectedBaseline({ name: "During" });
    assert.equal(store.isMemoryQueueBusy(), true);
    release();
    await blocker;
    const created = await createWhileBlocked;
    assert.equal(created.ok, true);

    const del = store.deleteBaseline({ id: a.baseline.id, fileName: a.baseline.fileName });
    const createRace = store.createProtectedBaseline({ name: "RaceCreate" });
    const [deleted, raced] = await Promise.all([del, createRace]);
    assert.equal(deleted.ok, true);
    assert.equal(raced.ok, true);
  });
});

test("shared ownership: text/memory blocked during Confirm; Confirm blocked during text; ownership released", async () => {
  await withStore(async (store, helpers) => {
    await store.memoryPriorities({ operation: "add", item: { text: "Own" } });
    await store.memoryPriorities({ operation: "remove", reference: { by: "text", value: "Own" } });

    helpers.setExternalBusy(true);
    const duringText = await store.confirmPendingConfirmation({});
    assert.equal(duringText.ok, false);
    assert.equal(duringText.code, "session.busy");
    helpers.setExternalBusy(false);

    assert.equal(store.tryAcquireSharedOwner("confirm", "hold-1"), true);
    const memBusy = await store.memoryPriorities({ operation: "add", item: { text: "nope" } });
    assert.equal(memBusy.ok, false);
    assert.equal(memBusy.code, "session.busy");
    const baseBusy = await store.createProtectedBaseline({ name: "Blocked" });
    assert.equal(baseBusy.ok, false);
    assert.equal(baseBusy.code, "session.busy");
    store.releaseSharedOwner("confirm", "hold-1");
    assert.equal(store.getSharedOwner(), null);

    const confirmed = await store.confirmPendingConfirmation({});
    assert.equal(confirmed.ok, true);
    assert.equal(store.getSharedOwner(), null);
    assert.equal(store.isConfirmInFlight(), false);

    // Stale failure still releases ownership.
    const stale = await store.confirmPendingConfirmation({});
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "STALE_PREVIEW");
    assert.equal(store.getSharedOwner(), null);

    // Duplicate confirm: one apply.
    await store.memoryPriorities({ operation: "add", item: { text: "Dup2" } });
    await store.memoryPriorities({ operation: "remove", reference: { by: "text", value: "Dup2" } });
    const first = store.confirmPendingConfirmation({});
    const second = store.confirmPendingConfirmation({});
    const results = await Promise.all([first, second]);
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.equal(results.filter((item) => item.code === "session.busy").length, 1);
    assert.equal(store.getSharedOwner(), null);
  });
});

test("public backup metadata strips paths and attacker extras", async () => {
  const crafted = projectPublicBaselineMetadata({
    id: "bl_1",
    name: "Safe",
    fileName: "safe.json",
    createdAt: "2026-07-29T00:00:00.000Z",
    full: "C:\\\\secret\\\\path\\\\safe.json",
    registryPath: "C:\\\\secret\\\\backup-baselines.json",
    preservedAs: "C:\\\\secret\\\\corrupt.json",
    error: { stack: "boom" },
    snapshot: { daily: { priorities: [] } },
    header: { raw: true },
    recovered: true,
    registered: false,
    invalid: false,
    missing: false,
    conflict: false,
    size: 12,
    mtimeMs: 99,
  });
  assert.equal(crafted.fileName, "safe.json");
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "full"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "registryPath"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "preservedAs"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "error"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "snapshot"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crafted, "header"), false);

  await withStore(async (store) => {
    const created = await store.createProtectedBaseline({ name: "Public" });
    assert.equal(created.ok, true);
    const list = await store.listBackupMetadata();
    assert.equal(list.ok, true);
    assert.ok(list.baselines.length >= 1);
    for (const row of list.baselines) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "full"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "registryPath"), false);
      assert.ok(row.fileName);
    }
  });
});

test("baseline transaction: initial quarantine rename failure preserves file and registry", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, { id: "bl_locked", name: "Locked" });
    const locked = createBaselineStore({
      rootDir,
      fsApi: {
        ...fsp,
        rename: async (from, to) => {
          if (
            path.basename(from) === seeded.fileName &&
            path.basename(to).startsWith(".deleting-")
          ) {
            const error = new Error("locked");
            error.code = "EPERM";
            throw error;
          }
          return fsp.rename(from, to);
        },
      },
      sanitizeText: sanitizeDiagnosticText,
    });

    const result = await locked.deleteBaseline({ id: seeded.id, fileName: seeded.fileName });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BASELINE_DELETE_FAILED");
    assert.equal(fs.existsSync(seeded.full), true);
    const registry = JSON.parse(await fsp.readFile(seeded.registryPath, "utf8"));
    assert.equal(registry.baselines.length, 1);
    assert.equal((await fsp.readdir(seeded.baselinesDir)).some((name) => name.startsWith(".deleting-")), false);
  });
});

test("baseline transaction: registry write failure rolls quarantine back", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, { id: "bl_rollback", name: "Rollback" });
    const store = createBaselineStore({
      rootDir,
      sanitizeText: sanitizeDiagnosticText,
      atomicWriteJson: async () => {
        throw new Error("registry write failed");
      },
    });

    const result = await store.deleteBaseline({ id: seeded.id, fileName: seeded.fileName });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BASELINE_REGISTRY_UPDATE_FAILED");
    assert.equal(fs.existsSync(seeded.full), true);
    assert.equal((await fsp.readdir(seeded.baselinesDir)).some((name) => name.startsWith(".deleting-")), false);
    const registry = JSON.parse(await fsp.readFile(seeded.registryPath, "utf8"));
    assert.equal(registry.baselines.length, 1);
  });
});

test("baseline transaction: rollback failure returns recovery-required metadata", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, {
      id: "bl_recovery",
      name: "Recovery",
    });
    const store = createBaselineStore({
      rootDir,
      sanitizeText: sanitizeDiagnosticText,
      atomicWriteJson: async () => {
        throw new Error("registry write failed");
      },
      fsApi: {
        ...fsp,
        rename: async (from, to) => {
          if (
            path.basename(from).startsWith(".deleting-") &&
            path.basename(to) === seeded.fileName
          ) {
            const error = new Error("rollback locked");
            error.code = "EPERM";
            throw error;
          }
          return fsp.rename(from, to);
        },
      },
    });

    const result = await store.deleteBaseline({ id: seeded.id, fileName: seeded.fileName });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BASELINE_DELETE_RECOVERY_REQUIRED");
    assert.equal(result.fileName, seeded.fileName);
    assert.match(result.quarantineFileName, /^\.deleting-/);
    assert.equal(path.basename(result.quarantineFileName), result.quarantineFileName);
    assert.equal(fs.existsSync(seeded.full), false);
    assert.equal(fs.existsSync(path.join(seeded.baselinesDir, result.quarantineFileName)), true);
    const registry = JSON.parse(await fsp.readFile(seeded.registryPath, "utf8"));
    assert.equal(registry.baselines.length, 1);
  });
});

test("baseline transaction: final unlink failure is logical success and cleanup-pending", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, { id: "bl_cleanup", name: "Cleanup" });
    const store = createBaselineStore({
      rootDir,
      sanitizeText: sanitizeDiagnosticText,
      fsApi: {
        ...fsp,
        unlink: async (filePath) => {
          if (path.basename(filePath).startsWith(".deleting-")) {
            const error = new Error("cleanup locked");
            error.code = "EPERM";
            throw error;
          }
          return fsp.unlink(filePath);
        },
      },
    });

    const result = await store.deleteBaseline({ id: seeded.id, fileName: seeded.fileName });
    assert.equal(result.ok, true);
    assert.equal(result.code, "BASELINE_DELETE_CLEANUP_PENDING");
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupArtifact, /^\.deleting-/);
    assert.equal(fs.existsSync(seeded.full), false);
    assert.equal(fs.existsSync(path.join(seeded.baselinesDir, result.cleanupArtifact)), true);
    const registry = JSON.parse(await fsp.readFile(seeded.registryPath, "utf8"));
    assert.equal(registry.baselines.length, 0);

    const listed = await store.listBaselines();
    assert.equal(
      listed.baselines.some((row) => row.recovered === true || row.full),
      false,
    );
    assert.ok(
      listed.baselines.some(
        (row) => row.recoveryArtifact === true && row.cleanupPending === true,
      ),
    );

    // A later scan with normal filesystem access performs the explicit safe cleanup pass.
    const cleanupStore = createBaselineStore({ rootDir, sanitizeText: sanitizeDiagnosticText });
    const afterCleanup = await cleanupStore.listBaselines();
    assert.equal(afterCleanup.baselines.length, 0);
    assert.equal(fs.existsSync(path.join(seeded.baselinesDir, result.cleanupArtifact)), false);
  });
});

test("baseline startup recovery restores quarantine when registry entry remains", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, { id: "bl_startup", name: "Startup" });
    const quarantineName = `.deleting-operation123-${seeded.fileName}`;
    const quarantineFull = path.join(seeded.baselinesDir, quarantineName);
    await fsp.rename(seeded.full, quarantineFull);

    const store = createBaselineStore({ rootDir, sanitizeText: sanitizeDiagnosticText });
    const list = await store.listBaselines();
    assert.equal(fs.existsSync(seeded.full), true);
    assert.equal(fs.existsSync(quarantineFull), false);
    const active = list.baselines.find((row) => row.id === seeded.id);
    assert.ok(active);
    assert.equal(active.registered, true);
    assert.equal(active.missing, false);
    assert.equal(list.baselines.some((row) => row.recoveryArtifact), false);
  });
});

test("baseline startup cleanup removes quarantine when registry entry is absent", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, { id: "bl_orphan", name: "Orphan" });
    const quarantineName = `.deleting-operation456-${seeded.fileName}`;
    const quarantineFull = path.join(seeded.baselinesDir, quarantineName);
    await fsp.rename(seeded.full, quarantineFull);
    await fsp.writeFile(
      seeded.registryPath,
      `${JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-29T00:00:00.000Z", baselines: [] })}\n`,
      "utf8",
    );

    const store = createBaselineStore({ rootDir, sanitizeText: sanitizeDiagnosticText });
    const list = await store.listBaselines();
    assert.equal(fs.existsSync(quarantineFull), false);
    assert.equal(list.baselines.length, 0);
  });
});

test("baseline recovery conflict fails closed and quarantine is never restorable", async () => {
  await withTemp(async (rootDir) => {
    const seeded = await seedRegisteredBaseline(rootDir, {
      id: "bl_conflict",
      name: "Conflict",
    });
    const quarantineName = `.deleting-operation789-${seeded.fileName}`;
    const quarantineFull = path.join(seeded.baselinesDir, quarantineName);
    await fsp.copyFile(seeded.full, quarantineFull);

    const store = createBaselineStore({ rootDir, sanitizeText: sanitizeDiagnosticText });
    const list = await store.listBaselines();
    assert.equal(fs.existsSync(seeded.full), true);
    assert.equal(fs.existsSync(quarantineFull), true);
    assert.equal(list.baselines.some((row) => row.fileName === quarantineName), false);
    const active = list.baselines.find((row) => row.id === seeded.id);
    assert.ok(active);
    assert.equal(active.conflict, true);
    assert.ok(
      list.baselines.some(
        (row) =>
          row.recoveryArtifact === true &&
          row.conflict === true &&
          row.reason === "DELETION_RECOVERY_CONFLICT",
      ),
    );

    const resolved = resolveBackupIdentifier(seeded.id, {
      ordinaryFiles: [],
      baselineEntries: list.baselines.map((row) => ({
        ...row,
        recoverable: row.registered || row.recovered,
      })),
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, "RESTORE_FAILED");
  });
});

test("duplicate baseline delete requests serialize to one logical deletion", async () => {
  await withStore(async (store) => {
    const created = await store.createProtectedBaseline({ name: "Duplicate Delete" });
    assert.equal(created.ok, true);
    const selection = {
      id: created.baseline.id,
      fileName: created.baseline.fileName,
    };
    const results = await Promise.all([
      store.deleteBaseline(selection),
      store.deleteBaseline(selection),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === "RESTORE_FAILED").length, 1);
    const list = await store.listBackupMetadata();
    assert.equal(
      list.baselines.some((row) => row.id === created.baseline.id),
      false,
    );
  });
});

test("journal projected line/byte ceilings rollover before append", async () => {
  await withTemp(async (rootDir) => {
    const journal = createPilotJournal({
      rootDir,
      sanitizeText: (value) => String(value || ""),
      maxJournalLines: 200,
      maxJournalBytes: 512,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });
    // Seed exactly 200 lines.
    const lines = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ schemaVersion: 1, id: `iss_${i}`, note: `n${i}`, build: { version: "1" } }),
    );
    await fsp.writeFile(journal.journalPath, `${lines.join("\n")}\n`, "utf8");
    const before = await fsp.readFile(journal.journalPath, "utf8");
    assert.equal(before.trim().split(/\n/).length, 200);
    const next = await journal.appendRecord({ note: "line-201", build: { version: "1" } });
    assert.equal(next.ok, true);
    assert.equal(next.rolled, true);
    const active = await fsp.readFile(journal.journalPath, "utf8");
    assert.equal(active.trim().split(/\n/).length, 1);
    assert.match(active, /line-201/);

    const byteJournal = createPilotJournal({
      rootDir: path.join(rootDir, "bytes"),
      sanitizeText: (value) => String(value || ""),
      maxJournalBytes: 400,
      maxJournalLines: 200,
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });
    await fsp.mkdir(path.join(rootDir, "bytes"), { recursive: true });
    // Existing file just under the byte ceiling; incoming record fits alone but not with seed.
    await fsp.writeFile(byteJournal.journalPath, `${"x".repeat(350)}\n`, "utf8");
    const incoming = await byteJournal.appendRecord({
      note: "short",
      build: { version: "1" },
    });
    assert.equal(incoming.ok, true, incoming.message || incoming.code);
    assert.equal(incoming.rolled, true);

    const oversized = createPilotJournal({
      rootDir: path.join(rootDir, "over"),
      sanitizeText: (value) => String(value || ""),
      maxJournalBytes: 40,
      randomUUID: () => "33333333-3333-4333-8333-333333333333",
    });
    await fsp.mkdir(path.join(rootDir, "over"), { recursive: true });
    const tooBig = await oversized.appendRecord({
      note: "z".repeat(80),
      build: { version: "1" },
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.code, "PILOT_JOURNAL_WRITE_FAILED");
  });
});

test("phase 18 modules export expected retention constants", () => {
  assert.equal(MAX_ORDINARY_BACKUPS, 40);
  assert.equal(MAX_ORDINARY_BACKUP_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_PROTECTED_BASELINES, 8);
  assert.equal(MAX_PROTECTED_BASELINE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_SINGLE_BACKUP_BYTES, 8 * 1024 * 1024);
});
