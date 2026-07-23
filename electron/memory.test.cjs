const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore, PERSONAL_CONTEXT_SOFT_CAP, SCHEMA_VERSION } = require("./memory.cjs");

async function withStore(run, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rj-memory-"));
  const clock = { value: options.startDate ? new Date(options.startDate) : new Date("2026-07-22T15:00:00.000Z") };
  const store = createMemoryStore({
    rootDir,
    now: () => new Date(clock.value.getTime()),
    randomUUID: options.randomUUID,
  });
  try {
    return await run(store, {
      rootDir,
      setDate: (iso) => {
        clock.value = new Date(iso);
      },
    });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test("first-run seeding creates schema version 1 files", async () => {
  await withStore(async (store) => {
    const result = await store.ensureMemory();
    assert.equal(result.ok, true);
    const data = await store.loadAll();
    assert.equal(data.preferences.schemaVersion, SCHEMA_VERSION);
    assert.equal(data.profile.schemaVersion, SCHEMA_VERSION);
    assert.equal(data.daily.schemaVersion, SCHEMA_VERSION);
    assert.equal(data.entries.schemaVersion, SCHEMA_VERSION);
    assert.match(data.instructions, /Personal Operating Instructions/);
    assert.equal(data.daily.date, "2026-07-22");
  });
});

test("preserve existing valid user data during startup", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.atomicWriteText(store.paths.instructions, "# Keep Me\nCustom instructions\n");
    await store.atomicWriteJson(store.paths.entries, {
      schemaVersion: 1,
      entries: [
        {
          id: "keep-1",
          kind: "fact",
          text: "Keep this fact",
          tags: ["priority"],
          sensitivity: "normal",
          status: "active",
          source: "user",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
          supersedes: null,
          confidence: "stated",
        },
      ],
    });
    await store.ensureMemory();
    const data = await store.loadAll();
    assert.match(data.instructions, /Keep Me/);
    assert.equal(data.entries.entries[0].text, "Keep this fact");
  });
});

test("atomic writes and serialized concurrent writes", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const writes = [];
    for (let i = 0; i < 12; i += 1) {
      writes.push(store.memoryRemember({ text: `fact-${i}`, tags: ["batch"], source: "user" }));
    }
    await Promise.all(writes);
    const data = await store.loadAll();
    assert.equal(data.entries.entries.length, 12);
    const raw = await fs.readFile(store.paths.entries, "utf8");
    JSON.parse(raw);
  });
});

test("daily rollover archives and carries open work", async () => {
  await withStore(async (store, helpers) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({
      summary: "Yesterday plan",
      priorities: [{ text: "Ship Phase 6", status: "open" }],
      commitments: [{ text: "Call attorney", status: "blocked" }],
      followUps: [{ text: "Email draft", status: "done" }],
      unresolved: [{ text: "Open question", status: "open" }],
      activeProjects: [{ name: "Jarvis", note: "memory" }],
    });
    helpers.setDate("2026-07-23T12:00:00.000Z");
    const rolled = await store.rolloverDailyIfNeeded();
    assert.equal(rolled.rolled, true);
    const archiveName = path.basename(rolled.archived);
    assert.equal(archiveName, "daily-2026-07-22.json");
    assert.equal(rolled.daily.date, "2026-07-23");
    assert.equal(rolled.daily.priorities.length, 1);
    assert.equal(rolled.daily.commitments[0].text, "Call attorney");
    assert.equal(rolled.daily.followUps.length, 0);
    assert.equal(rolled.daily.unresolved[0].text, "Open question");
    assert.equal(rolled.daily.activeProjects[0].name, "Jarvis");
    assert.equal(rolled.daily.summary, "");
  });
});

test("backup retention keeps last 10 snapshots", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    for (let i = 0; i < 12; i += 1) {
      await store.createBackupSnapshot(`snap-${i}`);
    }
    const backups = await store.listBackupFiles();
    assert.equal(backups.length, 10);
  });
});

test("remember, view filtering, correct/supersede, and conflict detection", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const remembered = await store.memoryRemember({
      text: "Visible project fact",
      kind: "project",
      tags: ["priority"],
      sensitivity: "normal",
      source: "user",
    });
    assert.equal(remembered.ok, true);

    await store.memoryRemember({
      target: "profile",
      key: "employer",
      value: "APC",
      source: "user",
    });
    await store.memoryRemember({
      text: "Secret token value",
      kind: "fact",
      sensitivity: "secret",
      source: "user",
    });
    await store.memoryRemember({
      text: "Sensitive medical note",
      kind: "fact",
      sensitivity: "sensitive",
      source: "user",
    });

    const view = await store.memoryView({ scope: "entries" });
    assert.equal(view.ok, true);
    assert.match(view.artifact.content, /Visible project fact/);
    assert.equal(view.artifact.content.includes("Secret token value"), false);
    assert.match(view.artifact.content, /\[sensitive stored\]/);

    const secretView = await store.memoryView({ scope: "entries", confirmed: true });
    assert.match(secretView.artifact.content, /Secret token value/);

    const conflict = await store.memoryRemember({
      text: "Different project fact",
      kind: "project",
      tags: ["priority"],
      source: "assistant",
      confidence: "inferred",
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "MEMORY_CONFLICT");

    const corrected = await store.memoryCorrect({
      id: remembered.entry.id,
      text: "Corrected project fact",
    });
    assert.equal(corrected.ok, true);
    assert.equal(corrected.entry.supersedes, remembered.entry.id);
    const data = await store.loadAll();
    const old = data.entries.entries.find((entry) => entry.id === remembered.entry.id);
    assert.equal(old.status, "corrected");
  });
});

