"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore } = require("./memory.cjs");
const {
  resolvePriorityReference,
  formatPrioritiesArtifact,
  canonicalizePriorities,
} = require("./priority-lifecycle.cjs");

const root = path.join(__dirname, "..");

async function withStore(run, options = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-prio-"));
  const clock = { value: options.startDate ? new Date(options.startDate) : new Date("2026-07-22T15:00:00.000Z") };
  let uuidSeq = 0;
  const store = createMemoryStore({
    rootDir,
    now: () => new Date(clock.value.getTime()),
    randomUUID:
      options.randomUUID ||
      (() => {
        uuidSeq += 1;
        return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
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

async function confirmReplace(store, items) {
  const preview = await store.memoryPriorities({ operation: "replace", items });
  assert.equal(preview.code, "CONFIRMATION_REQUIRED");
  const confirmed = await store.memoryPriorities({
    operation: "replace",
    items,
    confirmed: true,
    previewToken: preview.previewToken,
  });
  assert.equal(confirmed.ok, true);
  return confirmed;
}

async function confirmOp(store, args) {
  const preview = await store.memoryPriorities({ ...args, confirmed: false });
  assert.equal(preview.code, "CONFIRMATION_REQUIRED");
  assert.ok(preview.previewToken);
  const confirmed = await store.memoryPriorities({
    ...args,
    confirmed: true,
    previewToken: preview.previewToken,
  });
  return { preview, confirmed };
}

function texts(result) {
  return (result.priorities || []).map((item) => item.text);
}

function statuses(result) {
  return (result.priorities || []).map((item) => item.status);
}

test("list current priorities returns artifact and ordered list", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Alpha", status: "open" },
      { text: "Beta", status: "done" },
    ]);
    const listed = await store.memoryPriorities({ operation: "list" });
    assert.equal(listed.ok, true);
    assert.deepEqual(texts(listed), ["Alpha", "Beta"]);
    assert.equal(listed.priorities[0].order, 1);
    assert.equal(listed.artifact.title, "Daily Priorities");
    assert.match(listed.artifact.content, /1\. Alpha — open/);
    assert.match(listed.confirmation, /Listed current daily priorities/);
  });
});

test("add one and add several", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const one = await store.memoryPriorities({ operation: "add", item: { text: "First" } });
    assert.equal(one.ok, true);
    assert.deepEqual(texts(one), ["First"]);
    assert.ok(one.backupId);
    assert.match(one.confirmation, /add completed/i);

    const several = await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Second" }, { text: "Third" }],
    });
    assert.equal(several.ok, true);
    assert.deepEqual(texts(several), ["First", "Second", "Third"]);
    assert.equal(several.artifact.title, "Daily Priorities");
  });
});

test("insert at position shifts without changing existing IDs", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "A" }, { text: "C" }],
    });
    const before = await store.loadAll();
    const idA = before.daily.priorities[0].id;
    const idC = before.daily.priorities[1].id;
    const inserted = await store.memoryPriorities({
      operation: "insert",
      atPosition: 2,
      item: { text: "B" },
    });
    assert.deepEqual(texts(inserted), ["A", "B", "C"]);
    const after = await store.loadAll();
    assert.equal(after.daily.priorities[0].id, idA);
    assert.equal(after.daily.priorities[2].id, idC);
    assert.notEqual(after.daily.priorities[1].id, idA);
  });
});

test("edit wording preserves ID, order, and status", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Old wording" }, { text: "Keep me" }],
    });
    const before = await store.loadAll();
    const id = before.daily.priorities[0].id;
    const edited = await store.memoryPriorities({
      operation: "edit",
      reference: { by: "ordinal", value: 1 },
      item: { text: "New wording" },
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.priorities[0].text, "New wording");
    assert.equal(edited.priorities[0].id, id);
    assert.equal(edited.priorities[0].status, "open");
    assert.equal(edited.priorities[1].text, "Keep me");
  });
});

test("complete and reopen preserve ID and order", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Task one" }, { text: "Task two" }],
    });
    const before = await store.loadAll();
    const id = before.daily.priorities[0].id;
    const done = await store.memoryPriorities({
      operation: "complete",
      reference: { by: "text", value: "Task one" },
    });
    assert.equal(done.priorities[0].status, "done");
    assert.equal(done.priorities[0].id, id);
    assert.deepEqual(texts(done), ["Task one", "Task two"]);

    const reopened = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "id", value: id },
    });
    assert.equal(reopened.priorities[0].status, "open");
    assert.equal(reopened.priorities[0].id, id);
  });
});

test("remove preview and confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Keep" }, { text: "Drop" }],
    });
    const { preview, confirmed } = await confirmOp(store, {
      operation: "remove",
      reference: { by: "text", value: "Drop" },
    });
    assert.deepEqual(
      preview.after.map((item) => item.text),
      ["Keep"],
    );
    assert.equal(confirmed.ok, true);
    assert.deepEqual(texts(confirmed), ["Keep"]);
  });
});

