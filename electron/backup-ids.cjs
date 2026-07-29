"use strict";

/**
 * Exact backup / baseline identifier normalization and matching.
 * No fuzzy `includes` matching — ambiguity fails closed.
 */

function isoToStamp(iso) {
  return String(iso || "").replace(/[:.]/g, "-");
}

function stampToIsoCandidate(stamp) {
  const s = String(stamp || "");
  // 2026-07-29T12-00-00-000Z → 2026-07-29T12:00:00.000Z
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/);
  if (!m) return null;
  return `${m[1]}${m[2]}:${m[3]}:${m[4]}.${m[5]}`;
}

function basenameWithoutJson(name) {
  const n = String(name || "");
  return n.toLowerCase().endsWith(".json") ? n.slice(0, -5) : n;
}

/**
 * Extract leading ISO-like stamp from ordinary backup filename.
 * e.g. 2026-07-29T12-00-00-000Z-priorities-remove.json → 2026-07-29T12-00-00-000Z
 */
function stampPrefixFromFilename(name) {
  const base = basenameWithoutJson(name);
  const m = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  return m ? m[1] : null;
}

/**
 * Build the set of exact identity strings a candidate file/baseline supports.
 */
function identityKeysForCandidate(candidate) {
  const keys = new Set();
  const name = String(candidate.name || candidate.fileName || "");
  if (!name) return keys;

  keys.add(name);
  keys.add(basenameWithoutJson(name));

  const stamp = stampPrefixFromFilename(name);
  if (stamp) {
    keys.add(stamp);
    const iso = stampToIsoCandidate(stamp);
    if (iso) keys.add(iso);
  }

  if (candidate.createdAt) {
    const created = String(candidate.createdAt);
    keys.add(created);
    keys.add(isoToStamp(created));
  }

  if (candidate.id) keys.add(String(candidate.id));
  if (candidate.baselineName) {
    keys.add(String(candidate.baselineName).trim().toLowerCase());
  }

  return keys;
}

function normalizeQuery(query) {
  if (query == null) return { empty: true, value: "" };
  const trimmed = String(query).trim();
  if (!trimmed) return { empty: true, value: "" };
  return { empty: false, value: trimmed };
}

/**
 * Resolve a backupId against ordinary + baseline candidates.
 *
 * @param {string|null|undefined} backupId
 * @param {{
 *   ordinaryFiles: Array<{ name: string, full: string, mtimeMs?: number, createdAt?: string }>,
 *   baselineEntries?: Array<{
 *     id?: string,
 *     name?: string,
 *     fileName: string,
 *     full: string,
 *     createdAt?: string,
 *     recoverable?: boolean,
 *     conflict?: boolean,
 *     invalid?: boolean,
 *     missing?: boolean,
 *   }>,
 * }} options
 */
function resolveBackupIdentifier(backupId, options = {}) {
  const ordinaryFiles = Array.isArray(options.ordinaryFiles) ? options.ordinaryFiles : [];
  const baselineEntries = Array.isArray(options.baselineEntries) ? options.baselineEntries : [];

  const query = normalizeQuery(backupId);
  if (query.empty) {
    // Omitted → newest ordinary only (never a baseline).
    if (!ordinaryFiles.length) {
      return {
        ok: false,
        code: "RESTORE_FAILED",
        message: "No backup was found to restore.",
      };
    }
    const newest = [...ordinaryFiles].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
    return {
      ok: true,
      file: newest,
      source: "ordinary",
    };
  }

  const q = query.value;
  const qLower = q.toLowerCase();
  const matches = [];

  for (const file of ordinaryFiles) {
    const candidate = {
      name: file.name,
      createdAt: file.createdAt,
    };
    const keys = identityKeysForCandidate(candidate);
    if (keys.has(q) || keys.has(qLower) || keys.has(isoToStamp(q))) {
      matches.push({ file, source: "ordinary", label: file.name });
    }
  }

  for (const entry of baselineEntries) {
    if (entry.invalid || entry.missing || entry.conflict || entry.recoverable === false) continue;
    if (entry.conflict) continue;
    const candidate = {
      name: entry.fileName,
      fileName: entry.fileName,
      id: entry.id,
      baselineName: entry.name,
      createdAt: entry.createdAt,
    };
    const keys = identityKeysForCandidate(candidate);
    // Name match is case-insensitive exact only when unique among baselines (caller marks conflict).
    if (
      keys.has(q) ||
      keys.has(qLower) ||
      keys.has(isoToStamp(q)) ||
      (entry.name && String(entry.name).trim().toLowerCase() === qLower)
    ) {
      matches.push({
        file: { name: entry.fileName, full: entry.full, mtimeMs: entry.mtimeMs || 0 },
        source: "baseline",
        label: entry.id || entry.fileName,
        baseline: entry,
      });
    }
  }

  // Deduplicate by full path.
  const byFull = new Map();
  for (const match of matches) {
    const key = match.file.full || match.file.name;
    if (!byFull.has(key)) byFull.set(key, match);
  }
  const unique = [...byFull.values()];

  if (unique.length === 0) {
    return {
      ok: false,
      code: "RESTORE_FAILED",
      message: "No backup was found to restore.",
    };
  }
  if (unique.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS_BACKUP_ID",
      message: "Multiple backups match that identifier. Use a full filename or unique baseline id.",
      candidates: unique.map((item) => item.label),
    };
  }

  return {
    ok: true,
    file: unique[0].file,
    source: unique[0].source,
    baseline: unique[0].baseline || null,
  };
}

/**
 * List only ordinary direct-child .json files under backups/ (skip directories like baselines/).
 */
async function listOrdinaryBackupFiles(backupsDir, fsApi) {
  const fs = fsApi || require("node:fs/promises");
  try {
    const names = await fs.readdir(backupsDir);
    const withStats = [];
    for (const name of names) {
      if (!name || name === "baselines") continue;
      const full = require("node:path").join(backupsDir, name);
      let stats;
      try {
        stats = await fs.lstat(full);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (!name.toLowerCase().endsWith(".json")) continue;
      withStats.push({ name, full, mtimeMs: stats.mtimeMs || 0, size: stats.size || 0 });
    }
    return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

module.exports = {
  isoToStamp,
  stampToIsoCandidate,
  basenameWithoutJson,
  stampPrefixFromFilename,
  identityKeysForCandidate,
  normalizeQuery,
  resolveBackupIdentifier,
  listOrdinaryBackupFiles,
};
