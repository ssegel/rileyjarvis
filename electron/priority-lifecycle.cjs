"use strict";

const crypto = require("node:crypto");

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PRIORITY_STATUSES = new Set(["open", "done", "blocked", "active", "corrected", "cleared"]);
const DESTRUCTIVE_OPERATIONS = new Set([
  "remove",
  "replace",
  "clear_completed",
  "carry",
  "restore_backup",
]);

function isOpenPriorityStatus(status) {
  return status === "open" || status === "blocked";
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function canonicalizePriorities(list) {
  return (Array.isArray(list) ? list : []).map((item, index) => ({
    order: index + 1,
    id: item.id,
    text: item.text,
    status: item.status,
    updatedAt: item.updatedAt,
  }));
}

function formatPrioritiesArtifact(priorities) {
  const rows = canonicalizePriorities(priorities);
  const body = rows.length
    ? rows.map((row) => `${row.order}. ${row.text} — ${row.status}`).join("\n")
    : "No priorities stored.";
  return {
    title: "Daily Priorities",
    kind: "markdown",
    content: `# Daily Priorities\n\n${body}`,
  };
}

function clonePriorities(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({ ...item }));
}

function scopedPool(priorities, listScope = "open") {
  const all = Array.isArray(priorities) ? priorities : [];
  if (listScope === "all") return all.map((item, index) => ({ item, fullIndex: index }));
  return all
    .map((item, index) => ({ item, fullIndex: index }))
    .filter(({ item }) => isOpenPriorityStatus(item.status));
}

function candidatePayload(item, fullIndex) {
  return {
    order: fullIndex + 1,
    id: item.id,
    text: item.text,
    status: item.status,
  };
}

/**
 * Normalize single-priority references to canonical { by, value }.
 * Accepts: { by, value }, { text }, { name }, { query }, bare string/number.
 * Does not treat destination atPosition on the same object as the source identity.
 */
function normalizePriorityReference(reference) {
  if (reference == null) return null;

  if (typeof reference === "number") {
    return { by: "ordinal", value: reference };
  }

  if (typeof reference === "string") {
    const trimmed = reference.trim();
    if (!trimmed) return { by: "text", value: "" };
    if (trimmed === "recent") return { by: "recent", value: "recent" };
    if (/^\d+$/.test(trimmed)) return { by: "ordinal", value: Number(trimmed) };
    if (looksLikeUuid(trimmed)) return { by: "id", value: trimmed };
    return { by: "text", value: trimmed };
  }

  if (typeof reference !== "object") return null;

  let by = reference.by != null ? String(reference.by) : "";
  let value =
    reference.value != null
      ? reference.value
      : reference.query != null
        ? reference.query
        : reference.text != null
          ? reference.text
          : reference.name != null
            ? reference.name
            : undefined;

  // Never use destination-like fields as the source reference identity.
  if ((value == null || value === "") && reference.atPosition != null && !by) {
    return { by: "text", value: "" };
  }

  if (by === "phrase") by = "text";

  if (!by) {
    if (value == null || value === "") return { by: "text", value: "" };
    if (String(value) === "recent") by = "recent";
    else if (typeof value === "number" || /^\d+$/.test(String(value))) by = "ordinal";
    else if (looksLikeUuid(value)) by = "id";
    else by = "text";
  }

  if (by === "text" || by === "phrase") {
    const text = String(value != null ? value : "").trim();
    return { by: "text", value: text };
  }

  return { by, value };
}

/**
 * Deterministic priority reference resolution.
 * reference: { by?: "id"|"ordinal"|"text"|"phrase"|"recent", value?: string|number, query?: string, text?: string }
 */
