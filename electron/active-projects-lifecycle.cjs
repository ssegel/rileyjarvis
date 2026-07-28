"use strict";

const { looksLikeUuid, createPreviewToken, hashPreviewPayload } = require("./priority-lifecycle.cjs");
const { assertUnrelatedUnchanged } = require("./working-context-lifecycle.cjs");

const DESTRUCTIVE_ACTIVE_PROJECT_OPERATIONS = new Set(["remove", "replace", "restore_backup"]);

const PROJECT_REFERENCE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "item",
  "items",
  "my",
  "of",
  "on",
  "or",
  "project",
  "projects",
  "the",
  "this",
  "that",
  "these",
  "those",
  "to",
  "with",
  "your",
]);

function cloneProjects(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({
    id: item.id,
    name: item.name,
    note: item.note != null ? String(item.note) : "",
    updatedAt: item.updatedAt,
  }));
}

function canonicalizeProjects(list) {
  return cloneProjects(list).map((item, index) => ({
    order: index + 1,
    id: item.id,
    name: item.name,
    note: item.note || "",
    updatedAt: item.updatedAt,
  }));
}

function formatActiveProjectsArtifact(projects) {
  const rows = canonicalizeProjects(projects);
  const body = rows.length
    ? rows
        .map((row) => {
          const note = String(row.note || "").trim();
          return note ? `${row.order}. ${row.name} — ${note}` : `${row.order}. ${row.name}`;
        })
        .join("\n")
    : "No active projects stored.";
  return {
    title: "Active Projects",
    kind: "markdown",
    content: `# Active Projects\n\n${body}`,
  };
}

function candidatePayload(item, fullIndex) {
  return {
    order: fullIndex + 1,
    id: item.id,
    name: item.name,
    note: item.note || "",
  };
}

function significantReferenceTokens(text) {
  const raw = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!raw || !raw.length) return [];
  return raw.filter((token) => token.length > 0 && !PROJECT_REFERENCE_STOPWORDS.has(token));
}

function matchBySignificantTokens(pool, needle) {
  const queryTokens = significantReferenceTokens(needle);
  if (!queryTokens.length) return [];
  return pool.filter(({ item }) => {
    const itemTokens = new Set(significantReferenceTokens(item.name));
    return queryTokens.every((token) => itemTokens.has(token));
  });
}

function normalizeActiveProjectReference(reference) {
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

  if (by === "phrase" || by === "name") by = "text";

  if (!by) {
    if (value == null || value === "") return { by: "text", value: "" };
    if (String(value) === "recent") by = "recent";
    else if (typeof value === "number" || /^\d+$/.test(String(value))) by = "ordinal";
    else if (looksLikeUuid(value)) by = "id";
    else by = "text";
  }

  if (by === "text" || by === "phrase" || by === "name") {
    return { by: "text", value: String(value != null ? value : "").trim() };
  }

  return { by, value };
}

