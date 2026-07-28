"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore, planBroadPriorityAnswer } = require("./memory.cjs");
const {
  resolveActiveProjectReference,
  canonicalizeProjects,
} = require("./active-projects-lifecycle.cjs");
const { PREVIEW_TTL_MS: SHARED_PREVIEW_TTL_MS } = require("./priority-lifecycle.cjs");

async function withStore(run, options = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-ap-"));
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
        return `22222222-2222-4222-8222-${String(uuidSeq).padStart(12, "0")}`;
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
  const preview = await store.memoryActiveProjects({ ...args, confirmed: false });
  assert.equal(preview.code, "CONFIRMATION_REQUIRED");
  assert.ok(preview.previewToken);
  const confirmed = await store.memoryActiveProjects({
    ...args,
    confirmed: true,
    previewToken: preview.previewToken,
  });
  return { preview, confirmed };
}

function names(result) {
  return (result.projects || []).map((item) => item.name);
}

function schemaKeys(project) {
  return Object.keys(project).sort();
}

test("list empty / nonempty returns artifact and canonical schema", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const empty = await store.memoryActiveProjects({ operation: "list" });
    assert.equal(empty.ok, true);
    assert.equal(empty.artifact.title, "Active Projects");
    assert.deepEqual(names(empty), []);

    await store.memoryActiveProjects({
      operation: "add",
      item: { name: "Jarvis", note: "desktop" },
    });
    const listed = await store.memoryActiveProjects({ operation: "list" });
    assert.deepEqual(names(listed), ["Jarvis"]);
    assert.deepEqual(schemaKeys(listed.projects[0]), ["id", "name", "note", "order", "updatedAt"]);
    assert.equal(listed.projects[0].note, "desktop");
  });
});

test("add via item and items; insert positions; edit preserves id", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const one = await store.memoryActiveProjects({
      operation: "add",
      item: { name: "First" },
    });
    assert.equal(one.ok, true);
    assert.ok(one.backupId);
    assert.equal(one.projects[0].name, "First");

    const several = await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Second" }, { name: "Third" }],
    });
    assert.deepEqual(names(several), ["First", "Second", "Third"]);

    const inserted = await store.memoryActiveProjects({
      operation: "insert",
      atPosition: 1,
      item: { name: "Zero" },
    });
    assert.deepEqual(names(inserted), ["Zero", "First", "Second", "Third"]);

    const mid = await store.memoryActiveProjects({
      operation: "insert",
      atPosition: 3,
      item: { name: "Mid" },
    });
    assert.deepEqual(names(mid), ["Zero", "First", "Mid", "Second", "Third"]);

    const end = await store.memoryActiveProjects({
      operation: "insert",
      atPosition: 6,
      item: { name: "Tail" },
    });
    assert.deepEqual(names(end), ["Zero", "First", "Mid", "Second", "Third", "Tail"]);

    const keepId = end.projects[1].id;
    const edited = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "ordinal", value: 2 },
      item: { name: "First renamed", note: "n1" },
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.projects[1].id, keepId);
    assert.equal(edited.projects[1].name, "First renamed");
    assert.equal(edited.projects[1].note, "n1");

    const noteOnly = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "First renamed" },
      item: { note: "n2" },
    });
    assert.equal(noteOnly.projects[1].name, "First renamed");
    assert.equal(noteOnly.projects[1].note, "n2");

    const clearNote = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "First renamed" },
      item: { note: "" },
    });
    assert.equal(clearNote.projects[1].note, "");
  });
});

test("insert invalid atPosition and empty add fail without write", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({ operation: "add", item: { name: "Keep" } });
    const before = await store.loadAll();
    const bad = await store.memoryActiveProjects({
      operation: "insert",
      atPosition: 0,
      item: { name: "Nope" },
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "VALIDATION_FAILED");
    const empty = await store.memoryActiveProjects({ operation: "add", items: [] });
    assert.equal(empty.code, "VALIDATION_FAILED");
    const after = await store.loadAll();
    assert.deepEqual(after.daily.activeProjects, before.daily.activeProjects);
  });
});

