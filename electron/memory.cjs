const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  PREVIEW_TTL_MS,
  DESTRUCTIVE_OPERATIONS,
  canonicalizePriorities,
  formatPrioritiesArtifact,
  clonePriorities,
  resolvePriorityReference,
  normalizePriorityReference,
  resolveListScope,
  validatePrioritiesArray,
  validateDailyShape,
  assertUnchangedFields,
  normalizeIncomingItem,
  hashPreviewPayload,
  createPreviewToken,
  addDaysToDate,
  logPrioritiesEvent,
} = require("./priority-lifecycle.cjs");
const {
  normalizeScope,
  scopeKey,
  scopeTitle,
  isFutureDeferred,
  cloneItems,
  canonicalizeItems,
  formatListArtifact,
  formatPreviewArtifact,
  getListForScope,
  setListForScope,
  resolveListScope: resolveWcListScope,
  normalizeWcReference,
  planWorkingContextMutation,
  requiresConfirmation,
  validateWorkingContextDaily,
  assertUnrelatedUnchanged,
  logWorkingContextEvent,
  DESTRUCTIVE_WC_OPERATIONS,
  normalizeWorkingContextItem,
  normalizeWcStatus,
} = require("./working-context-lifecycle.cjs");
const {
  DESTRUCTIVE_ACTIVE_PROJECT_OPERATIONS,
  cloneProjects,
  canonicalizeProjects,
  formatActiveProjectsArtifact,
  resolveActiveProjectReference,
  normalizeActiveProjectReference,
  validateActiveProjectsArray,
  planActiveProjectsMutation,
  logActiveProjectsEvent,
} = require("./active-projects-lifecycle.cjs");

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;
const PERSONAL_CONTEXT_SOFT_CAP = 9_500;
const INSTRUCTIONS_EXCERPT_CAP = 3_000;
const DAILY_SECTION_CAP = 2_000;
const PREFS_SECTION_CAP = 1_500;
const ENTRIES_SECTION_CAP = 3_000;

const PRIORITY_SELECTION_PRECEDENCE = [
  "open daily priorities",
  "open commitments explicitly due now",
  "open follow-ups",
  "open unresolved items",
  "active projects",
];

const NO_OPEN_DAILY_PRIORITIES_LINE = "Open daily priorities: none.";
const NO_OPEN_DAILY_PRIORITIES_REPLY = "You currently have no open daily priorities.";

function isOpenWorkStatus(status) {
  return status === "open" || status === "blocked";
}

/** Phase 13 open priorities also treat legacy `active` as open for injection/selection. */
function isOpenPriorityStatus(status) {
  return status === "open" || status === "blocked" || status === "active";
}

function isCommitmentDueNow(item, today) {
  const due = String(item?.due || "").trim();
  if (!due) return false;
  return due <= String(today || "");
}

function formatCommitmentLine(item) {
  if (item.sensitivity === "secret") return `- [secret commitment stored] (${item.id})`;
  if (item.sensitivity === "sensitive") return `- [sensitive commitment stored] (${item.id})`;
  return `- ${item.text}${item.due ? ` (due ${item.due})` : ""}`;
}

/**
 * Build the labeled daily working-context sections used by personal-context injection.
 * Preserves stored list order within each category.
 */
function formatDailyWorkingContext(daily, today) {
  const openPriorities = (daily.priorities || []).filter((item) => isOpenPriorityStatus(item.status));
  const openCommitments = (daily.commitments || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, today),
  );
  const dueNowCommitments = openCommitments.filter((item) => isCommitmentDueNow(item, today));
  const otherCommitments = openCommitments.filter((item) => !isCommitmentDueNow(item, today));
  const openFollowUps = (daily.followUps || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, today),
  );
  const openUnresolved = (daily.unresolved || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, today),
  );
  const activeProjects = daily.activeProjects || [];

  const lines = [
    `Date: ${daily.date}`,
    daily.summary ? `Summary: ${daily.summary}` : null,
    "Priority selection order: open daily priorities, then commitments due now, then follow-ups, then unresolved items, then active projects.",
    openPriorities.length
      ? `Daily priorities:\n${openPriorities.map((item) => `- ${item.text}`).join("\n")}`
      : NO_OPEN_DAILY_PRIORITIES_LINE,
    dueNowCommitments.length
      ? `Commitments due now:\n${dueNowCommitments.map((item) => formatCommitmentLine(item)).join("\n")}`
      : null,
    otherCommitments.length
      ? `Commitments:\n${otherCommitments.map((item) => formatCommitmentLine(item)).join("\n")}`
      : null,
    openFollowUps.length ? `Follow-ups:\n${openFollowUps.map((item) => `- ${item.text}`).join("\n")}` : null,
    openUnresolved.length
      ? `Unresolved items:\n${openUnresolved.map((item) => `- ${item.text}`).join("\n")}`
      : null,
    activeProjects.length
      ? `Active projects:\n${activeProjects.map((item) => `- ${item.name}${item.note ? `: ${item.note}` : ""}`).join("\n")}`
      : null,
  ];

  return {
    text: lines.filter(Boolean).join("\n"),
    openPriorities,
    dueNowCommitments,
    openFollowUps,
    openUnresolved,
    activeProjects,
  };
}

/**
 * Deterministic precedence planner for broad priority questions (tests + docs alignment).
 * Does not invent memory values; only selects among open categories.
 */
function planBroadPriorityAnswer(daily, today) {
  const formatted = formatDailyWorkingContext(daily, today);
  if (formatted.openPriorities.length > 0) {
    return {
      category: "daily_priorities",
      items: formatted.openPriorities.map((item) => item.text),
      leadText: formatted.openPriorities[0].text,
      mustSayNoOpenDailyPriorities: false,
      categoryLabel: null,
    };
  }
  if (formatted.dueNowCommitments.length > 0) {
    return {
      category: "commitments_due_now",
      items: formatted.dueNowCommitments.map((item) => item.text),
      leadText: formatted.dueNowCommitments[0].text,
      mustSayNoOpenDailyPriorities: true,
      categoryLabel: "commitment due now",
      optionalLead: `Your next open commitment due now is ${formatted.dueNowCommitments[0].text}`,
    };
  }
  if (formatted.openFollowUps.length > 0) {
    return {
      category: "follow_ups",
      items: formatted.openFollowUps.map((item) => item.text),
      leadText: formatted.openFollowUps[0].text,
      mustSayNoOpenDailyPriorities: true,
      categoryLabel: "follow-up",
      optionalLead: `Your next open follow-up is ${formatted.openFollowUps[0].text}`,
    };
  }
  if (formatted.openUnresolved.length > 0) {
    return {
      category: "unresolved",
      items: formatted.openUnresolved.map((item) => item.text),
      leadText: formatted.openUnresolved[0].text,
      mustSayNoOpenDailyPriorities: true,
      categoryLabel: "unresolved item",
      optionalLead: `Your next open unresolved item is ${formatted.openUnresolved[0].text}`,
    };
  }
  if (formatted.activeProjects.length > 0) {
    return {
      category: "active_projects",
      items: formatted.activeProjects.map((item) => item.name),
      leadText: formatted.activeProjects[0].name,
      mustSayNoOpenDailyPriorities: true,
      categoryLabel: "active project",
      optionalLead: `Your next active project is ${formatted.activeProjects[0].name}`,
    };
  }
  return {
    category: "none",
    items: [],
    leadText: null,
    mustSayNoOpenDailyPriorities: true,
    categoryLabel: null,
  };
}

