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
    assert.equal(inserted.requiresConfirmation, undefined);
    const after = await store.loadAll();
    assert.equal(after.daily.priorities[0].id, idA);
    assert.equal(after.daily.priorities[2].id, idC);
    assert.notEqual(after.daily.priorities[1].id, idA);
  });
});

test("direct insert at position 1, 2, and end preserves existing IDs without confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Middle" }, { text: "Tail" }],
    });
    let data = await store.loadAll();
    const idMiddle = data.daily.priorities[0].id;
    const idTail = data.daily.priorities[1].id;

    const atOne = await store.memoryPriorities({
      operation: "insert",
      atPosition: 1,
      item: { text: "Head" },
    });
    assert.equal(atOne.ok, true);
    assert.equal(atOne.code, undefined);
    assert.doesNotMatch(String(atOne.message || ""), /confirm/i);
    assert.deepEqual(texts(atOne), ["Head", "Middle", "Tail"]);
    assert.equal(atOne.priorities[1].id, idMiddle);
    assert.equal(atOne.priorities[2].id, idTail);

    data = await store.loadAll();
    const idHead = data.daily.priorities[0].id;
    const atTwo = await store.memoryPriorities({
      operation: "insert",
      atPosition: 2,
      item: { text: "Second" },
    });
    assert.deepEqual(texts(atTwo), ["Head", "Second", "Middle", "Tail"]);
    assert.equal(atTwo.priorities[0].id, idHead);
    assert.equal(atTwo.priorities[2].id, idMiddle);
    assert.equal(atTwo.priorities[3].id, idTail);

    data = await store.loadAll();
    const end = await store.memoryPriorities({
      operation: "insert",
      atPosition: data.daily.priorities.length + 1,
      item: { text: "End" },
    });
    assert.deepEqual(texts(end), ["Head", "Second", "Middle", "Tail", "End"]);
    assert.equal(end.priorities[0].id, idHead);
    assert.equal(end.priorities[2].id, idMiddle);
    assert.equal(end.priorities[3].id, idTail);
  });
});

test("insert compatibility preview retains position; changed or omitted confirm position cannot silently become 1", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "call Cecilia" }, { text: "finish the website homepage" }],
    });
    const before = await store.loadAll();
    const idCecilia = before.daily.priorities[0].id;
    const idWebsite = before.daily.priorities[1].id;

    const preview = await store.memoryPriorities({
      operation: "preview",
      previewOperation: "insert",
      atPosition: 2,
      item: { text: "review the scanner purchase" },
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.requiresConfirmation, false);
    assert.deepEqual(
      preview.after.map((item) => item.text),
      ["call Cecilia", "review the scanner purchase", "finish the website homepage"],
    );
    assert.match(preview.message, /Dry-run only|Execute insert directly/i);
    assert.doesNotMatch(preview.message, /Preview ready for insert\. Confirm to apply\./);

    const mismatched = await store.memoryPriorities({
      operation: "insert",
      previewToken: preview.previewToken,
      confirmed: true,
      atPosition: 1,
      item: { text: "review the scanner purchase" },
    });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.code, "STALE_PREVIEW");
    let data = await store.loadAll();
    assert.deepEqual(
      data.daily.priorities.map((item) => item.text),
      ["call Cecilia", "finish the website homepage"],
    );

    const omittedPosition = await store.memoryPriorities({
      operation: "insert",
      previewToken: preview.previewToken,
      confirmed: true,
      item: { text: "review the scanner purchase" },
    });
    assert.equal(omittedPosition.ok, true);
    assert.deepEqual(texts(omittedPosition), [
      "call Cecilia",
      "review the scanner purchase",
      "finish the website homepage",
    ]);
    assert.equal(omittedPosition.priorities[0].id, idCecilia);
    assert.equal(omittedPosition.priorities[2].id, idWebsite);
    assert.notEqual(omittedPosition.priorities[0].text, "review the scanner purchase");
  });
});