test("preference updates and instruction append/replace confirmation", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const prefs = await store.memorySetPreference({
      addressAs: "Sarah",
      hardRule: "Prefer concise status updates",
    });
    assert.equal(prefs.ok, true);
    assert.equal(prefs.preferences.prefs.hardRules.includes("Prefer concise status updates"), true);

    const blocked = await store.memorySetInstructions({
      mode: "replace",
      content: "# Replaced\n",
    });
    assert.equal(blocked.requiresConfirmation, true);

    const replaced = await store.memorySetInstructions({
      mode: "replace",
      content: "# Replaced\nOnly this\n",
      confirmed: true,
    });
    assert.equal(replaced.ok, true);
    const appended = await store.memorySetInstructions({
      mode: "append",
      section: "Extra",
      content: "Appended line",
    });
    assert.equal(appended.ok, true);
    const data = await store.loadAll();
    assert.match(data.instructions, /# Replaced/);
    assert.match(data.instructions, /## Extra/);
    assert.match(data.instructions, /Appended line/);
  });
});

test("clear requires confirmation and scoped clearing works", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryRemember({ text: "Temp", source: "user" });
    const blocked = await store.memoryClear({ scope: "entries" });
    assert.equal(blocked.requiresConfirmation, true);
    const cleared = await store.memoryClear({ scope: "entries", confirmed: true });
    assert.equal(cleared.ok, true);
    const data = await store.loadAll();
    assert.equal(data.entries.entries.length, 0);
    const backups = await store.listBackupFiles();
    assert.equal(backups.length >= 1, true);
  });
});

test("secret exclusion, sensitive redaction, ordering, and size caps", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memorySetPreference({
      hardRules: ["Rule one", "Rule two"],
    });
    await store.memoryUpdateDaily({
      summary: "Focus day",
      commitments: [{ text: "Keep this commitment", status: "open" }],
      priorities: [{ text: "Priority A", status: "open" }],
    });
    await store.memoryRemember({
      text: "Secret value should never inject",
      sensitivity: "secret",
      source: "user",
    });
    await store.memoryRemember({
      text: "Sensitive value",
      sensitivity: "sensitive",
      tags: ["priority"],
      source: "user",
    });
    await store.memoryRemember({
      text: "Normal durable fact",
      sensitivity: "normal",
      tags: ["priority"],
      source: "user",
    });
    await store.atomicWriteText(store.paths.instructions, `# Instructions\n${"A".repeat(5000)}\n`);

    const data = await store.loadAll();
    const block = store.buildPersonalContextBlock(data, { softCap: 2500 });
    assert.equal(block.text.includes("Secret value should never inject"), false);
    assert.match(block.text, /\[sensitive stored\]/);
    assert.match(block.text, /Keep this commitment/);
    assert.match(block.text, /Rule one/);
    assert.equal(block.text.indexOf("Personal Preferences And Hard Rules") < block.text.indexOf("Today's Working Context"), true);
    assert.equal(block.bytes <= 2500 + 40, true);
    assert.equal(block.truncated, true);
    assert.match(block.text, /Additional personal memory exists/);
    assert.equal(PERSONAL_CONTEXT_SOFT_CAP >= 8000, true);
  });
});

test("restart persistence and malformed recovery with backup", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryRemember({ text: "Persists across reload", source: "user" });
    const first = await store.loadAll();
    assert.equal(first.entries.entries[0].text, "Persists across reload");

    await fs.writeFile(store.paths.entries, "{not-json", "utf8");
    await store.ensureMemory();
    const recovered = await store.loadAll();
    assert.equal(Array.isArray(recovered.entries.entries), true);
    const backups = await store.listBackupFiles();
    assert.equal(backups.some((file) => file.name.includes("malformed-entries")), true);
    const backupRaw = JSON.parse(await fs.readFile(backups.find((file) => file.name.includes("malformed-entries")).full, "utf8"));
    assert.equal(backupRaw.rawContent, "{not-json");
  });
});

test("memory module never invokes desktop automation code", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryView({});
    await store.memoryRemember({ text: "No desktop", source: "user" });
    const source = await fs.readFile(path.join(__dirname, "memory.cjs"), "utf8");
    assert.equal(source.includes("osascript"), false);
    assert.equal(source.includes("screencapture"), false);
    assert.equal(source.includes("SendInput"), false);
    assert.equal(source.includes("desktopCapturer"), false);
    assert.equal(source.includes("windows-ui.ps1"), false);
  });
});