test("move one priority and full reorder preserve IDs", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
    });
    const before = await store.loadAll();
    const ids = before.daily.priorities.map((item) => item.id);

    const moved = await store.memoryPriorities({
      operation: "reorder",
      reference: { by: "ordinal", value: 1 },
      atPosition: 3,
    });
    assert.deepEqual(texts(moved), ["Two", "Three", "One"]);
    assert.deepEqual(
      moved.priorities.map((item) => item.id).sort(),
      [...ids].sort(),
    );

    const full = await store.memoryPriorities({
      operation: "reorder",
      order: [
        { by: "text", value: "One" },
        { by: "text", value: "Two" },
        { by: "text", value: "Three" },
      ],
    });
    assert.deepEqual(texts(full), ["One", "Two", "Three"]);
    assert.deepEqual(
      full.priorities.map((item) => item.id).sort(),
      [...ids].sort(),
    );
  });
});

test("strict replacement with confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Old A" }, { text: "Old B" }],
    });
    const before = await store.loadAll();
    const keepId = before.daily.priorities[0].id;
    const { confirmed } = await confirmOp(store, {
      operation: "replace",
      items: [
        { id: keepId, text: "Old A renamed" },
        { text: "Brand new" },
      ],
    });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(texts(confirmed), ["Old A renamed", "Brand new"]);
    assert.equal(confirmed.priorities[0].id, keepId);
    assert.notEqual(confirmed.priorities[1].id, keepId);
    assert.equal(confirmed.priorities.length, 2);
  });
});

test("clear completed with confirmation preserves open and blocked", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Open task", status: "open" },
      { text: "Blocked task", status: "blocked" },
      { text: "Done task", status: "done" },
    ]);
    const { confirmed } = await confirmOp(store, { operation: "clear_completed" });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(texts(confirmed), ["Open task", "Blocked task"]);
    assert.deepEqual(statuses(confirmed), ["open", "blocked"]);
  });
});

test("carry one item and several items to tomorrow", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Carry me" }, { text: "Also carry" }, { text: "Stay" }],
    });

    const one = await confirmOp(store, {
      operation: "carry",
      reference: { by: "text", value: "Carry me" },
      targetDate: "tomorrow",
    });
    assert.equal(one.confirmed.ok, true);
    assert.equal(one.confirmed.targetDate, "2026-07-23");
    assert.deepEqual(texts(one.confirmed), ["Carry me", "Also carry", "Stay"]);

    const futurePath = path.join(store.paths.future, "daily-2026-07-23.json");
    const future = JSON.parse(await fsp.readFile(futurePath, "utf8"));
    assert.equal(future.priorities.some((item) => item.text === "Carry me"), true);

    const several = await confirmOp(store, {
      operation: "carry",
      order: [{ by: "text", value: "Also carry" }, { by: "text", value: "Stay" }],
      targetDate: "2026-07-23",
    });
    assert.equal(several.confirmed.ok, true);
    const future2 = JSON.parse(await fsp.readFile(futurePath, "utf8"));
    assert.equal(future2.priorities.filter((item) => item.text === "Also carry").length, 1);
    assert.equal(future2.priorities.filter((item) => item.text === "Stay").length, 1);
  });
});

test("restore latest backup", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.memoryPriorities({ operation: "add", item: { text: "Original" } });
    helpers.tick(2000);
    await store.memoryPriorities({ operation: "add", item: { text: "Later" } });
    const { confirmed } = await confirmOp(store, { operation: "restore_backup" });
    assert.equal(confirmed.ok, true);
    assert.ok(texts(confirmed).includes("Original"));
  });
});

test("exact wording, ordinal, distinctive phrase, and recent-item resolution", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [
        { text: "Ship website redesign" },
        { text: "Call the attorney" },
        { text: "Review contracts" },
      ],
    });
    const data = await store.loadAll();
    const priorities = data.daily.priorities;

    const byText = resolvePriorityReference(priorities, { by: "text", value: "Call the attorney" });
    assert.equal(byText.item.text, "Call the attorney");

    const byOrdinal = resolvePriorityReference(priorities, { by: "ordinal", value: 2 }, { listScope: "open" });
    assert.equal(byOrdinal.item.text, "Call the attorney");

    const byPhrase = resolvePriorityReference(priorities, { value: "website" });
    assert.equal(byPhrase.item.text, "Ship website redesign");

    await store.memoryPriorities({
      operation: "edit",
      reference: { by: "ordinal", value: 3 },
      item: { text: "Review contracts carefully" },
    });
    const recent = await store.memoryPriorities({
      operation: "complete",
      reference: { by: "recent" },
    });
    assert.equal(recent.ok, true);
    assert.equal(recent.priorities.find((item) => item.text === "Review contracts carefully").status, "done");
  });
});

