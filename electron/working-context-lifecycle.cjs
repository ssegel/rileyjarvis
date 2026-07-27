"use strict";

const crypto = require("node:crypto");
const {
  looksLikeUuid,
  addDaysToDate,
  createPreviewToken,
  hashPreviewPayload,
} = require("./priority-lifecycle.cjs");

const WC_STATUSES = new Set(["open", "blocked", "done"]);
const OPEN_LIKE = new Set(["open", "blocked", "active"]);
const LEGACY_OPEN_LIKE = new Set(["open", "blocked", "active"]);

const SCOPE_TO_KEY = {
  commitments: "commitments",
  follow_ups: "followUps",
  unresolved_items: "unresolved",
};

const KEY_TO_SCOPE = {
  commitments: "commitments",
  followUps: "follow_ups",
  unresolved: "unresolved_items",
};

const SCOPE_TITLES = {
  commitments: "Commitments",
  follow_ups: "Follow-ups",
  unresolved_items: "Unresolved Items",
};

const SUPPORTED_CONVERSIONS = new Set([
  "unresolved_items->commitments",
  "follow_ups->commitments",
  "commitments->follow_ups",
]);

const PROMOTE_SCOPES = new Set(["commitments", "follow_ups"]);

const DESTRUCTIVE_WC_OPERATIONS = new Set([
  "remove",
  "replace",
  "clear_completed",
  "convert",
  "restore_backup",
]);

function normalizeScope(scope) {
  const raw = String(scope || "").trim().toLowerCase();
  if (SCOPE_TO_KEY[raw]) return raw;
  if (raw === "followups") return "follow_ups";
  if (raw === "unresolved" || raw === "unresolveditems") return "unresolved_items";
  return null;
}

function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return normalized ? SCOPE_TO_KEY[normalized] : null;
}

function scopeTitle(scope) {
  const normalized = normalizeScope(scope);
  return normalized ? SCOPE_TITLES[normalized] : "Working Context";
}

function isOpenWcStatus(status) {
  return status === "open" || status === "blocked";
}

function isDoneWcStatus(status) {
  return status === "done";
}

function normalizeWcStatus(raw, fallback = "open") {
  const status = String(raw || fallback).toLowerCase();
  if (WC_STATUSES.has(status)) return status;
  if (LEGACY_OPEN_LIKE.has(status)) return "open";
  if (status === "resolved" || status === "cleared" || status === "corrected") {
    return status === "resolved" || status === "cleared" ? "done" : "open";
  }
  return WC_STATUSES.has(fallback) ? fallback : "open";
}

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseDateArg(value, today) {
  if (value == null || value === "") return { value: null };
  const raw = String(value).trim().toLowerCase();
  if (raw === "today") return { value: today };
  if (raw === "tomorrow") return { value: addDaysToDate(today, 1) };
  if (isValidIsoDate(raw)) return { value: raw };
  return { error: "INVALID_DATE", message: `Invalid date: ${value}` };
}

function endOfLocalWeek(today) {
  // Local week ends on Sunday (inclusive), matching common US calendar week.
  const [y, m, d] = String(today).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0=Sun
  const daysUntilSunday = (7 - day) % 7;
  return addDaysToDate(today, daysUntilSunday);
}

function isFutureDeferred(item, today) {
  const until = String(item?.deferredUntil || "").trim();
  if (!until || !isValidIsoDate(until)) return false;
  return until > String(today || "");
}

function cloneItems(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({ ...item }));
}

function cloneDaily(daily) {
  return {
    ...daily,
    priorities: cloneItems(daily.priorities),
    commitments: cloneItems(daily.commitments),
    followUps: cloneItems(daily.followUps),
    unresolved: cloneItems(daily.unresolved),
    activeProjects: cloneItems(daily.activeProjects),
  };
}

/**
 * Soft-normalize a working-context item for storage.
 * Never fabricates createdAt on read-only paths (materialRewrite=false).
 */
