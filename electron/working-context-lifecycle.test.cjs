"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore } = require("./memory.cjs");
const {
  resolveWorkingContextReference,
  canonicalizeItems,
  isFutureDeferred,
} = require("./working-context-lifecycle.cjs");

const root = path.join(__dirname, "..");

async function withStore(run, options = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-wc-"));
  const clock = {
    value: options.startDate ? new Date(options.startDate) : new Date("2026-07-22T15:00:00.000Z"),
  };
  let uuidSeq = 0;
  const store = createMemoryStore({
    rootDir,
    now: () => new Date(clock.value.getTime()),
    randomUUID:
      options.randomUUID ||
      (() => {
        uuidSeq += 1;
        return `11111111-1111-4111-8111-${String(uuidSeq).padStart(12, "0")}`;
      }),
    failBackup: options.failBackup,
    failAtomicWrite: options.failAtomicWrite,
    failReread: options.failReread,
  });
  try {
    return await run(store, {
      rootDir,
      setDate: (iso) => {
        clock.value = new Date(iso);
      },
      tick: (ms = 1000) => {
        clock.value = new Date(clock.value.getTime() + ms);
      },
    });
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

async function confirmOp(store, args) {
  const preview = await store.workingContextItems({ ...args, confirmed: false });
  assert.equal(preview.code, "CONFIRMATION_REQUIRED");
  assert.ok(preview.previewToken);
  const confirmed = await store.workingContextItems({
    ...args,
    confirmed: true,
    previewToken: preview.previewToken,
  });
  return { preview, confirmed };
}

function texts(result) {
  return (result.items || []).map((item) => item.text);
}

test("list each scope returns artifact and ordered list", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Commitment A" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Follow-up A" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      item: { text: "Unresolved A" },
    });

    const c = await store.workingContextItems({ operation: "list", scope: "commitments" });
    const f = await store.workingContextItems({ operation: "list", scope: "follow_ups" });
    const u = await store.workingContextItems({ operation: "list", scope: "unresolved_items" });
    assert.equal(c.ok, true);
    assert.equal(c.artifact.title, "Commitments");
    assert.deepEqual(texts(c), ["Commitment A"]);
    assert.equal(f.artifact.title, "Follow-ups");
    assert.deepEqual(texts(f), ["Follow-up A"]);
    assert.equal(u.artifact.title, "Unresolved Items");
    assert.deepEqual(texts(u), ["Unresolved A"]);
  });
});

test("add one and several; insert by position; edit keeps id", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const one = await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "First" },
    });
    assert.equal(one.ok, true);
    assert.ok(one.items[0].createdAt);
    assert.ok(one.items[0].updatedAt);
    assert.ok(one.backupId);

    const several = await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [{ text: "Second" }, { text: "Third" }],
    });
    assert.deepEqual(texts(several), ["First", "Second", "Third"]);

    const inserted = await store.workingContextItems({
      operation: "insert",
      scope: "commitments",
      atPosition: 2,
      item: { text: "Inserted" },
    });
    assert.deepEqual(texts(inserted), ["First", "Inserted", "Second", "Third"]);
    const id = inserted.items[1].id;

    const edited = await store.workingContextItems({
      operation: "edit",
      scope: "commitments",
      reference: { by: "text", value: "Inserted" },
      item: { text: "Inserted edited" },
    });
    assert.equal(edited.items[1].id, id);
    assert.equal(edited.items[1].text, "Inserted edited");
  });
});

test("complete sets completedAt; reopen clears it", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Call Cecilia" },
    });
    const done = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "text", value: "Cecilia" },
    });
    assert.equal(done.items[0].status, "done");
    assert.ok(done.items[0].completedAt);
    const id = done.items[0].id;

    const reopened = await store.workingContextItems({
      operation: "reopen",
      scope: "follow_ups",
      reference: { by: "text", value: "Cecilia" },
    });
    assert.equal(reopened.items[0].status, "open");
    assert.equal(reopened.items[0].completedAt, null);
    assert.equal(reopened.items[0].id, id);
  });
});

test("remove, replace, clear_completed require confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      items: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
    });
    const { confirmed: removed } = await confirmOp(store, {
      operation: "remove",
      scope: "unresolved_items",
      reference: { by: "ordinal", value: 2 },
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(texts(removed), ["One", "Three"]);

    const { confirmed: replaced } = await confirmOp(store, {
      operation: "replace",
      scope: "unresolved_items",
      items: [{ text: "Alpha" }, { text: "Beta" }],
    });
    assert.deepEqual(texts(replaced), ["Alpha", "Beta"]);

    await store.workingContextItems({
      operation: "complete",
      scope: "unresolved_items",
      reference: { by: "text", value: "Alpha" },
    });
    const { confirmed: cleared } = await confirmOp(store, {
      operation: "clear_completed",
      scope: "unresolved_items",
    });
    assert.deepEqual(texts(cleared), ["Beta"]);
  });
});