test("destructive preview confirmation rejects mismatched payload and still applies exact stored plan", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Keep" }, { text: "Drop" }],
    });
    const preview = await store.memoryPriorities({
      operation: "remove",
      reference: { by: "text", value: "Drop" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");

    const mismatched = await store.memoryPriorities({
      operation: "remove",
      confirmed: true,
      previewToken: preview.previewToken,
      reference: { by: "text", value: "Keep" },
    });
    assert.equal(mismatched.code, "STALE_PREVIEW");

    const confirmed = await store.memoryPriorities({
      operation: "remove",
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(texts(confirmed), ["Keep"]);
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

test("reorder accepts natural-language reference shapes for call Cecilia to priority one", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const before = await store.loadAll();
    const ids = before.daily.priorities.map((item) => item.id);

    const byItemText = await store.memoryPriorities({
      operation: "reorder",
      item: { text: "call Cecilia" },
      atPosition: 1,
    });
    assert.equal(byItemText.ok, true);
    assert.deepEqual(texts(byItemText), [
      "call Cecilia",
      "review the scanner purchase",
      "finish the website homepage",
    ]);
    assert.deepEqual(
      byItemText.priorities.map((item) => item.id).sort(),
      [...ids].sort(),
    );

    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const byReferenceText = await store.memoryPriorities({
      operation: "reorder",
      reference: { text: "call Cecilia" },
      atPosition: 1,
    });
    assert.equal(byReferenceText.ok, true);
    assert.deepEqual(texts(byReferenceText), [
      "call Cecilia",
      "review the scanner purchase",
      "finish the website homepage",
    ]);

    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const canonical = await store.memoryPriorities({
      operation: "reorder",
      reference: { by: "text", value: "call Cecilia" },
      atPosition: 1,
    });
    assert.equal(canonical.ok, true);
    assert.deepEqual(texts(canonical), [
      "call Cecilia",
      "review the scanner purchase",
      "finish the website homepage",
    ]);

    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const caseInsensitive = await store.memoryPriorities({
      operation: "reorder",
      reference: { by: "text", value: "CALL cecilia" },
      atPosition: 1,
    });
    assert.equal(caseInsensitive.ok, true);
    assert.equal(caseInsensitive.priorities[0].text, "call Cecilia");

    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const phrase = await store.memoryPriorities({
      operation: "reorder",
      reference: { value: "Cecilia" },
      atPosition: 1,
    });
    assert.equal(phrase.ok, true);
    assert.equal(phrase.priorities[0].text, "call Cecilia");
  });
});

test("destination ordinal is not mistaken for the source reference", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const before = await store.loadAll();
    const firstId = before.daily.priorities[0].id;
    // item carries destination-like atPosition noise; source must still be call Cecilia via text.
    const moved = await store.memoryPriorities({
      operation: "reorder",
      item: { text: "call Cecilia", atPosition: 1 },
      atPosition: 1,
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.priorities[0].text, "call Cecilia");
    assert.equal(moved.priorities[1].id, firstId);
    assert.equal(moved.priorities[1].text, "review the scanner purchase");
  });
});

test("identical NOT_FOUND reorder arguments are suppressed on retry", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "open" },
      { text: "call Cecilia", status: "open" },
    ]);
    const args = {
      operation: "reorder",
      reference: { by: "text", value: "does-not-exist" },
      atPosition: 1,
    };
    const first = await store.memoryPriorities(args);
    assert.equal(first.code, "NOT_FOUND");
    assert.equal(first.suppressedRetry, undefined);

    const second = await store.memoryPriorities(args);
    assert.equal(second.code, "NOT_FOUND");
    assert.equal(second.suppressedRetry, true);
    assert.match(second.message, /do not retry/i);
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
  assert.match(schemaBlock, /Reorder example|by":"text","value":"call Cecilia"/);
  assert.match(schemaBlock, /complete targets an open priority/);
  assert.match(schemaBlock, /reopen targets a completed priority/);
  assert.match(schemaBlock, /carry\/copy into another date defaults to copy/);
  assert.match(schemaBlock, /enum:\s*\["open",\s*"done",\s*"all"\]/);
  assert.match(main, /Do not retry identical or near-identical/);
  assert.match(main, /complete targets an open priority \(status open, blocked, or active\)/);
  assert.match(main, /reopen targets a completed priority \(status done\)/);
  assert.match(main, /"carry" \/ "carry forward" \/ "copy" defaults to copy/);
  assert.match(main, /Never call a copy operation a move/);
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

test("reopen resolves done scanner priority by distinctive phrase", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "call Cecilia", status: "open" },
      { text: "review the scanner purchase", status: "done" },
      { text: "finish the website homepage", status: "open" },
    ]);
    const before = await store.loadAll();
    const scannerId = before.daily.priorities[1].id;
    const reopened = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.priorities[1].status, "open");
    assert.equal(reopened.priorities[1].id, scannerId);
    assert.equal(reopened.priorities[1].text, "review the scanner purchase");
    assert.deepEqual(texts(reopened), [
      "call Cecilia",
      "review the scanner purchase",
      "finish the website homepage",
    ]);
    assert.deepEqual(statuses(reopened), ["open", "open", "open"]);
  });
});

