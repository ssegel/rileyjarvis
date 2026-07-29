"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

const JOURNAL_FILENAME = "pilot-issues.jsonl";
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_JOURNAL_LINES = 200;
const MAX_ARCHIVES = 5;

function createPilotJournal(options = {}) {
  const rootDir = options.rootDir;
  const fsApi = options.fsApi || require("node:fs/promises");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const maxJournalBytes =
    typeof options.maxJournalBytes === "number" && options.maxJournalBytes > 0
      ? options.maxJournalBytes
      : MAX_JOURNAL_BYTES;
  const maxJournalLines =
    typeof options.maxJournalLines === "number" && options.maxJournalLines > 0
      ? options.maxJournalLines
      : MAX_JOURNAL_LINES;
  const maxArchives =
    typeof options.maxArchives === "number" && options.maxArchives > 0
      ? options.maxArchives
      : MAX_ARCHIVES;
  const sanitizeText =
    typeof options.sanitizeText === "function"
      ? options.sanitizeText
      : (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

  const journalPath = path.join(rootDir, JOURNAL_FILENAME);
  let writeQueue = Promise.resolve();

  function enqueue(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function createIssueId() {
    if (typeof options.randomUUID === "function") {
      const id = options.randomUUID();
      return String(id).startsWith("iss_") ? String(id) : `iss_${id}`;
    }
    if (crypto.randomUUID) return `iss_${crypto.randomUUID()}`;
    return `iss_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function buildRecord(input = {}) {
    const pendingIn = input.pending && typeof input.pending === "object" ? input.pending : null;
    const buildIn = input.build && typeof input.build === "object" ? input.build : {};
    const record = {
      schemaVersion: 1,
      id: createIssueId(),
      recordedAt: now().toISOString(),
      build: {
        version: sanitizeText(buildIn.version || "1.0.0", 40),
        branch: buildIn.branch != null ? sanitizeText(String(buildIn.branch), 80) : null,
        gitSha: buildIn.gitSha != null ? sanitizeText(String(buildIn.gitSha), 40) : null,
      },
      errorCode: input.errorCode != null ? sanitizeText(String(input.errorCode), 64) : null,
      httpStatus:
        typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)
          ? input.httpStatus
          : null,
      cooldownUntilMs:
        typeof input.cooldownUntilMs === "number" && Number.isFinite(input.cooldownUntilMs)
          ? input.cooldownUntilMs
          : null,
      connectionState:
        input.connectionState != null ? sanitizeText(String(input.connectionState), 64) : null,
      pending: pendingIn
        ? {
            toolName: pendingIn.toolName != null ? sanitizeText(String(pendingIn.toolName), 80) : null,
            operation:
              pendingIn.operation != null ? sanitizeText(String(pendingIn.operation), 80) : null,
            scope: pendingIn.scope != null ? sanitizeText(String(pendingIn.scope), 80) : null,
            expiresAt:
              typeof pendingIn.expiresAt === "number" && Number.isFinite(pendingIn.expiresAt)
                ? pendingIn.expiresAt
                : null,
          }
        : null,
      note: input.note != null ? sanitizeText(String(input.note), 240) : "",
      staleBuild: input.staleBuild === true,
    };

    // Strip any attacker-supplied forbidden keys by rebuilding allowlist only.
    return record;
  }

  async function pathExists(filePath) {
    try {
      await fsApi.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function measureFile(filePath) {
    try {
      const stats = await fsApi.stat(filePath);
      return { exists: true, size: stats.size || 0 };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async function countLines(filePath) {
    try {
      const text = await fsApi.readFile(filePath, "utf8");
      if (!text) return 0;
      return text.split(/\r?\n/).filter((line) => line.length > 0).length;
    } catch {
      return 0;
    }
  }

  async function listArchives() {
    let names = [];
    try {
      names = await fsApi.readdir(rootDir);
    } catch {
      return [];
    }
    const archives = [];
    for (const name of names) {
      if (!/^pilot-issues-\d{8}T\d{6,}\.jsonl$/i.test(name) && !/^pilot-issues-.+\.jsonl$/i.test(name)) {
        continue;
      }
      if (name === JOURNAL_FILENAME) continue;
      const full = path.join(rootDir, name);
      try {
        const stats = await fsApi.stat(full);
        if (!stats.isFile()) continue;
        archives.push({ name, full, mtimeMs: stats.mtimeMs || 0 });
      } catch {
        // ignore
      }
    }
    return archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async function pruneArchives() {
    const archives = await listArchives();
    for (const file of archives.slice(maxArchives)) {
      try {
        await fsApi.unlink(file.full);
      } catch {
        // Keep extras if prune fails.
      }
    }
  }

  async function forceRollover() {
    const stamp = now().toISOString().replace(/[:.]/g, "").replace(/-/g, "").replace("T", "T");
    const archiveName = `pilot-issues-${stamp}.jsonl`;
    const archivePath = path.join(rootDir, archiveName);
    try {
      await fsApi.rename(journalPath, archivePath);
    } catch (error) {
      return {
        ok: false,
        code: "PILOT_JOURNAL_WRITE_FAILED",
        message: "Pilot journal rollover failed.",
        error,
      };
    }
    await pruneArchives();
    return { ok: true, rolled: true, archivePath };
  }

  /**
   * Evaluate whether appending `line` would exceed ceilings; rollover first if needed.
   * Builds projected size/line counts from the existing file + the incoming line.
   */
  async function rolloverIfNeededForLine(line) {
    const lineBytes = Buffer.byteLength(String(line || ""), "utf8");
    if (lineBytes > maxJournalBytes) {
      return {
        ok: false,
        code: "PILOT_JOURNAL_WRITE_FAILED",
        message: "Pilot journal record exceeds the active-file size budget.",
      };
    }
    const measured = await measureFile(journalPath);
    if (!measured.exists) return { ok: true, rolled: false };
    const lines = await countLines(journalPath);
    const projectedLines = lines + 1;
    const projectedBytes = (measured.size || 0) + lineBytes;
    if (projectedLines <= maxJournalLines && projectedBytes <= maxJournalBytes) {
      return { ok: true, rolled: false };
    }
    return forceRollover();
  }

  async function appendRecord(input) {
    return enqueue(async () => {
      try {
        await fsApi.mkdir(rootDir, { recursive: true });
        const record = buildRecord(input);
        const line = `${JSON.stringify(record)}\n`;
        const rolled = await rolloverIfNeededForLine(line);
        if (!rolled.ok) {
          return {
            ok: false,
            code: rolled.code,
            message: rolled.message,
          };
        }
        try {
          await fsApi.appendFile(journalPath, line, "utf8");
        } catch (error) {
          return {
            ok: false,
            code: "PILOT_JOURNAL_WRITE_FAILED",
            message: "Pilot journal append failed.",
            rolled: rolled.rolled === true,
          };
        }
        return { ok: true, id: record.id, rolled: rolled.rolled === true };
      } catch {
        return {
          ok: false,
          code: "PILOT_JOURNAL_WRITE_FAILED",
          message: "Pilot journal write failed.",
        };
      }
    });
  }

  async function readRecent(limit = 20) {
    try {
      const text = await fsApi.readFile(journalPath, "utf8");
      const lines = text.split(/\r?\n/);
      const records = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") {
            records.push({
              id: parsed.id || null,
              recordedAt: parsed.recordedAt || null,
              errorCode: parsed.errorCode || null,
              note: parsed.note || "",
            });
          }
        } catch {
          // Skip corrupt lines.
        }
      }
      return records.slice(-Math.max(1, Number(limit) || 20));
    } catch {
      return [];
    }
  }

  return {
    JOURNAL_FILENAME,
    journalPath,
    appendRecord,
    readRecent,
    buildRecord,
    enqueue,
    MAX_JOURNAL_BYTES,
    MAX_JOURNAL_LINES,
    MAX_ARCHIVES,
  };
}

module.exports = {
  JOURNAL_FILENAME,
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_LINES,
  MAX_ARCHIVES,
  createPilotJournal,
};