test("simple and full reorder preserve ids", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [{ text: "A" }, { text: "B" }, { text: "C" }],
    });
    const before = await store.loadAll();
    const ids = before.daily.commitments.map((item) => item.id);

    const moved = await store.workingContextItems({
      operation: "reorder",
      scope: "commitments",
      reference: { by: "text", value: "C" },
      atPosition: 1,
    });
    assert.deepEqual(texts(moved), ["C", "A", "B"]);
    assert.deepEqual(
      moved.items.map((item) => item.id).sort(),
      [...ids].sort(),
    );

    const full = await store.workingContextItems({
      operation: "reorder",
      scope: "commitments",
      order: [{ by: "text", value: "A" }, { by: "text", value: "B" }, { by: "text", value: "C" }],
    });
    assert.deepEqual(texts(full), ["A", "B", "C"]);
  });
});

test("defer, change defer, clear defer, and list filters", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [
        { text: "Due today", due: "2026-07-22" },
        { text: "Due tomorrow", due: "2026-07-23" },
        { text: "Due Friday", due: "2026-07-24" },
        { text: "Overdue", due: "2026-07-20" },
        { text: "No date" },
      ],
    });

    await store.workingContextItems({
      operation: "defer",
      scope: "commitments",
      reference: { by: "text", value: "No date" },
      deferredUntil: "2026-07-28",
    });

    const open = await store.workingContextItems({ operation: "list", scope: "commitments" });
    assert.equal(texts(open).includes("No date"), false);

    const deferred = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "deferred",
    });
    assert.deepEqual(texts(deferred), ["No date"]);

    await store.workingContextItems({
      operation: "defer",
      scope: "commitments",
      reference: { by: "text", value: "No date" },
      deferredUntil: "2026-07-29",
      listScope: "deferred",
    });

    await store.workingContextItems({
      operation: "clear_defer",
      scope: "commitments",
      reference: { by: "text", value: "No date" },
      listScope: "deferred",
    });
    const afterClear = await store.workingContextItems({ operation: "list", scope: "commitments" });
    assert.equal(texts(afterClear).includes("No date"), true);

    const overdue = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "overdue",
    });
    assert.deepEqual(texts(overdue), ["Overdue"]);

    const today = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "due_today",
    });
    assert.deepEqual(texts(today), ["Due today"]);

    const tomorrow = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "due_tomorrow",
    });
    assert.deepEqual(texts(tomorrow), ["Due tomorrow"]);

    const week = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "due_this_week",
    });
    assert.ok(texts(week).includes("Due today"));
    assert.ok(texts(week).includes("Due Friday"));

    const noDate = await store.workingContextItems({
      operation: "list",
      scope: "commitments",
      filter: "no_due_date",
    });
    assert.deepEqual(texts(noDate), ["No date"]);
  });
});

test("deferred item reappears when date arrives and rolls forward", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Deferred scanner" },
    });
    await store.workingContextItems({
      operation: "defer",
      scope: "follow_ups",
      reference: { by: "text", value: "scanner" },
      deferredUntil: "2026-07-23",
    });
    const hidden = await store.workingContextItems({ operation: "list", scope: "follow_ups" });
    assert.deepEqual(texts(hidden), []);

    helpers.setDate("2026-07-23T12:00:00.000Z");
    const rolled = await store.rolloverDailyIfNeeded();
    assert.equal(rolled.rolled, true);
    assert.equal(rolled.daily.followUps[0].text, "Deferred scanner");
    assert.equal(rolled.daily.followUps[0].deferredUntil, "2026-07-23");
    const visible = await store.workingContextItems({ operation: "list", scope: "follow_ups" });
    assert.deepEqual(texts(visible), ["Deferred scanner"]);
  });
});