function normalizeWorkingContextItem(item = {}, options = {}) {
  const materialRewrite = options.materialRewrite === true;
  const nowIso = options.nowIso || (() => new Date().toISOString());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const existing = options.existing || null;

  const text = String(item.text || item.name || item.note || existing?.text || "").trim();
  const status = normalizeWcStatus(item.status != null ? item.status : existing?.status, "open");
  const id = existing?.id
    ? existing.id
    : typeof item.id === "string" && item.id && options.trustId === true
      ? item.id
      : randomUUID();

  const next = {
    id,
    text,
    status,
    updatedAt: materialRewrite ? nowIso() : item.updatedAt || existing?.updatedAt || nowIso(),
  };

  const note = item.note != null ? item.note : existing?.note;
  if (note != null && String(note).trim()) next.note = String(note);

  const due =
    Object.prototype.hasOwnProperty.call(item, "due") || Object.prototype.hasOwnProperty.call(item, "dueDate")
      ? item.due != null
        ? item.due
        : item.dueDate != null
          ? item.dueDate
          : null
      : existing && Object.prototype.hasOwnProperty.call(existing, "due")
        ? existing.due
        : undefined;
  if (due != null && due !== "") next.due = String(due);
  else if (due === null) next.due = null;

  const deferredUntil = Object.prototype.hasOwnProperty.call(item, "deferredUntil")
    ? item.deferredUntil
    : existing && Object.prototype.hasOwnProperty.call(existing, "deferredUntil")
      ? existing.deferredUntil
      : undefined;
  if (deferredUntil != null && deferredUntil !== "") next.deferredUntil = String(deferredUntil);
  else if (deferredUntil === null) next.deferredUntil = null;

  if (existing?.createdAt) next.createdAt = existing.createdAt;
  else if (item.createdAt) next.createdAt = item.createdAt;
  else if (materialRewrite && !existing) next.createdAt = nowIso();
  else if (materialRewrite && existing && !existing.createdAt) next.createdAt = nowIso();

  if (status === "done") {
    next.completedAt =
      item.completedAt || existing?.completedAt || (materialRewrite ? nowIso() : undefined);
  } else if (Object.prototype.hasOwnProperty.call(item, "completedAt") && item.completedAt == null) {
    // cleared
  } else if (existing?.completedAt && status === "done") {
    next.completedAt = existing.completedAt;
  }

  const source = item.source || existing?.source;
  if (source) next.source = source;
  const sensitivity = item.sensitivity || existing?.sensitivity;
  if (sensitivity) next.sensitivity = sensitivity;

  const relatedPerson =
    item.relatedPerson != null ? item.relatedPerson : existing?.relatedPerson;
  if (relatedPerson) next.relatedPerson = String(relatedPerson);
  const relatedProject =
    item.relatedProject != null ? item.relatedProject : existing?.relatedProject;
  if (relatedProject) next.relatedProject = String(relatedProject);

  const linkedPriorityId =
    item.linkedPriorityId != null ? item.linkedPriorityId : existing?.linkedPriorityId;
  if (linkedPriorityId) next.linkedPriorityId = String(linkedPriorityId);

  const originScope = item.originScope != null ? item.originScope : existing?.originScope;
  if (originScope) next.originScope = String(originScope);
  const previousScope = item.previousScope != null ? item.previousScope : existing?.previousScope;
  if (previousScope) next.previousScope = String(previousScope);
  const convertedAt = item.convertedAt != null ? item.convertedAt : existing?.convertedAt;
  if (convertedAt) next.convertedAt = String(convertedAt);

  return next;
}

function canonicalizeItems(list, today) {
  return (Array.isArray(list) ? list : []).map((item, index) => {
    const due = item.due != null && item.due !== "" ? String(item.due) : null;
    const deferredUntil =
      item.deferredUntil != null && item.deferredUntil !== "" ? String(item.deferredUntil) : null;
    const overdue =
      Boolean(due) && item.status !== "done" && due < String(today || "");
    return {
      order: index + 1,
      id: item.id,
      text: item.text,
      note: item.note || null,
      status: item.status,
      due,
      deferredUntil,
      overdue,
      relatedPerson: item.relatedPerson || null,
      relatedProject: item.relatedProject || null,
      linkedPriorityId: item.linkedPriorityId || null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      completedAt: item.completedAt || null,
    };
  });
}

function formatListArtifact(scope, items, today) {
  const title = scopeTitle(scope);
  const rows = canonicalizeItems(items, today);
  const body = rows.length
    ? rows
        .map((row) => {
          const bits = [`${row.order}. ${row.text} — ${row.status}`];
          if (row.due) bits.push(`due ${row.due}${row.overdue ? " (overdue)" : ""}`);
          if (row.deferredUntil) bits.push(`deferred until ${row.deferredUntil}`);
          if (row.relatedPerson) bits.push(`person ${row.relatedPerson}`);
          if (row.relatedProject) bits.push(`project ${row.relatedProject}`);
          if (row.linkedPriorityId) bits.push(`linked priority ${row.linkedPriorityId}`);
          return bits.join(" · ");
        })
        .join("\n")
    : `No ${title.toLowerCase()} stored.`;
  return {
    title,
    kind: "markdown",
    content: `# ${title}\n\n${body}`,
  };
}