test("reopen by exact wording and canonical ID preserve array position", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "alpha open", status: "open" },
      { text: "beta done exact", status: "done" },
      { text: "gamma open", status: "open" },
    ]);
    const before = await store.loadAll();
    const id = before.daily.priorities[1].id;

    const byExact = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "beta done exact" },
    });
    assert.equal(byExact.ok, true);
    assert.equal(byExact.priorities[1].status, "open");
    assert.equal(byExact.priorities[1].id, id);
    assert.equal(byExact.priorities[1].text, "beta done exact");

    await store.memoryPriorities({
      operation: "complete",
      reference: { by: "id", value: id },
    });
    const byId = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "id", value: id },
    });
    assert.equal(byId.ok, true);
    assert.equal(byId.priorities[1].id, id);
    assert.equal(byId.priorities[1].status, "open");
    assert.deepEqual(texts(byId), ["alpha open", "beta done exact", "gamma open"]);
  });
});

test("reopen ordinal resolves against completed priorities in stored order", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "open first", status: "open" },
      { text: "done first", status: "done" },
      { text: "open second", status: "open" },
      { text: "done second", status: "done" },
    ]);
    const before = await store.loadAll();
    const firstDoneId = before.daily.priorities[1].id;
    const secondDoneId = before.daily.priorities[3].id;

    const first = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "ordinal", value: 1 },
    });
    assert.equal(first.ok, true);
    assert.equal(first.priorities[1].id, firstDoneId);
    assert.equal(first.priorities[1].status, "open");
    assert.equal(first.priorities[3].status, "done");

    const second = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "ordinal", value: 1 },
    });
    assert.equal(second.ok, true);
    assert.equal(second.priorities[3].id, secondDoneId);
    assert.equal(second.priorities[3].status, "open");
  });
});

test("complete prefers open items and ignores done duplicates", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "done" },
      { text: "call scanner vendor", status: "open" },
      { text: "finish homepage", status: "open" },
    ]);
    const before = await store.loadAll();
    const openId = before.daily.priorities[1].id;
    const doneId = before.daily.priorities[0].id;

    const completed = await store.memoryPriorities({
      operation: "complete",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.priorities[1].id, openId);
    assert.equal(completed.priorities[1].status, "done");
    assert.equal(completed.priorities[0].id, doneId);
    assert.equal(completed.priorities[0].status, "done");
    assert.equal(completed.priorities[0].text, "review the scanner purchase");
  });
});

test("reopen missing completed target returns NOT_FOUND without write", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "call Cecilia", status: "open" },
      { text: "finish homepage", status: "open" },
    ]);
    const before = await store.loadAll();
    const missing = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "NOT_FOUND");
    const after = await store.loadAll();
    assert.deepEqual(after.daily.priorities, before.daily.priorities);
  });
});

test("ambiguous completed phrase returns AMBIGUOUS_MATCH without write", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "review the scanner purchase", status: "done" },
      { text: "call scanner vendor", status: "done" },
      { text: "open other", status: "open" },
    ]);
    const before = await store.loadAll();
    const ambiguous = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "AMBIGUOUS_MATCH");
    assert.ok(Array.isArray(ambiguous.candidates));
    assert.equal(ambiguous.candidates.length, 2);
    const after = await store.loadAll();
    assert.deepEqual(after.daily.priorities, before.daily.priorities);
  });
});

test("identical and near-identical NOT_FOUND reopen retries are suppressed", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "call Cecilia", status: "open" },
      { text: "finish homepage", status: "open" },
    ]);

    const first = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(first.code, "NOT_FOUND");
    assert.equal(first.suppressedRetry, undefined);

    const identical = await store.memoryPriorities({
      operation: "reopen",
      reference: { by: "text", value: "scanner" },
    });
    assert.equal(identical.code, "NOT_FOUND");
    assert.equal(identical.suppressedRetry, true);
    assert.match(identical.message, /do not retry/i);

    // Near-identical: different reference shape, same normalized text.
    const near = await store.memoryPriorities({
      operation: "reopen",
      reference: { text: "scanner" },
    });
    assert.equal(near.code, "NOT_FOUND");
    assert.equal(near.suppressedRetry, true);

    const viaItem = await store.memoryPriorities({
      operation: "reopen",
      item: { text: "scanner" },
    });
    assert.equal(viaItem.code, "NOT_FOUND");
    assert.equal(viaItem.suppressedRetry, true);
  });
});