test("set, change, and clear due dates", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Website draft" },
    });
    const set = await store.workingContextItems({
      operation: "set_due_date",
      scope: "commitments",
      reference: { by: "text", value: "Website" },
      dueDate: "2026-07-25",
    });
    assert.equal(set.items[0].due, "2026-07-25");
    const changed = await store.workingContextItems({
      operation: "set_due_date",
      scope: "commitments",
      reference: { by: "text", value: "Website" },
      dueDate: "tomorrow",
    });
    assert.equal(changed.items[0].due, "2026-07-23");
    const cleared = await store.workingContextItems({
      operation: "clear_due_date",
      scope: "commitments",
      reference: { by: "text", value: "Website" },
    });
    assert.equal(cleared.items[0].due, null);
  });
});

test("conversions preserve id and require confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      item: { text: "Email access", note: "blocked" },
    });
    const before = await store.loadAll();
    const id = before.daily.unresolved[0].id;

    const { confirmed } = await confirmOp(store, {
      operation: "convert",
      scope: "unresolved_items",
      destinationScope: "commitments",
      reference: { by: "text", value: "Email" },
    });
    assert.equal(confirmed.ok, true);
    const after = await store.loadAll();
    assert.equal(after.daily.unresolved.length, 0);
    assert.equal(after.daily.commitments[0].id, id);
    assert.equal(after.daily.commitments[0].previousScope, "unresolved_items");
    assert.equal(after.daily.commitments[0].originScope, "unresolved_items");
    assert.ok(after.daily.commitments[0].convertedAt);

    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Website copy" },
    });
    const fuId = (await store.loadAll()).daily.followUps[0].id;
    const { confirmed: toCommitment } = await confirmOp(store, {
      operation: "convert",
      scope: "follow_ups",
      destinationScope: "commitments",
      reference: { by: "text", value: "Website" },
    });
    assert.equal(toCommitment.ok, true);
    assert.equal((await store.loadAll()).daily.commitments.some((item) => item.id === fuId), true);

    const { confirmed: toFollowUp } = await confirmOp(store, {
      operation: "convert",
      scope: "commitments",
      destinationScope: "follow_ups",
      reference: { by: "id", value: id },
    });
    assert.equal(toFollowUp.ok, true);

    const invalid = await store.workingContextItems({
      operation: "convert",
      scope: "commitments",
      destinationScope: "commitments",
      reference: { by: "ordinal", value: 1 },
    });
    assert.equal(invalid.code, "INVALID_CONVERSION");
  });
});

test("promote_to_priority linkage and no auto-complete either side", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Review homepage" },
    });
    const promoted = await store.workingContextItems({
      operation: "promote_to_priority",
      scope: "follow_ups",
      reference: { by: "text", value: "homepage" },
    });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.items[0].status, "open");
    assert.ok(promoted.items[0].linkedPriorityId);
    assert.ok(promoted.linked?.[0]?.priorityId);

    const daily = await store.loadAll();
    const priority = daily.daily.priorities.find((item) => item.id === promoted.items[0].linkedPriorityId);
    assert.ok(priority);
    assert.equal(priority.sourceScope, "follow_ups");
    assert.equal(priority.sourceId, promoted.items[0].id);

    const dup = await store.workingContextItems({
      operation: "promote_to_priority",
      scope: "follow_ups",
      reference: { by: "text", value: "homepage" },
    });
    assert.equal(dup.code, "ALREADY_PROMOTED");

    await store.memoryPriorities({
      operation: "complete",
      reference: { by: "id", value: priority.id },
      listScope: "all",
    });
    const afterPriorityDone = await store.loadAll();
    assert.equal(afterPriorityDone.daily.followUps[0].status, "open");
    assert.equal(afterPriorityDone.daily.priorities[0].status, "done");

    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Greg draft" },
    });
    const promotedC = await store.workingContextItems({
      operation: "promote_to_priority",
      scope: "commitments",
      reference: { by: "text", value: "Greg" },
    });
    assert.equal(promotedC.ok, true);
    await store.workingContextItems({
      operation: "complete",
      scope: "commitments",
      reference: { by: "text", value: "Greg" },
    });
    const afterSourceDone = await store.loadAll();
    const linkedPriority = afterSourceDone.daily.priorities.find(
      (item) => item.id === afterSourceDone.daily.commitments.find((c) => c.text === "Greg draft").linkedPriorityId,
    );
    assert.equal(linkedPriority.status, "open");
  });
});