function createMemoryStore(options = {}) {
  const rootDir = options.rootDir || path.join(process.cwd(), "data", "memory");
  const fsApi = options.fs || fs;
  const now = options.now || (() => new Date());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  let writeQueue = Promise.resolve();

  const paths = {
    root: rootDir,
    instructions: path.join(rootDir, "instructions.md"),
    preferences: path.join(rootDir, "preferences.json"),
    profile: path.join(rootDir, "profile.json"),
    daily: path.join(rootDir, "daily.json"),
    entries: path.join(rootDir, "entries.json"),
    archive: path.join(rootDir, "archive"),
    backups: path.join(rootDir, "backups"),
    future: path.join(rootDir, "future"),
  };

  /** @type {Map<string, { expiresAt: number, operation: string, hash: string, afterPriorities: any[], beforePriorities: any[], dailyUpdatedAt: string, meta?: any }>} */
  const previewStore = new Map();
  let recentPriorityId = null;
  let recentActiveProjectId = null;
  /** @type {{ commitments: string|null, follow_ups: string|null, unresolved_items: string|null }} */
  const recentWcIds = { commitments: null, follow_ups: null, unresolved_items: null };
  /** @type {Set<string>} */
  const notFoundFingerprints = new Set();
  /** @type {Set<string>} */
  const wcNotFoundFingerprints = new Set();

  function isoNow() {
    return now().toISOString();
  }

  function fingerprintFailedArgs(args = {}, code = "NOT_FOUND") {
    const operation = String(args.operation || "").trim().toLowerCase();
    const rawRef = args.reference != null ? args.reference : args.item;
    const normalizedRef = normalizePriorityReference(rawRef);
    return JSON.stringify({
      operation,
      reference: normalizedRef,
      atPosition: args.atPosition ?? null,
      order: args.order ?? null,
      listScope: resolveListScope(operation, args),
      code: String(code || "NOT_FOUND"),
    });
  }

  function applyFailedRetryPolicy(args, result) {
    if (!result || (result.code !== "NOT_FOUND" && result.code !== "AMBIGUOUS_MATCH")) return result;
    const fp = fingerprintFailedArgs(args, result.code);
    if (notFoundFingerprints.has(fp)) {
      const message =
        result.code === "AMBIGUOUS_MATCH"
          ? "Multiple priorities matched. This identical request already failed; do not retry it with the same arguments. Ask one concise clarification."
          : "No matching priority was found. This identical request already failed; do not retry it with the same arguments. Report once or ask one concise clarification.";
      return {
        ...result,
        suppressedRetry: true,
        message,
        error: message,
      };
    }
    notFoundFingerprints.add(fp);
    return result;
  }

  function todayDate() {
    const d = now();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function defaultInstructions() {
    return `# Personal Operating Instructions

Edit this file or ask Jarvis to update it with memory_set_instructions.

## Workflows
- Keep priorities and follow-ups current in daily context.
- Prefer explicit confirmation before irreversible actions.

## Hard Expectations
- Do not invent commitments.
- Ask before sharing private information.
`;
  }

  function defaultPreferences() {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: isoNow(),
      prefs: {
        addressAs: "Sarah",
        defaultMode: "display",
        confirmBefore: ["delete", "send", "purchase", "share"],
        hardRules: [
          "Never invent commitments",
          "Ask before sharing private information",
          "User-stated corrections override stored or inferred facts",
        ],
      },
    };
  }

  function defaultProfile() {
    return { schemaVersion: SCHEMA_VERSION, facts: [] };
  }

  function defaultDaily(date = todayDate()) {
    return {
      schemaVersion: SCHEMA_VERSION,
      date,
      summary: "",
      priorities: [],
      activeProjects: [],
      commitments: [],
      followUps: [],
      unresolved: [],
      updatedAt: isoNow(),
    };
  }

  function defaultEntries() {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }

  async function pathExists(filePath) {
    try {
      await fsApi.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function readText(filePath) {
    return await fsApi.readFile(filePath, "utf8");
  }

  async function atomicWriteText(filePath, contents) {
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsApi.writeFile(tempPath, contents, "utf8");
    await fsApi.rename(tempPath, filePath);
  }

  async function atomicWriteJson(filePath, value) {
    await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function enqueue(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function normalizeSensitivity(value) {
    const sensitivity = String(value || "normal").toLowerCase();
    if (sensitivity === "sensitive" || sensitivity === "secret") return sensitivity;
    return "normal";
  }

  function normalizeStatus(value, fallback = "active") {
    const status = String(value || fallback).toLowerCase();
    if (["active", "corrected", "cleared", "open", "done", "blocked"].includes(status)) return status;
    return fallback;
  }

  function normalizeConfidence(value) {
    const confidence = String(value || "stated").toLowerCase();
    return confidence === "inferred" ? "inferred" : "stated";
  }

  function normalizeKind(value) {
    const kind = String(value || "fact").toLowerCase();
    if (["fact", "preference", "project", "person", "rule", "other"].includes(kind)) return kind;
    return "other";
  }

  function normalizeSource(value) {
    const source = String(value || "user").toLowerCase();
    if (source === "assistant" || source === "import") return source;
    return "user";
  }

  function asStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item)).filter(Boolean);
  }

  function normalizeWorkItem(item = {}, fallbackStatus = "open") {
    const normalized = {
      id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
      text: String(item.text || item.name || item.note || "").trim(),
      name: item.name ? String(item.name) : undefined,
      note: item.note ? String(item.note) : undefined,
      due: item.due != null && item.due !== "" ? String(item.due) : item.due === null ? null : undefined,
      deferredUntil:
        item.deferredUntil != null && item.deferredUntil !== ""
          ? String(item.deferredUntil)
          : item.deferredUntil === null
            ? null
            : undefined,
      status: normalizeStatus(item.status, fallbackStatus),
      updatedAt: item.updatedAt || isoNow(),
      source: item.source ? normalizeSource(item.source) : undefined,
      sensitivity: item.sensitivity ? normalizeSensitivity(item.sensitivity) : undefined,
    };
    // Preserve lifecycle timestamps when present; never fabricate createdAt on read.
    if (item.createdAt) normalized.createdAt = String(item.createdAt);
    if (item.completedAt) normalized.completedAt = String(item.completedAt);
    if (item.relatedPerson) normalized.relatedPerson = String(item.relatedPerson);
    if (item.relatedProject) normalized.relatedProject = String(item.relatedProject);
    if (item.linkedPriorityId) normalized.linkedPriorityId = String(item.linkedPriorityId);
    if (item.originScope) normalized.originScope = String(item.originScope);
    if (item.previousScope) normalized.previousScope = String(item.previousScope);
    if (item.convertedAt) normalized.convertedAt = String(item.convertedAt);
    if (item.sourceScope) normalized.sourceScope = String(item.sourceScope);
    if (item.sourceId) normalized.sourceId = String(item.sourceId);
    return normalized;
  }

  function mapWorkingContextItem(item = {}) {
    const base = normalizeWorkItem(item);
    const status = normalizeWcStatus(base.status, "open");
    const mapped = {
      id: base.id,
      text: base.text,
      status,
      updatedAt: base.updatedAt,
    };
    if (base.note) mapped.note = base.note;
    if (base.due != null) mapped.due = base.due;
    else mapped.due = null;
    if (base.deferredUntil != null) mapped.deferredUntil = base.deferredUntil;
    else if (base.deferredUntil === null) mapped.deferredUntil = null;
    if (base.createdAt) mapped.createdAt = base.createdAt;
    if (status === "done" && base.completedAt) mapped.completedAt = base.completedAt;
    if (base.source) mapped.source = base.source;
    if (base.sensitivity) mapped.sensitivity = base.sensitivity;
    if (base.relatedPerson) mapped.relatedPerson = base.relatedPerson;
    if (base.relatedProject) mapped.relatedProject = base.relatedProject;
    if (base.linkedPriorityId) mapped.linkedPriorityId = base.linkedPriorityId;
    if (base.originScope) mapped.originScope = base.originScope;
    if (base.previousScope) mapped.previousScope = base.previousScope;
    if (base.convertedAt) mapped.convertedAt = base.convertedAt;
    return mapped;
  }

  function normalizeDaily(raw, fallbackDate = todayDate()) {
    const base = defaultDaily(fallbackDate);
    if (!raw || typeof raw !== "object") return base;
    return {
      schemaVersion: SCHEMA_VERSION,
      date: typeof raw.date === "string" && raw.date ? raw.date : fallbackDate,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      priorities: Array.isArray(raw.priorities)
        ? raw.priorities.map((item) => {
            const priority = normalizeWorkItem(item);
            const mapped = {
              id: priority.id,
              text: priority.text,
              status: priority.status,
              updatedAt: priority.updatedAt,
              source: priority.source,
            };
            if (priority.sourceScope) mapped.sourceScope = priority.sourceScope;
            if (priority.sourceId) mapped.sourceId = priority.sourceId;
            return mapped;
          })
        : [],
      activeProjects: Array.isArray(raw.activeProjects)
        ? raw.activeProjects.map((item) => {
            const project = normalizeWorkItem({ ...item, text: item.name || item.text });
            return {
              id: project.id,
              name: String(item.name || item.text || "Untitled project"),
              note: String(item.note || ""),
              updatedAt: project.updatedAt,
            };
          })
        : [],
      commitments: Array.isArray(raw.commitments)
        ? raw.commitments.map((item) => {
            const commitment = mapWorkingContextItem(item);
            return {
              ...commitment,
              source: commitment.source || "user",
              sensitivity: commitment.sensitivity || "normal",
            };
          })
        : [],
      followUps: Array.isArray(raw.followUps) ? raw.followUps.map((item) => mapWorkingContextItem(item)) : [],
      unresolved: Array.isArray(raw.unresolved) ? raw.unresolved.map((item) => mapWorkingContextItem(item)) : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : isoNow(),
    };
  }

  function normalizePreferences(raw) {
    const defaults = defaultPreferences();
    if (!raw || typeof raw !== "object") return defaults;
    const prefs = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : isoNow(),
      prefs: {
        addressAs: typeof prefs.addressAs === "string" ? prefs.addressAs : defaults.prefs.addressAs,
        defaultMode: prefs.defaultMode === "computer" ? "computer" : "display",
        confirmBefore: asStringArray(prefs.confirmBefore).length
          ? asStringArray(prefs.confirmBefore)
          : defaults.prefs.confirmBefore,
        hardRules: asStringArray(prefs.hardRules).length ? asStringArray(prefs.hardRules) : defaults.prefs.hardRules,
      },
    };
  }

  function normalizeFact(raw = {}) {
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
      key: String(raw.key || "fact").trim() || "fact",
      value: String(raw.value || "").trim(),
      sensitivity: normalizeSensitivity(raw.sensitivity),
      status: ["active", "corrected", "cleared"].includes(String(raw.status || "active"))
        ? String(raw.status)
        : "active",
      source: normalizeSource(raw.source),
      createdAt: raw.createdAt || isoNow(),
      updatedAt: raw.updatedAt || isoNow(),
      supersedes: raw.supersedes || null,
      confidence: normalizeConfidence(raw.confidence),
    };
  }

  function normalizeProfile(raw) {
    if (!raw || typeof raw !== "object") return defaultProfile();
    return {
      schemaVersion: SCHEMA_VERSION,
      facts: Array.isArray(raw.facts) ? raw.facts.map((fact) => normalizeFact(fact)) : [],
    };
  }

  function normalizeEntry(raw = {}) {
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
      kind: normalizeKind(raw.kind),
      text: String(raw.text || "").trim(),
      tags: asStringArray(raw.tags),
      sensitivity: normalizeSensitivity(raw.sensitivity),
      status: ["active", "corrected", "cleared"].includes(String(raw.status || "active"))
        ? String(raw.status)
        : "active",
      source: normalizeSource(raw.source),
      createdAt: raw.createdAt || isoNow(),
      updatedAt: raw.updatedAt || isoNow(),
      supersedes: raw.supersedes || null,
      confidence: normalizeConfidence(raw.confidence),
    };
  }

  function normalizeEntries(raw) {
    if (!raw || typeof raw !== "object") return defaultEntries();
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: Array.isArray(raw.entries) ? raw.entries.map((entry) => normalizeEntry(entry)) : [],
    };
  }

  async function readJsonFile(filePath, normalizer, fallbackFactory) {
    try {
      const raw = JSON.parse(await readText(filePath));
      return normalizer(raw);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) {
        return fallbackFactory();
      }
      throw error;
    }
  }

  async function listBackupFiles() {
    try {
      const names = await fsApi.readdir(paths.backups);
      const withStats = [];
      for (const name of names) {
        const full = path.join(paths.backups, name);
        const stats = await fsApi.stat(full);
        withStats.push({ name, full, mtimeMs: stats.mtimeMs || 0 });
      }
      return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  async function pruneBackups() {
    const files = await listBackupFiles();
    for (const file of files.slice(MAX_BACKUPS)) {
      try {
        await fsApi.unlink(file.full);
      } catch {
        // Ignore prune races.
      }
    }
  }

  async function createBackupSnapshot(reason = "backup", extras = {}) {
    if (typeof options.failBackup === "function" && options.failBackup()) {
      throw new Error("Simulated backup failure.");
    }
    await fsApi.mkdir(paths.backups, { recursive: true });
    const stamp = isoNow().replace(/[:.]/g, "-");
    const prefix = `${stamp}-${String(reason).replace(/[^a-z0-9_-]+/gi, "").slice(0, 40) || "backup"}`;
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      reason,
      createdAt: isoNow(),
      instructions: (await pathExists(paths.instructions)) ? await readText(paths.instructions) : defaultInstructions(),
      preferences: await readJsonFile(paths.preferences, normalizePreferences, defaultPreferences),
      profile: await readJsonFile(paths.profile, normalizeProfile, defaultProfile),
      daily: await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily()),
      entries: await readJsonFile(paths.entries, normalizeEntries, defaultEntries),
      ...extras,
    };
    await atomicWriteJson(path.join(paths.backups, `${prefix}.json`), snapshot);
    await pruneBackups();
    return snapshot;
  }

  async function backupRawAndReset(filePath, reason, resetWriter) {
    let raw = null;
    try {
      raw = await readText(filePath);
    } catch {
      raw = null;
    }
    await createBackupSnapshot(reason, { rawFile: path.basename(filePath), rawContent: raw });
    await resetWriter();
  }

  function openDailyItems(daily) {
    const openStatuses = new Set(["open", "blocked", "active"]);
    return {
      priorities: (daily.priorities || []).filter((item) => openStatuses.has(item.status)),
      commitments: (daily.commitments || []).filter((item) => openStatuses.has(item.status)),
      followUps: (daily.followUps || []).filter((item) => openStatuses.has(item.status)),
      unresolved: (daily.unresolved || []).filter((item) => openStatuses.has(item.status)),
      activeProjects: daily.activeProjects || [],
    };
  }

  async function rolloverDailyIfNeeded() {
    const today = todayDate();
    let daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily(today));
    if (daily.date === today) return { rolled: false, daily };

    await fsApi.mkdir(paths.archive, { recursive: true });
    const archivePath = path.join(paths.archive, `daily-${daily.date}.json`);
    await atomicWriteJson(archivePath, daily);

    const carried = openDailyItems(daily);
    let priorities = carried.priorities;
    const futurePath = path.join(paths.future, `daily-${today}.json`);
    if (await pathExists(futurePath)) {
      try {
        const futureDaily = await readJsonFile(futurePath, (raw) => normalizeDaily(raw, today), () => defaultDaily(today));
        const seen = new Set(priorities.map((item) => item.id));
        for (const item of futureDaily.priorities || []) {
          if (!seen.has(item.id)) {
            priorities.push(item);
            seen.add(item.id);
          }
        }
      } finally {
        try {
          await fsApi.unlink(futurePath);
        } catch {
          // Ignore missing future file races.
        }
      }
    }

    const next = {
      ...defaultDaily(today),
      priorities,
      commitments: carried.commitments,
      followUps: carried.followUps,
      unresolved: carried.unresolved,
      activeProjects: carried.activeProjects,
      summary: "",
      updatedAt: isoNow(),
    };
    await atomicWriteJson(paths.daily, next);
    return { rolled: true, daily: next, archived: archivePath };
  }

  async function ensureMemoryUnlocked() {
    await fsApi.mkdir(paths.root, { recursive: true });
    await fsApi.mkdir(paths.archive, { recursive: true });
    await fsApi.mkdir(paths.backups, { recursive: true });
    await fsApi.mkdir(paths.future, { recursive: true });

    if (!(await pathExists(paths.instructions))) {
      await atomicWriteText(paths.instructions, defaultInstructions());
    }

    if (!(await pathExists(paths.preferences))) {
      await atomicWriteJson(paths.preferences, defaultPreferences());
    } else {
      try {
        JSON.parse(await readText(paths.preferences));
      } catch {
        await backupRawAndReset(paths.preferences, "malformed-preferences", async () => {
          await atomicWriteJson(paths.preferences, defaultPreferences());
        });
      }
    }

    if (!(await pathExists(paths.profile))) {
      await atomicWriteJson(paths.profile, defaultProfile());
    } else {
      try {
        JSON.parse(await readText(paths.profile));
      } catch {
        await backupRawAndReset(paths.profile, "malformed-profile", async () => {
          await atomicWriteJson(paths.profile, defaultProfile());
        });
      }
    }

    if (!(await pathExists(paths.entries))) {
      await atomicWriteJson(paths.entries, defaultEntries());
    } else {
      try {
        JSON.parse(await readText(paths.entries));
      } catch {
        await backupRawAndReset(paths.entries, "malformed-entries", async () => {
          await atomicWriteJson(paths.entries, defaultEntries());
        });
      }
    }

    if (!(await pathExists(paths.daily))) {
      await atomicWriteJson(paths.daily, defaultDaily());
    } else {
      try {
        JSON.parse(await readText(paths.daily));
      } catch {
        await backupRawAndReset(paths.daily, "malformed-daily", async () => {
          await atomicWriteJson(paths.daily, defaultDaily());
        });
      }
    }

    const rollover = await rolloverDailyIfNeeded();
    return {
      ok: true,
      rootDir: paths.root,
      rolled: rollover.rolled === true,
    };
  }

  async function ensureMemory() {
    return enqueue(async () => ensureMemoryUnlocked());
  }

  async function loadAll() {
    await ensureMemory();
    return {
      instructions: await readText(paths.instructions),
      preferences: await readJsonFile(paths.preferences, normalizePreferences, defaultPreferences),
      profile: await readJsonFile(paths.profile, normalizeProfile, defaultProfile),
      daily: await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily()),
      entries: await readJsonFile(paths.entries, normalizeEntries, defaultEntries),
    };
  }

  function artifact(title, content) {
    return { title, kind: "text", content };
  }

  async function memoryView(args = {}) {
    const scope = String(args.scope || "all").toLowerCase();
    const confirmed = args.confirmed === true;
    const includeSecrets = confirmed === true;
    const data = await loadAll();
    const sections = [];
    const push = (title, body) => {
      if (body && String(body).trim()) sections.push(`## ${title}\n${String(body).trim()}`);
    };

    if (scope === "instructions" || scope === "all") push("Instructions", data.instructions);
    if (scope === "preferences" || scope === "all") {
      push("Preferences", JSON.stringify(data.preferences.prefs, null, 2));
    }
    if (scope === "profile" || scope === "all") {
      const facts = (data.profile.facts || [])
        .filter((fact) => fact.status === "active")
        .filter((fact) => includeSecrets || fact.sensitivity !== "secret")
        .map((fact) => {
          if (!includeSecrets && fact.sensitivity === "sensitive") {
            return `- ${fact.key}: [sensitive stored] (${fact.id})`;
          }
          return `- ${fact.key}: ${fact.value} (${fact.sensitivity}, ${fact.id})`;
        })
        .join("\n");
      push("Profile", facts || "(none)");
    }
    if (scope === "daily" || scope === "all") {
      push(
        "Daily",
        JSON.stringify(
          {
            date: data.daily.date,
            summary: data.daily.summary,
            priorities: data.daily.priorities,
            activeProjects: data.daily.activeProjects,
            commitments: data.daily.commitments.map((item) => {
              if (!includeSecrets && item.sensitivity === "secret") return { ...item, text: "[secret stored]" };
              if (!includeSecrets && item.sensitivity === "sensitive") return { ...item, text: "[sensitive stored]" };
              return item;
            }),
            followUps: data.daily.followUps,
            unresolved: data.daily.unresolved,
          },
          null,
          2,
        ),
      );
    }
    if (scope === "entries" || scope === "all") {
      const lines = (data.entries.entries || [])
        .filter((entry) => entry.status === "active")
        .filter((entry) => includeSecrets || entry.sensitivity !== "secret")
        .map((entry) => {
          if (!includeSecrets && entry.sensitivity === "sensitive") {
            return `- [${entry.kind}] [sensitive stored] (${entry.id}) tags=${entry.tags.join(",")}`;
          }
          return `- [${entry.kind}] ${entry.text} (${entry.sensitivity}, ${entry.id})`;
        })
        .join("\n");
      push("Entries", lines || "(none)");
    }

    if (!sections.length) return { ok: false, error: `Unsupported memory view scope: ${scope}` };
    const content = `# Memory View (${scope})\n\n${sections.join("\n\n")}`;
    return {
      ok: true,
      message: "Memory view ready.",
      scope,
      includesSecrets: includeSecrets,
      artifact: artifact("Personal Memory", content),
    };
  }

  async function memoryRemember(args = {}) {
    return enqueue(async () => {
      await ensureMemoryUnlocked();
      const target = String(args.target || "entry").toLowerCase();
      const text = String(args.text || args.value || "").trim();
      const confidence = normalizeConfidence(args.confidence);
      const source = normalizeSource(args.source);
      const sensitivity = normalizeSensitivity(args.sensitivity);
      if (!text) return { ok: false, error: "Memory text is required." };

      if (target === "profile") {
        const key = String(args.key || "").trim();
        if (!key) return { ok: false, error: "Profile facts require a key." };
        const profile = await readJsonFile(paths.profile, normalizeProfile, defaultProfile);
        const active = (profile.facts || []).find(
          (fact) => fact.status === "active" && fact.key.toLowerCase() === key.toLowerCase(),
        );
        if (active && active.value !== text) {
          if (confidence === "inferred" && source === "assistant") {
            return {
              ok: false,
              code: "MEMORY_CONFLICT",
              error: "Inferred profile fact conflicts with an active stored fact.",
              conflict: { type: "profile", id: active.id, key: active.key, value: active.value, proposed: text },
            };
          }
          active.status = "corrected";
          active.updatedAt = isoNow();
          const replacement = normalizeFact({
            key,
            value: text,
            sensitivity,
            source,
            confidence: "stated",
            supersedes: active.id,
          });
          profile.facts.push(replacement);
          await atomicWriteJson(paths.profile, profile);
          return { ok: true, message: "Profile fact corrected.", fact: replacement };
        }
        const fact = normalizeFact({ key, value: text, sensitivity, source, confidence });
        profile.facts.push(fact);
        await atomicWriteJson(paths.profile, profile);
        return { ok: true, message: "Profile fact stored.", fact };
      }

      const entriesDoc = await readJsonFile(paths.entries, normalizeEntries, defaultEntries);
      const kind = normalizeKind(args.kind);
      const tags = asStringArray(args.tags);
      if (confidence === "inferred" && source === "assistant") {
        const conflict = (entriesDoc.entries || []).find((entry) => {
          if (entry.status !== "active" || entry.kind !== kind) return false;
          if (!tags.length) return false;
          const overlap = tags.some((tag) => entry.tags.map((item) => item.toLowerCase()).includes(tag.toLowerCase()));
          return overlap && entry.text.toLowerCase() !== text.toLowerCase();
        });
        if (conflict) {
          return {
            ok: false,
            code: "MEMORY_CONFLICT",
            error: "Inferred memory conflicts with an active stored entry.",
            conflict: { type: "entry", id: conflict.id, text: conflict.text, proposed: text },
          };
        }
      }

      const entry = normalizeEntry({ kind, text, tags, sensitivity, source, confidence });
      entriesDoc.entries.unshift(entry);
      await atomicWriteJson(paths.entries, entriesDoc);
      return { ok: true, message: "Memory entry stored.", entry };
    });
  }

  async function memoryCorrect(args = {}) {
    return enqueue(async () => {
      await ensureMemoryUnlocked();
      const id = String(args.id || "").trim();
      const text = String(args.text || args.value || "").trim();
      if (!id) return { ok: false, error: "Correction requires an id." };
      if (!text) return { ok: false, error: "Correction requires replacement text." };

      const entriesDoc = await readJsonFile(paths.entries, normalizeEntries, defaultEntries);
      const entry = (entriesDoc.entries || []).find((item) => item.id === id);
      if (entry) {
        entry.status = "corrected";
        entry.updatedAt = isoNow();
        const replacement = normalizeEntry({
          kind: args.kind || entry.kind,
          text,
          tags: args.tags || entry.tags,
          sensitivity: args.sensitivity || entry.sensitivity,
          source: "user",
          confidence: "stated",
          supersedes: entry.id,
        });
        entriesDoc.entries.unshift(replacement);
        await atomicWriteJson(paths.entries, entriesDoc);
        return { ok: true, message: "Memory entry corrected.", entry: replacement, correctedId: id };
      }

      const profile = await readJsonFile(paths.profile, normalizeProfile, defaultProfile);
      const fact = (profile.facts || []).find((item) => item.id === id);
      if (!fact) return { ok: false, error: "Memory item not found." };
      fact.status = "corrected";
      fact.updatedAt = isoNow();
      const replacement = normalizeFact({
        key: args.key || fact.key,
        value: text,
        sensitivity: args.sensitivity || fact.sensitivity,
        source: "user",
        confidence: "stated",
        supersedes: fact.id,
      });
      profile.facts.push(replacement);
      await atomicWriteJson(paths.profile, profile);
      return { ok: true, message: "Profile fact corrected.", fact: replacement, correctedId: id };
    });
  }

  function upsertWorkList(existing, updates, mapper) {
    const list = Array.isArray(existing) ? [...existing] : [];
    if (!Array.isArray(updates)) return list;
    for (const update of updates) {
      const mapped = mapper(update);
      if (!mapped.text && !mapped.name) continue;
      const index = list.findIndex(
        (item) => item.id === mapped.id || (mapped.text && item.text === mapped.text) || (mapped.name && item.name === mapped.name),
      );
      if (index >= 0) list[index] = { ...list[index], ...mapped, updatedAt: isoNow() };
      else list.push({ ...mapped, updatedAt: isoNow() });
    }
    return list;
  }

  async function memoryUpdateDaily(args = {}) {
    return enqueue(async () => {
      if (Object.prototype.hasOwnProperty.call(args, "priorities")) {
        return {
          ok: false,
          code: "USE_MEMORY_PRIORITIES",
          error:
            "Use memory_priorities for daily-priority lifecycle changes. memory_update_daily no longer accepts priorities.",
        };
      }
      if (
        Object.prototype.hasOwnProperty.call(args, "commitments") ||
        Object.prototype.hasOwnProperty.call(args, "followUps") ||
        Object.prototype.hasOwnProperty.call(args, "unresolved")
      ) {
        return {
          ok: false,
          code: "USE_WORKING_CONTEXT_ITEMS",
          error:
            "Use working_context_items for commitments, follow-ups, and unresolved items. memory_update_daily no longer accepts those arrays.",
        };
      }
      if (Object.prototype.hasOwnProperty.call(args, "activeProjects")) {
        return {
          ok: false,
          code: "USE_MEMORY_ACTIVE_PROJECTS",
          error:
            "Use memory_active_projects for active project lifecycle. memory_update_daily no longer accepts activeProjects.",
        };
      }
      await ensureMemoryUnlocked();
      await rolloverDailyIfNeeded();
      const daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
      if (typeof args.summary === "string") daily.summary = args.summary;
      daily.updatedAt = isoNow();
      await atomicWriteJson(paths.daily, daily);
      return { ok: true, message: "Daily context updated.", daily };
    });
  }

  async function memorySetPreference(args = {}) {
    return enqueue(async () => {
      await ensureMemoryUnlocked();
      const preferences = await readJsonFile(paths.preferences, normalizePreferences, defaultPreferences);
      if (typeof args.addressAs === "string") preferences.prefs.addressAs = args.addressAs;
      if (args.defaultMode === "display" || args.defaultMode === "computer") preferences.prefs.defaultMode = args.defaultMode;
      if (Array.isArray(args.confirmBefore)) preferences.prefs.confirmBefore = asStringArray(args.confirmBefore);
      if (Array.isArray(args.hardRules)) preferences.prefs.hardRules = asStringArray(args.hardRules);
      if (typeof args.hardRule === "string" && args.hardRule.trim()) preferences.prefs.hardRules.push(args.hardRule.trim());
      preferences.updatedAt = isoNow();
      await atomicWriteJson(paths.preferences, preferences);
      return { ok: true, message: "Preferences updated.", preferences };
    });
  }

  async function memorySetInstructions(args = {}) {
    return enqueue(async () => {
      await ensureMemoryUnlocked();
      const mode = String(args.mode || "append").toLowerCase();
      const content = String(args.content || args.text || "");
      if (!content.trim()) return { ok: false, error: "Instruction content is required." };

      if (mode === "replace") {
        if (args.confirmed !== true) {
          return {
            ok: false,
            requiresConfirmation: true,
            message: "Confirmation required before replacing all personal instructions.",
          };
        }
        await createBackupSnapshot("instructions-replace");
        await atomicWriteText(paths.instructions, content.endsWith("\n") ? content : `${content}\n`);
        return { ok: true, message: "Personal instructions replaced." };
      }

      const current = await readText(paths.instructions);
      const section = typeof args.section === "string" && args.section.trim() ? args.section.trim() : null;
      const addition = section ? `\n\n## ${section}\n${content.trim()}\n` : `\n\n${content.trim()}\n`;
      await atomicWriteText(paths.instructions, `${current.trimEnd()}${addition}`);
      return { ok: true, message: "Personal instructions updated." };
    });
  }

  async function memoryClear(args = {}) {
    return enqueue(async () => {
      await ensureMemoryUnlocked();
      if (args.confirmed !== true) {
        return {
          ok: false,
          requiresConfirmation: true,
          message: "Confirmation required before clearing memory.",
        };
      }
      const scope = String(args.scope || "daily").toLowerCase();
      await createBackupSnapshot(`clear-${scope}`);

      if (scope === "daily") await atomicWriteJson(paths.daily, defaultDaily());
      else if (scope === "entries") await atomicWriteJson(paths.entries, defaultEntries());
      else if (scope === "preferences") await atomicWriteJson(paths.preferences, defaultPreferences());
      else if (scope === "instructions") await atomicWriteText(paths.instructions, defaultInstructions());
      else if (scope === "all") {
        await atomicWriteText(paths.instructions, defaultInstructions());
        await atomicWriteJson(paths.preferences, defaultPreferences());
        await atomicWriteJson(paths.profile, defaultProfile());
        await atomicWriteJson(paths.daily, defaultDaily());
        await atomicWriteJson(paths.entries, defaultEntries());
      } else {
        return { ok: false, error: `Unsupported clear scope: ${scope}` };
      }
      return { ok: true, message: `Cleared memory scope: ${scope}.` };
    });
  }

  function trimToBudget(text, budget) {
    if (text.length <= budget) return text;
    return `${text.slice(0, Math.max(0, budget - 20)).trimEnd()}\n…`;
  }

  function selectDurableEntries(entriesDoc) {
    const priorityTags = new Set(["priority", "important", "urgent", "commitment", "project"]);
    return (entriesDoc.entries || [])
      .filter((entry) => entry.status === "active")
      .filter((entry) => entry.sensitivity !== "secret")
      .map((entry) => ({
        entry,
        score:
          (entry.tags || []).reduce((sum, tag) => sum + (priorityTags.has(String(tag).toLowerCase()) ? 5 : 0), 0) +
          (Date.parse(entry.updatedAt) || 0) / 1e12,
      }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.entry);
  }

  function buildPersonalContextBlock(data, options = {}) {
    const softCap = Number(options.softCap) || PERSONAL_CONTEXT_SOFT_CAP;
    const preferences = data.preferences;
    const daily = data.daily;
    const instructions = String(data.instructions || "");
    const selectedEntries = selectDurableEntries(data.entries);
    const totalActiveNonSecret = (data.entries.entries || []).filter(
      (entry) => entry.status === "active" && entry.sensitivity !== "secret",
    ).length;

    const hardRules = [
      `Address the user as ${preferences.prefs.addressAs}.`,
      `Default mode preference: ${preferences.prefs.defaultMode}.`,
      ...preferences.prefs.hardRules.map((rule) => `- ${rule}`),
      `Confirm before: ${preferences.prefs.confirmBefore.join(", ") || "none listed"}.`,
    ].join("\n");

    const openCommitments = (daily.commitments || []).filter((item) => isOpenWorkStatus(item.status));
    const openPriorities = (daily.priorities || []).filter((item) => isOpenWorkStatus(item.status));
    const formattedDaily = formatDailyWorkingContext(daily, daily.date || todayDate());
    const dailyLines = formattedDaily.text;

    let prefsBlock = trimToBudget(`# Personal Preferences And Hard Rules\n${hardRules}`, PREFS_SECTION_CAP);
    let instructionsBlock = trimToBudget(
      `# Personal Operating Instructions (excerpt)\n${instructions}`,
      INSTRUCTIONS_EXCERPT_CAP,
    );
    let dailyBlock = trimToBudget(`# Today's Working Context\n${dailyLines}`, DAILY_SECTION_CAP);

    const entryLines = [];
    for (const entry of selectedEntries) {
      if (entry.sensitivity === "sensitive") entryLines.push(`- [${entry.kind}] [sensitive stored] (${entry.id})`);
      else entryLines.push(`- [${entry.kind}] ${entry.text}`);
    }
    let entriesBlock = trimToBudget(
      `# Durable Memory (selected)\n${entryLines.join("\n") || "No durable entries selected."}`,
      ENTRIES_SECTION_CAP,
    );

    const markerNeeded = totalActiveNonSecret > entryLines.length || instructions.length > INSTRUCTIONS_EXCERPT_CAP;
    let marker = markerNeeded
      ? "# Memory Availability\nAdditional personal memory exists beyond this excerpt. Use memory_view for the full permitted scope."
      : "";

    let block = [
      "# Personal Jarvis Context",
      "Use this durable local memory for Sarah. Temporary conversation history is session-only and is not stored here.",
      prefsBlock,
      instructionsBlock,
      dailyBlock,
      entriesBlock,
      marker,
    ]
      .filter(Boolean)
      .join("\n\n");

    let truncated = false;
    if (block.length > softCap) {
      truncated = true;
      entriesBlock = trimToBudget(entriesBlock, Math.max(400, Math.floor(ENTRIES_SECTION_CAP / 3)));
      instructionsBlock = trimToBudget(instructionsBlock, Math.max(500, Math.floor(INSTRUCTIONS_EXCERPT_CAP / 2)));
      const compactDaily = [
        `Date: ${daily.date}`,
        openPriorities.length
          ? `Daily priorities:\n${openPriorities.map((item) => `- ${item.text}`).join("\n")}`
          : NO_OPEN_DAILY_PRIORITIES_LINE,
        `Commitments:\n${
          openCommitments
            .map((item) => formatCommitmentLine(item))
            .join("\n") || "- none"
        }`,
      ].join("\n");
      dailyBlock = trimToBudget(
        `# Today's Working Context\n${compactDaily}`,
        Math.max(600, Math.floor(DAILY_SECTION_CAP / 2)),
      );
      marker =
        "# Memory Availability\nAdditional personal memory exists beyond this excerpt. Use memory_view for the full permitted scope.";
      block = [
        "# Personal Jarvis Context",
        "Use this durable local memory for Sarah. Temporary conversation history is session-only and is not stored here.",
        prefsBlock,
        instructionsBlock,
        dailyBlock,
        entriesBlock,
        marker,
      ].join("\n\n");
      if (block.length > softCap) block = trimToBudget(block, softCap);
    }

    return { text: block, bytes: Buffer.byteLength(block, "utf8"), truncated };
  }

  async function buildPersonalContextForSession() {
    const data = await loadAll();
    return buildPersonalContextBlock(data);
  }

  function invalidatePreviews() {
    previewStore.clear();
  }

  const CARRY_PREVIEW_BINDING_VERSION = 1;

  function buildPreviewRequestBinding(args = {}) {
    const items = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
    return {
      atPosition:
        args.atPosition != null && args.atPosition !== "" ? Number(args.atPosition) : null,
      targetDate: args.targetDate != null && args.targetDate !== "" ? String(args.targetDate) : null,
      move: args.move === true,
      backupId: args.backupId != null && args.backupId !== "" ? String(args.backupId) : null,
      reference: args.reference != null ? args.reference : null,
      order: Array.isArray(args.order) ? args.order : null,
      itemTexts: items.map((raw) => String(raw?.text || raw?.name || "").trim()).filter(Boolean),
    };
  }

  function resolveCarryTargetDateArg(targetDate, dailyDate) {
    if (targetDate === "tomorrow" || targetDate == null || targetDate === "") {
      return addDaysToDate(dailyDate, 1);
    }
    return String(targetDate);
  }

  function projectCarryOntoFuture(futurePriorities, carryItems) {
    const next = clonePriorities(futurePriorities);
    const seen = new Set(next.map((item) => item.id));
    for (const item of carryItems) {
      if (!seen.has(item.id)) {
        next.push({ ...item, status: "open" });
        seen.add(item.id);
      }
    }
    return next;
  }

  function formatCarryPreviewMessage(carryItems, move, targetLabel) {
    if (carryItems.length === 1) {
      const name = String(carryItems[0].text || "").trim();
      if (move) {
        return `You're about to move "${name}" into ${targetLabel}'s daily priorities. It will be removed from today's list.`;
      }
      return `You're about to copy "${name}" into ${targetLabel}'s daily priorities. Today's priority will remain unchanged.`;
    }
    if (move) {
      return `You're about to move ${carryItems.length} priorities into ${targetLabel}'s daily priorities. They will be removed from today's list.`;
    }
    return `You're about to copy ${carryItems.length} priorities into ${targetLabel}'s daily priorities. Today's priorities will remain unchanged.`;
  }

  function formatPriorityLines(priorities) {
    const rows = canonicalizePriorities(priorities);
    return rows.length
      ? rows.map((row) => `${row.order}. ${row.text} — ${row.status}`).join("\n")
      : "No priorities stored.";
  }

  function formatCarryPreviewArtifact({
    mode,
    targetDate,
    targetLabel,
    selected,
    todayBefore,
    todayAfter,
    tomorrowBefore,
    tomorrowAfter,
  }) {
    const selectedLines = selected.map((item) => `- ${item.text}`).join("\n");
    return {
      title: `Carry preview (${mode})`,
      kind: "markdown",
      content: [
        `# Carry preview (${mode})`,
        "",
        `Target date: ${targetLabel} (${targetDate})`,
        "",
        "## Selected",
        selectedLines || "- (none)",
        "",
        "## Today before",
        formatPriorityLines(todayBefore),
        "",
        "## Today after",
        formatPriorityLines(todayAfter),
        "",
        "## Tomorrow before",
        formatPriorityLines(tomorrowBefore),
        "",
        "## Tomorrow after",
        formatPriorityLines(tomorrowAfter),
      ].join("\n"),
    };
  }

  async function readFutureDaily(targetDate) {
    await fsApi.mkdir(paths.future, { recursive: true });
    const futurePath = path.join(paths.future, `daily-${targetDate}.json`);
    if (await pathExists(futurePath)) {
      return readJsonFile(futurePath, (raw) => normalizeDaily(raw, targetDate), () => defaultDaily(targetDate));
    }
    return defaultDaily(targetDate);
  }

  function confirmationConflictsWithPreview(args, entry, context = {}) {
    const bound = entry?.meta?.request;
    if (!bound) return null;

    if (entry.operation === "carry") {
      if (bound.carryBindingVersion !== CARRY_PREVIEW_BINDING_VERSION) {
        return "Carry preview binding is stale or invalid.";
      }
    }

    if (args.atPosition != null && args.atPosition !== "" && bound.atPosition != null) {
      if (Number(args.atPosition) !== Number(bound.atPosition)) {
        return "Confirmation atPosition does not match the preview.";
      }
    }
    if (args.targetDate != null && args.targetDate !== "") {
      const resolvedConfirm = resolveCarryTargetDateArg(args.targetDate, context.dailyDate || "");
      if (bound.resolvedTargetDate && String(resolvedConfirm) !== String(bound.resolvedTargetDate)) {
        return "Confirmation targetDate does not match the preview.";
      }
      if (!bound.resolvedTargetDate && bound.targetDate != null && String(args.targetDate) !== String(bound.targetDate)) {
        return "Confirmation targetDate does not match the preview.";
      }
    }
    if (Object.prototype.hasOwnProperty.call(args, "move") && Boolean(args.move) !== Boolean(bound.move)) {
      return "Confirmation move flag does not match the preview.";
    }
    if (args.backupId != null && args.backupId !== "" && bound.backupId != null) {
      if (String(args.backupId) !== String(bound.backupId)) {
        return "Confirmation backupId does not match the preview.";
      }
    }
    if (args.reference != null && bound.reference != null) {
      if (JSON.stringify(args.reference) !== JSON.stringify(bound.reference)) {
        return "Confirmation reference does not match the preview.";
      }
    }
    if (Array.isArray(args.order) && Array.isArray(bound.order)) {
      if (JSON.stringify(args.order) !== JSON.stringify(bound.order)) {
        return "Confirmation order does not match the preview.";
      }
    }
    const supplied = buildPreviewRequestBinding(args);
    if (supplied.itemTexts.length && bound.itemTexts.length) {
      if (JSON.stringify(supplied.itemTexts) !== JSON.stringify(bound.itemTexts)) {
        return "Confirmation items do not match the preview.";
      }
    }
    return null;
  }

  function storePreview(operation, beforePriorities, afterPriorities, dailyUpdatedAt, meta = {}) {
    const token = createPreviewToken();
    const payload = { operation, beforePriorities, afterPriorities, dailyUpdatedAt, meta };
    previewStore.set(token, {
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      operation,
      hash: hashPreviewPayload(payload),
      beforePriorities: clonePriorities(beforePriorities),
      afterPriorities: clonePriorities(afterPriorities),
      dailyUpdatedAt,
      meta,
    });
    return token;
  }

  function readPreview(token, operation, dailyUpdatedAt) {
    const entry = previewStore.get(String(token || ""));
    if (!entry) return { code: "STALE_PREVIEW" };
    if (Date.now() > entry.expiresAt) {
      previewStore.delete(token);
      return { code: "STALE_PREVIEW" };
    }
    if (entry.operation !== operation) return { code: "STALE_PREVIEW" };
    if (entry.dailyUpdatedAt !== dailyUpdatedAt) return { code: "STALE_PREVIEW" };
    return { entry };
  }

  function successPriorityResult(options) {
    const { operation, priorities, dailyUpdatedAt, message, backupId, startedAt, extra } = options;
    logPrioritiesEvent({
      operation,
      ok: true,
      itemCount: priorities.length,
      backupId,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true,
      message,
      operation,
      priorities: canonicalizePriorities(priorities),
      dailyUpdatedAt,
      backupId,
      artifact: formatPrioritiesArtifact(priorities),
      confirmation: message,
      ...extra,
    };
  }

  function failPriorityResult(operation, code, message, startedAt, extra = {}) {
    logPrioritiesEvent({
      operation,
      ok: false,
      code,
      itemCount: extra.priorities ? extra.priorities.length : undefined,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      code,
      error: message,
      message,
      operation,
      ...extra,
    };
  }

  async function commitPriorityDaily(beforeDaily, nextDaily, operation, startedAt) {
    const unchanged = assertUnchangedFields(beforeDaily, nextDaily);
    if (unchanged) {
      return failPriorityResult(operation, "VALIDATION_FAILED", unchanged, startedAt, {
        priorities: canonicalizePriorities(beforeDaily.priorities),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }
    const validationError = validateDailyShape(nextDaily);
    if (validationError) {
      return failPriorityResult(operation, "VALIDATION_FAILED", validationError, startedAt, {
        priorities: canonicalizePriorities(beforeDaily.priorities),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }

    let backupId = null;
    try {
      const snapshot = await createBackupSnapshot(`priorities-${operation}`);
      backupId = snapshot.createdAt;
    } catch (error) {
      return failPriorityResult(
        operation,
        "BACKUP_FAILED",
        error instanceof Error ? error.message : "Backup creation failed.",
        startedAt,
        {
          priorities: canonicalizePriorities(beforeDaily.priorities),
          dailyUpdatedAt: beforeDaily.updatedAt,
        },
      );
    }

    nextDaily.updatedAt = isoNow();
    try {
      if (typeof options.failAtomicWrite === "function" && options.failAtomicWrite()) {
        throw new Error("Simulated atomic write failure.");
      }
      await atomicWriteJson(paths.daily, nextDaily);
    } catch (error) {
      return failPriorityResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Atomic write failed.",
        startedAt,
        {
          priorities: canonicalizePriorities(beforeDaily.priorities),
          dailyUpdatedAt: beforeDaily.updatedAt,
          backupId,
        },
      );
    }

    let reread;
    try {
      if (typeof options.failReread === "function" && options.failReread()) {
        throw new Error("Simulated reread failure.");
      }
      reread = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
    } catch (error) {
      return failPriorityResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Reread failed after write.",
        startedAt,
        {
          priorities: canonicalizePriorities(nextDaily.priorities),
          dailyUpdatedAt: nextDaily.updatedAt,
          backupId,
        },
      );
    }

    invalidatePreviews();
    notFoundFingerprints.clear();

    return successPriorityResult({
      operation,
      priorities: reread.priorities,
      dailyUpdatedAt: reread.updatedAt,
      message: `Daily priorities ${operation.replace(/_/g, " ")} completed.`,
      backupId,
      startedAt,
      extra: { daily: reread },
    });
  }

  async function memoryPriorities(args = {}) {
    const startedAt = Date.now();
    const operation = String(args.operation || "").trim().toLowerCase();
    if (!operation) {
      return failPriorityResult("unknown", "UNSUPPORTED_OPERATION", "operation is required.", startedAt);
    }

    return enqueue(async () => {
      const result = await runMemoryPrioritiesOperation(args, operation, startedAt);
      return applyFailedRetryPolicy(args, result);
    });
  }

  async function runMemoryPrioritiesOperation(args, operation, startedAt) {
      await ensureMemoryUnlocked();
      await rolloverDailyIfNeeded();
      const daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
      const beforePriorities = clonePriorities(daily.priorities);
      const listScope = resolveListScope(operation, args);

      if (args.expectedUpdatedAt && args.expectedUpdatedAt !== daily.updatedAt) {
        return failPriorityResult(operation, "STALE_WRITE", "Daily context changed since the last read.", startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
          artifact: formatPrioritiesArtifact(daily.priorities),
        });
      }

      const resolveOpts = { listScope, recentId: recentPriorityId };

      if (operation === "list") {
        const requestedDate =
          args.targetDate != null && args.targetDate !== ""
            ? resolveCarryTargetDateArg(args.targetDate, daily.date)
            : daily.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate))) {
          return failPriorityResult(operation, "VALIDATION_FAILED", "list targetDate must be YYYY-MM-DD or tomorrow.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }

        let listedPriorities = daily.priorities;
        let listedUpdatedAt = daily.updatedAt;
        let listLabel = "Daily Priorities";
        let message = "Current daily priorities.";
        let confirmation = "Listed current daily priorities.";

        if (requestedDate !== daily.date) {
          const futureDaily = await readFutureDaily(requestedDate);
          listedPriorities = futureDaily.priorities || [];
          listedUpdatedAt = futureDaily.updatedAt || null;
          const isTomorrow = requestedDate === addDaysToDate(daily.date, 1);
          listLabel = isTomorrow ? `Daily Priorities (tomorrow ${requestedDate})` : `Daily Priorities (${requestedDate})`;
          message = isTomorrow
            ? `Tomorrow's daily priorities (${requestedDate}).`
            : `Daily priorities for ${requestedDate}.`;
          confirmation = message;
        }

        logPrioritiesEvent({
          operation,
          ok: true,
          itemCount: listedPriorities.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: true,
          operation,
          message,
          targetDate: requestedDate,
          priorities: canonicalizePriorities(listedPriorities),
          dailyUpdatedAt: listedUpdatedAt,
          artifact: formatPrioritiesArtifact(listedPriorities, { label: listLabel }),
          confirmation,
        };
      }

      if (operation === "preview") {
        const nested = { ...args, operation: String(args.previewOperation || args.targetOperation || "").trim() };
        if (!nested.operation) {
          return failPriorityResult(operation, "UNSUPPORTED_OPERATION", "preview requires previewOperation.", startedAt);
        }
        nested.confirmed = false;
        nested._previewOnly = true;
        return memoryPrioritiesPreviewPlan(nested, daily, beforePriorities, startedAt, resolveOpts);
      }

      if (DESTRUCTIVE_OPERATIONS.has(operation)) {
        if (args.confirmed !== true || !args.previewToken) {
          const planned = await memoryPrioritiesPreviewPlan(
            { ...args, _previewOnly: true },
            daily,
            beforePriorities,
            startedAt,
            resolveOpts,
          );
          if (planned.ok === false && planned.code !== "CONFIRMATION_REQUIRED") return planned;
          return {
            ok: false,
            code: "CONFIRMATION_REQUIRED",
            requiresConfirmation: true,
            message: planned.message || `Confirmation required before ${operation.replace(/_/g, " ")}.`,
            operation,
            previewToken: planned.previewToken,
            before: planned.before,
            after: planned.after,
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
            artifact: planned.artifact || formatPrioritiesArtifact(daily.priorities),
            ...(planned.mode != null
              ? {
                  mode: planned.mode,
                  move: planned.move === true,
                  targetDate: planned.targetDate,
                  selected: planned.selected,
                  todayBefore: planned.todayBefore,
                  todayAfter: planned.todayAfter,
                  tomorrowBefore: planned.tomorrowBefore,
                  tomorrowAfter: planned.tomorrowAfter,
                }
              : {}),
          };
        }
        const preview = readPreview(args.previewToken, operation, daily.updatedAt);
        if (preview.code) {
          return failPriorityResult(operation, "STALE_PREVIEW", "Priority preview is stale or invalid.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
      }

      return applyPriorityOperation(args, daily, beforePriorities, startedAt, resolveOpts);
  }

  async function loadValidatedBackupPriorities(backupId) {
    const files = await listBackupFiles();
    let file = null;
    if (backupId) {
      file = files.find(
        (item) =>
          item.name.includes(String(backupId)) ||
          item.name === backupId ||
          item.full.endsWith(String(backupId)),
      );
    } else {
      file = files[0];
    }
    if (!file) {
      return { error: { code: "RESTORE_FAILED", message: "No backup was found to restore." } };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readText(file.full));
    } catch (error) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: error instanceof Error ? error.message : "Backup could not be read.",
        },
      };
    }
    if (!snapshot || typeof snapshot !== "object" || !snapshot.daily || typeof snapshot.daily !== "object") {
      return { error: { code: "RESTORE_FAILED", message: "Backup is missing a valid daily snapshot." } };
    }
    const restoredPriorities = (Array.isArray(snapshot.daily.priorities) ? snapshot.daily.priorities : []).map((item) =>
      normalizeWorkItem(item),
    );
    const validationError = validatePrioritiesArray(restoredPriorities);
    if (validationError) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: `Backup priorities failed validation: ${validationError}`,
        },
      };
    }
    return { file, restoredPriorities };
  }

  async function memoryPrioritiesPreviewPlan(args, daily, beforePriorities, startedAt, resolveOpts) {
    const operation = String(args.operation || "").trim().toLowerCase();

    if (operation === "restore_backup") {
      const loaded = await loadValidatedBackupPriorities(args.backupId);
      if (loaded.error) {
        return failPriorityResult(operation, loaded.error.code, loaded.error.message, startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const afterPriorities = loaded.restoredPriorities;
      const token = storePreview(operation, beforePriorities, afterPriorities, daily.updatedAt, {
        backupFile: loaded.file.name,
        request: buildPreviewRequestBinding(args),
      });
      return {
        ok: true,
        operation: "preview",
        previewOperation: operation,
        message: `Preview ready for restore from ${loaded.file.name}. Confirm to apply.`,
        previewToken: token,
        before: canonicalizePriorities(beforePriorities),
        after: canonicalizePriorities(afterPriorities),
        priorities: canonicalizePriorities(beforePriorities),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatPrioritiesArtifact(afterPriorities),
        requiresConfirmation: true,
      };
    }

    const planned = planPriorityMutation(args, daily, resolveOpts);
    if (planned.error) {
      return failPriorityResult(operation, planned.error.code, planned.error.message, startedAt, {
        candidates: planned.error.candidates,
        priorities: canonicalizePriorities(daily.priorities),
        dailyUpdatedAt: daily.updatedAt,
      });
    }

    if (operation === "carry") {
      const move = planned.meta?.move === true;
      const mode = move ? "move" : "copy";
      const targetDate = planned.meta.targetDate;
      const carryItems = (planned.meta.carryItems || []).map((item) => ({ ...item }));
      const futureDaily = await readFutureDaily(targetDate);
      const tomorrowBefore = clonePriorities(futureDaily.priorities || []);
      const tomorrowAfter = projectCarryOntoFuture(tomorrowBefore, carryItems);
      const tomorrowLabel = targetDate === addDaysToDate(daily.date, 1) ? "tomorrow" : targetDate;
      const message = formatCarryPreviewMessage(carryItems, move, tomorrowLabel);
      const todayBefore = clonePriorities(beforePriorities);
      const todayAfter = clonePriorities(planned.nextPriorities);
      const request = {
        ...buildPreviewRequestBinding(args),
        move,
        resolvedTargetDate: targetDate,
        sourceIds: carryItems.map((item) => item.id),
        normalizedReference: normalizePriorityReference(args.reference || args.item),
        carryBindingVersion: CARRY_PREVIEW_BINDING_VERSION,
        todayAfter: canonicalizePriorities(todayAfter),
        tomorrowAfter: canonicalizePriorities(tomorrowAfter),
      };
      const token = storePreview(operation, beforePriorities, planned.nextPriorities, daily.updatedAt, {
        ...planned.meta,
        carryBindingVersion: CARRY_PREVIEW_BINDING_VERSION,
        mode,
        tomorrowBefore: clonePriorities(tomorrowBefore),
        tomorrowAfter: clonePriorities(tomorrowAfter),
        request,
      });
      const artifact = formatCarryPreviewArtifact({
        mode,
        targetDate,
        targetLabel: tomorrowLabel,
        selected: carryItems,
        todayBefore,
        todayAfter,
        tomorrowBefore,
        tomorrowAfter,
      });
      return {
        ok: true,
        operation: args._previewOnly ? operation : "preview",
        previewOperation: operation,
        message,
        previewToken: token,
        mode,
        move,
        targetDate,
        selected: canonicalizePriorities(carryItems),
        before: canonicalizePriorities(todayBefore),
        after: canonicalizePriorities(todayAfter),
        todayBefore: canonicalizePriorities(todayBefore),
        todayAfter: canonicalizePriorities(todayAfter),
        tomorrowBefore: canonicalizePriorities(tomorrowBefore),
        tomorrowAfter: canonicalizePriorities(tomorrowAfter),
        priorities: canonicalizePriorities(beforePriorities),
        dailyUpdatedAt: daily.updatedAt,
        artifact,
        requiresConfirmation: true,
      };
    }

    const request = buildPreviewRequestBinding(args);
    const token = storePreview(operation, beforePriorities, planned.nextPriorities, daily.updatedAt, {
      ...planned.meta,
      request,
      atPosition: request.atPosition,
    });
    const destructive = DESTRUCTIVE_OPERATIONS.has(operation);
    return {
      ok: true,
      operation: args._previewOnly ? operation : "preview",
      previewOperation: operation,
      message: destructive
        ? `Preview ready for ${operation.replace(/_/g, " ")}. Confirm to apply.`
        : `Dry-run only for ${operation.replace(/_/g, " ")}. Execute ${operation} directly with the same arguments to apply; do not ask Sarah to confirm.`,
      previewToken: token,
      before: canonicalizePriorities(beforePriorities),
      after: canonicalizePriorities(planned.nextPriorities),
      priorities: canonicalizePriorities(beforePriorities),
      dailyUpdatedAt: daily.updatedAt,
      artifact: formatPrioritiesArtifact(planned.nextPriorities),
      requiresConfirmation: destructive,
    };
  }

  function planPriorityMutation(args, daily, resolveOpts) {
    const operation = String(args.operation || "").trim().toLowerCase();
    const priorities = clonePriorities(daily.priorities);

    if (operation === "add") {
      const incoming = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
      if (!incoming.length) return { error: { code: "VALIDATION_FAILED", message: "add requires items." } };
      const next = clonePriorities(priorities);
      for (const raw of incoming) {
        const item = normalizeIncomingItem(raw, randomUUID, isoNow);
        if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "Priority wording is required." } };
        const dup = next.some((p) => p.text.toLowerCase() === item.text.toLowerCase());
        if (dup && args.allowDuplicates !== true) {
          return { error: { code: "DUPLICATE_TEXT", message: "A priority with that wording already exists." } };
        }
        next.push(item);
      }
      return { nextPriorities: next };
    }

    if (operation === "insert") {
      const incoming = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
      const at = Number(args.atPosition);
      if (!incoming.length) return { error: { code: "VALIDATION_FAILED", message: "insert requires items." } };
      if (!Number.isInteger(at) || at < 1 || at > priorities.length + 1) {
        return { error: { code: "VALIDATION_FAILED", message: "insert requires a valid 1-based atPosition." } };
      }
      const next = clonePriorities(priorities);
      const prepared = [];
      for (const raw of incoming) {
        const item = normalizeIncomingItem(raw, randomUUID, isoNow);
        if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "Priority wording is required." } };
        const dup = next.some((p) => p.text.toLowerCase() === item.text.toLowerCase());
        if (dup && args.allowDuplicates !== true) {
          return { error: { code: "DUPLICATE_TEXT", message: "A priority with that wording already exists." } };
        }
        prepared.push(item);
      }
      next.splice(at - 1, 0, ...prepared);
      return { nextPriorities: next, meta: { atPosition: at } };
    }

    if (operation === "edit" || operation === "complete" || operation === "reopen" || operation === "remove") {
      const resolved = resolvePriorityReference(priorities, args.reference || args.item, resolveOpts);
      if (resolved.code) {
        return {
          error: {
            code: resolved.code,
            message:
              resolved.code === "AMBIGUOUS_MATCH"
                ? "Multiple priorities matched. Ask one concise clarification."
                : "No matching priority was found.",
            candidates: resolved.candidates,
          },
        };
      }
      const next = clonePriorities(priorities);
      if (operation === "remove") {
        next.splice(resolved.fullIndex, 1);
        return { nextPriorities: next, meta: { removedId: resolved.item.id } };
      }
      if (operation === "edit") {
        const text = String(args.item?.text || args.text || "").trim();
        if (!text) return { error: { code: "VALIDATION_FAILED", message: "edit requires new wording." } };
        const dup = next.some(
          (p, idx) => idx !== resolved.fullIndex && p.text.toLowerCase() === text.toLowerCase(),
        );
        if (dup && args.allowDuplicates !== true) {
          return { error: { code: "DUPLICATE_TEXT", message: "A priority with that wording already exists." } };
        }
        next[resolved.fullIndex] = {
          ...next[resolved.fullIndex],
          text,
          updatedAt: isoNow(),
        };
        return { nextPriorities: next, meta: { touchedId: resolved.item.id } };
      }
      next[resolved.fullIndex] = {
        ...next[resolved.fullIndex],
        status: operation === "complete" ? "done" : "open",
        updatedAt: isoNow(),
      };
      return { nextPriorities: next, meta: { touchedId: resolved.item.id } };
    }

    if (operation === "reorder") {
      if (Array.isArray(args.order) && args.order.length) {
        const next = [];
        const used = new Set();
        for (const ref of args.order) {
          const resolved = resolvePriorityReference(priorities, ref, { ...resolveOpts, listScope: "all" });
          if (resolved.code) {
            return {
              error: {
                code: resolved.code,
                message: "Could not resolve reorder reference.",
                candidates: resolved.candidates,
              },
            };
          }
          if (used.has(resolved.item.id)) {
            return { error: { code: "VALIDATION_FAILED", message: "reorder order contains duplicates." } };
          }
          used.add(resolved.item.id);
          next.push({ ...resolved.item });
        }
        if (next.length !== priorities.length) {
          return { error: { code: "VALIDATION_FAILED", message: "full reorder must include every priority." } };
        }
        return { nextPriorities: next };
      }
      const resolved = resolvePriorityReference(priorities, args.reference || args.item, resolveOpts);
      if (resolved.code) {
        return {
          error: {
            code: resolved.code,
            message: "Could not resolve reorder target.",
            candidates: resolved.candidates,
          },
        };
      }
      const at = Number(args.atPosition);
      if (!Number.isInteger(at) || at < 1 || at > priorities.length) {
        return { error: { code: "VALIDATION_FAILED", message: "reorder requires a valid 1-based atPosition." } };
      }
      const next = clonePriorities(priorities);
      const [moved] = next.splice(resolved.fullIndex, 1);
      next.splice(at - 1, 0, moved);
      return { nextPriorities: next, meta: { touchedId: moved.id } };
    }

    if (operation === "replace") {
      const incoming = Array.isArray(args.items) ? args.items : [];
      const next = [];
      const seenText = new Set();
      for (const raw of incoming) {
        const byId =
          typeof raw?.id === "string" && raw.id
            ? priorities.find((item) => item.id === raw.id)
            : null;
        const byText = priorities.find(
          (item) => String(item.text || "").toLowerCase() === String(raw?.text || "").trim().toLowerCase(),
        );
        const existing = byId || byText || null;
        const item = normalizeIncomingItem(raw, randomUUID, isoNow, { existing });
        if (!item.text) return { error: { code: "VALIDATION_FAILED", message: "replace items require wording." } };
        if (seenText.has(item.text.toLowerCase()) && args.allowDuplicates !== true) {
          return { error: { code: "DUPLICATE_TEXT", message: "Replace list contains duplicate wording." } };
        }
        seenText.add(item.text.toLowerCase());
        next.push(item);
      }
      return { nextPriorities: next };
    }

    if (operation === "clear_completed") {
      return { nextPriorities: priorities.filter((item) => item.status !== "done") };
    }

    if (operation === "carry") {
      const targetDate =
        args.targetDate === "tomorrow" || !args.targetDate
          ? addDaysToDate(daily.date, 1)
          : String(args.targetDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return { error: { code: "VALIDATION_FAILED", message: "carry requires a valid targetDate." } };
      }
      if (targetDate === daily.date) {
        return {
          error: {
            code: "VALIDATION_FAILED",
            message: "carry targetDate must be a different day than the current daily date.",
          },
        };
      }
      let selected = [];
      if (Array.isArray(args.order) && args.order.length) {
        for (const ref of args.order) {
          const resolved = resolvePriorityReference(priorities, ref, resolveOpts);
          if (resolved.code) {
            return {
              error: {
                code: resolved.code,
                message: "Could not resolve carry reference.",
                candidates: resolved.candidates,
              },
            };
          }
          selected.push(resolved.item);
        }
      } else if (args.reference || args.item) {
        const resolved = resolvePriorityReference(priorities, args.reference || args.item, resolveOpts);
        if (resolved.code) {
          return {
            error: {
              code: resolved.code,
              message: "Could not resolve carry reference.",
              candidates: resolved.candidates,
            },
          };
        }
        selected = [resolved.item];
      } else {
        selected = priorities.filter((item) => item.status === "open" || item.status === "blocked");
      }
      selected = selected.filter((item) => item.status === "open" || item.status === "blocked");
      if (!selected.length) {
        return { error: { code: "NOT_FOUND", message: "No open priorities available to carry." } };
      }
      const move = args.move === true;
      const next = move
        ? priorities.filter((item) => !selected.some((sel) => sel.id === item.id))
        : clonePriorities(priorities);
      return {
        nextPriorities: next,
        meta: {
          targetDate,
          carryItems: selected.map((item) => ({ ...item })),
          move,
        },
      };
    }

    if (operation === "restore_backup") {
      return {
        nextPriorities: null,
        meta: { restore: true, backupId: args.backupId || null },
      };
    }

    return { error: { code: "UNSUPPORTED_OPERATION", message: `Unsupported operation: ${operation}` } };
  }

  async function applyPriorityOperation(args, daily, beforePriorities, startedAt, resolveOpts) {
    const operation = String(args.operation || "").trim().toLowerCase();

    // Compatibility: if insert is called with a preview token, apply the stored plan
    // exactly (or reject mismatched confirmation args). Never re-plan with a missing
    // atPosition that could silently insert at position 1.
    if (operation === "insert" && args.previewToken) {
      const preview = readPreview(args.previewToken, "insert", daily.updatedAt);
      if (preview.code) {
        return failPriorityResult(operation, "STALE_PREVIEW", "Priority preview is stale or invalid.", startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const conflict = confirmationConflictsWithPreview(args, preview.entry);
      if (conflict) {
        return failPriorityResult(operation, "STALE_PREVIEW", conflict, startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const nextDaily = { ...daily, priorities: clonePriorities(preview.entry.afterPriorities) };
      const result = await commitPriorityDaily(daily, nextDaily, operation, startedAt);
      if (result.ok) {
        const beforeIds = new Set(beforePriorities.map((item) => item.id));
        const inserted = result.priorities.find((item) => !beforeIds.has(item.id));
        recentPriorityId = inserted?.id || recentPriorityId;
      }
      return result;
    }

    if (DESTRUCTIVE_OPERATIONS.has(operation) && args.confirmed === true && args.previewToken) {
      const preview = readPreview(args.previewToken, operation, daily.updatedAt);
      if (preview.code) {
        return failPriorityResult(operation, "STALE_PREVIEW", "Priority preview is stale or invalid.", startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const conflict = confirmationConflictsWithPreview(args, preview.entry, { dailyDate: daily.date });
      if (conflict) {
        return failPriorityResult(operation, "STALE_PREVIEW", conflict, startedAt, {
          priorities: canonicalizePriorities(daily.priorities),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      if (operation === "restore_backup") {
        const backupFile = preview.entry.meta?.backupFile;
        if (!backupFile) {
          return failPriorityResult(operation, "RESTORE_FAILED", "Restore preview is missing its backup reference.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const full = path.join(paths.backups, backupFile);
        if (!(await pathExists(full))) {
          return failPriorityResult(operation, "RESTORE_FAILED", "Backup file is no longer available.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        let snapshot;
        try {
          snapshot = JSON.parse(await readText(full));
        } catch (error) {
          return failPriorityResult(
            operation,
            "RESTORE_FAILED",
            error instanceof Error ? error.message : "Backup could not be read.",
            startedAt,
          );
        }
        if (!snapshot || typeof snapshot !== "object" || !snapshot.daily || typeof snapshot.daily !== "object") {
          return failPriorityResult(operation, "RESTORE_FAILED", "Backup is missing a valid daily snapshot.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const restoredPriorities = (Array.isArray(snapshot.daily.priorities) ? snapshot.daily.priorities : []).map((item) =>
          normalizeWorkItem(item),
        );
        const validationError = validatePrioritiesArray(restoredPriorities);
        if (validationError) {
          return failPriorityResult(
            operation,
            "RESTORE_FAILED",
            `Backup priorities failed validation: ${validationError}`,
            startedAt,
            {
              priorities: canonicalizePriorities(daily.priorities),
              dailyUpdatedAt: daily.updatedAt,
            },
          );
        }
        if (
          JSON.stringify(canonicalizePriorities(restoredPriorities)) !==
          JSON.stringify(canonicalizePriorities(preview.entry.afterPriorities))
        ) {
          return failPriorityResult(operation, "STALE_PREVIEW", "Backup contents changed since preview.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const nextDaily = { ...daily, priorities: restoredPriorities };
        const result = await commitPriorityDaily(daily, nextDaily, operation, startedAt);
        if (result.ok) recentPriorityId = result.priorities[0]?.id || recentPriorityId;
        return result;
      }
      if (operation === "carry") {
        const meta = preview.entry.meta || {};
        if (meta.carryBindingVersion !== CARRY_PREVIEW_BINDING_VERSION) {
          return failPriorityResult(operation, "STALE_PREVIEW", "Carry preview binding is stale or invalid.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const targetDate = meta.targetDate;
        const carryItems = meta.carryItems || [];
        const tomorrowAfter = Array.isArray(meta.tomorrowAfter) ? meta.tomorrowAfter : null;
        if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate)) || targetDate === daily.date) {
          return failPriorityResult(operation, "VALIDATION_FAILED", "Carry preview has an invalid target date.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        if (!tomorrowAfter) {
          return failPriorityResult(operation, "STALE_PREVIEW", "Carry preview is missing tomorrow-after plan.", startedAt, {
            priorities: canonicalizePriorities(daily.priorities),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        await fsApi.mkdir(paths.future, { recursive: true });
        const futurePath = path.join(paths.future, `daily-${targetDate}.json`);
        let futureDaily = defaultDaily(targetDate);
        if (await pathExists(futurePath)) {
          futureDaily = await readJsonFile(futurePath, (raw) => normalizeDaily(raw, targetDate), () => defaultDaily(targetDate));
        }
        const nextFuturePriorities = clonePriorities(tomorrowAfter).map((item) => ({
          ...item,
          updatedAt: isoNow(),
        }));
        futureDaily = {
          ...futureDaily,
          priorities: nextFuturePriorities,
          updatedAt: isoNow(),
        };
        try {
          await createBackupSnapshot(`priorities-carry-future-${targetDate}`);
          await atomicWriteJson(futurePath, futureDaily);
        } catch (error) {
          return failPriorityResult(
            operation,
            "WRITE_FAILED",
            error instanceof Error ? error.message : "Failed to write carry target.",
            startedAt,
          );
        }
        const nextDaily = { ...daily, priorities: clonePriorities(preview.entry.afterPriorities) };
        const result = await commitPriorityDaily(daily, nextDaily, operation, startedAt);
        if (result.ok) {
          const verb = meta.move === true ? "Moved" : "Copied";
          result.message = `${verb} ${carryItems.length} open priorit${carryItems.length === 1 ? "y" : "ies"} to ${targetDate}.`;
          result.confirmation = result.message;
          result.targetDate = targetDate;
          result.mode = meta.move === true ? "move" : "copy";
          result.move = meta.move === true;
        }
        return result;
      }

      // Destructive confirm: apply the exact stored preview plan; do not re-plan from confirm args.
      const nextDaily = { ...daily, priorities: clonePriorities(preview.entry.afterPriorities) };
      const result = await commitPriorityDaily(daily, nextDaily, operation, startedAt);
      if (result.ok && preview.entry.meta?.touchedId) recentPriorityId = preview.entry.meta.touchedId;
      if (result.ok && preview.entry.meta?.removedId) {
        recentPriorityId = result.priorities[0]?.id || null;
      }
      return result;
    }

    const planned = planPriorityMutation(args, daily, resolveOpts);
    if (planned.error) {
      return failPriorityResult(operation, planned.error.code, planned.error.message, startedAt, {
        candidates: planned.error.candidates,
        priorities: canonicalizePriorities(daily.priorities),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatPrioritiesArtifact(daily.priorities),
      });
    }

    if (operation === "carry") {
      // Non-confirm path should not write; confirmation branch handles it.
      return failPriorityResult(operation, "CONFIRMATION_REQUIRED", "Confirmation required before carry.", startedAt);
    }

    const nextDaily = { ...daily, priorities: planned.nextPriorities };
    const result = await commitPriorityDaily(daily, nextDaily, operation, startedAt);
    if (result.ok) {
      if (planned.meta?.touchedId) recentPriorityId = planned.meta.touchedId;
      else if (operation === "add" || operation === "insert") {
        recentPriorityId = result.priorities[result.priorities.length - 1]?.id || recentPriorityId;
      }
    }
    return result;
  }

  function fingerprintWcFailedArgs(args = {}, code = "NOT_FOUND") {
    const operation = String(args.operation || "").trim().toLowerCase();
    const scope = normalizeScope(args.scope);
    const rawRef = args.reference != null ? args.reference : args.item;
    const normalizedRef = normalizeWcReference(rawRef);
    return JSON.stringify({
      tool: "working_context_items",
      operation,
      scope,
      reference: normalizedRef,
      atPosition: args.atPosition ?? null,
      order: args.order ?? null,
      destinationScope: args.destinationScope ?? null,
      listScope: resolveWcListScope(operation, args),
      code: String(code || "NOT_FOUND"),
    });
  }

  function applyWcFailedRetryPolicy(args, result) {
    if (!result || (result.code !== "NOT_FOUND" && result.code !== "AMBIGUOUS_MATCH")) return result;
    const fp = fingerprintWcFailedArgs(args, result.code);
    if (wcNotFoundFingerprints.has(fp)) {
      const message =
        result.code === "AMBIGUOUS_MATCH"
          ? "Multiple items matched. This identical request already failed; do not retry it with the same arguments. Ask one concise clarification."
          : "No matching item was found. This identical request already failed; do not retry it with the same arguments. Report once or ask one concise clarification.";
      return {
        ...result,
        suppressedRetry: true,
        message,
        error: message,
      };
    }
    wcNotFoundFingerprints.add(fp);
    return result;
  }

  function successWcResult(options) {
    const { operation, scope, items, dailyUpdatedAt, message, backupId, startedAt, extra } = options;
    logWorkingContextEvent({
      scope,
      operation,
      ok: true,
      itemCount: items.length,
      backupId,
      durationMs: Date.now() - startedAt,
    });
    const today = extra?.today || todayDate();
    return {
      ok: true,
      message,
      operation,
      scope,
      items: canonicalizeItems(items, today),
      dailyUpdatedAt,
      backupId,
      artifact: formatListArtifact(scope, items, today),
      confirmation: message,
      ...extra,
    };
  }

  function failWcResult(operation, code, message, startedAt, extra = {}) {
    logWorkingContextEvent({
      scope: extra.scope,
      operation,
      ok: false,
      code,
      itemCount: extra.items ? extra.items.length : undefined,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      code,
      error: message,
      message,
      operation,
      ...extra,
    };
  }

  async function commitWorkingContextDaily(beforeDaily, nextDaily, operation, scope, startedAt, allowedKeys) {
    const unchanged = assertUnrelatedUnchanged(beforeDaily, nextDaily, { allowedKeys });
    if (unchanged) {
      return failWcResult(operation, "VALIDATION_FAILED", unchanged, startedAt, {
        scope,
        items: canonicalizeItems(getListForScope(beforeDaily, scope), beforeDaily.date),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }
    const shapeError = validateDailyShape(nextDaily);
    if (shapeError) {
      return failWcResult(operation, "VALIDATION_FAILED", shapeError, startedAt, {
        scope,
        items: canonicalizeItems(getListForScope(beforeDaily, scope), beforeDaily.date),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }
    const wcError = validateWorkingContextDaily(nextDaily);
    if (wcError) {
      return failWcResult(operation, "VALIDATION_FAILED", wcError, startedAt, {
        scope,
        items: canonicalizeItems(getListForScope(beforeDaily, scope), beforeDaily.date),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }

    let backupId = null;
    try {
      const snapshot = await createBackupSnapshot(`working-context-${operation}`);
      backupId = snapshot.createdAt;
    } catch (error) {
      return failWcResult(
        operation,
        "BACKUP_FAILED",
        error instanceof Error ? error.message : "Backup creation failed.",
        startedAt,
        {
          scope,
          items: canonicalizeItems(getListForScope(beforeDaily, scope), beforeDaily.date),
          dailyUpdatedAt: beforeDaily.updatedAt,
        },
      );
    }

    nextDaily.updatedAt = isoNow();
    try {
      if (typeof options.failAtomicWrite === "function" && options.failAtomicWrite()) {
        throw new Error("Simulated atomic write failure.");
      }
      await atomicWriteJson(paths.daily, nextDaily);
    } catch (error) {
      return failWcResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Atomic write failed.",
        startedAt,
        {
          scope,
          items: canonicalizeItems(getListForScope(beforeDaily, scope), beforeDaily.date),
          dailyUpdatedAt: beforeDaily.updatedAt,
          backupId,
        },
      );
    }

    let reread;
    try {
      if (typeof options.failReread === "function" && options.failReread()) {
        throw new Error("Simulated reread failure.");
      }
      reread = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
    } catch (error) {
      return failWcResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Reread failed after write.",
        startedAt,
        {
          scope,
          items: canonicalizeItems(getListForScope(nextDaily, scope), nextDaily.date),
          dailyUpdatedAt: nextDaily.updatedAt,
          backupId,
        },
      );
    }

    invalidatePreviews();
    wcNotFoundFingerprints.clear();

    return successWcResult({
      operation,
      scope,
      items: getListForScope(reread, scope),
      dailyUpdatedAt: reread.updatedAt,
      message: `${scopeTitle(scope)} ${operation.replace(/_/g, " ")} completed.`,
      backupId,
      startedAt,
      extra: { daily: reread, today: reread.date },
    });
  }

  function storeWcPreview(operation, scope, beforeList, afterList, dailyUpdatedAt, meta = {}) {
    const token = createPreviewToken();
    const payload = { operation, scope, beforeList, afterList, dailyUpdatedAt, meta };
    previewStore.set(token, {
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      operation,
      hash: hashPreviewPayload(payload),
      beforePriorities: [],
      afterPriorities: [],
      beforeList: cloneItems(beforeList),
      afterList: cloneItems(afterList),
      afterDaily: meta.afterDaily || null,
      dailyUpdatedAt,
      meta: { ...meta, scope, kind: "working_context" },
    });
    return token;
  }

  function readWcPreview(token, operation, dailyUpdatedAt, scope) {
    const entry = previewStore.get(String(token || ""));
    if (!entry) return { code: "STALE_PREVIEW" };
    if (Date.now() > entry.expiresAt) {
      previewStore.delete(token);
      return { code: "STALE_PREVIEW" };
    }
    if (entry.operation !== operation) return { code: "STALE_PREVIEW" };
    if (entry.dailyUpdatedAt !== dailyUpdatedAt) return { code: "STALE_PREVIEW" };
    if (entry.meta?.kind !== "working_context") return { code: "STALE_PREVIEW" };
    if (normalizeScope(entry.meta?.scope) !== normalizeScope(scope)) return { code: "STALE_PREVIEW" };
    return { entry };
  }

  function buildWcPreviewRequestBinding(args = {}) {
    const items = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
    return {
      scope: normalizeScope(args.scope),
      destinationScope: args.destinationScope != null ? normalizeScope(args.destinationScope) : null,
      atPosition: args.atPosition != null && args.atPosition !== "" ? Number(args.atPosition) : null,
      backupId: args.backupId != null && args.backupId !== "" ? String(args.backupId) : null,
      reference: args.reference != null ? args.reference : null,
      order: Array.isArray(args.order) ? args.order : null,
      dueDate: args.dueDate != null ? String(args.dueDate) : args.due != null ? String(args.due) : null,
      deferredUntil: args.deferredUntil != null ? String(args.deferredUntil) : null,
      itemTexts: items.map((raw) => String(raw?.text || raw?.name || "").trim()).filter(Boolean),
    };
  }

  async function loadValidatedBackupScope(backupId, scope) {
    const key = scopeKey(scope);
    const files = await listBackupFiles();
    let file = null;
    if (backupId) {
      file = files.find(
        (item) =>
          item.name.includes(String(backupId)) ||
          item.name === backupId ||
          item.full.endsWith(String(backupId)),
      );
    } else {
      file = files[0];
    }
    if (!file) {
      return { error: { code: "RESTORE_FAILED", message: "No backup was found to restore." } };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readText(file.full));
    } catch (error) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: error instanceof Error ? error.message : "Backup could not be read.",
        },
      };
    }
    if (!snapshot || typeof snapshot !== "object" || !snapshot.daily || typeof snapshot.daily !== "object") {
      return { error: { code: "RESTORE_FAILED", message: "Backup is missing a valid daily snapshot." } };
    }
    const restored = (Array.isArray(snapshot.daily[key]) ? snapshot.daily[key] : []).map((item) =>
      mapWorkingContextItem(item),
    );
    const { validateWorkingContextArray } = require("./working-context-lifecycle.cjs");
    const arrErr = validateWorkingContextArray(restored, scope);
    if (arrErr) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: `Backup ${scope} failed validation: ${arrErr}`,
        },
      };
    }
    return { file, restored };
  }

  async function workingContextItems(args = {}) {
    const startedAt = Date.now();
    const operation = String(args.operation || "").trim().toLowerCase();
    if (!operation) {
      return failWcResult("unknown", "UNSUPPORTED_OPERATION", "operation is required.", startedAt);
    }

    return enqueue(async () => {
      const result = await runWorkingContextOperation(args, operation, startedAt);
      return applyWcFailedRetryPolicy(args, result);
    });
  }

  async function runWorkingContextOperation(args, operation, startedAt) {
    await ensureMemoryUnlocked();
    await rolloverDailyIfNeeded();
    const daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
    const scope = normalizeScope(args.scope);
    if (!scope && operation !== "preview") {
      return failWcResult(operation, "INVALID_SCOPE", "scope must be commitments, follow_ups, or unresolved_items.", startedAt);
    }

    if (args.expectedUpdatedAt && args.expectedUpdatedAt !== daily.updatedAt) {
      return failWcResult(operation, "STALE_WRITE", "Daily context changed since the last read.", startedAt, {
        scope,
        items: canonicalizeItems(getListForScope(daily, scope || "commitments"), daily.date),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatListArtifact(scope || "commitments", getListForScope(daily, scope || "commitments"), daily.date),
      });
    }

    const helpers = {
      randomUUID,
      nowIso: isoNow,
      recentIds: recentWcIds,
    };

    if (operation === "list") {
      const planned = planWorkingContextMutation(args, daily, helpers);
      if (planned.error) {
        return failWcResult(operation, planned.error.code, planned.error.message, startedAt, {
          scope,
          candidates: planned.error.candidates,
          items: canonicalizeItems(getListForScope(daily, scope), daily.date),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      logWorkingContextEvent({
        scope,
        operation,
        ok: true,
        itemCount: planned.listed.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        operation,
        scope,
        message: `Current ${scopeTitle(scope).toLowerCase()}.`,
        items: canonicalizeItems(planned.listed, daily.date),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatListArtifact(scope, planned.listed, daily.date),
        confirmation: `Listed ${scopeTitle(scope).toLowerCase()}.`,
        filter: resolveWcListScope(operation, args),
      };
    }

    if (operation === "preview") {
      const nestedOp = String(args.previewOperation || args.targetOperation || "").trim().toLowerCase();
      if (!nestedOp) {
        return failWcResult(operation, "UNSUPPORTED_OPERATION", "preview requires previewOperation.", startedAt, {
          scope,
        });
      }
      return workingContextPreviewPlan(
        { ...args, operation: nestedOp, confirmed: false, _previewOnly: true },
        daily,
        startedAt,
        helpers,
      );
    }

    const plannedForGate = planWorkingContextMutation(args, daily, helpers);
    const needsConfirm =
      DESTRUCTIVE_WC_OPERATIONS.has(operation) ||
      (operation === "promote_to_priority" && plannedForGate.meta?.bulk === true);

    if (plannedForGate.error && !needsConfirm) {
      return failWcResult(operation, plannedForGate.error.code, plannedForGate.error.message, startedAt, {
        scope,
        candidates: plannedForGate.error.candidates,
        items: canonicalizeItems(getListForScope(daily, scope), daily.date),
        dailyUpdatedAt: daily.updatedAt,
      });
    }

    if (needsConfirm) {
      if (args.confirmed !== true || !args.previewToken) {
        const planned = await workingContextPreviewPlan(
          { ...args, _previewOnly: true },
          daily,
          startedAt,
          helpers,
        );
        if (planned.ok === false && planned.code !== "CONFIRMATION_REQUIRED") return planned;
        return {
          ok: false,
          code: "CONFIRMATION_REQUIRED",
          requiresConfirmation: true,
          message: planned.message || `Confirmation required before ${operation.replace(/_/g, " ")}.`,
          operation,
          scope,
          previewToken: planned.previewToken,
          before: planned.before,
          after: planned.after,
          items: canonicalizeItems(getListForScope(daily, scope), daily.date),
          dailyUpdatedAt: daily.updatedAt,
          artifact: planned.artifact,
          destinationScope: planned.destinationScope,
          selected: planned.selected,
        };
      }

      if (args.confirmed === true && args.previewToken) {
        const preview = readWcPreview(args.previewToken, operation, daily.updatedAt, scope);
        if (preview.code) {
          return failWcResult(operation, "STALE_PREVIEW", "Working-context preview is stale or invalid.", startedAt, {
            scope,
            items: canonicalizeItems(getListForScope(daily, scope), daily.date),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const conflict = confirmationConflictsWithWcPreview(args, preview.entry);
        if (conflict) {
          return failWcResult(operation, "STALE_PREVIEW", conflict, startedAt, {
            scope,
            items: canonicalizeItems(getListForScope(daily, scope), daily.date),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const afterDaily = preview.entry.afterDaily || preview.entry.meta?.afterDaily;
        if (!afterDaily) {
          return failWcResult(operation, "STALE_PREVIEW", "Preview is missing a stored plan.", startedAt, {
            scope,
            items: canonicalizeItems(getListForScope(daily, scope), daily.date),
            dailyUpdatedAt: daily.updatedAt,
          });
        }
        const allowedKeys = preview.entry.meta?.allowedKeys || [scopeKey(scope)];
        const result = await commitWorkingContextDaily(
          daily,
          afterDaily,
          operation,
          scope,
          startedAt,
          allowedKeys,
        );
        if (result.ok) {
          if (preview.entry.meta?.touchedIds?.[0]) {
            recentWcIds[scope] = preview.entry.meta.touchedIds[0];
          }
          if (operation === "promote_to_priority" && preview.entry.meta?.promoted?.[0]?.priority?.id) {
            recentPriorityId = preview.entry.meta.promoted[0].priority.id;
            result.priorities = canonicalizePriorities(afterDaily.priorities || []);
            result.linked = preview.entry.meta.promoted.map((row) => ({
              sourceId: row.source.id,
              priorityId: row.priority.id,
            }));
          }
          if (operation === "convert") {
            const destinationScope =
              preview.entry.meta?.destinationScope || preview.entry.destinationScope || null;
            if (destinationScope) {
              result.destinationScope = destinationScope;
              result.destinationItems = canonicalizeItems(
                getListForScope(result.daily || afterDaily, destinationScope),
                daily.date,
              );
            }
          }
        }
        return result;
      }
    }

    return applyWorkingContextOperation(args, daily, startedAt, helpers);
  }

  function confirmationConflictsWithWcPreview(args, entry) {
    const bound = entry?.meta?.request;
    if (!bound) return null;
    if (normalizeScope(args.scope) !== normalizeScope(bound.scope)) {
      return "Confirmation scope does not match the preview.";
    }
    if (args.destinationScope != null && bound.destinationScope != null) {
      if (normalizeScope(args.destinationScope) !== normalizeScope(bound.destinationScope)) {
        return "Confirmation destinationScope does not match the preview.";
      }
    }
    if (args.dueDate != null && bound.dueDate != null && String(args.dueDate) !== String(bound.dueDate)) {
      return "Confirmation dueDate does not match the preview.";
    }
    if (
      args.deferredUntil != null &&
      bound.deferredUntil != null &&
      String(args.deferredUntil) !== String(bound.deferredUntil)
    ) {
      return "Confirmation deferredUntil does not match the preview.";
    }
    if (args.backupId != null && args.backupId !== "" && bound.backupId != null) {
      if (String(args.backupId) !== String(bound.backupId)) {
        return "Confirmation backupId does not match the preview.";
      }
    }
    if (args.reference != null && bound.reference != null) {
      if (JSON.stringify(args.reference) !== JSON.stringify(bound.reference)) {
        return "Confirmation reference does not match the preview.";
      }
    }
    if (Array.isArray(args.order) && Array.isArray(bound.order)) {
      if (JSON.stringify(args.order) !== JSON.stringify(bound.order)) {
        return "Confirmation order does not match the preview.";
      }
    }
    if (Array.isArray(bound.itemTexts) && bound.itemTexts.length) {
      const items = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
      const confirmTexts = items.map((raw) => String(raw?.text || raw?.name || "").trim()).filter(Boolean);
      if (JSON.stringify(confirmTexts) !== JSON.stringify(bound.itemTexts)) {
        return "Confirmation items do not match the preview.";
      }
    }
    if (entry.meta?.conversion && args.destinationScope != null) {
      const expected = `${normalizeScope(args.scope)}->${normalizeScope(args.destinationScope)}`;
      if (String(entry.meta.conversion) !== expected) {
        return "Confirmation conversion does not match the preview.";
      }
    }
    return null;
  }

  async function workingContextPreviewPlan(args, daily, startedAt, helpers) {
    const operation = String(args.operation || "").trim().toLowerCase();
    const scope = normalizeScope(args.scope);
    if (!scope) {
      return failWcResult(operation, "INVALID_SCOPE", "scope must be commitments, follow_ups, or unresolved_items.", startedAt);
    }

    if (operation === "restore_backup") {
      const loaded = await loadValidatedBackupScope(args.backupId, scope);
      if (loaded.error) {
        return failWcResult(operation, loaded.error.code, loaded.error.message, startedAt, {
          scope,
          items: canonicalizeItems(getListForScope(daily, scope), daily.date),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const beforeList = cloneItems(getListForScope(daily, scope));
      const afterList = loaded.restored;
      const afterDaily = setListForScope(daily, scope, afterList);
      const request = buildWcPreviewRequestBinding(args);
      const token = storeWcPreview(operation, scope, beforeList, afterList, daily.updatedAt, {
        allowedKeys: [scopeKey(scope)],
        afterDaily,
        backupFile: loaded.file.name,
        request,
      });
      return {
        ok: true,
        operation: "preview",
        previewOperation: operation,
        scope,
        message: `Preview ready for restore of ${scopeTitle(scope).toLowerCase()} from ${loaded.file.name}. Confirm to apply.`,
        previewToken: token,
        before: canonicalizeItems(beforeList, daily.date),
        after: canonicalizeItems(afterList, daily.date),
        items: canonicalizeItems(beforeList, daily.date),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatPreviewArtifact({
          scope,
          operation,
          before: beforeList,
          after: afterList,
          today: daily.date,
        }),
        requiresConfirmation: true,
      };
    }

    const planned = planWorkingContextMutation(args, daily, helpers);
    if (planned.error) {
      return failWcResult(operation, planned.error.code, planned.error.message, startedAt, {
        scope,
        candidates: planned.error.candidates,
        items: canonicalizeItems(getListForScope(daily, scope), daily.date),
        dailyUpdatedAt: daily.updatedAt,
      });
    }

    const beforeList = planned.beforeList || cloneItems(getListForScope(daily, scope));
    const afterList = planned.afterList || cloneItems(getListForScope(planned.nextDaily, scope));
    const request = buildWcPreviewRequestBinding(args);
    const token = storeWcPreview(operation, scope, beforeList, afterList, daily.updatedAt, {
      ...planned.meta,
      afterDaily: planned.nextDaily,
      destinationScope: planned.destinationScope,
      request,
    });
    const destructive = requiresConfirmation(operation, planned);
    return {
      ok: true,
      operation: args._previewOnly ? operation : "preview",
      previewOperation: operation,
      scope,
      destinationScope: planned.destinationScope,
      message: destructive
        ? `Preview ready for ${operation.replace(/_/g, " ")}. Confirm to apply.`
        : `Dry-run only for ${operation.replace(/_/g, " ")}.`,
      previewToken: token,
      before: canonicalizeItems(beforeList, daily.date),
      after: canonicalizeItems(afterList, daily.date),
      selected: (planned.meta?.selected || []).map((item) => ({
        id: item.id,
        text: item.text,
        status: item.status,
      })),
      items: canonicalizeItems(beforeList, daily.date),
      dailyUpdatedAt: daily.updatedAt,
      artifact: formatPreviewArtifact({
        scope,
        operation,
        before: beforeList,
        after: afterList,
        destinationScope: planned.destinationScope,
        selected: planned.meta?.selected,
        today: daily.date,
      }),
      requiresConfirmation: destructive,
    };
  }

  async function applyWorkingContextOperation(args, daily, startedAt, helpers) {
    const operation = String(args.operation || "").trim().toLowerCase();
    const scope = normalizeScope(args.scope);

    const planned = planWorkingContextMutation(args, daily, helpers);
    if (planned.error) {
      return failWcResult(operation, planned.error.code, planned.error.message, startedAt, {
        scope,
        candidates: planned.error.candidates,
        items: canonicalizeItems(getListForScope(daily, scope), daily.date),
        dailyUpdatedAt: daily.updatedAt,
      });
    }

    if (planned.meta?.noop) {
      return successWcResult({
        operation,
        scope,
        items: getListForScope(daily, scope),
        dailyUpdatedAt: daily.updatedAt,
        message: `${scopeTitle(scope)} already ${operation === "complete" ? "completed" : "updated"}.`,
        backupId: null,
        startedAt,
        extra: { today: daily.date, noop: true },
      });
    }

    if (planned.meta?.restore) {
      return failWcResult(operation, "CONFIRMATION_REQUIRED", "Confirmation required before restore.", startedAt, {
        scope,
      });
    }

    const result = await commitWorkingContextDaily(
      daily,
      planned.nextDaily,
      operation,
      scope,
      startedAt,
      planned.meta?.allowedKeys || [scopeKey(scope)],
    );
    if (result.ok) {
      if (planned.meta?.touchedIds?.[0]) recentWcIds[scope] = planned.meta.touchedIds[0];
      else if (operation === "add" || operation === "insert") {
        const items = result.items || [];
        recentWcIds[scope] = items[items.length - 1]?.id || recentWcIds[scope];
      }
      if (operation === "promote_to_priority" && planned.meta?.promoted?.[0]?.priority?.id) {
        recentPriorityId = planned.meta.promoted[0].priority.id;
        result.priorities = canonicalizePriorities(planned.nextDaily.priorities);
        result.linked = planned.meta.promoted.map((row) => ({
          sourceId: row.source.id,
          priorityId: row.priority.id,
        }));
      }
      if (operation === "convert" && planned.destinationScope) {
        result.destinationScope = planned.destinationScope;
        result.destinationItems = canonicalizeItems(
          getListForScope(result.daily || planned.nextDaily, planned.destinationScope),
          daily.date,
        );
      }
    }
    return result;
  }

  function successActiveProjectsResult(options) {
    const { operation, projects, dailyUpdatedAt, message, backupId, startedAt, extra } = options;
    logActiveProjectsEvent({
      operation,
      ok: true,
      itemCount: projects.length,
      backupId,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true,
      message,
      operation,
      projects: canonicalizeProjects(projects),
      dailyUpdatedAt,
      backupId,
      artifact: formatActiveProjectsArtifact(projects),
      confirmation: message,
      ...extra,
    };
  }

  function failActiveProjectsResult(operation, code, message, startedAt, extra = {}) {
    logActiveProjectsEvent({
      operation,
      ok: false,
      code,
      itemCount: extra.projects ? extra.projects.length : undefined,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      code,
      error: message,
      message,
      operation,
      ...extra,
    };
  }

  function updateRecentActiveProjectId(operation, meta, nextProjects) {
    const mode = meta?.recentMode;
    if (mode === "last_new" || mode === "touched") {
      const ids = meta.touchedIds || [];
      if (ids.length) recentActiveProjectId = ids[ids.length - 1];
      return;
    }
    if (mode === "remove") {
      if (meta.removedId && recentActiveProjectId === meta.removedId) recentActiveProjectId = null;
      return;
    }
    if (mode === "replace") {
      recentActiveProjectId = nextProjects?.[0]?.id || null;
    }
  }

  async function commitActiveProjectsDaily(beforeDaily, nextDaily, operation, startedAt, allowedKeys) {
    const unchanged = assertUnrelatedUnchanged(beforeDaily, nextDaily, {
      allowedKeys: allowedKeys || ["activeProjects"],
    });
    if (unchanged) {
      return failActiveProjectsResult(operation, "VALIDATION_FAILED", unchanged, startedAt, {
        projects: canonicalizeProjects(beforeDaily.activeProjects || []),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }
    const shapeError = validateDailyShape(nextDaily);
    if (shapeError) {
      return failActiveProjectsResult(operation, "VALIDATION_FAILED", shapeError, startedAt, {
        projects: canonicalizeProjects(beforeDaily.activeProjects || []),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }
    const projectsError = validateActiveProjectsArray(nextDaily.activeProjects || []);
    if (projectsError) {
      return failActiveProjectsResult(operation, "VALIDATION_FAILED", projectsError, startedAt, {
        projects: canonicalizeProjects(beforeDaily.activeProjects || []),
        dailyUpdatedAt: beforeDaily.updatedAt,
      });
    }

    let backupId = null;
    try {
      const snapshot = await createBackupSnapshot(`active-projects-${operation}`);
      backupId = snapshot.createdAt;
    } catch (error) {
      return failActiveProjectsResult(
        operation,
        "BACKUP_FAILED",
        error instanceof Error ? error.message : "Backup creation failed.",
        startedAt,
        {
          projects: canonicalizeProjects(beforeDaily.activeProjects || []),
          dailyUpdatedAt: beforeDaily.updatedAt,
        },
      );
    }

    nextDaily.updatedAt = isoNow();
    try {
      if (typeof options.failAtomicWrite === "function" && options.failAtomicWrite()) {
        throw new Error("Simulated atomic write failure.");
      }
      await atomicWriteJson(paths.daily, nextDaily);
    } catch (error) {
      return failActiveProjectsResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Atomic write failed.",
        startedAt,
        {
          projects: canonicalizeProjects(beforeDaily.activeProjects || []),
          dailyUpdatedAt: beforeDaily.updatedAt,
          backupId,
        },
      );
    }

    let reread;
    try {
      if (typeof options.failReread === "function" && options.failReread()) {
        throw new Error("Simulated reread failure.");
      }
      reread = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
    } catch (error) {
      return failActiveProjectsResult(
        operation,
        "WRITE_FAILED",
        error instanceof Error ? error.message : "Reread failed after write.",
        startedAt,
        {
          projects: canonicalizeProjects(nextDaily.activeProjects || []),
          dailyUpdatedAt: nextDaily.updatedAt,
          backupId,
        },
      );
    }

    invalidatePreviews();
    return successActiveProjectsResult({
      operation,
      projects: reread.activeProjects || [],
      dailyUpdatedAt: reread.updatedAt,
      message: `Active projects ${operation.replace(/_/g, " ")} completed.`,
      backupId,
      startedAt,
      extra: { daily: reread },
    });
  }

  function storeActiveProjectsPreview(operation, beforeList, afterList, dailyUpdatedAt, meta = {}) {
    const token = createPreviewToken();
    const payload = { operation, beforeList, afterList, dailyUpdatedAt, meta };
    previewStore.set(token, {
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      operation,
      hash: hashPreviewPayload(payload),
      beforePriorities: [],
      afterPriorities: [],
      beforeList: cloneProjects(beforeList),
      afterList: cloneProjects(afterList),
      afterDaily: meta.afterDaily || null,
      dailyUpdatedAt,
      meta: { ...meta, kind: "active_projects" },
    });
    return token;
  }

  function readActiveProjectsPreview(token, operation, dailyUpdatedAt) {
    const entry = previewStore.get(String(token || ""));
    if (!entry) return { code: "STALE_PREVIEW" };
    if (Date.now() > entry.expiresAt) {
      previewStore.delete(token);
      return { code: "STALE_PREVIEW" };
    }
    if (entry.operation !== operation) return { code: "STALE_PREVIEW" };
    if (entry.dailyUpdatedAt !== dailyUpdatedAt) return { code: "STALE_PREVIEW" };
    if (entry.meta?.kind !== "active_projects") return { code: "STALE_PREVIEW" };
    return { entry };
  }

  function buildActiveProjectsPreviewRequestBinding(args = {}) {
    const items = Array.isArray(args.items) ? args.items : args.item ? [args.item] : [];
    return {
      atPosition: args.atPosition != null && args.atPosition !== "" ? Number(args.atPosition) : null,
      backupId: args.backupId != null && args.backupId !== "" ? String(args.backupId) : null,
      reference: args.reference != null ? normalizeActiveProjectReference(args.reference) : null,
      order: Array.isArray(args.order)
        ? args.order.map((ref) => normalizeActiveProjectReference(ref))
        : null,
      itemNames: items
        .map((raw) => String(raw?.name != null ? raw.name : raw?.text != null ? raw.text : "").trim())
        .filter(Boolean),
    };
  }

  function confirmationConflictsWithActiveProjectsPreview(args, entry) {
    const bound = entry?.meta?.request;
    if (!bound) return null;
    if (args.backupId != null && args.backupId !== "" && bound.backupId != null) {
      if (String(args.backupId) !== String(bound.backupId)) {
        return "Confirmation backupId does not match the preview.";
      }
    }
    if (args.reference != null && bound.reference != null) {
      const nextRef = normalizeActiveProjectReference(args.reference);
      if (JSON.stringify(nextRef) !== JSON.stringify(bound.reference)) {
        return "Confirmation reference does not match the preview.";
      }
    }
    if (Array.isArray(args.items) && bound.itemNames) {
      const names = args.items
        .map((raw) => String(raw?.name != null ? raw.name : raw?.text != null ? raw.text : "").trim())
        .filter(Boolean);
      if (JSON.stringify(names) !== JSON.stringify(bound.itemNames)) {
        return "Confirmation items do not match the preview.";
      }
    }
    return null;
  }

  async function loadValidatedBackupActiveProjects(backupId) {
    const files = await listBackupFiles();
    let file = null;
    if (backupId) {
      file = files.find(
        (item) =>
          item.name.includes(String(backupId)) ||
          item.name === backupId ||
          item.full.endsWith(String(backupId)),
      );
    } else {
      file = files[0];
    }
    if (!file) {
      return { error: { code: "RESTORE_FAILED", message: "No backup was found to restore." } };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readText(file.full));
    } catch (error) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: error instanceof Error ? error.message : "Backup could not be read.",
        },
      };
    }
    if (!snapshot || typeof snapshot !== "object" || !snapshot.daily || typeof snapshot.daily !== "object") {
      return { error: { code: "RESTORE_FAILED", message: "Backup is missing a valid daily snapshot." } };
    }
    const restored = (Array.isArray(snapshot.daily.activeProjects) ? snapshot.daily.activeProjects : []).map(
      (item) => {
        const project = normalizeWorkItem({ ...item, text: item.name || item.text });
        return {
          id: project.id,
          name: String(item.name || item.text || "Untitled project"),
          note: String(item.note || ""),
          updatedAt: project.updatedAt,
        };
      },
    );
    const validationError = validateActiveProjectsArray(restored);
    if (validationError) {
      return {
        error: {
          code: "RESTORE_FAILED",
          message: `Backup active projects failed validation: ${validationError}`,
        },
      };
    }
    return { file, restored };
  }

  async function activeProjectsPreviewPlan(args, daily, startedAt, helpers) {
    const operation = String(args.operation || "").trim().toLowerCase();
    const beforeList = cloneProjects(daily.activeProjects || []);

    if (operation === "restore_backup") {
      const loaded = await loadValidatedBackupActiveProjects(args.backupId);
      if (loaded.error) {
        return failActiveProjectsResult(operation, loaded.error.code, loaded.error.message, startedAt, {
          projects: canonicalizeProjects(beforeList),
          dailyUpdatedAt: daily.updatedAt,
        });
      }
      const afterList = loaded.restored;
      const afterDaily = {
        ...daily,
        activeProjects: cloneProjects(afterList),
      };
      const token = storeActiveProjectsPreview(operation, beforeList, afterList, daily.updatedAt, {
        backupFile: loaded.file.name,
        backupId: args.backupId || null,
        afterDaily,
        allowedKeys: ["activeProjects"],
        recentMode: "replace",
        request: buildActiveProjectsPreviewRequestBinding(args),
      });
      return {
        ok: true,
        operation: "preview",
        previewOperation: operation,
        message: `Preview ready for restore from ${loaded.file.name}. Confirm to apply.`,
        previewToken: token,
        before: canonicalizeProjects(beforeList),
        after: canonicalizeProjects(afterList),
        projects: canonicalizeProjects(beforeList),
        dailyUpdatedAt: daily.updatedAt,
        artifact: formatActiveProjectsArtifact(afterList),
        requiresConfirmation: true,
      };
    }

    const planned = planActiveProjectsMutation(args, daily, helpers);
    if (planned.error) {
      return failActiveProjectsResult(operation, planned.error.code, planned.error.message, startedAt, {
        candidates: planned.error.candidates,
        projects: canonicalizeProjects(beforeList),
        dailyUpdatedAt: daily.updatedAt,
      });
    }

    const afterList = cloneProjects(planned.nextDaily.activeProjects || []);
    const requiresConfirm = DESTRUCTIVE_ACTIVE_PROJECT_OPERATIONS.has(operation);
    const token = requiresConfirm
      ? storeActiveProjectsPreview(operation, beforeList, afterList, daily.updatedAt, {
          afterDaily: planned.nextDaily,
          allowedKeys: planned.meta?.allowedKeys || ["activeProjects"],
          recentMode: planned.meta?.recentMode,
          touchedIds: planned.meta?.touchedIds,
          removedId: planned.meta?.removedId,
          request: buildActiveProjectsPreviewRequestBinding(args),
        })
      : null;

    return {
      ok: true,
      operation: "preview",
      previewOperation: operation,
      message: requiresConfirm
        ? `Preview ready for ${operation.replace(/_/g, " ")}. Confirm to apply.`
        : `Dry-run only for ${operation.replace(/_/g, " ")}. Execute ${operation} directly to apply.`,
      previewToken: token,
      before: canonicalizeProjects(beforeList),
      after: canonicalizeProjects(afterList),
      projects: canonicalizeProjects(beforeList),
      dailyUpdatedAt: daily.updatedAt,
      artifact: formatActiveProjectsArtifact(afterList),
      requiresConfirmation: requiresConfirm,
    };
  }

  async function applyActiveProjectsOperation(args, daily, startedAt, helpers) {
    const operation = String(args.operation || "").trim().toLowerCase();
    const planned = planActiveProjectsMutation(args, daily, helpers);
    if (planned.error) {
      return failActiveProjectsResult(operation, planned.error.code, planned.error.message, startedAt, {
        candidates: planned.error.candidates,
        projects: canonicalizeProjects(daily.activeProjects || []),
        dailyUpdatedAt: daily.updatedAt,
      });
    }
    const result = await commitActiveProjectsDaily(
      daily,
      planned.nextDaily,
      operation,
      startedAt,
      planned.meta?.allowedKeys || ["activeProjects"],
    );
    if (result.ok) {
      updateRecentActiveProjectId(
        operation,
        planned.meta,
        result.daily?.activeProjects || planned.nextDaily.activeProjects,
      );
    }
    return result;
  }

  async function memoryActiveProjects(args = {}) {
    const startedAt = Date.now();
    const operation = String(args.operation || "").trim().toLowerCase();
    if (!operation) {
      return failActiveProjectsResult("unknown", "UNSUPPORTED_OPERATION", "operation is required.", startedAt);
    }

    return enqueue(async () => {
      await ensureMemoryUnlocked();
      await rolloverDailyIfNeeded();
      const daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
      const helpers = {
        randomUUID,
        nowIso: isoNow,
        recentId: recentActiveProjectId,
      };

      if (args.expectedUpdatedAt && args.expectedUpdatedAt !== daily.updatedAt) {
        return failActiveProjectsResult(
          operation,
          "STALE_WRITE",
          "Daily context changed since the last read.",
          startedAt,
          {
            projects: canonicalizeProjects(daily.activeProjects || []),
            dailyUpdatedAt: daily.updatedAt,
            artifact: formatActiveProjectsArtifact(daily.activeProjects || []),
          },
        );
      }

      if (operation === "list") {
        const listed = cloneProjects(daily.activeProjects || []);
        logActiveProjectsEvent({
          operation,
          ok: true,
          itemCount: listed.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: true,
          operation,
          message: "Current active projects.",
          projects: canonicalizeProjects(listed),
          dailyUpdatedAt: daily.updatedAt,
          artifact: formatActiveProjectsArtifact(listed),
          confirmation: "Listed current active projects.",
        };
      }

      if (operation === "preview") {
        const nestedOp = String(args.previewOperation || args.targetOperation || "").trim().toLowerCase();
        if (!nestedOp) {
          return failActiveProjectsResult(
            operation,
            "UNSUPPORTED_OPERATION",
            "preview requires previewOperation.",
            startedAt,
          );
        }
        return activeProjectsPreviewPlan(
          { ...args, operation: nestedOp, confirmed: false, _previewOnly: true },
          daily,
          startedAt,
          helpers,
        );
      }

      if (DESTRUCTIVE_ACTIVE_PROJECT_OPERATIONS.has(operation)) {
        if (args.confirmed === true && !args.previewToken) {
          return failActiveProjectsResult(
            operation,
            "STALE_PREVIEW",
            "Active-projects preview is stale or invalid.",
            startedAt,
            {
              projects: canonicalizeProjects(daily.activeProjects || []),
              dailyUpdatedAt: daily.updatedAt,
            },
          );
        }

        if (args.confirmed !== true) {
          const planned = await activeProjectsPreviewPlan(
            { ...args, _previewOnly: true },
            daily,
            startedAt,
            helpers,
          );
          if (planned.ok === false && planned.code !== "CONFIRMATION_REQUIRED") return planned;
          return {
            ok: false,
            code: "CONFIRMATION_REQUIRED",
            requiresConfirmation: true,
            message: planned.message || `Confirmation required before ${operation.replace(/_/g, " ")}.`,
            operation,
            previewToken: planned.previewToken,
            before: planned.before,
            after: planned.after,
            projects: canonicalizeProjects(daily.activeProjects || []),
            dailyUpdatedAt: daily.updatedAt,
            artifact: planned.artifact || formatActiveProjectsArtifact(daily.activeProjects || []),
          };
        }

        const preview = readActiveProjectsPreview(args.previewToken, operation, daily.updatedAt);
        if (preview.code) {
          return failActiveProjectsResult(
            operation,
            "STALE_PREVIEW",
            "Active-projects preview is stale or invalid.",
            startedAt,
            {
              projects: canonicalizeProjects(daily.activeProjects || []),
              dailyUpdatedAt: daily.updatedAt,
            },
          );
        }
        const conflict = confirmationConflictsWithActiveProjectsPreview(args, preview.entry);
        if (conflict) {
          return failActiveProjectsResult(operation, "STALE_PREVIEW", conflict, startedAt, {
            projects: canonicalizeProjects(daily.activeProjects || []),
            dailyUpdatedAt: daily.updatedAt,
          });
        }

        if (operation === "restore_backup") {
          const backupFile = preview.entry.meta?.backupFile;
          if (!backupFile) {
            return failActiveProjectsResult(
              operation,
              "RESTORE_FAILED",
              "Restore preview is missing its backup reference.",
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          const full = path.join(paths.backups, backupFile);
          if (!(await pathExists(full))) {
            return failActiveProjectsResult(
              operation,
              "RESTORE_FAILED",
              "Backup file is no longer available.",
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          let snapshot;
          try {
            snapshot = JSON.parse(await readText(full));
          } catch (error) {
            return failActiveProjectsResult(
              operation,
              "RESTORE_FAILED",
              error instanceof Error ? error.message : "Backup could not be read.",
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          if (!snapshot || typeof snapshot !== "object" || !snapshot.daily || typeof snapshot.daily !== "object") {
            return failActiveProjectsResult(
              operation,
              "RESTORE_FAILED",
              "Backup is missing a valid daily snapshot.",
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          const restored = (Array.isArray(snapshot.daily.activeProjects) ? snapshot.daily.activeProjects : []).map(
            (item) => {
              const project = normalizeWorkItem({ ...item, text: item.name || item.text });
              return {
                id: project.id,
                name: String(item.name || item.text || "Untitled project"),
                note: String(item.note || ""),
                updatedAt: project.updatedAt,
              };
            },
          );
          const validationError = validateActiveProjectsArray(restored);
          if (validationError) {
            return failActiveProjectsResult(
              operation,
              "RESTORE_FAILED",
              `Backup active projects failed validation: ${validationError}`,
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          if (
            JSON.stringify(canonicalizeProjects(restored)) !==
            JSON.stringify(canonicalizeProjects(preview.entry.afterList || []))
          ) {
            return failActiveProjectsResult(
              operation,
              "STALE_PREVIEW",
              "Backup contents changed since preview.",
              startedAt,
              {
                projects: canonicalizeProjects(daily.activeProjects || []),
                dailyUpdatedAt: daily.updatedAt,
              },
            );
          }
          const nextDaily = { ...daily, activeProjects: cloneProjects(restored) };
          const result = await commitActiveProjectsDaily(daily, nextDaily, operation, startedAt, [
            "activeProjects",
          ]);
          if (result.ok) updateRecentActiveProjectId(operation, { recentMode: "replace" }, restored);
          return result;
        }

        const afterDaily = preview.entry.afterDaily || preview.entry.meta?.afterDaily;
        if (!afterDaily) {
          return failActiveProjectsResult(
            operation,
            "STALE_PREVIEW",
            "Preview is missing a stored plan.",
            startedAt,
            {
              projects: canonicalizeProjects(daily.activeProjects || []),
              dailyUpdatedAt: daily.updatedAt,
            },
          );
        }
        const result = await commitActiveProjectsDaily(
          daily,
          afterDaily,
          operation,
          startedAt,
          preview.entry.meta?.allowedKeys || ["activeProjects"],
        );
        if (result.ok) {
          updateRecentActiveProjectId(operation, preview.entry.meta, afterDaily.activeProjects || []);
        }
        return result;
      }

      return applyActiveProjectsOperation(args, daily, startedAt, helpers);
    });
  }

  return {
    SCHEMA_VERSION,
    PERSONAL_CONTEXT_SOFT_CAP,
    MAX_BACKUPS,
    paths,
    ensureMemory,
    loadAll,
    createBackupSnapshot,
    listBackupFiles,
    rolloverDailyIfNeeded,
    buildPersonalContextBlock,
    buildPersonalContextForSession,
    memoryView,
    memoryRemember,
    memoryCorrect,
    memoryUpdateDaily,
    memoryPriorities,
    workingContextItems,
    memoryActiveProjects,
    memorySetPreference,
    memorySetInstructions,
    memoryClear,
    defaultDaily,
    defaultEntries,
    defaultPreferences,
    defaultProfile,
    defaultInstructions,
    normalizeDaily,
    normalizeEntries,
    normalizePreferences,
    normalizeProfile,
    openDailyItems,
    enqueue,
    atomicWriteJson,
    atomicWriteText,
    todayDate,
    // test helpers
    _test: {
      getRecentPriorityId: () => recentPriorityId,
      setRecentPriorityId: (id) => {
        recentPriorityId = id;
      },
      getRecentActiveProjectId: () => recentActiveProjectId,
      setRecentActiveProjectId: (id) => {
        recentActiveProjectId = id;
      },
      getRecentWcId: (scope) => recentWcIds[normalizeScope(scope)] || null,
      setRecentWcId: (scope, id) => {
        const key = normalizeScope(scope);
        if (key) recentWcIds[key] = id;
      },
      clearPreviews: () => invalidatePreviews(),
      clearNotFoundFingerprints: () => {
        notFoundFingerprints.clear();
        wcNotFoundFingerprints.clear();
      },
      getPreviewEntry: (token) => previewStore.get(String(token || "")) || null,
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  PERSONAL_CONTEXT_SOFT_CAP,
  MAX_BACKUPS,
  PRIORITY_SELECTION_PRECEDENCE,
  NO_OPEN_DAILY_PRIORITIES_LINE,
  NO_OPEN_DAILY_PRIORITIES_REPLY,
  formatDailyWorkingContext,
  planBroadPriorityAnswer,
  createMemoryStore,
  priorityLifecycle: require("./priority-lifecycle.cjs"),
  workingContextLifecycle: require("./working-context-lifecycle.cjs"),
  activeProjectsLifecycle: require("./active-projects-lifecycle.cjs"),
};