function formatPreviewArtifact({
  scope,
  operation,
  before,
  after,
  destinationScope,
  selected,
  today,
}) {
  const title = "Working Context Preview";
  const beforeLines = canonicalizeItems(before, today)
    .map((row) => `${row.order}. ${row.text} — ${row.status}`)
    .join("\n");
  const afterLines = canonicalizeItems(after, today)
    .map((row) => `${row.order}. ${row.text} — ${row.status}`)
    .join("\n");
  const selectedLines = (selected || [])
    .map((item) => `- ${item.text || item}`)
    .join("\n");
  return {
    title,
    kind: "markdown",
    content: [
      `# ${title}`,
      "",
      `Scope: ${scopeTitle(scope)}`,
      `Operation: ${operation}`,
      destinationScope ? `Destination: ${scopeTitle(destinationScope)}` : null,
      "",
      "## Selected",
      selectedLines || "- (none)",
      "",
      "## Before",
      beforeLines || "(empty)",
      "",
      "## After",
      afterLines || "(empty)",
    ]
      .filter((line) => line != null)
      .join("\n"),
  };
}

function getListForScope(daily, scope) {
  const key = scopeKey(scope);
  if (!key) return null;
  return Array.isArray(daily[key]) ? daily[key] : [];
}

function setListForScope(daily, scope, list) {
  const key = scopeKey(scope);
  if (!key) throw new Error("INVALID_SCOPE");
  return { ...daily, [key]: list };
}

function defaultListScopeForOperation(operation) {
  const op = String(operation || "").trim().toLowerCase();
  if (op === "reopen") return "done";
  if (op === "complete") return "open";
  return "open";
}

function resolveListScope(operation, args = {}) {
  const requested = args.listScope || args.filter;
  if (
    requested === "all" ||
    requested === "done" ||
    requested === "open" ||
    requested === "overdue" ||
    requested === "due_today" ||
    requested === "due_tomorrow" ||
    requested === "due_this_week" ||
    requested === "no_due_date" ||
    requested === "deferred"
  ) {
    return requested;
  }
  return defaultListScopeForOperation(operation);
}

function matchesFilter(item, filter, today) {
  const due = item.due != null && item.due !== "" ? String(item.due) : null;
  const deferred = isFutureDeferred(item, today);

  switch (filter) {
    case "all":
      return true;
    case "done":
      return isDoneWcStatus(item.status);
    case "open":
      return isOpenWcStatus(item.status) && !deferred;
    case "deferred":
      return deferred;
    case "overdue":
      return Boolean(due) && item.status !== "done" && due < today;
    case "due_today":
      return due === today;
    case "due_tomorrow":
      return due === addDaysToDate(today, 1);
    case "due_this_week": {
      if (!due || item.status === "done") return false;
      const end = endOfLocalWeek(today);
      return due >= today && due <= end;
    }
    case "no_due_date":
      return !due;
    default:
      return isOpenWcStatus(item.status) && !deferred;
  }
}

function scopedPool(items, filter, today) {
  const all = Array.isArray(items) ? items : [];
  return all
    .map((item, fullIndex) => ({ item, fullIndex }))
    .filter(({ item }) => matchesFilter(item, filter, today));
}

function candidatePayload(item, fullIndex, today) {
  return {
    order: fullIndex + 1,
    id: item.id,
    text: item.text,
    status: item.status,
    due: item.due || null,
    deferredUntil: item.deferredUntil || null,
    relatedPerson: item.relatedPerson || null,
    relatedProject: item.relatedProject || null,
  };
}