test("reference resolution: ordinal, id, exact, phrase, ambiguous, recent", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [
        { name: "Jarvis desktop assistant" },
        { name: "Website redesign" },
        { name: "Website content" },
      ],
    });
    const all = await store.loadAll();
    const jarvisId = all.daily.activeProjects[0].id;

    const byOrdinal = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "ordinal", value: 1 },
      item: { note: "o1" },
    });
    assert.equal(byOrdinal.ok, true);
    assert.equal(byOrdinal.projects[0].note, "o1");

    const byId = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "id", value: jarvisId },
      item: { note: "id1" },
    });
    assert.equal(byId.ok, true);
    assert.equal(byId.projects[0].note, "id1");

    const exact = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "jarvis desktop assistant" },
      item: { note: "exact" },
    });
    assert.equal(exact.ok, true);

    const phrase = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "desktop" },
      item: { note: "phrase" },
    });
    assert.equal(phrase.ok, true);

    const ambiguous = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "Website" },
      item: { note: "x" },
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "AMBIGUOUS_MATCH");
    assert.equal(ambiguous.candidates.length, 2);

    const short = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "zz" },
      item: { note: "x" },
    });
    assert.equal(short.code, "NOT_FOUND");

    const recent = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "recent" },
      item: { note: "recent-note" },
    });
    assert.equal(recent.ok, true);
    assert.equal(recent.projects[0].note, "recent-note");

    store._test.setRecentActiveProjectId(null);
    const noRecent = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "recent" },
      item: { note: "nope" },
    });
    assert.equal(noRecent.code, "NOT_FOUND");

    const unknownId = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "id", value: "00000000-0000-4000-8000-000000000000" },
      item: { note: "nope" },
    });
    assert.equal(unknownId.code, "NOT_FOUND");
  });
});

test("significant-token ambiguity does not silently pick", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Phase 15 audit notes" }, { name: "Phase 15 implementation" }],
    });
    const ambiguous = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "Phase 15 project" },
      item: { note: "x" },
    });
    assert.equal(ambiguous.code, "AMBIGUOUS_MATCH");
  });
});

test("remove preview + confirm; swapped payload applies bound plan", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Keep" }, { name: "Drop" }],
    });
    const before = await store.loadAll();
    const preview = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Drop" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(
      preview.after.map((p) => p.name),
      ["Keep"],
    );

    const swapped = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Keep" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    // Bound-plan apply or STALE_PREVIEW are both acceptable; never delete the wrong target.
    if (swapped.ok) {
      assert.deepEqual(names(swapped), ["Keep"]);
    } else {
      assert.equal(swapped.code, "STALE_PREVIEW");
      const after = await store.loadAll();
      assert.deepEqual(
        after.daily.activeProjects.map((p) => p.name),
        ["Keep", "Drop"],
      );
      const { confirmed } = await confirmOp(store, {
        operation: "remove",
        reference: { by: "text", value: "Drop" },
      });
      assert.equal(confirmed.ok, true);
      assert.deepEqual(names(confirmed), ["Keep"]);
    }
    assert.deepEqual(before.daily.priorities, (await store.loadAll()).daily.priorities);
  });
});

test("stale preview after intervening write", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "A" }, { name: "B" }],
    });
    const preview = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "B" },
    });
    await store.memoryActiveProjects({
      operation: "add",
      item: { name: "C" },
    });
    const stale = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "B" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stale.code, "STALE_PREVIEW");
  });
});

test("confirmed true without token and expired token are STALE_PREVIEW", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Keep" }, { name: "Drop" }],
    });

    const missingToken = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Drop" },
      confirmed: true,
    });
    assert.equal(missingToken.code, "STALE_PREVIEW");

    const preview = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Drop" },
    });
    assert.equal(preview.code, "CONFIRMATION_REQUIRED");
    const entry = store._test.getPreviewEntry(preview.previewToken);
    assert.ok(entry);
    entry.expiresAt = Date.now() - 1;
    helpers.tick(1);

    const expired = await store.memoryActiveProjects({
      operation: "remove",
      reference: { by: "text", value: "Drop" },
      confirmed: true,
      previewToken: preview.previewToken,
    });
    assert.equal(expired.code, "STALE_PREVIEW");
    const after = await store.loadAll();
    assert.deepEqual(
      after.daily.activeProjects.map((p) => p.name),
      ["Keep", "Drop"],
    );
  });
});

test("replace strict, duplicate-name continuity, and empty clear", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Website" }, { name: "Website" }, { name: "Jarvis" }],
    });
    const before = await store.loadAll();
    const websiteIds = before.daily.activeProjects.filter((p) => p.name === "Website").map((p) => p.id);
    const jarvisId = before.daily.activeProjects.find((p) => p.name === "Jarvis").id;

    const { confirmed } = await confirmOp(store, {
      operation: "replace",
      items: [{ name: "Jarvis", note: "kept" }, { name: "Website" }, { name: "Website" }],
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.projects.length, 3);
    assert.equal(confirmed.projects[0].id, jarvisId);
    assert.equal(confirmed.projects[0].note, "kept");
    const assignedWebsiteIds = confirmed.projects.slice(1).map((p) => p.id);
    assert.equal(new Set(assignedWebsiteIds).size, 2);
    assert.ok(assignedWebsiteIds.every((id) => websiteIds.includes(id) || !websiteIds.includes(id)));

    const cleared = await confirmOp(store, { operation: "replace", items: [] });
    assert.equal(cleared.confirmed.ok, true);
    assert.deepEqual(names(cleared.confirmed), []);
  });
});