function resolvePriorityReference(priorities, reference, options = {}) {
  const listScope = options.listScope === "all" ? "all" : "open";
  const recentId = options.recentId || null;
  const pool = scopedPool(priorities, listScope);

  const ref = normalizePriorityReference(reference);
  if (!ref) return { code: "NOT_FOUND", candidates: [] };

  const by = ref.by;
  const value = ref.value;

  if (by === "recent") {
    if (!recentId) return { code: "NOT_FOUND", candidates: [] };
    const fullIndex = priorities.findIndex((item) => item.id === recentId);
    if (fullIndex < 0) return { code: "NOT_FOUND", candidates: [] };
    return { item: priorities[fullIndex], fullIndex };
  }

  if (by === "id") {
    const id = String(value || "").trim();
    const matches = priorities
      .map((item, fullIndex) => ({ item, fullIndex }))
      .filter(({ item }) => item.id === id);
    if (matches.length === 0) return { code: "NOT_FOUND", candidates: [] };
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
      };
    }
    return matches[0];
  }

  if (by === "ordinal") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > pool.length) {
      return { code: "NOT_FOUND", candidates: [] };
    }
    return pool[n - 1];
  }

  const query = String(value || "").trim();
  if (!query) return { code: "NOT_FOUND", candidates: [] };
  const needle = query.toLowerCase();

  const exact = pool.filter(({ item }) => String(item.text || "").trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return {
      code: "AMBIGUOUS_MATCH",
      candidates: exact.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
    };
  }

  if (needle.length >= 3) {
    const partial = pool.filter(({ item }) => String(item.text || "").toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: partial.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
      };
    }
  }

  return { code: "NOT_FOUND", candidates: [] };
}

function validatePrioritiesArray(priorities) {
  if (!Array.isArray(priorities)) return "priorities must be an array";
  const seen = new Set();
  for (const item of priorities) {
    if (!item || typeof item !== "object") return "priority items must be objects";
    if (!item.id || typeof item.id !== "string") return "each priority requires a string id";
    if (seen.has(item.id)) return "priority ids must be unique";
    seen.add(item.id);
    if (!String(item.text || "").trim()) return "each priority requires nonempty wording";
    if (!PRIORITY_STATUSES.has(item.status)) return `invalid priority status: ${item.status}`;
  }
  return null;
}

function validateDailyShape(daily) {
  if (!daily || typeof daily !== "object") return "daily object missing";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(daily.date || ""))) return "invalid daily date";
  if (typeof daily.summary !== "string") return "summary must be a string";
  if (!Array.isArray(daily.activeProjects)) return "activeProjects must be an array";
  if (!Array.isArray(daily.commitments)) return "commitments must be an array";
  if (!Array.isArray(daily.followUps)) return "followUps must be an array";
  if (!Array.isArray(daily.unresolved)) return "unresolved must be an array";
  return validatePrioritiesArray(daily.priorities);
}

function assertUnchangedFields(before, after) {
  const keys = ["summary", "activeProjects", "commitments", "followUps", "unresolved", "date", "schemaVersion"];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return `unintended change to ${key}`;
    }
  }
  return null;
}

function normalizeIncomingItem(raw, randomUUID, nowIso, { existing } = {}) {
  const text = String(raw?.text || raw?.name || "").trim();
  const statusRaw = String(raw?.status || existing?.status || "open").toLowerCase();
  const status = PRIORITY_STATUSES.has(statusRaw) ? statusRaw : "open";
  // Preserve IDs only for matched existing items. Never trust client-supplied IDs for new rows.
  const id = existing?.id ? existing.id : randomUUID();
  return {
    id,
    text,
    status,
    updatedAt: nowIso(),
    source: raw?.source || existing?.source || "user",
  };
}

function hashPreviewPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function createPreviewToken() {
  return crypto.randomUUID();
}

function addDaysToDate(dateStr, days) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function logPrioritiesEvent(details) {
  console.info(
    "[jarvis-memory] priorities",
    JSON.stringify({
      operation: details.operation,
      ok: details.ok === true,
      code: details.code || undefined,
      itemCount: details.itemCount != null ? details.itemCount : undefined,
      backupId: details.backupId || undefined,
      durationMs: details.durationMs != null ? details.durationMs : undefined,
    }),
  );
}

module.exports = {
  PREVIEW_TTL_MS,
  DESTRUCTIVE_OPERATIONS,
  canonicalizePriorities,
  formatPrioritiesArtifact,
  clonePriorities,
  normalizePriorityReference,
  resolvePriorityReference,
  validatePrioritiesArray,
  validateDailyShape,
  assertUnchangedFields,
  normalizeIncomingItem,
  hashPreviewPayload,
  createPreviewToken,
  addDaysToDate,
  isOpenPriorityStatus,
  logPrioritiesEvent,
  looksLikeUuid,
};