function normalizeWcReference(reference) {
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

  if (by === "phrase") by = "text";

  if (!by) {
    if (value == null || value === "") {
      if (reference.relatedPerson || reference.person) {
        return {
          by: "person",
          value: String(reference.relatedPerson || reference.person).trim(),
        };
      }
      if (reference.relatedProject || reference.project) {
        return {
          by: "project",
          value: String(reference.relatedProject || reference.project).trim(),
        };
      }
      if (reference.due || reference.dueDate) {
        return { by: "due", value: String(reference.due || reference.dueDate).trim() };
      }
      return { by: "text", value: "" };
    }
    if (String(value) === "recent") by = "recent";
    else if (typeof value === "number" || /^\d+$/.test(String(value))) by = "ordinal";
    else if (looksLikeUuid(value)) by = "id";
    else by = "text";
  }

  if (by === "person" || by === "relatedPerson") {
    return {
      by: "person",
      value: String(value != null ? value : reference.relatedPerson || reference.person || "").trim(),
    };
  }
  if (by === "project" || by === "relatedProject") {
    return {
      by: "project",
      value: String(
        value != null ? value : reference.relatedProject || reference.project || "",
      ).trim(),
    };
  }
  if (by === "due" || by === "dueDate") {
    return {
      by: "due",
      value: String(value != null ? value : reference.due || reference.dueDate || "").trim(),
    };
  }

  if (by === "text" || by === "phrase") {
    return { by: "text", value: String(value != null ? value : "").trim() };
  }

  return { by, value };
}

function resolveWorkingContextReference(items, reference, options = {}) {
  const today = options.today || "";
  const filter = options.listScope || "open";
  const recentId = options.recentId || null;
  const pool = scopedPool(items, filter, today);
  const all = Array.isArray(items) ? items : [];

  const ref = normalizeWcReference(reference);
  if (!ref) return { code: "NOT_FOUND", candidates: [] };

  if (ref.by === "recent") {
    if (!recentId) return { code: "NOT_FOUND", candidates: [] };
    const fullIndex = all.findIndex((item) => item.id === recentId);
    if (fullIndex < 0) return { code: "NOT_FOUND", candidates: [] };
    return { item: all[fullIndex], fullIndex };
  }

  if (ref.by === "id") {
    const id = String(ref.value || "").trim();
    const matches = all
      .map((item, fullIndex) => ({ item, fullIndex }))
      .filter(({ item }) => item.id === id);
    if (matches.length === 0) return { code: "NOT_FOUND", candidates: [] };
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
      };
    }
    return matches[0];
  }

  if (ref.by === "ordinal") {
    const n = Number(ref.value);
    if (!Number.isInteger(n) || n < 1 || n > pool.length) {
      return { code: "NOT_FOUND", candidates: [] };
    }
    return pool[n - 1];
  }

  if (ref.by === "person") {
    const needle = String(ref.value || "").trim().toLowerCase();
    if (!needle) return { code: "NOT_FOUND", candidates: [] };
    const matches = pool.filter(
      ({ item }) => String(item.relatedPerson || "").toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
      };
    }
    return { code: "NOT_FOUND", candidates: [] };
  }

  if (ref.by === "project") {
    const needle = String(ref.value || "").trim().toLowerCase();
    if (!needle) return { code: "NOT_FOUND", candidates: [] };
    const matches = pool.filter(
      ({ item }) => String(item.relatedProject || "").toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
      };
    }
    return { code: "NOT_FOUND", candidates: [] };
  }

  if (ref.by === "due") {
    const needle = String(ref.value || "").trim().toLowerCase();
    if (!needle) return { code: "NOT_FOUND", candidates: [] };
    const parsed = parseDateArg(needle, today);
    const dueNeedle = parsed.error ? needle : parsed.value;
    const matches = pool.filter(({ item }) => String(item.due || "").toLowerCase() === String(dueNeedle));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
      };
    }
    return { code: "NOT_FOUND", candidates: [] };
  }

  const query = String(ref.value || "").trim();
  if (!query) return { code: "NOT_FOUND", candidates: [] };
  const needle = query.toLowerCase();

  const exact = pool.filter(({ item }) => String(item.text || "").trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return {
      code: "AMBIGUOUS_MATCH",
      candidates: exact.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
    };
  }

  if (needle.length >= 3) {
    const partial = pool.filter(({ item }) => String(item.text || "").toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: partial.map(({ item, fullIndex }) => candidatePayload(item, fullIndex, today)),
      };
    }
  }

  return { code: "NOT_FOUND", candidates: [] };
}

function validateWorkingContextArray(items, label) {
  if (!Array.isArray(items)) return `${label} must be an array`;
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object") return `${label} items must be objects`;
    if (!item.id || typeof item.id !== "string") return `each ${label} item requires a string id`;
    if (seen.has(item.id)) return `${label} ids must be unique`;
    seen.add(item.id);
    if (!String(item.text || "").trim()) return `each ${label} item requires nonempty wording`;
    if (!WC_STATUSES.has(item.status)) return `invalid ${label} status: ${item.status}`;
    if (item.due != null && item.due !== "" && !isValidIsoDate(item.due)) {
      return `invalid ${label} due date: ${item.due}`;
    }
    if (item.deferredUntil != null && item.deferredUntil !== "" && !isValidIsoDate(item.deferredUntil)) {
      return `invalid ${label} deferredUntil: ${item.deferredUntil}`;
    }
  }
  return null;
}