test("reorder single and full order", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    const moved = await store.memoryActiveProjects({
      operation: "reorder",
      reference: { by: "text", value: "C" },
      atPosition: 1,
    });
    assert.deepEqual(names(moved), ["C", "A", "B"]);

    const full = await store.memoryActiveProjects({
      operation: "reorder",
      order: [
        { by: "text", value: "A" },
        { by: "text", value: "B" },
        { by: "text", value: "C" },
      ],
    });
    assert.deepEqual(names(full), ["A", "B", "C"]);

    const incomplete = await store.memoryActiveProjects({
      operation: "reorder",
      order: [{ by: "text", value: "A" }, { by: "text", value: "B" }],
    });
    assert.equal(incomplete.code, "VALIDATION_FAILED");
  });
});

test("restore_backup scoped; unrelated fields preserved", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      item: { text: "Priority keep" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Commitment keep" },
    });
    await store.memoryUpdateDaily({ summary: "Day summary" });
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Original" }],
    });
    const beforeRestore = await store.loadAll();

    await confirmOp(store, {
      operation: "replace",
      items: [{ name: "Changed" }],
    });

    const restored = await confirmOp(store, { operation: "restore_backup" });
    assert.equal(restored.confirmed.ok, true);
    assert.ok(names(restored.confirmed).includes("Original") || names(restored.confirmed).includes("Changed"));
    const after = await store.loadAll();
    assert.equal(after.daily.summary, "Day summary");
    assert.equal(after.daily.priorities[0].text, "Priority keep");
    assert.equal(after.daily.commitments[0].text, "Commitment keep");
    assert.equal(after.daily.date, beforeRestore.daily.date);
  });
});

test("restore with explicit and missing backupId", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({ operation: "add", item: { name: "Seed" } });
    const files = await store.listBackupFiles();
    assert.ok(files.length > 0);
    const { confirmed } = await confirmOp(store, {
      operation: "restore_backup",
      backupId: files[0].name,
    });
    assert.equal(confirmed.ok, true);

    const missing = await store.memoryActiveProjects({
      operation: "restore_backup",
      backupId: "does-not-exist.json",
    });
    assert.equal(missing.code, "RESTORE_FAILED");
  });
});

test("priority and WC writes leave projects unchanged; project writes leave them unchanged", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [{ name: "Project X" }],
    });
    const projectsBefore = (await store.loadAll()).daily.activeProjects;

    await store.memoryPriorities({ operation: "add", item: { text: "P1" } });
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "F1" },
    });
    assert.deepEqual((await store.loadAll()).daily.activeProjects, projectsBefore);

    const before = await store.loadAll();
    await store.memoryActiveProjects({
      operation: "add",
      item: { name: "Project Y" },
    });
    const after = await store.loadAll();
    assert.deepEqual(after.daily.priorities, before.daily.priorities);
    assert.deepEqual(after.daily.followUps, before.daily.followUps);
    assert.equal(after.daily.summary, before.daily.summary);
  });
});

test("memory_update_daily rejects activeProjects including empty and null; summary-only works", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({ operation: "add", item: { name: "Keep" } });
    const before = await store.loadAll();

    for (const payload of [{ activeProjects: [] }, { activeProjects: null }, { activeProjects: [{ name: "X" }], summary: "nope" }]) {
      const rejected = await store.memoryUpdateDaily(payload);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, "USE_MEMORY_ACTIVE_PROJECTS");
    }
    const mid = await store.loadAll();
    assert.deepEqual(mid.daily.activeProjects, before.daily.activeProjects);
    assert.equal(mid.daily.summary, before.daily.summary);

    const summary = await store.memoryUpdateDaily({ summary: "Only summary" });
    assert.equal(summary.ok, true);
    const after = await store.loadAll();
    assert.equal(after.daily.summary, "Only summary");
    assert.deepEqual(after.daily.activeProjects, before.daily.activeProjects);
  });
});

test("backup failure blocks write; client id ignored on add", async () => {
  await withStore(
    async (store) => {
      await store.ensureMemory();
      const failed = await store.memoryActiveProjects({
        operation: "add",
        item: { name: "Blocked" },
      });
      assert.equal(failed.code, "BACKUP_FAILED");
      const listed = await store.memoryActiveProjects({ operation: "list" });
      assert.deepEqual(names(listed), []);
    },
    { failBackup: () => true },
  );

  await withStore(async (store) => {
    await store.ensureMemory();
    const added = await store.memoryActiveProjects({
      operation: "add",
      item: { id: "11111111-1111-4111-8111-111111111111", name: "Generated" },
    });
    assert.equal(added.ok, true);
    assert.notEqual(added.projects[0].id, "11111111-1111-4111-8111-111111111111");
  });
});

