"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemoryStore } = require("./memory.cjs");
const {
  EMPTY_STATE,
  BRIEFING_SECTION_HEADINGS,
  composeDayBriefing,
  resolveBriefTarget,
  sortArchiveDatesDescending,
  parseArchiveFilenameDate,
} = require("./day-briefing.cjs");

const root = path.join(__dirname, "..");

async function withStore(run, options = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rj-brief-"));
  const clock = {
    value: options.startDate ? new Date(options.startDate) : new Date("2026-07-28T15:00:00.000Z"),
  };
  let uuidSeq = 0;
  const store = createMemoryStore({
    rootDir,
    now: () => new Date(clock.value.getTime()),
    randomUUID:
      options.randomUUID ||
      (() => {
        uuidSeq += 1;
        return `33333333-3333-4333-8333-${String(uuidSeq).padStart(12, "0")}`;
      }),
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

async function hashPath(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

async function snapshotMemoryDisk(store) {
  const dailyHash = await hashPath(store.paths.daily);
  let archiveNames = [];
  try {
    archiveNames = (await fsp.readdir(store.paths.archive)).sort();
  } catch {
    archiveNames = [];
  }
  const archives = {};
  for (const name of archiveNames) {
    archives[name] = await hashPath(path.join(store.paths.archive, name));
  }
  return { dailyHash, archives, archiveNames };
}

function assertAllSevenHeadings(content) {
  let lastIndex = -1;
  for (const heading of BRIEFING_SECTION_HEADINGS) {
    const marker = `## ${heading}\n`;
    const index = content.indexOf(marker);
    assert.ok(index !== -1, `missing section ${heading}`);
    assert.ok(index > lastIndex, `section order broken at ${heading}`);
    lastIndex = index;
  }
}

function sectionContent(content, heading) {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(re);
  assert.ok(match, `missing section ${heading}`);
  return match[1].trim();
}

async function writeArchiveFile(store, date, partial = {}) {
  await fsp.mkdir(store.paths.archive, { recursive: true });
  const body = {
    schemaVersion: 1,
    date,
    summary: "",
    priorities: [],
    activeProjects: [],
    commitments: [],
    followUps: [],
    unresolved: [],
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
  await fsp.writeFile(
    path.join(store.paths.archive, `daily-${date}.json`),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

test("T01 brief today with mixed filled sections preserves order", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({ summary: "Focus on briefing ship" });
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "First priority" }, { text: "Second priority" }],
    });
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [
        { text: "Due today item", due: "2026-07-28" },
        { text: "No due item" },
      ],
    });
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Follow Cecilia" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      item: { text: "Scanner access" },
    });
    await store.memoryActiveProjects({
      operation: "add",
      items: [
        { name: "Jarvis", note: "Phase 16" },
        { name: "Website" },
      ],
    });

    const result = await store.memoryDayBriefing({ operation: "brief" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "today");
    assert.equal(result.targetDate, "2026-07-28");
    assert.equal(result.dailyDate, "2026-07-28");
    assert.equal(result.message, "Day briefing for today (2026-07-28).");
    assertAllSevenHeadings(result.artifact.content);
    assert.equal(sectionContent(result.artifact.content, "Summary"), "Focus on briefing ship");
    assert.equal(
      sectionContent(result.artifact.content, "Open priorities"),
      "- First priority\n- Second priority",
    );
    assert.match(sectionContent(result.artifact.content, "Commitments due now"), /Due today item/);
    assert.match(sectionContent(result.artifact.content, "Other open commitments"), /No due item/);
    assert.equal(sectionContent(result.artifact.content, "Open follow-ups"), "- Follow Cecilia");
    assert.equal(sectionContent(result.artifact.content, "Open unresolved items"), "- Scanner access");
    assert.equal(
      sectionContent(result.artifact.content, "Active projects"),
      "- Jarvis: Phase 16\n- Website",
    );
    assert.equal(result.artifact.title, "Day briefing — 2026-07-28");
    assert.equal(result.artifact.kind, "text");
  });
});

test("T02 brief today all-empty daily shows none. for every section", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const result = await store.memoryDayBriefing({ operation: "brief", targetDate: "today" });
    assert.equal(result.ok, true);
    assertAllSevenHeadings(result.artifact.content);
    for (const heading of BRIEFING_SECTION_HEADINGS) {
      assert.equal(sectionContent(result.artifact.content, heading), EMPTY_STATE);
    }
  });
});

