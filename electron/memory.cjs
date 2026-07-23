const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;
const PERSONAL_CONTEXT_SOFT_CAP = 9_500;
const INSTRUCTIONS_EXCERPT_CAP = 3_000;
const DAILY_SECTION_CAP = 2_000;
const PREFS_SECTION_CAP = 1_500;
const ENTRIES_SECTION_CAP = 3_000;

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
  };

  function isoNow() {
    return now().toISOString();
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
    return {
      id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
      text: String(item.text || item.name || item.note || "").trim(),
      name: item.name ? String(item.name) : undefined,
      note: item.note ? String(item.note) : undefined,
      due: item.due ? String(item.due) : undefined,
      status: normalizeStatus(item.status, fallbackStatus),
      updatedAt: item.updatedAt || isoNow(),
      source: item.source ? normalizeSource(item.source) : undefined,
      sensitivity: item.sensitivity ? normalizeSensitivity(item.sensitivity) : undefined,
    };
  }

  function normalizeDaily(raw, fallbackDate = todayDate()) {
    const base = defaultDaily(fallbackDate);
    if (!raw || typeof raw !== "object") return base;
    return {
      schemaVersion: SCHEMA_VERSION,
      date: typeof raw.date === "string" && raw.date ? raw.date : fallbackDate,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      priorities: Array.isArray(raw.priorities) ? raw.priorities.map((item) => normalizeWorkItem(item)) : [],
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
            const commitment = normalizeWorkItem(item);
            return {
              id: commitment.id,
              text: commitment.text,
              due: commitment.due || null,
              status: ["open", "done", "blocked"].includes(commitment.status) ? commitment.status : "open",
              updatedAt: commitment.updatedAt,
              source: commitment.source || "user",
              sensitivity: commitment.sensitivity || "normal",
            };
          })
        : [],
      followUps: Array.isArray(raw.followUps) ? raw.followUps.map((item) => normalizeWorkItem(item)) : [],
      unresolved: Array.isArray(raw.unresolved) ? raw.unresolved.map((item) => normalizeWorkItem(item)) : [],
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
    const next = {
      ...defaultDaily(today),
      priorities: carried.priorities,
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
      await ensureMemoryUnlocked();
      await rolloverDailyIfNeeded();
      const daily = await readJsonFile(paths.daily, (raw) => normalizeDaily(raw), () => defaultDaily());
      if (typeof args.summary === "string") daily.summary = args.summary;
      if (args.priorities) daily.priorities = upsertWorkList(daily.priorities, args.priorities, (item) => normalizeWorkItem(item));
      if (args.activeProjects) {
        daily.activeProjects = upsertWorkList(daily.activeProjects, args.activeProjects, (item) => {
          const project = normalizeWorkItem({ ...item, text: item.name || item.text });
          return {
            id: project.id,
            name: String(item.name || item.text || "Untitled project"),
            note: String(item.note || ""),
            updatedAt: isoNow(),
          };
        });
      }
      if (args.commitments) {
        daily.commitments = upsertWorkList(daily.commitments, args.commitments, (item) => {
          const commitment = normalizeWorkItem(item);
          return {
            id: commitment.id,
            text: commitment.text,
            due: commitment.due || null,
            status: ["open", "done", "blocked"].includes(commitment.status) ? commitment.status : "open",
            updatedAt: isoNow(),
            source: commitment.source || "user",
            sensitivity: commitment.sensitivity || "normal",
          };
        });
      }
      if (args.followUps) daily.followUps = upsertWorkList(daily.followUps, args.followUps, (item) => normalizeWorkItem(item));
      if (args.unresolved) daily.unresolved = upsertWorkList(daily.unresolved, args.unresolved, (item) => normalizeWorkItem(item));
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

    const openCommitments = (daily.commitments || []).filter((item) => item.status === "open" || item.status === "blocked");
    const openPriorities = (daily.priorities || []).filter((item) => item.status === "open" || item.status === "blocked");
    const openFollowUps = (daily.followUps || []).filter((item) => item.status === "open" || item.status === "blocked");
    const openUnresolved = (daily.unresolved || []).filter((item) => item.status === "open" || item.status === "blocked");

    const dailyLines = [
      `Date: ${daily.date}`,
      daily.summary ? `Summary: ${daily.summary}` : null,
      openPriorities.length ? `Priorities:\n${openPriorities.map((item) => `- ${item.text}`).join("\n")}` : null,
      (daily.activeProjects || []).length
        ? `Active projects:\n${daily.activeProjects.map((item) => `- ${item.name}${item.note ? `: ${item.note}` : ""}`).join("\n")}`
        : null,
      openCommitments.length
        ? `Commitments:\n${openCommitments
            .map((item) => {
              if (item.sensitivity === "secret") return `- [secret commitment stored] (${item.id})`;
              if (item.sensitivity === "sensitive") return `- [sensitive commitment stored] (${item.id})`;
              return `- ${item.text}${item.due ? ` (due ${item.due})` : ""}`;
            })
            .join("\n")}`
        : null,
      openFollowUps.length ? `Follow-ups:\n${openFollowUps.map((item) => `- ${item.text}`).join("\n")}` : null,
      openUnresolved.length ? `Unresolved:\n${openUnresolved.map((item) => `- ${item.text}`).join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    let prefsBlock = trimToBudget(`# Personal Preferences And Hard Rules\n${hardRules}`, PREFS_SECTION_CAP);
    let instructionsBlock = trimToBudget(
      `# Personal Operating Instructions (excerpt)\n${instructions}`,
      INSTRUCTIONS_EXCERPT_CAP,
    );
    let dailyBlock = trimToBudget(`# Today's Working Context\n${dailyLines || "No open daily items."}`, DAILY_SECTION_CAP);

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
      dailyBlock = trimToBudget(
        `# Today's Working Context\nDate: ${daily.date}\nCommitments:\n${
          openCommitments
            .map((item) => {
              if (item.sensitivity === "secret") return `- [secret commitment stored] (${item.id})`;
              if (item.sensitivity === "sensitive") return `- [sensitive commitment stored] (${item.id})`;
              return `- ${item.text}`;
            })
            .join("\n") || "- none"
        }\nPriorities:\n${openPriorities.map((item) => `- ${item.text}`).join("\n") || "- none"}`,
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
  };
}

module.exports = {
  SCHEMA_VERSION,
  PERSONAL_CONTEXT_SOFT_CAP,
  MAX_BACKUPS,
  createMemoryStore,
};