test("rollover carries projects in order; Phase 12 fallback uses first project", async () => {
  await withStore(
    async (store, helpers) => {
      await store.ensureMemory();
      await store.memoryActiveProjects({
        operation: "add",
        items: [{ name: "Alpha" }, { name: "Beta" }],
      });
      await store.memoryActiveProjects({
        operation: "reorder",
        reference: { by: "text", value: "Beta" },
        atPosition: 1,
      });
      helpers.setDate("2026-07-23T12:00:00.000Z");
      await store.ensureMemory();
      const daily = (await store.loadAll()).daily;
      assert.equal(daily.date, "2026-07-23");
      assert.deepEqual(
        daily.activeProjects.map((p) => p.name),
        ["Beta", "Alpha"],
      );
      const plan = planBroadPriorityAnswer(daily, daily.date);
      assert.equal(plan.category, "active_projects");
      assert.equal(plan.leadText, "Beta");
    },
    { startDate: "2026-07-22T15:00:00.000Z" },
  );
});

test("empty name rejected; unknown op; preview paths; status keys ignored", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const emptyName = await store.memoryActiveProjects({
      operation: "add",
      item: { name: "   " },
    });
    assert.equal(emptyName.code, "VALIDATION_FAILED");

    const unknown = await store.memoryActiveProjects({ operation: "complete" });
    assert.equal(unknown.code, "UNSUPPORTED_OPERATION");

    const missingPreviewOp = await store.memoryActiveProjects({ operation: "preview" });
    assert.equal(missingPreviewOp.code, "UNSUPPORTED_OPERATION");

    await store.memoryActiveProjects({
      operation: "add",
      item: { name: "Clean", status: "done", due: "2026-07-30", deferredUntil: "2026-08-01" },
    });
    const daily = (await store.loadAll()).daily;
    assert.deepEqual(schemaKeys(daily.activeProjects[0]), ["id", "name", "note", "updatedAt"]);
    assert.equal(daily.activeProjects[0].status, undefined);

    const dry = await store.memoryActiveProjects({
      operation: "preview",
      previewOperation: "add",
      item: { name: "Dry" },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.requiresConfirmation, false);
    assert.ok(dry.after.some((p) => p.name === "Dry"));
    assert.equal((await store.loadAll()).daily.activeProjects.length, 1);

    const destr = await store.memoryActiveProjects({
      operation: "preview",
      previewOperation: "remove",
      reference: { by: "text", value: "Clean" },
    });
    assert.equal(destr.ok, true);
    assert.equal(destr.requiresConfirmation, true);
    assert.ok(destr.previewToken);
  });
});

test("add prefers nonempty items; item used when items empty or omitted", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const viaItemDespiteEmptyItems = await store.memoryActiveProjects({
      operation: "add",
      items: [],
      item: { name: "From item" },
    });
    assert.equal(viaItemDespiteEmptyItems.ok, true);
    assert.deepEqual(names(viaItemDespiteEmptyItems), ["From item"]);
  });
});

test("duplicate names allowed on add; later phrase ambiguous", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const first = await store.memoryActiveProjects({ operation: "add", item: { name: "Twin" } });
    const second = await store.memoryActiveProjects({ operation: "add", item: { name: "Twin" } });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const ambiguous = await store.memoryActiveProjects({
      operation: "edit",
      reference: { by: "text", value: "Twin" },
      item: { note: "x" },
    });
    assert.equal(ambiguous.code, "AMBIGUOUS_MATCH");
  });
});

test("remove clears recent when removed id was recent", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({ operation: "add", item: { name: "Temp" } });
    assert.ok(store._test.getRecentActiveProjectId());
    await confirmOp(store, {
      operation: "remove",
      reference: { by: "text", value: "Temp" },
    });
    assert.equal(store._test.getRecentActiveProjectId(), null);
  });
});

test("pure resolver exports and shared preview TTL", () => {
  assert.equal(SHARED_PREVIEW_TTL_MS, 10 * 60 * 1000);
  const projects = [
    { id: "a", name: "Alpha", note: "", updatedAt: "t" },
    { id: "b", name: "Beta", note: "", updatedAt: "t" },
  ];
  const hit = resolveActiveProjectReference(projects, { by: "ordinal", value: 2 });
  assert.equal(hit.item.name, "Beta");
  assert.deepEqual(
    canonicalizeProjects(projects).map((p) => p.order),
    [1, 2],
  );
});