test("ambiguous and nonexistent references", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Website homepage" }, { text: "Website footer" }],
      allowDuplicates: false,
    });
    const ambiguous = await store.memoryPriorities({
      operation: "edit",
      reference: { value: "Website" },
      item: { text: "Changed" },
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "AMBIGUOUS_MATCH");
    assert.ok(ambiguous.candidates.length >= 2);

    const missing = await store.memoryPriorities({
      operation: "complete",
      reference: { value: "does-not-exist" },
    });
    assert.equal(missing.code, "NOT_FOUND");

    const staleId = await store.memoryPriorities({
      operation: "complete",
      reference: { by: "id", value: "00000000-0000-4000-8000-999999999999" },
    });
    assert.equal(staleId.code, "NOT_FOUND");
  });
});

test("duplicate wording rejection and explicit allowance", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({ operation: "add", item: { text: "Same text" } });
    const rejected = await store.memoryPriorities({ operation: "add", item: { text: "same text" } });
    assert.equal(rejected.code, "DUPLICATE_TEXT");

    const allowed = await store.memoryPriorities({
      operation: "add",
      item: { text: "same text" },
      allowDuplicates: true,
    });
    assert.equal(allowed.ok, true);
    assert.equal(texts(allowed).filter((text) => text.toLowerCase() === "same text").length, 2);
  });
});

test("stale preview and stale expectedUpdatedAt", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "A" }, { text: "B" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "B" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");

    await store.memoryPriorities({ operation: "add", item: { text: "C" } });
    const stalePreview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "B" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stalePreview.code, "STALE_PREVIEW");

    const listed = await store.memoryPriorities({ operation: "list" });
    const staleWrite = await store.memoryPriorities({
      operation: "add",
      item: { text: "D" },
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(staleWrite.code, "STALE_WRITE");
    assert.ok(Array.isArray(staleWrite.priorities));
    assert.equal(listed.dailyUpdatedAt !== "2000-01-01T00:00:00.000Z", true);
  });
});

test("failed validation, backup failure, atomic-write failure, and reread failure", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const invalid = await store.memoryPriorities({ operation: "add", item: { text: "   " } });
    assert.equal(invalid.code, "VALIDATION_FAILED");
  });

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.memoryPriorities({ operation: "add", item: { text: "Backup boom" } });
      assert.equal(failed.code, "BACKUP_FAILED");
    },
    { failBackup: () => true },
  );

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.memoryPriorities({ operation: "add", item: { text: "Write boom" } });
      assert.equal(failed.code, "WRITE_FAILED");
      const data = await store.loadAll();
      assert.equal(data.daily.priorities.length, 0);
    },
    { failAtomicWrite: () => true },
  );

  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.memoryPriorities({ operation: "add", item: { text: "Reread boom" } });
      assert.equal(failed.code, "WRITE_FAILED");
    },
    { failReread: () => true },
  );
});

test("backup creation before every successful write", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const before = await store.listBackupFiles();
    const added = await store.memoryPriorities({ operation: "add", item: { text: "Tracked" } });
    assert.equal(added.ok, true);
    const after = await store.listBackupFiles();
    assert.ok(after.length > before.length);
    assert.ok(added.backupId);
    assert.ok(after.some((file) => file.name.includes("priorities-add")));
  });
});

test("stable IDs on edit, status change, and reorder; no unintended field changes", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({
      summary: "Keep summary",
      commitments: [{ text: "Keep commitment", status: "open" }],
      followUps: [{ text: "Keep follow-up", status: "open" }],
      unresolved: [{ text: "Keep unresolved", status: "open" }],
      activeProjects: [{ name: "Keep project" }],
    });
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "P1" }, { text: "P2" }, { text: "P3" }],
    });
    const start = await store.loadAll();
    const ids = start.daily.priorities.map((item) => item.id);

    await store.memoryPriorities({
      operation: "edit",
      reference: { by: "ordinal", value: 1 },
      item: { text: "P1 edited" },
    });
    await store.memoryPriorities({
      operation: "complete",
      reference: { by: "ordinal", value: 2 },
      listScope: "all",
    });
    await store.memoryPriorities({
      operation: "reorder",
      reference: { by: "text", value: "P3" },
      atPosition: 1,
    });

    const end = await store.loadAll();
    assert.deepEqual(
      end.daily.priorities.map((item) => item.id).sort(),
      [...ids].sort(),
    );
    assert.equal(end.daily.summary, "Keep summary");
    assert.equal(end.daily.commitments[0].text, "Keep commitment");
    assert.equal(end.daily.followUps[0].text, "Keep follow-up");
    assert.equal(end.daily.unresolved[0].text, "Keep unresolved");
    assert.equal(end.daily.activeProjects[0].name, "Keep project");
  });
});