test("reference resolution: ordinal, person, project, due, recent, ambiguous, missing, duplicate", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      items: [
        { text: "Call Cecilia about website", relatedPerson: "Cecilia", relatedProject: "Website" },
        { text: "Email Justin about website", relatedPerson: "Justin", relatedProject: "Website", due: "2026-07-25" },
        { text: "Other task" },
      ],
    });

    const byOrdinal = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "ordinal", value: 2 },
    });
    assert.equal(byOrdinal.items[1].status, "done");

    await store.workingContextItems({
      operation: "reopen",
      scope: "follow_ups",
      reference: { by: "ordinal", value: 1 },
    });

    const byPerson = await store.workingContextItems({
      operation: "edit",
      scope: "follow_ups",
      reference: { by: "person", value: "Cecilia" },
      item: { text: "Call Cecilia about homepage" },
    });
    assert.match(byPerson.items[0].text, /homepage/);

    const byProjectAmbiguous = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "project", value: "Website" },
    });
    assert.equal(byProjectAmbiguous.code, "AMBIGUOUS_MATCH");

    const byDue = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "due", value: "2026-07-25" },
    });
    assert.equal(byDue.items.find((item) => item.due === "2026-07-25").status, "done");

    store._test.setRecentWcId("follow_ups", byPerson.items[0].id);
    const recent = await store.workingContextItems({
      operation: "edit",
      scope: "follow_ups",
      reference: "recent",
      item: { text: "Call Cecilia about homepage copy" },
    });
    assert.match(recent.items[0].text, /homepage copy/);

    const missing = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "text", value: "does-not-exist" },
    });
    assert.equal(missing.code, "NOT_FOUND");
    const missingRetry = await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "text", value: "does-not-exist" },
    });
    assert.equal(missingRetry.suppressedRetry, true);

    const dup = await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Other task" },
    });
    assert.equal(dup.code, "DUPLICATE_TEXT");
  });
});

test("stale preview, stale write, invalid date/status, backup and write failures", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [{ text: "A" }, { text: "B" }],
    });
    const preview = await store.workingContextItems({
      operation: "remove",
      scope: "commitments",
      reference: { by: "text", value: "A" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");

    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "C" },
    });
    const stale = await store.workingContextItems({
      operation: "remove",
      scope: "commitments",
      reference: { by: "text", value: "A" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stale.code, "STALE_PREVIEW");

    const listed = await store.workingContextItems({ operation: "list", scope: "commitments" });
    const staleWrite = await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "D" },
      expectedUpdatedAt: "not-the-current-timestamp",
    });
    assert.equal(staleWrite.code, "STALE_WRITE");
    assert.ok(listed.dailyUpdatedAt);

    const badDate = await store.workingContextItems({
      operation: "set_due_date",
      scope: "commitments",
      reference: { by: "text", value: "A" },
      dueDate: "Friday",
    });
    assert.equal(badDate.code, "INVALID_DATE");
  });

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.workingContextItems({
        operation: "add",
        scope: "commitments",
        item: { text: "Backup fail" },
      });
      assert.equal(failed.code, "BACKUP_FAILED");
    },
    { failBackup: () => true },
  );

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.workingContextItems({
        operation: "add",
        scope: "commitments",
        item: { text: "Write fail" },
      });
      assert.equal(failed.code, "WRITE_FAILED");
    },
    { failAtomicWrite: () => true },
  );

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.workingContextItems({
        operation: "add",
        scope: "commitments",
        item: { text: "Reread fail" },
      });
      assert.equal(failed.code, "WRITE_FAILED");
    },
    { failReread: () => true },
  );
});

test("scoped restore only; unrelated fields unchanged", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({
      summary: "Keep me",
      activeProjects: [{ name: "Project X" }],
    });
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Original commitment" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Keep follow-up" },
    });
    await store.memoryPriorities({
      operation: "add",
      item: { text: "Keep priority" },
    });
    const backups = await store.listBackupFiles();
    assert.ok(backups.length > 0);

    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Changed commitment" },
    });

    const { confirmed } = await confirmOp(store, {
      operation: "restore_backup",
      scope: "commitments",
      backupId: backups[0].name,
    });
    assert.equal(confirmed.ok, true);
    const end = await store.loadAll();
    assert.equal(end.daily.summary, "Keep me");
    assert.equal(end.daily.activeProjects[0].name, "Project X");
    assert.equal(end.daily.followUps[0].text, "Keep follow-up");
    assert.equal(end.daily.priorities[0].text, "Keep priority");
    assert.equal(end.daily.commitments.some((item) => item.text === "Changed commitment"), false);
  });
});

