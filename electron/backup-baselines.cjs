"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

const REGISTRY_FILENAME = "backup-baselines.json";
const BASELINES_DIRNAME = "baselines";
const SCHEMA_VERSION = 1;
const HEADER_READ_LIMIT = 64 * 1024;
const MAX_PROTECTED_BASELINES = 8;
const MAX_PROTECTED_BASELINE_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_BACKUP_BYTES = 8 * 1024 * 1024;
const DELETION_PREFIX = ".deleting-";

function emptyRegistry(nowIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso || new Date().toISOString(),
    baselines: [],
  };
}

/** Closed public projection — never includes absolute paths or raw internals. */
function projectPublicBaselineMetadata(row) {
  const source = row && typeof row === "object" ? row : {};
  return {
    id: source.id != null ? String(source.id) : null,
    name: source.name != null ? String(source.name) : null,
    fileName: source.fileName != null ? String(source.fileName) : null,
    createdAt: source.createdAt != null ? String(source.createdAt) : null,
    createdBy: source.createdBy != null ? String(source.createdBy) : null,
    note: source.note != null ? String(source.note) : null,
    registered: source.registered === true,
    recovered: source.recovered === true,
    invalid: source.invalid === true,
    missing: source.missing === true,
    conflict: source.conflict === true,
    recoveryArtifact: source.recoveryArtifact === true,
    cleanupPending: source.cleanupPending === true,
    operationId: source.operationId != null ? String(source.operationId) : null,
    reason: source.reason != null ? String(source.reason) : null,
    size: Number(source.size) || 0,
    mtimeMs: Number(source.mtimeMs) || 0,
  };
}

function parseDeletionArtifactName(fileName) {
  const name = String(fileName || "");
  if (!name.startsWith(DELETION_PREFIX)) return null;
  const match = name.match(/^\.deleting-([a-zA-Z0-9_]{8,80})-(.+)$/);
  if (!match || !isSafeBasename(match[2]) || match[2].startsWith(DELETION_PREFIX)) {
    return { valid: false, fileName: path.basename(name) };
  }
  return {
    valid: true,
    fileName: name,
    operationId: match[1],
    originalFileName: match[2],
  };
}

function sanitizeBaselineName(raw, sanitizeText) {
  const sanitize =
    typeof sanitizeText === "function"
      ? sanitizeText
      : (value, max = 80) => String(value || "").trim().slice(0, max);
  const name = sanitize(String(raw || "").trim(), 80);
  return name;
}

function isSafeBasename(fileName) {
  const name = String(fileName || "");
  if (!name || name !== path.basename(name)) return false;
  if (name === "." || name === ".." || name.includes("\0")) return false;
  if (/[\\/]/.test(name)) return false;
  if (name.includes("..")) return false;
  return true;
}

/**
 * Resolve a baseline file path that must be a direct child of baselinesDir.
 * Rejects traversal, absolute paths, and symlink escapes when possible.
 */
async function resolveSafeBaselinePath(baselinesDir, fileName, fsApi) {
  const fs = fsApi || require("node:fs/promises");
  if (!isSafeBasename(fileName)) {
    return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path is invalid." };
  }
  const canonicalDir = path.resolve(baselinesDir);
  const full = path.resolve(canonicalDir, fileName);
  const normalizedDir = canonicalDir.replace(/[\\/]+$/, "");
  if (path.dirname(full) !== normalizedDir && path.dirname(full) !== canonicalDir) {
    return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path escapes the baselines directory." };
  }
  // Reject if resolved path is not a direct child using path.relative.
  const rel = path.relative(canonicalDir, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("..")) {
    return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path escapes the baselines directory." };
  }
  if (path.basename(rel) !== fileName || rel !== fileName) {
    return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path escapes the baselines directory." };
  }

  try {
    const realDir = await fs.realpath(canonicalDir).catch(() => canonicalDir);
    let exists = false;
    let realFull = full;
    try {
      realFull = await fs.realpath(full);
      exists = true;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { ok: true, full, fileName, exists: false };
      }
      return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path could not be resolved." };
    }
    const relReal = path.relative(realDir, realFull);
    if (!relReal || relReal.startsWith("..") || path.isAbsolute(relReal) || path.dirname(relReal) !== ".") {
      return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path escapes the baselines directory." };
    }
    return { ok: true, full: realFull, fileName, exists };
  } catch {
    return { ok: false, code: "BASELINE_PATH_INVALID", message: "Baseline path could not be resolved." };
  }
}