test("old memory_update_daily.priorities path is rejected", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const rejected = await store.memoryUpdateDaily({
      priorities: [{ text: "Should fail", status: "open" }],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "USE_MEMORY_PRIORITIES");
  });
});

test("text and voice share identical memory_priorities tool schema and handler", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  assert.match(main, /name:\s*"memory_priorities"/);
  assert.match(main, /if \(name === "memory_priorities"\)/);
  assert.match(main, /memoryStore\.memoryPriorities\(args\)/);
  assert.match(main, /ipcMain\.handle\("tools:list", \(\) => toolSpecs\)/);
  assert.match(main, /tools:\s*toolSpecs/);
  assert.match(main, /getToolSpecs:\s*\(\) => toolSpecs/);

  const textSession = fs.readFileSync(path.join(root, "electron/text-session.cjs"), "utf8");
  assert.match(textSession, /mapToolsForResponses\(toolSpecs\)|getToolSpecs/);

  const ops = [
    "list",
    "add",
    "insert",
    "edit",
    "complete",
    "reopen",
    "remove",
    "reorder",
    "replace",
    "clear_completed",
    "carry",
    "restore_backup",
    "preview",
  ];
  for (const op of ops) {
    assert.match(main, new RegExp(`"${op}"`));
  }
  const start = main.indexOf('name: "memory_priorities"');
  const end = main.indexOf('name: "memory_set_preference"');
  assert.ok(start >= 0 && end > start);
  const schemaBlock = main.slice(start, end);
  for (const field of [
    "operation",
    "confirmed",
    "expectedUpdatedAt",
    "items",
    "item",
    "reference",
    "atPosition",
    "order",
    "targetDate",
    "backupId",
    "previewToken",
    "listScope",
    "allowDuplicates",
  ]) {
    assert.match(schemaBlock, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(schemaBlock, /^\s*text:\s*\{/m);
});

test("artifact contains canonical resulting list and confirmation is set", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const result = await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Canonical one" }, { text: "Canonical two" }],
    });
    assert.equal(result.artifact.title, "Daily Priorities");
    assert.deepEqual(canonicalizePriorities(result.priorities).map((item) => item.text), [
      "Canonical one",
      "Canonical two",
    ]);
    const artifact = formatPrioritiesArtifact([
      { id: "1", text: "Canonical one", status: "open", updatedAt: "t" },
      { id: "2", text: "Canonical two", status: "open", updatedAt: "t" },
    ]);
    assert.match(artifact.content, /1\. Canonical one — open/);
    assert.match(artifact.content, /2\. Canonical two — open/);
    assert.ok(result.confirmation);
    assert.match(result.confirmation, /add completed/i);
  });
});

test("ordinal resolution defaults to open list unless listScope is all", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Done first", status: "done" },
      { text: "Open first", status: "open" },
      { text: "Open second", status: "open" },
    ]);
    const data = await store.loadAll();
    const openSecond = resolvePriorityReference(data.daily.priorities, 2, { listScope: "open" });
    assert.equal(openSecond.item.text, "Open second");
    const allSecond = resolvePriorityReference(data.daily.priorities, 2, { listScope: "all" });
    assert.equal(allSecond.item.text, "Open first");
  });
});

test("replace ignores unmatched client IDs and generates new ones", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({ operation: "add", item: { text: "Keep me" } });
    const before = await store.loadAll();
    const keepId = before.daily.priorities[0].id;
    const { confirmed } = await confirmOp(store, {
      operation: "replace",
      items: [
        { id: keepId, text: "Keep me" },
        { id: "00000000-0000-4000-8000-ffffffffffff", text: "Fresh item" },
      ],
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.priorities[0].id, keepId);
    assert.notEqual(confirmed.priorities[1].id, "00000000-0000-4000-8000-ffffffffffff");
    assert.deepEqual(texts(confirmed), ["Keep me", "Fresh item"]);
  });
});

test("restore validates backup and binds confirm to previewed backup file", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.memoryPriorities({ operation: "add", item: { text: "Snapshot me" } });
    helpers.tick(1000);
    await store.memoryPriorities({ operation: "add", item: { text: "Later change" } });

    const preview = await store.memoryPriorities({ operation: "restore_backup" });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.ok(preview.previewToken);

    const invalidPath = path.join(store.paths.backups, "broken-backup.json");
    await fsp.writeFile(invalidPath, JSON.stringify({ reason: "no-daily" }), "utf8");
    const bad = await store.memoryPriorities({ operation: "restore_backup", backupId: "broken-backup.json" });
    assert.equal(bad.code, "RESTORE_FAILED");

    const confirmed = await store.memoryPriorities({
      operation: "restore_backup",
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(texts(confirmed), ["Snapshot me"]);
  });
});