function validateWorkingContextDaily(daily) {
  for (const [apiScope, key] of Object.entries(SCOPE_TO_KEY)) {
    const err = validateWorkingContextArray(daily[key], apiScope);
    if (err) return err;
  }
  return null;
}

function assertUnrelatedUnchanged(before, after, options = {}) {
  const allowedKeys = new Set(options.allowedKeys || []);
  const keys = [
    "summary",
    "activeProjects",
    "priorities",
    "commitments",
    "followUps",
    "unresolved",
    "date",
    "schemaVersion",
  ];
  for (const key of keys) {
    if (allowedKeys.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return `unintended change to ${key}`;
    }
  }
  return null;
}

function newIncomingItem(raw, helpers, extras = {}) {
  const { randomUUID, nowIso } = helpers;
  const item = normalizeWorkingContextItem(
    {
      ...raw,
      text: raw?.text || raw?.name,
      due: raw?.due != null ? raw.due : raw?.dueDate,
      deferredUntil: raw?.deferredUntil,
      relatedPerson: raw?.relatedPerson || extras.relatedPerson,
      relatedProject: raw?.relatedProject || extras.relatedProject,
      status: raw?.status || "open",
    },
    { materialRewrite: true, randomUUID, nowIso },
  );
  return item;
}

function resolveIncomingRefs(args) {
  if (Array.isArray(args.items) && args.items.length) return args.items;
  if (args.item) return [args.item];
  return [];
}