test("T03 due now vs other split; future-deferred excluded", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [
        { text: "Overdue", due: "2026-07-20" },
        { text: "Due today", due: "2026-07-28" },
        { text: "Future due", due: "2026-08-01" },
        { text: "Undated" },
        { text: "Deferred future", deferredUntil: "2026-08-05" },
      ],
    });

    const result = await store.memoryDayBriefing({ operation: "brief" });
    const dueNow = sectionContent(result.artifact.content, "Commitments due now");
    const other = sectionContent(result.artifact.content, "Other open commitments");
    assert.match(dueNow, /Overdue/);
    assert.match(dueNow, /Due today/);
    assert.doesNotMatch(dueNow, /Future due/);
    assert.doesNotMatch(dueNow, /Undated/);
    assert.doesNotMatch(dueNow, /Deferred future/);
    assert.match(other, /Future due/);
    assert.match(other, /Undated/);
    assert.doesNotMatch(other, /Deferred future/);
    assert.doesNotMatch(other, /Overdue/);
  });
});

test("T04 done priorities and WC excluded", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({
      operation: "add",
      items: [{ text: "Open one" }, { text: "Done one" }],
    });
    await store.memoryPriorities({
      operation: "complete",
      reference: { by: "text", value: "Done one" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      items: [{ text: "Open commitment" }, { text: "Done commitment" }],
    });
    await store.workingContextItems({
      operation: "complete",
      scope: "commitments",
      reference: { by: "text", value: "Done commitment" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      items: [{ text: "Open FU" }, { text: "Done FU" }],
    });
    await store.workingContextItems({
      operation: "complete",
      scope: "follow_ups",
      reference: { by: "text", value: "Done FU" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      items: [{ text: "Open UR" }, { text: "Done UR" }],
    });
    await store.workingContextItems({
      operation: "complete",
      scope: "unresolved_items",
      reference: { by: "text", value: "Done UR" },
    });

    const result = await store.memoryDayBriefing({ operation: "brief" });
    const content = result.artifact.content;
    assert.match(content, /Open one/);
    assert.doesNotMatch(content, /Done one/);
    assert.match(content, /Open commitment/);
    assert.doesNotMatch(content, /Done commitment/);
    assert.match(content, /Open FU/);
    assert.doesNotMatch(content, /Done FU/);
    assert.match(content, /Open UR/);
    assert.doesNotMatch(content, /Done UR/);
  });
});

test("T05 legacy priority active included", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const daily = await store.loadAll().then((d) => d.daily);
    daily.priorities = [
      {
        id: "legacy-active-1",
        text: "Legacy active priority",
        status: "active",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ];
    await store.atomicWriteJson(store.paths.daily, daily);
    const result = await store.memoryDayBriefing({ operation: "brief" });
    assert.equal(sectionContent(result.artifact.content, "Open priorities"), "- Legacy active priority");
  });
});

test("T06 projects listed in stored order with notes", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryActiveProjects({
      operation: "add",
      items: [
        { name: "Alpha", note: "note A" },
        { name: "Beta" },
        { name: "Gamma", note: "note G" },
      ],
    });
    const result = await store.memoryDayBriefing({ operation: "brief" });
    assert.equal(
      sectionContent(result.artifact.content, "Active projects"),
      "- Alpha: note A\n- Beta\n- Gamma: note G",
    );
  });
});

test("T07 commitment secret/sensitive redaction", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const secret = await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Secret passphrase XYZ", sensitivity: "secret", due: "2026-07-28" },
    });
    const sensitive = await store.workingContextItems({
      operation: "add",
      scope: "commitments",
      item: { text: "Sensitive salary figure", sensitivity: "sensitive" },
    });
    assert.equal(secret.ok, true);
    assert.equal(sensitive.ok, true);
    const daily = (await store.loadAll()).daily;
    const secretItem = daily.commitments.find((i) => i.text === "Secret passphrase XYZ");
    const sensitiveItem = daily.commitments.find((i) => i.text === "Sensitive salary figure");
    assert.ok(secretItem);
    assert.ok(sensitiveItem);
    assert.equal(secretItem.sensitivity, "secret");
    assert.equal(sensitiveItem.sensitivity, "sensitive");

    const result = await store.memoryDayBriefing({ operation: "brief" });
    const content = result.artifact.content;
    assert.doesNotMatch(content, /Secret passphrase XYZ/);
    assert.doesNotMatch(content, /Sensitive salary figure/);
    assert.match(content, new RegExp(`\\[secret commitment stored\\] \\(${secretItem.id}\\)`));
    assert.match(content, new RegExp(`\\[sensitive commitment stored\\] \\(${sensitiveItem.id}\\)`));
  });
});

