"use strict";

/**
 * Limited restart continuity: recent reference UUIDs only.
 * Never persists preview tokens, pending confirmations, plans, or transcripts.
 */

const SCHEMA_VERSION = 1;
const CONTINUITY_FILENAME = "session-continuity.json";

function emptyRecent() {
  return {
    priorityId: null,
    activeProjectId: null,
    workingContext: {
      commitments: null,
      follow_ups: null,
      unresolved_items: null,
    },
  };
}

function emptyDocument(nowIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso || new Date().toISOString(),
    recent: emptyRecent(),
  };
}

function isValidId(value) {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // UUID-like or existing id strings used by memory (reject objects/arrays/secrets).
  if (trimmed.length > 128) return false;
  if (/[\s<>{}]/.test(trimmed)) return false;
  return true;
}

function coerceId(value) {
  if (value == null || value === "") return null;
  if (!isValidId(value)) return null;
  return String(value).trim();
}

/**
 * Validate and normalize a continuity document.
 * Returns { ok:true, doc } or { ok:false, reason }.
 */
function validateContinuityDocument(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not_object" };
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "schema_version" };
  }
  const recentRaw = raw.recent;
  if (recentRaw == null || typeof recentRaw !== "object" || Array.isArray(recentRaw)) {
    return { ok: false, reason: "recent_shape" };
  }
  if (!isValidId(recentRaw.priorityId) || !isValidId(recentRaw.activeProjectId)) {
    return { ok: false, reason: "invalid_id" };
  }
  const wcRaw =
    recentRaw.workingContext && typeof recentRaw.workingContext === "object" && !Array.isArray(recentRaw.workingContext)
      ? recentRaw.workingContext
      : {};
  if (
    !isValidId(wcRaw.commitments) ||
    !isValidId(wcRaw.follow_ups) ||
    !isValidId(wcRaw.unresolved_items)
  ) {
    return { ok: false, reason: "invalid_wc_id" };
  }

  const updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt.trim()
      ? raw.updatedAt.trim()
      : new Date().toISOString();

  return {
    ok: true,
    doc: {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      recent: {
        priorityId: coerceId(recentRaw.priorityId),
        activeProjectId: coerceId(recentRaw.activeProjectId),
        workingContext: {
          commitments: coerceId(wcRaw.commitments),
          follow_ups: coerceId(wcRaw.follow_ups),
          unresolved_items: coerceId(wcRaw.unresolved_items),
        },
      },
    },
  };
}

/**
 * Strip any attacker-crafted preview/pending keys from a document before write.
 */
function sanitizeForWrite(recent, nowIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso || new Date().toISOString(),
    recent: {
      priorityId: coerceId(recent?.priorityId),
      activeProjectId: coerceId(recent?.activeProjectId),
      workingContext: {
        commitments: coerceId(recent?.workingContext?.commitments),
        follow_ups: coerceId(recent?.workingContext?.follow_ups),
        unresolved_items: coerceId(recent?.workingContext?.unresolved_items),
      },
    },
  };
}

function continuityPath(memoryRootDir) {
  return require("node:path").join(memoryRootDir, CONTINUITY_FILENAME);
}

/**
 * Load continuity file. Missing/corrupt → empty recent (safe).
 */
async function loadSessionContinuity(options) {
  const { memoryRootDir, fsApi, pathExists, readText } = options;
  const filePath = continuityPath(memoryRootDir);
  try {
    if (typeof pathExists === "function") {
      if (!(await pathExists(filePath))) {
        return { ok: true, doc: emptyDocument(), created: false, missing: true };
      }
    }
    const text = await readText(filePath);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("[jarvis] session-continuity.load_failed reason=invalid_json");
      return { ok: true, doc: emptyDocument(), created: false, reset: true, reason: "invalid_json" };
    }
    const validated = validateContinuityDocument(parsed);
    if (!validated.ok) {
      console.warn(`[jarvis] session-continuity.load_failed reason=${validated.reason}`);
      return { ok: true, doc: emptyDocument(), created: false, reset: true, reason: validated.reason };
    }
    return { ok: true, doc: validated.doc, created: false };
  } catch (error) {
    const code = error && error.code;
    if (code === "ENOENT") {
      return { ok: true, doc: emptyDocument(), created: false, missing: true };
    }
    console.warn("[jarvis] session-continuity.load_failed reason=io");
    return { ok: true, doc: emptyDocument(), created: false, reset: true, reason: "io" };
  }
}

/**
 * Atomic write of recent IDs only.
 */
async function saveSessionContinuity(options) {
  const { memoryRootDir, recent, atomicWriteJson, nowIso } = options;
  const filePath = continuityPath(memoryRootDir);
  const doc = sanitizeForWrite(recent, nowIso);
  await atomicWriteJson(filePath, doc);
  return { ok: true, doc, path: filePath };
}

/**
 * Pure launch prerequisite checks (testable without spawning Electron).
 */
function checkLaunchPrerequisites(context) {
  const failures = [];
  if (!context.nodeAvailable) {
    failures.push({ code: "node_missing", message: "Node.js was not found. Install Node.js, then try again." });
  }
  if (!context.npmAvailable) {
    failures.push({ code: "npm_missing", message: "npm was not found." });
  }
  if (!context.packageJsonPresent) {
    failures.push({
      code: "project_root",
      message: "Launch script could not find the Jarvis project root.",
    });
  }
  if (!context.electronInstalled) {
    failures.push({
      code: "deps_missing",
      message: "Dependencies missing. Run npm install in the Jarvis folder.",
    });
  }
  if (!context.envLocalPresent) {
    failures.push({
      code: "env_missing",
      message: "Missing .env.local. Copy .env.example to .env.local and add OPENAI_API_KEY.",
    });
  } else if (!context.openAiKeyPresent) {
    failures.push({
      code: "api_key_missing",
      message: "OPENAI_API_KEY is missing in .env.local.",
    });
  }
  if (!context.distPresent && !context.willRebuild) {
    failures.push({
      code: "dist_missing",
      message: "Built UI is missing (dist/index.html). Run with -Rebuild or npm run build.",
    });
  }
  return { ok: failures.length === 0, failures };
}

function parseEnvLocalHasOpenAiKey(contents) {
  const text = String(contents || "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^OPENAI_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0;
  }
  return false;
}

module.exports = {
  SCHEMA_VERSION,
  CONTINUITY_FILENAME,
  emptyRecent,
  emptyDocument,
  isValidId,
  coerceId,
  validateContinuityDocument,
  sanitizeForWrite,
  continuityPath,
  loadSessionContinuity,
  saveSessionContinuity,
  checkLaunchPrerequisites,
  parseEnvLocalHasOpenAiKey,
};