function planWorkingContextMutation(args, daily, helpers) {
  const operation = String(args.operation || "").trim().toLowerCase();
  const scope = normalizeScope(args.scope);
  if (!scope) {
    return { error: { code: "INVALID_SCOPE", message: "scope must be commitments, follow_ups, or unresolved_items." } };
  }

  const today = daily.date;
  const list = cloneItems(getListForScope(daily, scope));
  const listScope = resolveListScope(operation, args);
  const recentId = helpers.recentIds?.[scope] || null;
  const resolveOpts = { listScope, recentId, today };
  const { randomUUID, nowIso } = helpers;

  const failResolve = (resolved, message) => ({
    error: {
      code: resolved.code,
      message:
        resolved.code === "AMBIGUOUS_MATCH"
          ? message || "Multiple items matched. Ask one concise clarification."
          : message || "No matching item was found.",
      candidates: resolved.candidates,
    },
  });

  if (operation === "list") {
    const filtered = scopedPool(list, listScope, today).map(({ item }) => item);
    return { nextDaily: daily, listed: filtered, scope, meta: { listOnly: true } };
  }

  if (operation === "add") {
    const incoming = resolveIncomingRefs(args);
    if (!incoming.length) return { error: { code: "VALIDATION_FAILED", message: "add requires items." } };
    const next = cloneItems(list);
    const touched = [];
    for (const raw of incoming) {
      const item = newIncomingItem(raw, helpers, {
        relatedPerson: args.relatedPerson,
        relatedProject: args.relatedProject,
      });
      if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "Item wording is required." } };
      if (item.due != null && item.due !== "" && !isValidIsoDate(item.due)) {
        return { error: { code: "INVALID_DATE", message: `Invalid due date: ${item.due}` } };
      }
      const dup = next.some((p) => p.text.toLowerCase() === item.text.toLowerCase());
      if (dup && args.allowDuplicates !== true) {
        return { error: { code: "DUPLICATE_TEXT", message: "An item with that wording already exists." } };
      }
      next.push(item);
      touched.push(item);
    }
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: touched.map((i) => i.id), allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "insert") {
    const incoming = resolveIncomingRefs(args);
    const at = Number(args.atPosition);
    if (!incoming.length) return { error: { code: "VALIDATION_FAILED", message: "insert requires items." } };
    if (!Number.isInteger(at) || at < 1 || at > list.length + 1) {
      return { error: { code: "VALIDATION_FAILED", message: "insert requires a valid 1-based atPosition." } };
    }
    const next = cloneItems(list);
    const prepared = [];
    for (const raw of incoming) {
      const item = newIncomingItem(raw, helpers, {
        relatedPerson: args.relatedPerson,
        relatedProject: args.relatedProject,
      });
      if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "Item wording is required." } };
      if (item.due != null && item.due !== "" && !isValidIsoDate(item.due)) {
        return { error: { code: "INVALID_DATE", message: `Invalid due date: ${item.due}` } };
      }
      const dup = next.some((p) => p.text.toLowerCase() === item.text.toLowerCase());
      if (dup && args.allowDuplicates !== true) {
        return { error: { code: "DUPLICATE_TEXT", message: "An item with that wording already exists." } };
      }
      prepared.push(item);
    }
    next.splice(at - 1, 0, ...prepared);
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: {
        touchedIds: prepared.map((i) => i.id),
        atPosition: at,
        allowedKeys: [scopeKey(scope)],
      },
    };
  }

  if (operation === "edit") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    const patch = args.item && typeof args.item === "object" ? args.item : args;
    const text =
      patch.text != null
        ? String(patch.text).trim()
        : args.text != null
          ? String(args.text).trim()
          : current.text;
    if (!text) return { error: { code: "VALIDATION_FAILED", message: "edit requires wording." } };
    const dup = next.some(
      (p, idx) => idx !== resolved.fullIndex && p.text.toLowerCase() === text.toLowerCase(),
    );
    if (dup && args.allowDuplicates !== true) {
      return { error: { code: "DUPLICATE_TEXT", message: "An item with that wording already exists." } };
    }
    const updated = normalizeWorkingContextItem(
      {
        ...current,
        text,
        note: patch.note != null ? patch.note : current.note,
        relatedPerson:
          patch.relatedPerson != null
            ? patch.relatedPerson
            : args.relatedPerson != null
              ? args.relatedPerson
              : current.relatedPerson,
        relatedProject:
          patch.relatedProject != null
            ? patch.relatedProject
            : args.relatedProject != null
              ? args.relatedProject
              : current.relatedProject,
        due:
          patch.due != null || patch.dueDate != null
            ? patch.due != null
              ? patch.due
              : patch.dueDate
            : current.due,
      },
      { materialRewrite: true, existing: current, randomUUID, nowIso },
    );
    updated.status = current.status;
    if (current.completedAt) updated.completedAt = current.completedAt;
    else delete updated.completedAt;
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "complete" || operation === "reopen") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    if (operation === "complete" && current.status === "done") {
      return {
        nextDaily: daily,
        scope,
        meta: { noop: true, touchedIds: [current.id], allowedKeys: [] },
      };
    }
    const updated = { ...current, updatedAt: nowIso() };
    if (operation === "complete") {
      updated.status = "done";
      updated.completedAt = nowIso();
    } else {
      updated.status = "open";
      delete updated.completedAt;
    }
    if (!updated.createdAt) updated.createdAt = nowIso();
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "remove") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = cloneItems(list);
    const [removed] = next.splice(resolved.fullIndex, 1);
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: {
        removedId: removed.id,
        selected: [removed],
        allowedKeys: [scopeKey(scope)],
      },
      beforeList: list,
      afterList: next,
    };
  }

  if (operation === "reorder") {
    if (Array.isArray(args.order) && args.order.length) {
      const next = [];
      const used = new Set();
      for (const ref of args.order) {
        const resolved = resolveWorkingContextReference(list, ref, {
          ...resolveOpts,
          listScope: "all",
        });
        if (resolved.code) return failResolve(resolved, "Could not resolve reorder reference.");
        if (used.has(resolved.item.id)) {
          return { error: { code: "VALIDATION_FAILED", message: "reorder order contains duplicates." } };
        }
        used.add(resolved.item.id);
        next.push({ ...resolved.item });
      }
      if (next.length !== list.length) {
        return { error: { code: "VALIDATION_FAILED", message: "full reorder must include every item." } };
      }
      return {
        nextDaily: setListForScope(daily, scope, next),
        scope,
        meta: { allowedKeys: [scopeKey(scope)] },
      };
    }
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved, "Could not resolve reorder target.");
    const at = Number(args.atPosition);
    if (!Number.isInteger(at) || at < 1 || at > list.length) {
      return { error: { code: "VALIDATION_FAILED", message: "reorder requires a valid 1-based atPosition." } };
    }
    const next = cloneItems(list);
    const [moved] = next.splice(resolved.fullIndex, 1);
    next.splice(at - 1, 0, moved);
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [moved.id], allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "replace") {
    const incoming = Array.isArray(args.items) ? args.items : [];
    const next = [];
    const seenText = new Set();
    for (const raw of incoming) {
      const byId =
        typeof raw?.id === "string" && raw.id ? list.find((item) => item.id === raw.id) : null;
      const byText = list.find(
        (item) =>
          String(item.text || "").toLowerCase() === String(raw?.text || raw?.name || "").trim().toLowerCase(),
      );
      const existing = byId || byText || null;
      const item = normalizeWorkingContextItem(raw, {
        materialRewrite: true,
        existing,
        randomUUID,
        nowIso,
      });
      if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "replace items require wording." } };
      if (seenText.has(item.text.toLowerCase()) && args.allowDuplicates !== true) {
        return { error: { code: "DUPLICATE_TEXT", message: "Replace list contains duplicate wording." } };
      }
      seenText.add(item.text.toLowerCase());
      next.push(item);
    }
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { allowedKeys: [scopeKey(scope)] },
      beforeList: list,
      afterList: next,
    };
  }

  if (operation === "clear_completed") {
    const next = list.filter((item) => item.status !== "done");
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { allowedKeys: [scopeKey(scope)] },
      beforeList: list,
      afterList: next,
    };
  }

  if (operation === "defer") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const parsed = parseDateArg(args.deferredUntil || args.item?.deferredUntil, today);
    if (parsed.error) return { error: { code: "INVALID_DATE", message: parsed.message } };
    if (!parsed.value) {
      return { error: { code: "INVALID_DATE", message: "defer requires deferredUntil." } };
    }
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    if (!isOpenWcStatus(current.status)) {
      return { error: { code: "INVALID_STATUS", message: "Only open or blocked items can be deferred." } };
    }
    const updated = { ...current, deferredUntil: parsed.value, updatedAt: nowIso() };
    if (!updated.createdAt) updated.createdAt = nowIso();
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)], deferredUntil: parsed.value },
    };
  }

  if (operation === "clear_defer") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    const updated = { ...current, deferredUntil: null, updatedAt: nowIso() };
    if (!updated.createdAt) updated.createdAt = nowIso();
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "set_due_date") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const parsed = parseDateArg(args.dueDate || args.due || args.item?.due || args.item?.dueDate, today);
    if (parsed.error) return { error: { code: "INVALID_DATE", message: parsed.message } };
    if (!parsed.value) return { error: { code: "INVALID_DATE", message: "set_due_date requires dueDate." } };
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    const updated = { ...current, due: parsed.value, updatedAt: nowIso() };
    if (!updated.createdAt) updated.createdAt = nowIso();
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)], due: parsed.value },
    };
  }

  if (operation === "clear_due_date") {
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = cloneItems(list);
    const current = next[resolved.fullIndex];
    const updated = { ...current, due: null, updatedAt: nowIso() };
    if (!updated.createdAt) updated.createdAt = nowIso();
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setListForScope(daily, scope, next),
      scope,
      meta: { touchedIds: [current.id], allowedKeys: [scopeKey(scope)] },
    };
  }

  if (operation === "convert") {
    const destinationScope = normalizeScope(args.destinationScope);
    if (!destinationScope) {
      return { error: { code: "INVALID_CONVERSION", message: "convert requires destinationScope." } };
    }
    if (destinationScope === scope) {
      return { error: { code: "INVALID_CONVERSION", message: "Cannot convert within the same scope." } };
    }
    const key = `${scope}->${destinationScope}`;
    if (!SUPPORTED_CONVERSIONS.has(key)) {
      return {
        error: {
          code: "INVALID_CONVERSION",
          message: `Unsupported conversion: ${scope} → ${destinationScope}.`,
        },
      };
    }
    const resolved = resolveWorkingContextReference(list, args.reference || args.item, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const sourceNext = cloneItems(list);
    const [moved] = sourceNext.splice(resolved.fullIndex, 1);
    const destList = cloneItems(getListForScope(daily, destinationScope));
    const converted = {
      ...moved,
      previousScope: scope,
      originScope: moved.originScope || scope,
      convertedAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (!converted.createdAt) converted.createdAt = nowIso();
    // Commitment destination may keep note; follow-up destination keeps note.
    destList.push(converted);
    let nextDaily = setListForScope(daily, scope, sourceNext);
    nextDaily = setListForScope(nextDaily, destinationScope, destList);
    return {
      nextDaily,
      scope,
      destinationScope,
      meta: {
        selected: [moved],
        allowedKeys: [scopeKey(scope), scopeKey(destinationScope)],
        conversion: key,
      },
      beforeList: list,
      afterList: sourceNext,
      destBefore: getListForScope(daily, destinationScope),
      destAfter: destList,
    };
  }

  if (operation === "promote_to_priority") {
    if (!PROMOTE_SCOPES.has(scope)) {
      return {
        error: {
          code: "INVALID_CONVERSION",
          message: "promote_to_priority only supports commitments and follow_ups.",
        },
      };
    }
    const refs = Array.isArray(args.order) && args.order.length
      ? args.order
      : args.reference || args.item
        ? [args.reference || args.item]
        : null;
    if (!refs) {
      return { error: { code: "VALIDATION_FAILED", message: "promote_to_priority requires a reference." } };
    }
    const bulk = refs.length > 1;
    const selected = [];
    for (const ref of refs) {
      const resolved = resolveWorkingContextReference(list, ref, resolveOpts);
      if (resolved.code) return failResolve(resolved);
      selected.push(resolved);
    }

    const nextList = cloneItems(list);
    const nextPriorities = cloneItems(daily.priorities || []);
    const promoted = [];

    for (const resolved of selected) {
      const current = nextList[resolved.fullIndex];
      if (current.linkedPriorityId) {
        const existing = nextPriorities.find((p) => p.id === current.linkedPriorityId);
        if (existing) {
          return {
            error: {
              code: "ALREADY_PROMOTED",
              message: "That item is already linked to a daily priority.",
            },
          };
        }
      }
      const priorityId = randomUUID();
      const priority = {
        id: priorityId,
        text: current.text,
        status: "open",
        updatedAt: nowIso(),
        source: current.source || "user",
        sourceScope: scope,
        sourceId: current.id,
      };
      const at =
        args.priorityPosition != null ? Number(args.priorityPosition) : nextPriorities.length + 1;
      if (!Number.isInteger(at) || at < 1 || at > nextPriorities.length + 1) {
        return {
          error: { code: "VALIDATION_FAILED", message: "priorityPosition must be a valid 1-based index." },
        };
      }
      nextPriorities.splice(at - 1, 0, priority);
      const updated = {
        ...current,
        linkedPriorityId: priorityId,
        updatedAt: nowIso(),
      };
      if (!updated.createdAt) updated.createdAt = nowIso();
      nextList[resolved.fullIndex] = updated;
      promoted.push({ source: updated, priority });
    }

    let nextDaily = setListForScope(daily, scope, nextList);
    nextDaily = { ...nextDaily, priorities: nextPriorities };
    return {
      nextDaily,
      scope,
      meta: {
        bulk,
        selected: selected.map((s) => s.item),
        promoted,
        touchedIds: selected.map((s) => s.item.id),
        allowedKeys: [scopeKey(scope), "priorities"],
      },
    };
  }

  if (operation === "restore_backup") {
    return {
      nextDaily: null,
      scope,
      meta: { restore: true, backupId: args.backupId || null, allowedKeys: [scopeKey(scope)] },
    };
  }

  return { error: { code: "UNSUPPORTED_OPERATION", message: `Unsupported operation: ${operation}` } };
}

function requiresConfirmation(operation, planned) {
  if (DESTRUCTIVE_WC_OPERATIONS.has(operation)) return true;
  if (operation === "promote_to_priority" && planned?.meta?.bulk) return true;
  return false;
}

function logWorkingContextEvent(details) {
  console.info(
    "[jarvis-memory] working_context",
    JSON.stringify({
      scope: details.scope || undefined,
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
  SCOPE_TO_KEY,
  KEY_TO_SCOPE,
  SCOPE_TITLES,
  SUPPORTED_CONVERSIONS,
  PROMOTE_SCOPES,
  DESTRUCTIVE_WC_OPERATIONS,
  WC_STATUSES,
  normalizeScope,
  scopeKey,
  scopeTitle,
  isOpenWcStatus,
  isDoneWcStatus,
  normalizeWcStatus,
  isValidIsoDate,
  parseDateArg,
  endOfLocalWeek,
  isFutureDeferred,
  cloneItems,
  cloneDaily,
  normalizeWorkingContextItem,
  canonicalizeItems,
  formatListArtifact,
  formatPreviewArtifact,
  getListForScope,
  setListForScope,
  defaultListScopeForOperation,
  resolveListScope,
  matchesFilter,
  scopedPool,
  normalizeWcReference,
  resolveWorkingContextReference,
  validateWorkingContextArray,
  validateWorkingContextDaily,
  assertUnrelatedUnchanged,
  planWorkingContextMutation,
  requiresConfirmation,
  logWorkingContextEvent,
  createPreviewToken,
  hashPreviewPayload,
  OPEN_LIKE,
};