test("T08 follow-up/unresolved with sensitivity shown as stored text", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.workingContextItems({
      operation: "add",
      scope: "follow_ups",
      item: { text: "Sensitive FU text", sensitivity: "sensitive" },
    });
    await store.workingContextItems({
      operation: "add",
      scope: "unresolved_items",
      item: { text: "Secret UR text", sensitivity: "secret" },
    });
    const result = await store.memoryDayBriefing({ operation: "brief" });
    assert.match(result.artifact.content, /Sensitive FU text/);
    assert.match(result.artifact.content, /Secret UR text/);
    assert.doesNotMatch(result.artifact.content, /\[secret commitment stored\]/);
  });
});

test("T09 list_archives sorting descending; ignores junk filenames", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await writeArchiveFile(store, "2026-07-20", { summary: "A" });
    await writeArchiveFile(store, "2026-07-25", { summary: "B" });
    await writeArchiveFile(store, "2026-07-22", { summary: "C" });
    await fsp.writeFile(path.join(store.paths.archive, "readme.txt"), "ignore", "utf8");
    await fsp.writeFile(path.join(store.paths.archive, "daily-not-a-date.json"), "{}", "utf8");
    await fsp.writeFile(path.join(store.paths.archive, "other-2026-07-21.json"), "{}", "utf8");

    const result = await store.memoryDayBriefing({ operation: "list_archives" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.dates, ["2026-07-25", "2026-07-22", "2026-07-20"]);
    assert.equal(result.count, 3);
    assert.equal(result.message, "Found 3 archived day(s).");
  });
});

test("T10 malformed archive omitted from list; list still ok", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await writeArchiveFile(store, "2026-07-20", { summary: "good" });
    await fsp.writeFile(path.join(store.paths.archive, "daily-2026-07-21.json"), "{not-json", "utf8");
    await writeArchiveFile(store, "2026-07-19", { date: "2026-07-01", summary: "mismatch" });

    const result = await store.memoryDayBriefing({ operation: "list_archives" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.dates, ["2026-07-20"]);
    assert.equal(result.count, 1);
  });
});

test("T11 brief missing archive ARCHIVE_NOT_FOUND; disk unchanged", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const before = await snapshotMemoryDisk(store);
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-10",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ARCHIVE_NOT_FOUND");
    assert.equal(result.artifact, undefined);
    const after = await snapshotMemoryDisk(store);
    assert.deepEqual(after, before);
  });
});

test("T12 brief malformed archive ARCHIVE_MALFORMED; disk unchanged", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await fsp.mkdir(store.paths.archive, { recursive: true });
    await fsp.writeFile(path.join(store.paths.archive, "daily-2026-07-15.json"), "{bad", "utf8");
    const before = await snapshotMemoryDisk(store);
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-15",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ARCHIVE_MALFORMED");
    assert.equal(result.artifact, undefined);
    const after = await snapshotMemoryDisk(store);
    assert.deepEqual(after, before);
  });
});

test("T13 brief yesterday alias resolves to calendarToday-1 archive", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await writeArchiveFile(store, "2026-07-27", {
      summary: "Yesterday summary",
      priorities: [
        {
          id: "p1",
          text: "Yesterday priority",
          status: "open",
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
      ],
    });
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "yesterday",
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "archive");
    assert.equal(result.targetDate, "2026-07-27");
    assert.equal(result.dailyDate, "2026-07-27");
    assert.equal(result.message, "Day briefing for archived day 2026-07-27.");
    assert.equal(sectionContent(result.artifact.content, "Summary"), "Yesterday summary");
    assert.equal(sectionContent(result.artifact.content, "Open priorities"), "- Yesterday priority");
  });
});