/**
 * Parse only safe header metadata from a baseline/ordinary snapshot without returning bodies.
 */
function extractSafeHeaderMetadata(rawText) {
  const text = String(rawText || "").slice(0, HEADER_READ_LIMIT);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Attempt to parse truncated object by finding top-level keys via regex (bounded).
    const schemaMatch = text.match(/"schemaVersion"\s*:\s*(\d+)/);
    const reasonMatch = text.match(/"reason"\s*:\s*"([^"\\]{0,80})"/);
    const createdMatch = text.match(/"createdAt"\s*:\s*"([^"\\]{0,40})"/);
    const idMatch = text.match(/"baselineId"\s*:\s*"([^"\\]{0,80})"/);
    const nameMatch = text.match(/"baselineName"\s*:\s*"([^"\\]{0,80})"/);
    if (!schemaMatch && !createdMatch && !reasonMatch) {
      return { ok: false, reason: "unparseable_header" };
    }
    return {
      ok: true,
      schemaVersion: schemaMatch ? Number(schemaMatch[1]) : null,
      reason: reasonMatch ? reasonMatch[1] : null,
      createdAt: createdMatch ? createdMatch[1] : null,
      baselineId: idMatch ? idMatch[1] : null,
      baselineName: nameMatch ? nameMatch[1] : null,
      partial: true,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid_header_object" };
  }
  return {
    ok: true,
    schemaVersion: parsed.schemaVersion != null ? Number(parsed.schemaVersion) : null,
    reason: parsed.reason != null ? String(parsed.reason) : null,
    createdAt: parsed.createdAt != null ? String(parsed.createdAt) : null,
    baselineId: parsed.baselineId != null ? String(parsed.baselineId) : null,
    baselineName: parsed.baselineName != null ? String(parsed.baselineName) : null,
    partial: false,
  };
}