test("memory_update_daily lifecycle arrays rejected", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const rejected = await store.memoryUpdateDaily({
      commitments: [{ text: "Nope" }],
    });
    assert.equal(rejected.code, "USE_WORKING_CONTEXT_ITEMS");
    const rejectedFu = await store.memoryUpdateDaily({
      followUps: [{ text: "Nope" }],
    });
    assert.equal(rejectedFu.code, "USE_WORKING_CONTEXT_ITEMS");
    const rejectedU = await store.memoryUpdateDaily({
      unresolved: [{ text: "Nope" }],
    });
    assert.equal(rejectedU.code, "USE_WORKING_CONTEXT_ITEMS");
  });
});

test("text and voice share identical working_context_items schema and handler", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const textSession = fs.readFileSync(path.join(root, "electron/text-session.cjs"), "utf8");
  assert.match(main, /name:\s*"working_context_items"/);
  assert.match(main, /if \(name === "working_context_items"\)/);
  assert.match(main, /ipcMain\.handle\("tools:list", \(\) => toolSpecs\)/);
  assert.match(main, /tools:\s*toolSpecs/);
  assert.match(main, /getToolSpecs:\s*\(\) => toolSpecs/);
  assert.match(textSession, /mapToolsForResponses\(toolSpecs\)|getToolSpecs/);
  assert.match(main, /Use working_context_items for every commitment/);
  assert.match(main, /List overdue commitments/);
});

test("legacy items without createdAt remain valid on read", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const daily = await store.loadAll();
    daily.daily.commitments = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "Legacy commitment",
        status: "open",
        due: null,
        updatedAt: "2026-07-20T00:00:00.000Z",
        source: "user",
        sensitivity: "normal",
      },
    ];
    await store.atomicWriteJson(store.paths.daily, daily.daily);
    const listed = await store.workingContextItems({ operation: "list", scope: "commitments" });
    assert.equal(listed.ok, true);
    assert.equal(listed.items[0].createdAt, null);
    assert.equal(listed.items[0].text, "Legacy commitment");
  });
});

test("resolveWorkingContextReference unit helpers", () => {
  const items = [
    { id: "a", text: "Alpha", status: "open" },
    { id: "b", text: "Beta website", status: "open", relatedPerson: "Greg" },
    { id: "c", text: "Gamma", status: "done" },
  ];
  const open = resolveWorkingContextReference(items, { by: "ordinal", value: 2 }, {
    listScope: "open",
    today: "2026-07-22",
  });
  assert.equal(open.item.text, "Beta website");
  const person = resolveWorkingContextReference(items, { by: "person", value: "Greg" }, {
    listScope: "open",
    today: "2026-07-22",
  });
  assert.equal(person.item.id, "b");
  assert.equal(isFutureDeferred({ deferredUntil: "2026-07-30" }, "2026-07-22"), true);
  assert.equal(canonicalizeItems(items, "2026-07-22")[0].order, 1);
});

test("invalid scope rejected", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const bad = await store.workingContextItems({
      operation: "list",
      scope: "projects",
    });
    assert.equal(bad.code, "INVALID_SCOPE");
  });
});

test("bulk promote requires confirmation; insert rejects invalid due", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      items: [{ text: "One" }, { text: "Two" }],
    });
    const preview = await store.workingContextItems({
      operation: "promote_to_priority",
      scope: "follow_ups",
      order: [{ by: "text", value: "One" }, { by: "text", value: "Two" }],
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.ok(preview.previewToken);

    const mismatched = await store.workingContextItems({
      operation: "promote_to_priority",
      scope: "follow_ups",
      order: [{ by: "text", value: "Two" }, { by: "text", value: "One" }],
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(mismatched.code, "STALE_PREVIEW");

    const { confirmed } = await confirmOp(store, {
      operation: "promote_to_priority",
      scope: "follow_ups",
      order: [{ by: "text", value: "One" }, { by: "text", value: "Two" }],
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.linked?.length, 2);
    const daily = await store.loadAll();
    assert.equal(daily.daily.priorities.length, 2);
    assert.equal(daily.daily.followUps.every((item) => item.status === "open"), true);

    const badInsert = await store.workingContextItems({
      operation: "insert",
      scope: "commitments",
      atPosition: 1,
      item: { text: "Bad due", due: "next Monday" },
    });
    assert.equal(badInsert.code, "INVALID_DATE");
  });
});

test("replace confirmation rejects mismatched items", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Keep" },
    });
    const preview = await store.workingContextItems({
      operation: "replace",
      scope: "commitments",
      items: [{ text: "Alpha" }, { text: "Beta" }],
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    const stale = await store.workingContextItems({
      operation: "replace",
      scope: "commitments",
      items: [{ text: "Alpha" }, { text: "Gamma" }],
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stale.code, "STALE_PREVIEW");
  });
});