test("archive brief classifies due-now against snapshot date not calendar today", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    // Calendar today is 2026-07-28. Against calendar today, due 2026-07-26 would be due-now.
    // Against archive date 2026-07-25, due 2026-07-26 must stay in other open commitments.
    await writeArchiveFile(store, "2026-07-25", {
      summary: "Archive classification",
      commitments: [
        {
          id: "c-due-on-archive-day",
          text: "Due on archive day",
          status: "open",
          due: "2026-07-25",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "c-due-after-archive",
          text: "Due after archive day",
          status: "open",
          due: "2026-07-26",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "c-deferred-after-archive",
          text: "Deferred after archive day",
          status: "open",
          deferredUntil: "2026-07-26",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
    });

    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-25",
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "archive");
    const dueNow = sectionContent(result.artifact.content, "Commitments due now");
    const other = sectionContent(result.artifact.content, "Other open commitments");
    assert.match(dueNow, /Due on archive day/);
    assert.doesNotMatch(dueNow, /Due after archive day/);
    assert.match(other, /Due after archive day/);
    assert.doesNotMatch(other, /Deferred after archive day/);
    assert.doesNotMatch(result.artifact.content, /Deferred after archive day/);
  });
});

test("T14 brief explicit past ISO uses archive content", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await writeArchiveFile(store, "2026-07-25", {
      summary: "July 25 archive",
      followUps: [
        {
          id: "f1",
          text: "Archived follow-up",
          status: "open",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
    });
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-25",
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "archive");
    assert.equal(result.targetDate, "2026-07-25");
    assert.equal(sectionContent(result.artifact.content, "Summary"), "July 25 archive");
    assert.equal(sectionContent(result.artifact.content, "Open follow-ups"), "- Archived follow-up");
  });
});

test("T15 brief tomorrow / future ISO UNSUPPORTED_DATE; no future file read", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await fsp.mkdir(store.paths.future, { recursive: true });
    const futurePath = path.join(store.paths.future, "daily-2026-07-29.json");
    await fsp.writeFile(
      futurePath,
      JSON.stringify({
        schemaVersion: 1,
        date: "2026-07-29",
        summary: "Should not be read",
        priorities: [{ id: "x", text: "Future priority", status: "open", updatedAt: "t" }],
        activeProjects: [],
        commitments: [],
        followUps: [],
        unresolved: [],
        updatedAt: "t",
      }),
      "utf8",
    );
    const futureBefore = await hashPath(futurePath);

    const tomorrow = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "tomorrow",
    });
    assert.equal(tomorrow.ok, false);
    assert.equal(tomorrow.code, "UNSUPPORTED_DATE");

    const futureIso = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-29",
    });
    assert.equal(futureIso.ok, false);
    assert.equal(futureIso.code, "UNSUPPORTED_DATE");
    assert.equal(await hashPath(futurePath), futureBefore);
  });
});

test("T16 brief today via explicit ISO = calendarToday uses live daily", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({ summary: "Live today via ISO" });
    await writeArchiveFile(store, "2026-07-28", { summary: "Wrong archive same date" });

    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-28",
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "today");
    assert.equal(sectionContent(result.artifact.content, "Summary"), "Live today via ISO");
  });
});

test("T17 invalid targetDate token VALIDATION_FAILED", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "next week",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "VALIDATION_FAILED");
  });
});

test("T18 unknown operation UNSUPPORTED_OPERATION", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const result = await store.memoryDayBriefing({ operation: "restore" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNSUPPORTED_OPERATION");
  });
});

test("T19 non-mutation: daily.json + archives byte-identical after brief/list", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryUpdateDaily({ summary: "Stable" });
    await writeArchiveFile(store, "2026-07-26", { summary: "Arch" });
    const before = await snapshotMemoryDisk(store);

    await store.memoryDayBriefing({ operation: "brief" });
    await store.memoryDayBriefing({ operation: "brief", targetDate: "yesterday" });
    await store.memoryDayBriefing({ operation: "list_archives" });
    await store.memoryDayBriefing({ operation: "brief", targetDate: "2026-07-26" });

    const after = await snapshotMemoryDisk(store);
    assert.deepEqual(after, before);
  });
});

test("T20 archive date field mismatch ARCHIVE_MALFORMED", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await writeArchiveFile(store, "2026-07-24", { date: "2026-07-01", summary: "mismatch" });
    const before = await snapshotMemoryDisk(store);
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "2026-07-24",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ARCHIVE_MALFORMED");
    assert.deepEqual(await snapshotMemoryDisk(store), before);
  });
});