function resolveActiveProjectReference(projects, reference, options = {}) {
  const recentId = options.recentId || null;
  const all = Array.isArray(projects) ? projects : [];
  const pool = all.map((item, fullIndex) => ({ item, fullIndex }));

  const ref = normalizeActiveProjectReference(reference);
  if (!ref) return { code: "NOT_FOUND", candidates: [] };

  if (ref.by === "recent") {
    if (!recentId) return { code: "NOT_FOUND", candidates: [] };
    const fullIndex = all.findIndex((item) => item.id === recentId);
    if (fullIndex < 0) return { code: "NOT_FOUND", candidates: [] };
    return { item: all[fullIndex], fullIndex };
  }

  if (ref.by === "id") {
    const id = String(ref.value || "").trim();
    const matches = pool.filter(({ item }) => item.id === id);
    if (matches.length === 0) return { code: "NOT_FOUND", candidates: [] };
    if (matches.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: matches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
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

  const query = String(ref.value || "").trim();
  if (!query) return { code: "NOT_FOUND", candidates: [] };
  const needle = query.toLowerCase();

  const exact = pool.filter(({ item }) => String(item.name || "").trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return {
      code: "AMBIGUOUS_MATCH",
      candidates: exact.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
    };
  }

  if (needle.length >= 3) {
    const partial = pool.filter(({ item }) => String(item.name || "").toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      return {
        code: "AMBIGUOUS_MATCH",
        candidates: partial.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
      };
    }
  }

  const tokenMatches = matchBySignificantTokens(pool, needle);
  if (tokenMatches.length === 1) return tokenMatches[0];
  if (tokenMatches.length > 1) {
    return {
      code: "AMBIGUOUS_MATCH",
      candidates: tokenMatches.map(({ item, fullIndex }) => candidatePayload(item, fullIndex)),
    };
  }

  return { code: "NOT_FOUND", candidates: [] };
}

function validateActiveProjectsArray(projects) {
  if (!Array.isArray(projects)) return "activeProjects must be an array";
  const seen = new Set();
  for (const item of projects) {
    if (!item || typeof item !== "object") return "active project items must be objects";
    if (!item.id || typeof item.id !== "string") return "each active project requires a string id";
    if (seen.has(item.id)) return "active project ids must be unique";
    seen.add(item.id);
    if (!String(item.name || "").trim()) return "each active project requires nonempty name";
    if (item.note != null && typeof item.note !== "string") return "active project note must be a string";
  }
  return null;
}

function incomingName(raw) {
  return String(raw?.name != null ? raw.name : raw?.text != null ? raw.text : "").trim();
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeWritableProject(raw, helpers, { existing } = {}) {
  const { randomUUID, nowIso } = helpers;
  const nameProvided = hasOwn(raw, "name") || hasOwn(raw, "text");
  const noteProvided = hasOwn(raw, "note");

  let name;
  if (existing) {
    name = nameProvided ? incomingName(raw) : String(existing.name || "").trim();
  } else {
    name = incomingName(raw);
  }

  let note;
  if (existing) {
    note = noteProvided ? String(raw.note != null ? raw.note : "") : String(existing.note || "");
  } else {
    note = noteProvided ? String(raw.note != null ? raw.note : "") : "";
  }

  return {
    id: existing?.id ? existing.id : randomUUID(),
    name,
    note,
    updatedAt: nowIso(),
  };
}

function resolveIncomingRefs(args) {
  if (Array.isArray(args.items) && args.items.length) return args.items;
  if (args.item) return [args.item];
  if (Array.isArray(args.items)) return args.items;
  return null;
}

function setProjectsOnDaily(daily, projects) {
  return {
    ...daily,
    activeProjects: cloneProjects(projects),
  };
}

function planActiveProjectsMutation(args, daily, helpers) {
  const operation = String(args.operation || "").trim().toLowerCase();
  const list = cloneProjects(daily.activeProjects || []);
  const recentId = helpers.recentId || null;
  const resolveOpts = { recentId };

  const failResolve = (resolved, message) => ({
    error: {
      code: resolved.code,
      message:
        resolved.code === "AMBIGUOUS_MATCH"
          ? message || "Multiple projects matched. Ask one concise clarification."
          : message || "No matching project was found.",
      candidates: resolved.candidates,
    },
  });

  if (operation === "list") {
    return { nextDaily: daily, listed: list, meta: { listOnly: true } };
  }

  if (operation === "add") {
    const incoming = resolveIncomingRefs(args);
    if (!incoming || !incoming.length) {
      return { error: { code: "VALIDATION_FAILED", message: "add requires items." } };
    }
    const next = cloneProjects(list);
    const touched = [];
    for (const raw of incoming) {
      const item = normalizeWritableProject(raw, helpers);
      if (!item.name) {
        return { error: { code: "VALIDATION_FAILED", message: "Project name is required." } };
      }
      next.push(item);
      touched.push(item);
    }
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        touchedIds: touched.map((i) => i.id),
        allowedKeys: ["activeProjects"],
        recentMode: "last_new",
      },
    };
  }

  if (operation === "insert") {
    const incoming = resolveIncomingRefs(args);
    const at = Number(args.atPosition);
    if (!incoming || !incoming.length) {
      return { error: { code: "VALIDATION_FAILED", message: "insert requires items." } };
    }
    if (!Number.isInteger(at) || at < 1 || at > list.length + 1) {
      return { error: { code: "VALIDATION_FAILED", message: "insert requires a valid 1-based atPosition." } };
    }
    const next = cloneProjects(list);
    const prepared = [];
    for (const raw of incoming) {
      const item = normalizeWritableProject(raw, helpers);
      if (!item.name) {
        return { error: { code: "VALIDATION_FAILED", message: "Project name is required." } };
      }
      prepared.push(item);
    }
    next.splice(at - 1, 0, ...prepared);
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        touchedIds: prepared.map((i) => i.id),
        atPosition: at,
        allowedKeys: ["activeProjects"],
        recentMode: "last_new",
      },
    };
  }

  if (operation === "edit") {
    const resolved = resolveActiveProjectReference(list, args.reference, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const raw = args.item && typeof args.item === "object" ? args.item : {};
    const nameProvided = hasOwn(raw, "name") || hasOwn(raw, "text");
    const noteProvided = hasOwn(raw, "note");
    if (!nameProvided && !noteProvided) {
      return { error: { code: "VALIDATION_FAILED", message: "edit requires name and/or note." } };
    }
    if (nameProvided && !incomingName(raw)) {
      return { error: { code: "VALIDATION_FAILED", message: "Project name is required." } };
    }
    const next = cloneProjects(list);
    const updated = normalizeWritableProject(raw, helpers, { existing: resolved.item });
    next[resolved.fullIndex] = updated;
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        touchedIds: [updated.id],
        allowedKeys: ["activeProjects"],
        recentMode: "touched",
      },
    };
  }

  if (operation === "remove") {
    const resolved = resolveActiveProjectReference(list, args.reference, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const next = list.filter((_, index) => index !== resolved.fullIndex);
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        touchedIds: [resolved.item.id],
        removedId: resolved.item.id,
        allowedKeys: ["activeProjects"],
        recentMode: "remove",
      },
    };
  }

  if (operation === "reorder") {
    if (Array.isArray(args.order) && args.order.length) {
      const next = [];
      const seen = new Set();
      for (const ref of args.order) {
        const resolved = resolveActiveProjectReference(list, ref, resolveOpts);
        if (resolved.code) return failResolve(resolved, "Could not resolve reorder reference.");
        if (seen.has(resolved.item.id)) {
          return { error: { code: "VALIDATION_FAILED", message: "reorder order contains duplicates." } };
        }
        seen.add(resolved.item.id);
        next.push({ ...resolved.item });
      }
      if (next.length !== list.length || seen.size !== list.length) {
        return { error: { code: "VALIDATION_FAILED", message: "full reorder must include every active project." } };
      }
      return {
        nextDaily: setProjectsOnDaily(daily, next),
        meta: { allowedKeys: ["activeProjects"], recentMode: "unchanged", fullReorder: true },
      };
    }

    const resolved = resolveActiveProjectReference(list, args.reference, resolveOpts);
    if (resolved.code) return failResolve(resolved);
    const at = Number(args.atPosition);
    if (!Number.isInteger(at) || at < 1 || at > list.length) {
      return { error: { code: "VALIDATION_FAILED", message: "reorder requires a valid 1-based atPosition." } };
    }
    const next = cloneProjects(list);
    const [moved] = next.splice(resolved.fullIndex, 1);
    next.splice(at - 1, 0, moved);
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        touchedIds: [moved.id],
        atPosition: at,
        allowedKeys: ["activeProjects"],
        recentMode: "touched",
      },
    };
  }

  if (operation === "replace") {
    if (!Array.isArray(args.items)) {
      return { error: { code: "VALIDATION_FAILED", message: "replace requires an items array." } };
    }
    const claimed = new Set();
    const next = [];
    for (const raw of args.items) {
      const requestedId = raw?.id != null ? String(raw.id).trim() : "";
      let existing = null;
      if (requestedId) {
        const byId = list.find((item) => item.id === requestedId && !claimed.has(item.id));
        if (byId) existing = byId;
      }
      if (!existing) {
        const name = incomingName(raw).toLowerCase();
        if (name) {
          const matches = list.filter(
            (item) => !claimed.has(item.id) && String(item.name || "").trim().toLowerCase() === name,
          );
          if (matches.length === 1) existing = matches[0];
        }
      }
      const item = normalizeWritableProject(raw, helpers, existing ? { existing } : {});
      if (!item.name) {
        return { error: { code: "VALIDATION_FAILED", message: "Project name is required." } };
      }
      if (existing) claimed.add(existing.id);
      next.push(item);
    }
    return {
      nextDaily: setProjectsOnDaily(daily, next),
      meta: {
        allowedKeys: ["activeProjects"],
        recentMode: "replace",
        touchedIds: next.map((item) => item.id),
      },
    };
  }

  if (operation === "restore_backup") {
    return {
      nextDaily: null,
      meta: { restore: true, backupId: args.backupId || null, allowedKeys: ["activeProjects"], recentMode: "replace" },
    };
  }

  return { error: { code: "UNSUPPORTED_OPERATION", message: `Unsupported operation: ${operation}` } };
}

function logActiveProjectsEvent(details) {
  console.info(
    "[jarvis-memory] active-projects",
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
  DESTRUCTIVE_ACTIVE_PROJECT_OPERATIONS,
  cloneProjects,
  canonicalizeProjects,
  formatActiveProjectsArtifact,
  normalizeActiveProjectReference,
  resolveActiveProjectReference,
  validateActiveProjectsArray,
  normalizeWritableProject,
  planActiveProjectsMutation,
  assertUnrelatedUnchanged,
  logActiveProjectsEvent,
  createPreviewToken,
  hashPreviewPayload,
  incomingName,
};