test("omitted move defaults to copy and preserves today", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({
      summary: "Keep summary",
      commitments: [{ text: "Keep commitment", status: "open" }],
    });
    await confirmReplace(store, [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
    ]);
    const before = await store.loadAll();
    const ceciliaId = before.daily.priorities[1].id;

    const preview = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.equal(preview.move, false);
    assert.equal(preview.mode, "copy");
    assert.match(preview.message, /copy/i);
    assert.match(preview.message, /Today's priority will remain unchanged/i);
    assert.doesNotMatch(preview.message, /removed from today's list/i);
    assert.ok(preview.todayBefore);
    assert.ok(preview.todayAfter);
    assert.ok(preview.tomorrowBefore);
    assert.ok(preview.tomorrowAfter);
    assert.deepEqual(
      preview.todayAfter.map((item) => item.text),
      ["Finish website homepage", "Call Cecilia"],
    );
    assert.equal(preview.tomorrowAfter.some((item) => item.text === "Call Cecilia"), true);
    assert.match(preview.artifact.content, /Today before/);
    assert.match(preview.artifact.content, /Tomorrow after/);

    const confirmed = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.mode, "copy");
    assert.deepEqual(texts(confirmed), ["Finish website homepage", "Call Cecilia"]);
    assert.equal(confirmed.priorities[1].id, ceciliaId);

    const after = await store.loadAll();
    assert.equal(after.daily.summary, "Keep summary");
    assert.equal(after.daily.commitments[0].text, "Keep commitment");
    const future = JSON.parse(await fsp.readFile(path.join(store.paths.future, "daily-2026-07-23.json"), "utf8"));
    assert.equal(future.priorities.some((item) => item.text === "Call Cecilia" && item.id === ceciliaId), true);
  });
});

test("move false copies and move true removes from today", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
    ]);

    const copy = await confirmOp(store, {
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      move: false,
    });
    assert.equal(copy.preview.mode, "copy");
    assert.match(copy.preview.message, /\bcopy\b/i);
    assert.deepEqual(texts(copy.confirmed), ["Finish website homepage", "Call Cecilia"]);

    await confirmReplace(store, [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
    ]);
    const move = await confirmOp(store, {
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      move: true,
    });
    assert.equal(move.preview.mode, "move");
    assert.equal(move.preview.move, true);
    assert.match(move.preview.message, /\bmove\b/i);
    assert.match(move.preview.message, /removed from today's list/i);
    assert.deepEqual(
      move.preview.todayAfter.map((item) => item.text),
      ["Finish website homepage"],
    );
    assert.deepEqual(texts(move.confirmed), ["Finish website homepage"]);
    const future = JSON.parse(await fsp.readFile(path.join(store.paths.future, "daily-2026-07-23.json"), "utf8"));
    assert.equal(future.priorities.some((item) => item.text === "Call Cecilia"), true);
  });
});

test("carry confirmation rejects flipped move and target-date mismatch", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
    ]);

    const copyPreview = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
    });
    const flipToMove = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      move: true,
      confirmed: true,
      previewToken: copyPreview.previewToken,
    });
    assert.equal(flipToMove.code, "STALE_PREVIEW");

    const movePreview = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      move: true,
    });
    const flipToCopy = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      move: false,
      confirmed: true,
      previewToken: movePreview.previewToken,
    });
    assert.equal(flipToCopy.code, "STALE_PREVIEW");

    const dateMismatch = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "2026-07-30",
      confirmed: true,
      previewToken: copyPreview.previewToken,
    });
    assert.equal(dateMismatch.code, "STALE_PREVIEW");
  });
});

test("intervening write invalidates carry preview; pre-binding preview is stale", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await confirmReplace(store, [
      { text: "Finish website homepage", status: "open" },
      { text: "Call Cecilia", status: "open" },
    ]);
    const preview = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
    });
    await store.memoryPriorities({ operation: "add", item: { text: "Intervening" } });
    const stale = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stale.code, "STALE_PREVIEW");

    const fresh = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
    });
    // Simulate a pre-correction preview entry missing carryBindingVersion.
    const entry = store._test.getPreviewEntry(fresh.previewToken);
    assert.ok(entry);
    delete entry.meta.carryBindingVersion;
    if (entry.meta.request) delete entry.meta.request.carryBindingVersion;
    const oldBinding = await store.memoryPriorities({
      operation: "carry",
      reference: { by: "text", value: "Call Cecilia" },
      targetDate: "tomorrow",
      confirmed: true,
      previewToken: fresh.previewToken,
    });
    assert.equal(oldBinding.code, "STALE_PREVIEW");
  });
});