test("T21 tool schema and instructions present in main.cjs", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  assert.match(main, /name:\s*"memory_day_briefing"/);
  assert.match(main, /if \(name === "memory_day_briefing"\)/);
  assert.match(main, /memoryStore\.memoryDayBriefing\(args\)/);
  assert.match(main, /enum:\s*\[\s*"brief",\s*"list_archives"\s*\]/);
  assert.match(main, /Brief me on today/);
  assert.match(main, /"targetDate":"yesterday"/);
  assert.match(main, /list_archives/);
  assert.match(main, /never invent/i);
  assert.match(main, /Do not invent items missing from the artifact/);
  assert.match(main, /ipcMain\.handle\("tools:list", \(\) => toolSpecs\)/);
  assert.match(main, /tools:\s*toolSpecs/);
  assert.match(main, /getToolSpecs:\s*\(\) => toolSpecs/);
  assert.match(main, /executeTool:\s*\(toolCall\) => executeTrustedTool\(toolCall\)/);
  assert.match(main, /ipcMain\.handle\("tools:execute".*executeTrustedTool/);

  const textSession = fs.readFileSync(path.join(root, "electron/text-session.cjs"), "utf8");
  assert.match(textSession, /mapToolsForResponses\(toolSpecs\)|getToolSpecs/);
});

test("T22 no raw daily JSON dump in success payload", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    await store.memoryPriorities({ operation: "add", item: { text: "P" } });
    const brief = await store.memoryDayBriefing({ operation: "brief" });
    assert.equal(brief.ok, true);
    assert.equal(brief.daily, undefined);
    assert.equal(typeof brief.artifact.content, "string");
    assert.doesNotMatch(JSON.stringify(brief), /"priorities":\s*\[/);

    const list = await store.memoryDayBriefing({ operation: "list_archives" });
    assert.equal(list.ok, true);
    assert.equal(list.daily, undefined);
  });
});

test("list_archives ignores targetDate and empty archive message", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const empty = await store.memoryDayBriefing({
      operation: "list_archives",
      targetDate: "yesterday",
    });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.dates, []);
    assert.equal(empty.count, 0);
    assert.equal(empty.message, "No archived days found.");
  });
});

test("pure helpers: resolveBriefTarget and archive filename parse", () => {
  assert.deepEqual(resolveBriefTarget(undefined, "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-28",
    source: "today",
  });
  assert.deepEqual(resolveBriefTarget("", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-28",
    source: "today",
  });
  assert.deepEqual(resolveBriefTarget("   ", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-28",
    source: "today",
  });
  assert.deepEqual(resolveBriefTarget("TODAY", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-28",
    source: "today",
  });
  assert.deepEqual(resolveBriefTarget("2026-07-28", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-28",
    source: "today",
  });
  assert.deepEqual(resolveBriefTarget("yesterday", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-27",
    source: "archive",
  });
  assert.deepEqual(resolveBriefTarget("2026-07-20", "2026-07-28"), {
    ok: true,
    resolvedDate: "2026-07-20",
    source: "archive",
  });
  assert.equal(resolveBriefTarget("Tomorrow", "2026-07-28").code, "UNSUPPORTED_DATE");
  assert.equal(resolveBriefTarget("2026-07-29", "2026-07-28").code, "UNSUPPORTED_DATE");
  assert.equal(resolveBriefTarget("bogus", "2026-07-28").code, "VALIDATION_FAILED");
  assert.equal(resolveBriefTarget(42, "2026-07-28").code, "VALIDATION_FAILED");
  assert.equal(parseArchiveFilenameDate("daily-2026-07-25.json"), "2026-07-25");
  assert.equal(parseArchiveFilenameDate("junk.json"), null);
  assert.deepEqual(sortArchiveDatesDescending(["2026-07-20", "2026-07-25", "2026-07-22"]), [
    "2026-07-25",
    "2026-07-22",
    "2026-07-20",
  ]);

  const empty = composeDayBriefing({
    date: "2026-07-28",
    summary: "  ",
    priorities: [],
    commitments: [],
    followUps: [],
    unresolved: [],
    activeProjects: [],
  });
  assert.equal(empty.sections.summary, EMPTY_STATE);
});

test("T19b yesterday missing after ensure returns ARCHIVE_NOT_FOUND", async () => {
  await withStore(async (store) => {
    await store.ensureMemory();
    const result = await store.memoryDayBriefing({
      operation: "brief",
      targetDate: "Yesterday",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ARCHIVE_NOT_FOUND");
    assert.equal(result.targetDate, "2026-07-27");
  });
});