async function readBoundedHeader(fullPath, fsApi) {
  const fs = fsApi || require("node:fs/promises");
  const handle = await fs.open(fullPath, "r");
  try {
    const buf = Buffer.alloc(HEADER_READ_LIMIT);
    const { bytesRead } = await handle.read(buf, 0, HEADER_READ_LIMIT, 0);
    return buf.slice(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function createBaselineId(randomUUID) {
  const id =
    typeof randomUUID === "function"
      ? randomUUID()
      : crypto.randomUUID
        ? crypto.randomUUID()
        : `bl_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return String(id).startsWith("bl_") ? String(id) : `bl_${id}`;
}

/**
 * Create a baselines manager bound to a memory root.
 */
function createBaselineStore(options = {}) {
  const rootDir = options.rootDir;
  const fsApi = options.fsApi || require("node:fs/promises");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const randomUUID = options.randomUUID;
  const sanitizeText = options.sanitizeText;
  const atomicWriteJson =
    typeof options.atomicWriteJson === "function"
      ? options.atomicWriteJson
      : async (filePath, value) => {
          const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
          await fsApi.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
          await fsApi.rename(tmp, filePath);
        };

  const baselinesDir = path.join(rootDir, "backups", BASELINES_DIRNAME);
  const registryPath = path.join(rootDir, REGISTRY_FILENAME);
  let deleteSequence = 0;
  let deletionInFlight = 0;
  let recoveryQueue = Promise.resolve();

  async function ensureBaselinesDir() {
    await fsApi.mkdir(baselinesDir, { recursive: true });
  }

  async function readRegistryRaw() {
    try {
      const text = await fsApi.readFile(registryPath, "utf8");
      return { ok: true, text, exists: true };
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, text: null, exists: false };
      return { ok: false, error };
    }
  }

  function parseRegistry(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid_object" };
    }
    if (Number(parsed.schemaVersion) !== SCHEMA_VERSION) {
      return { ok: false, reason: "unsupported_schema" };
    }
    if (!Array.isArray(parsed.baselines)) {
      return { ok: false, reason: "invalid_baselines" };
    }
    return { ok: true, doc: parsed };
  }

  async function preserveCorruptRegistry() {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(rootDir, `backup-baselines.corrupt-${stamp}.json`);
    try {
      await fsApi.rename(registryPath, dest);
      return { ok: true, preservedAs: dest };
    } catch (error) {
      return {
        ok: false,
        code: "BASELINE_REGISTRY_RECOVERY_FAILED",
        message: "Corrupt baseline registry could not be preserved.",
        error,
      };
    }
  }

  async function writeRegistry(doc) {
    const next = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now().toISOString(),
      baselines: Array.isArray(doc.baselines) ? doc.baselines : [],
    };
    await atomicWriteJson(registryPath, next);
    return next;
  }

  function createDeleteOperationId() {
    deleteSequence += 1;
    const entropy =
      typeof randomUUID === "function"
        ? randomUUID()
        : crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const safeEntropy = String(entropy).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48) || "operation";
    return `${safeEntropy}${deleteSequence.toString(36)}`;
  }

  async function pathExistsDirect(fileName) {
    const safe = await resolveSafeBaselinePath(baselinesDir, fileName, fsApi);
    return safe.ok ? safe : { ok: false, exists: false };
  }

  async function recoverDeletionArtifacts(registryDoc, registryState) {
    if (deletionInFlight > 0) {
      return { recoveryArtifacts: [], conflictOriginals: new Set() };
    }

    const run = recoveryQueue.then(async () => {
      let names = [];
      try {
        names = await fsApi.readdir(baselinesDir);
      } catch {
        return { recoveryArtifacts: [], conflictOriginals: new Set() };
      }

      const parsedArtifacts = names
        .filter((name) => String(name).startsWith(DELETION_PREFIX))
        .map((name) => parseDeletionArtifactName(name));
      const recoveryArtifacts = [];
      const conflictOriginals = new Set();
      const byOriginal = new Map();

      for (const artifact of parsedArtifacts) {
        if (!artifact || !artifact.valid) {
          recoveryArtifacts.push({
            fileName: artifact?.fileName || null,
            operationId: null,
            recoveryArtifact: true,
            cleanupPending: false,
            conflict: true,
            reason: "DELETION_ARTIFACT_INVALID",
          });
          continue;
        }
        const group = byOriginal.get(artifact.originalFileName) || [];
        group.push(artifact);
        byOriginal.set(artifact.originalFileName, group);
      }

      const registeredFiles = new Set(
        (Array.isArray(registryDoc?.baselines) ? registryDoc.baselines : [])
          .map((entry) => String(entry?.fileName || ""))
          .filter(Boolean),
      );

      for (const [originalFileName, artifacts] of byOriginal) {
        if (artifacts.length !== 1 || registryState === "corrupt_preserved") {
          conflictOriginals.add(originalFileName);
          for (const artifact of artifacts) {
            recoveryArtifacts.push({
              fileName: originalFileName,
              quarantineFileName: artifact.fileName,
              operationId: artifact.operationId,
              recoveryArtifact: true,
              cleanupPending: false,
              conflict: true,
              reason: "DELETION_RECOVERY_REQUIRED",
            });
          }
          continue;
        }

        const artifact = artifacts[0];
        const quarantine = await pathExistsDirect(artifact.fileName);
        const original = await pathExistsDirect(originalFileName);
        if (!quarantine.ok || !quarantine.exists || !original.ok) continue;

        const registryContainsOriginal = registeredFiles.has(originalFileName);
        if (original.exists) {
          conflictOriginals.add(originalFileName);
          recoveryArtifacts.push({
            fileName: originalFileName,
            quarantineFileName: artifact.fileName,
            operationId: artifact.operationId,
            recoveryArtifact: true,
            cleanupPending: false,
            conflict: true,
            reason: "DELETION_RECOVERY_CONFLICT",
          });
          continue;
        }

        if (registryContainsOriginal) {
          try {
            await fsApi.rename(quarantine.full, original.full);
          } catch (error) {
            if (!error || error.code !== "ENOENT") {
              conflictOriginals.add(originalFileName);
              recoveryArtifacts.push({
                fileName: originalFileName,
                quarantineFileName: artifact.fileName,
                operationId: artifact.operationId,
                recoveryArtifact: true,
                cleanupPending: false,
                conflict: true,
                reason: "DELETION_RECOVERY_REQUIRED",
              });
            }
          }
          continue;
        }

        try {
          await fsApi.unlink(quarantine.full);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            recoveryArtifacts.push({
              fileName: originalFileName,
              quarantineFileName: artifact.fileName,
              operationId: artifact.operationId,
              recoveryArtifact: true,
              cleanupPending: true,
              conflict: false,
              reason: "DELETION_CLEANUP_PENDING",
            });
          }
        }
      }

      return { recoveryArtifacts, conflictOriginals };
    });
    recoveryQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function scanBaselineFiles() {
    await ensureBaselinesDir();
    let names = [];
    try {
      names = await fsApi.readdir(baselinesDir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      // Transaction artifacts are handled only by recoverDeletionArtifacts.
      if (String(name).startsWith(DELETION_PREFIX)) continue;
      const safe = await resolveSafeBaselinePath(baselinesDir, name, fsApi);
      if (!safe.ok) {
        entries.push({
          fileName: path.basename(name),
          full: null,
          invalid: true,
          registered: false,
          recovered: false,
          reason: safe.message,
        });
        continue;
      }
      let stats;
      try {
        stats = await fsApi.lstat(safe.full);
      } catch {
        continue;
      }
      if (!stats.isFile()) {
        entries.push({
          fileName: name,
          full: safe.full,
          invalid: true,
          registered: false,
          recovered: false,
          reason: "not_a_file",
          size: 0,
        });
        continue;
      }
      let header;
      try {
        const raw = await readBoundedHeader(safe.full, fsApi);
        header = extractSafeHeaderMetadata(raw);
      } catch {
        header = { ok: false, reason: "header_read_failed" };
      }
      if (!header.ok) {
        entries.push({
          fileName: name,
          full: safe.full,
          invalid: true,
          registered: false,
          recovered: false,
          reason: header.reason || "invalid",
          size: stats.size || 0,
          mtimeMs: stats.mtimeMs || 0,
        });
        continue;
      }
      entries.push({
        fileName: name,
        full: safe.full,
        invalid: false,
        registered: false,
        recovered: true,
        createdAt: header.createdAt,
        reason: header.reason,
        size: stats.size || 0,
        mtimeMs: stats.mtimeMs || 0,
        headerBaselineId: header.baselineId,
        headerBaselineName: header.baselineName,
      });
    }
    return entries;
  }

  /**
   * Merge registry + disk scan into public list entries (metadata only).
   */
  async function listBaselines() {
    await ensureBaselinesDir();
    const raw = await readRegistryRaw();
    let registryDoc = emptyRegistry(now().toISOString());
    let registryState = "missing";
    let preservedAs = null;

    if (raw.exists && raw.ok && raw.text != null) {
      const parsed = parseRegistry(raw.text);
      if (parsed.ok) {
        registryDoc = parsed.doc;
        registryState = "ok";
      } else {
        const preserved = await preserveCorruptRegistry();
        if (!preserved.ok) {
          return {
            ok: false,
            code: preserved.code,
            message: preserved.message,
            baselines: [],
          };
        }
        preservedAs = preserved.preservedAs;
        registryState = "corrupt_preserved";
        registryDoc = emptyRegistry(now().toISOString());
        // Do not write empty registry until user re-registers / creates.
      }
    }

    const recovery = await recoverDeletionArtifacts(registryDoc, registryState);
    const scanned = await scanBaselineFiles();
    const byFile = new Map(scanned.map((item) => [item.fileName, item]));
    const results = [];
    const nameCounts = new Map();
    const idCounts = new Map();

    const registered = Array.isArray(registryDoc.baselines) ? registryDoc.baselines : [];
    for (const entry of registered) {
      const fileName = entry && entry.fileName != null ? String(entry.fileName) : "";
      const id = entry && entry.id != null ? String(entry.id) : "";
      const name = entry && entry.name != null ? String(entry.name) : "";
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
      if (name) {
        const key = name.trim().toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
      }

      const safe = fileName ? await resolveSafeBaselinePath(baselinesDir, fileName, fsApi) : { ok: false };
      if (!safe.ok) {
        results.push({
          id: id || null,
          name: name || null,
          fileName,
          createdAt: entry.createdAt || null,
          createdBy: entry.createdBy || null,
          note: entry.note || null,
          registered: true,
          recovered: false,
          invalid: true,
          missing: false,
          conflict: false,
          reason: "BASELINE_PATH_INVALID",
          size: 0,
        });
        continue;
      }

      const disk = byFile.get(fileName);
      if (!disk) {
        results.push({
          id: id || null,
          name: name || null,
          fileName,
          full: safe.full,
          createdAt: entry.createdAt || null,
          createdBy: entry.createdBy || null,
          note: entry.note || null,
          registered: true,
          recovered: false,
          invalid: false,
          missing: true,
          conflict: recovery.conflictOriginals.has(fileName),
          size: 0,
        });
        continue;
      }
      disk.claimed = true;
      results.push({
        id: id || null,
        name: name || null,
        fileName,
        full: disk.full,
        createdAt: entry.createdAt || disk.createdAt || null,
        createdBy: entry.createdBy || null,
        note: entry.note || null,
        registered: true,
        recovered: false,
        invalid: Boolean(disk.invalid),
        missing: false,
        conflict: recovery.conflictOriginals.has(fileName),
        size: disk.size || 0,
        mtimeMs: disk.mtimeMs || 0,
        reason: disk.reason || null,
      });
    }

    for (const disk of scanned) {
      if (disk.claimed) continue;
      results.push({
        id: disk.headerBaselineId || null,
        name: disk.headerBaselineName || null,
        fileName: disk.fileName,
        full: disk.full,
        createdAt: disk.createdAt || null,
        createdBy: null,
        note: null,
        registered: false,
        recovered: !disk.invalid,
        invalid: Boolean(disk.invalid),
        missing: false,
        conflict: recovery.conflictOriginals.has(disk.fileName),
        size: disk.size || 0,
        mtimeMs: disk.mtimeMs || 0,
        reason: disk.reason || null,
      });
    }

    // Mark duplicate ids/names as conflict across registered entries.
    for (const item of results) {
      if (item.id && (idCounts.get(item.id) || 0) > 1) item.conflict = true;
      if (item.name && (nameCounts.get(String(item.name).trim().toLowerCase()) || 0) > 1) {
        item.conflict = true;
      }
    }

    for (const artifact of recovery.recoveryArtifacts) {
      results.push({
        id: null,
        name: null,
        fileName: artifact.fileName,
        full: null,
        createdAt: null,
        createdBy: null,
        note: null,
        registered: false,
        recovered: false,
        invalid: true,
        missing: false,
        conflict: artifact.conflict === true,
        recoveryArtifact: true,
        cleanupPending: artifact.cleanupPending === true,
        operationId: artifact.operationId || null,
        size: 0,
        mtimeMs: 0,
        reason: artifact.reason,
      });
    }

    // Case-insensitive name uniqueness among recoverable/registered valid entries for matching.
    const recoverableNameCounts = new Map();
    for (const item of results) {
      if (item.invalid || item.missing || item.conflict) continue;
      if (!item.name) continue;
      const key = String(item.name).trim().toLowerCase();
      recoverableNameCounts.set(key, (recoverableNameCounts.get(key) || 0) + 1);
    }
    for (const item of results) {
      if (!item.name) continue;
      const key = String(item.name).trim().toLowerCase();
      if ((recoverableNameCounts.get(key) || 0) > 1) item.conflict = true;
    }

    return {
      ok: true,
      registryState,
      preservedAs,
      baselines: results.map((item) => ({
        id: item.id,
        name: item.name,
        fileName: item.fileName,
        full: item.full || null,
        createdAt: item.createdAt,
        createdBy: item.createdBy,
        note: item.note,
        registered: item.registered,
        recovered: item.recovered,
        invalid: item.invalid,
        missing: item.missing,
        conflict: item.conflict,
        recoveryArtifact: item.recoveryArtifact === true,
        cleanupPending: item.cleanupPending === true,
        operationId: item.operationId || null,
        size: item.size || 0,
        mtimeMs: item.mtimeMs || 0,
        reason: item.reason || null,
      })),
    };
  }

  function budgetStatus(baselines) {
    const valid = (baselines || []).filter(
      (item) => !item.invalid && !item.missing && (item.registered || item.recovered),
    );
    const count = valid.length;
    const bytes = valid.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    return { count, bytes };
  }

  async function createBaseline({ name, note, snapshotWriter }) {
    const list = await listBaselines();
    if (!list.ok) return list;
    const displayName = sanitizeBaselineName(name, sanitizeText);
    if (!displayName) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Baseline name is required." };
    }
    const conflict = list.baselines.some(
      (item) =>
        item.name &&
        String(item.name).trim().toLowerCase() === displayName.toLowerCase() &&
        !item.missing,
    );
    if (conflict) {
      return { ok: false, code: "BASELINE_NAME_EXISTS", message: "A baseline with that name already exists." };
    }

    const budget = budgetStatus(list.baselines);
    if (budget.count >= MAX_PROTECTED_BASELINES) {
      return {
        ok: false,
        code: "BASELINE_BUDGET_FULL",
        message: "Protected baseline count limit reached. Delete a baseline before creating another.",
      };
    }

    await ensureBaselinesDir();
    const id = createBaselineId(randomUUID);
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const reasonSlug = String(displayName)
      .replace(/[^a-z0-9_-]+/gi, "")
      .slice(0, 40) || "baseline";
    const fileName = `${stamp}-baseline-${reasonSlug}.json`;
    const safe = await resolveSafeBaselinePath(baselinesDir, fileName, fsApi);
    if (!safe.ok) return safe;

    const snapshot = await snapshotWriter({
      baselineId: id,
      baselineName: displayName,
      reason: `baseline-${reasonSlug}`,
    });
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_SINGLE_BACKUP_BYTES) {
      return {
        ok: false,
        code: "BASELINE_BUDGET_FULL",
        message: "Baseline snapshot exceeds the single-file size ceiling.",
      };
    }
    if (budget.bytes + byteLength > MAX_PROTECTED_BASELINE_BYTES) {
      return {
        ok: false,
        code: "BASELINE_BUDGET_FULL",
        message: "Protected baseline byte budget would be exceeded.",
      };
    }

    await atomicWriteJson(safe.full, snapshot);

    // Load or create registry (write empty if missing after successful create).
    const raw = await readRegistryRaw();
    let doc = emptyRegistry(now().toISOString());
    if (raw.exists && raw.text) {
      const parsed = parseRegistry(raw.text);
      if (parsed.ok) doc = parsed.doc;
      else {
        const preserved = await preserveCorruptRegistry();
        if (!preserved.ok) {
          try {
            await fsApi.unlink(safe.full);
          } catch {
            // ignore
          }
          return preserved;
        }
      }
    }
    const noteSanitized = note ? sanitizeBaselineName(note, sanitizeText) : null;
    doc.baselines = Array.isArray(doc.baselines) ? doc.baselines : [];
    doc.baselines.push({
      id,
      name: displayName,
      fileName,
      createdAt: snapshot.createdAt || now().toISOString(),
      createdBy: "user",
      note: noteSanitized,
    });
    await writeRegistry(doc);

    return {
      ok: true,
      baseline: {
        id,
        name: displayName,
        fileName,
        createdAt: snapshot.createdAt || null,
        size: byteLength,
      },
    };
  }

  async function reregisterBaseline({ fileName, name, note }) {
    const safe = await resolveSafeBaselinePath(baselinesDir, fileName, fsApi);
    if (!safe.ok) return safe;
    if (!safe.exists) {
      return { ok: false, code: "RESTORE_FAILED", message: "Baseline file was not found." };
    }
    const displayName = sanitizeBaselineName(name, sanitizeText);
    if (!displayName) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Baseline name is required." };
    }
    const list = await listBaselines();
    if (!list.ok) return list;
    const conflict = list.baselines.some(
      (item) =>
        item.name &&
        String(item.name).trim().toLowerCase() === displayName.toLowerCase() &&
        item.fileName !== fileName &&
        !item.missing,
    );
    if (conflict) {
      return { ok: false, code: "BASELINE_NAME_EXISTS", message: "A baseline with that name already exists." };
    }
    const disk = list.baselines.find((item) => item.fileName === fileName);
    if (!disk || disk.invalid) {
      return { ok: false, code: "RESTORE_FAILED", message: "Baseline file is not recoverable." };
    }
    if (disk.registered && !disk.missing) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Baseline is already registered." };
    }

    const budget = budgetStatus(list.baselines.filter((item) => item.fileName !== fileName));
    if (budget.count >= MAX_PROTECTED_BASELINES) {
      return {
        ok: false,
        code: "BASELINE_BUDGET_FULL",
        message: "Protected baseline count limit reached.",
      };
    }
    if (budget.bytes + (disk.size || 0) > MAX_PROTECTED_BASELINE_BYTES) {
      return {
        ok: false,
        code: "BASELINE_BUDGET_FULL",
        message: "Protected baseline byte budget would be exceeded.",
      };
    }

    const raw = await readRegistryRaw();
    let doc = emptyRegistry(now().toISOString());
    if (raw.exists && raw.text) {
      const parsed = parseRegistry(raw.text);
      if (parsed.ok) doc = parsed.doc;
      else {
        const preserved = await preserveCorruptRegistry();
        if (!preserved.ok) return preserved;
      }
    }
    const id = createBaselineId(randomUUID);
    doc.baselines = Array.isArray(doc.baselines) ? doc.baselines : [];
    doc.baselines.push({
      id,
      name: displayName,
      fileName,
      createdAt: disk.createdAt || now().toISOString(),
      createdBy: "user",
      note: note ? sanitizeBaselineName(note, sanitizeText) : null,
    });
    await writeRegistry(doc);
    return { ok: true, baseline: { id, name: displayName, fileName } };
  }

  async function deleteBaseline({ id, fileName }) {
    deletionInFlight += 1;
    await recoveryQueue;
    try {
      const list = await listBaselines();
      if (!list.ok) return list;
      const requestedId = id != null ? String(id) : "";
      const requestedFileName = fileName != null ? String(fileName) : "";
      let target = null;

      if (requestedId) {
        const matches = list.baselines.filter(
          (item) =>
            item.id === requestedId &&
            (!requestedFileName || item.fileName === requestedFileName),
        );
        if (matches.length > 1 || matches.some((item) => item.conflict)) {
          return {
            ok: false,
            code: "AMBIGUOUS_BACKUP_ID",
            message: "Baseline selection is ambiguous.",
          };
        }
        target = matches[0] || null;
      } else if (requestedFileName) {
        const matches = list.baselines.filter(
          (item) => item.fileName === requestedFileName && !item.recoveryArtifact,
        );
        if (matches.length > 1) {
          return {
            ok: false,
            code: "AMBIGUOUS_BACKUP_ID",
            message: "Baseline selection is ambiguous.",
          };
        }
        target = matches[0] || null;
      }

      if (!target || target.recoveryArtifact) {
        return { ok: false, code: "RESTORE_FAILED", message: "Baseline was not found." };
      }

      const safe = await resolveSafeBaselinePath(baselinesDir, target.fileName, fsApi);
      if (!safe.ok) return safe;

      const raw = await readRegistryRaw();
      if (!raw.ok) {
        return {
          ok: false,
          code: "BASELINE_REGISTRY_UPDATE_FAILED",
          message: "Baseline registry could not be read.",
        };
      }
      let doc = emptyRegistry(now().toISOString());
      if (raw.exists && raw.text) {
        const parsed = parseRegistry(raw.text);
        if (!parsed.ok) {
          return {
            ok: false,
            code: "BASELINE_REGISTRY_UPDATE_FAILED",
            message: "Baseline registry is invalid; deletion was not started.",
          };
        }
        doc = parsed.doc;
      }

      const registryMatches = (doc.baselines || []).filter(
        (entry) => String(entry?.fileName || "") === target.fileName,
      );
      if (target.registered) {
        const exactRegistryMatch = registryMatches.some(
          (entry) => !requestedId || String(entry?.id || "") === requestedId,
        );
        if (!exactRegistryMatch) {
          return {
            ok: false,
            code: "STALE_BASELINE_SELECTION",
            message: "Baseline registry changed; refresh the list and select it again.",
          };
        }
      }

      const operationId = createDeleteOperationId();
      const quarantineFileName = `${DELETION_PREFIX}${operationId}-${target.fileName}`;
      const quarantine = await resolveSafeBaselinePath(baselinesDir, quarantineFileName, fsApi);
      if (!quarantine.ok || quarantine.exists) {
        return {
          ok: false,
          code: "BASELINE_DELETE_FAILED",
          message: "A safe baseline deletion transaction could not be created.",
        };
      }

      let movedToQuarantine = false;
      if (safe.exists) {
        try {
          await fsApi.rename(safe.full, quarantine.full);
          movedToQuarantine = true;
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            return {
              ok: false,
              code: "BASELINE_DELETE_FAILED",
              message: "Baseline file could not be moved into the deletion transaction.",
              operationId,
              fileName: target.fileName,
            };
          }
        }
      }

      const nextDoc = {
        ...doc,
        baselines: (doc.baselines || []).filter(
          (entry) => String(entry?.fileName || "") !== target.fileName,
        ),
      };
      try {
        await writeRegistry(nextDoc);
      } catch {
        if (movedToQuarantine) {
          try {
            await fsApi.rename(quarantine.full, safe.full);
          } catch {
            return {
              ok: false,
              code: "BASELINE_DELETE_RECOVERY_REQUIRED",
              message: "Baseline deletion was rolled back incompletely; recovery is required.",
              operationId,
              fileName: target.fileName,
              quarantineFileName,
            };
          }
        }
        return {
          ok: false,
          code: "BASELINE_REGISTRY_UPDATE_FAILED",
          message: "Baseline registry update failed; deletion was rolled back.",
          operationId,
          fileName: target.fileName,
        };
      }

      if (movedToQuarantine) {
        try {
          await fsApi.unlink(quarantine.full);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            return {
              ok: true,
              code: "BASELINE_DELETE_CLEANUP_PENDING",
              message: "Baseline deleted; protected cleanup is pending.",
              cleanupPending: true,
              operationId,
              cleanupArtifact: quarantineFileName,
              deleted: { fileName: target.fileName, id: target.id || null },
            };
          }
        }
      }

      return {
        ok: true,
        cleanupPending: false,
        deleted: { fileName: target.fileName, id: target.id || null },
      };
    } finally {
      deletionInFlight = Math.max(0, deletionInFlight - 1);
    }
  }

  return {
    REGISTRY_FILENAME,
    BASELINES_DIRNAME,
    baselinesDir,
    registryPath,
    listBaselines,
    createBaseline,
    reregisterBaseline,
    deleteBaseline,
    recoverDeletionArtifacts: async () => {
      await ensureBaselinesDir();
      const raw = await readRegistryRaw();
      let doc = emptyRegistry(now().toISOString());
      let state = raw.exists ? "ok" : "missing";
      if (raw.exists && raw.text) {
        const parsed = parseRegistry(raw.text);
        if (parsed.ok) doc = parsed.doc;
        else state = "corrupt_preserved";
      }
      return recoverDeletionArtifacts(doc, state);
    },
    projectPublicBaselineMetadata,
    budgetStatus,
    resolveSafeBaselinePath: (fileName) => resolveSafeBaselinePath(baselinesDir, fileName, fsApi),
    extractSafeHeaderMetadata,
    emptyRegistry,
    MAX_PROTECTED_BASELINES,
    MAX_PROTECTED_BASELINE_BYTES,
  };
}

module.exports = {
  REGISTRY_FILENAME,
  BASELINES_DIRNAME,
  SCHEMA_VERSION,
  HEADER_READ_LIMIT,
  MAX_PROTECTED_BASELINES,
  MAX_PROTECTED_BASELINE_BYTES,
  MAX_SINGLE_BACKUP_BYTES,
  DELETION_PREFIX,
  projectPublicBaselineMetadata,
  parseDeletionArtifactName,
  emptyRegistry,
  sanitizeBaselineName,
  isSafeBasename,
  resolveSafeBaselinePath,
  extractSafeHeaderMetadata,
  createBaselineStore,
};
