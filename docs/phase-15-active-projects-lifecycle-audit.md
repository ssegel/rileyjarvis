# Phase 15 audit: reliable active-projects lifecycle

**Status:** Audit and design only. No application-code or runtime-memory edits.
**Goal:** Sarah can manage active projects through ordinary text and voice without editing JSON, without knowing internal IDs, and without silent upsert/merge via `memory_update_daily`.
**Architectural reference:** Phase 13 `memory_priorities` and Phase 14 `working_context_items` deterministic lifecycles (`electron/priority-lifecycle.cjs`, `electron/working-context-lifecycle.cjs`, `electron/memory.cjs`).
**Branch context:** Documentation for Phase 15 implementation planning on `phase-15`.

---

## Locked product decisions (Sarah)

| # | Decision |
|---|---|
| 1 | Project schema remains **name-and-note only**: `id`, `name`, `note`, `updatedAt`. |
| 2 | Do **not** add project status, completion, due dates, deferral, or priority fields. |
| 3 | Working-context → project promotion or linking is **out of scope**. |
| 4 | Connected accounts, OAuth, calendar, email, integrations, packaging, and installer work remain **deferred**. |
| 5 | Voice uses the **same shared tool path** as text; Phase 8 audio stabilization is **out of scope**. |

---

## Executive summary

### Confirmed current state

Active projects live only on **`data/memory/daily.json`** as `activeProjects[]`. After Phases 13 and 14, this is the **last daily array still written through legacy upsert**. The only normal writer is **`memory_update_daily.activeProjects`**, which **upserts / merges** by `id` or exact `name`/`text`. It cannot:

- strictly replace the projects array;
- remove a project by ordinal or name;
- reorder projects;
- clear via empty array (`[]` leaves the list unchanged);
- resolve “the second project” or “the website project” in code.

Natural-language reference resolution is **entirely model-side**. Missing ID + changed name → **silent append**. Intended replace → **silent merge/append**. Exact IDs are effectively required for reliable edits.

Phases 13 and 14 already proved the robust pattern for priorities and working-context items. Phase 15 must bring **parity of lifecycle reliability** to `activeProjects`, with a **narrower** schema and operation set (no status/due/defer/complete/carry/promote).

### Design recommendation

**One shared tool** `memory_active_projects` with an `operation` discriminator, shared by text and Realtime via existing `toolSpecs` / `executeTrustedTool`. Reuse Phase 13/14 resolution, preview tokens, backup/atomic/reread, and confirmation gates. Retire `memory_update_daily.activeProjects` with structured rejection `USE_MEMORY_ACTIVE_PROJECTS`. Keep `memory_update_daily.summary` unchanged.

### Final Phase 15 design decisions

| Topic | Locked rule |
|---|---|
| **Schema** | `id`, `name`, `note`, `updatedAt` only. No status, due, deferredUntil, linked ids, or priority fields. |
| **Canonical wording** | `name` is the primary display/resolution field. Empty `name` is invalid. `note` may be `""`. |
| **Ordering** | Stored array order in `daily.activeProjects` is canonical. Phase 12 falls back to **first** project in that order. |
| **Timestamps** | New projects get `updatedAt`. Edits refresh `updatedAt`. Do **not** add `createdAt` in Phase 15 (keeps schema to the four locked fields). |
| **Confirmation** | Preview + confirm for `remove`, `replace`, `restore_backup`. Direct execute for `list`, `add`, `insert`, `edit`, `reorder`. |
| **Backup restoration** | `restore_backup` restores **only** `activeProjects` from a validated backup. Preserve priorities, summary, commitments, followUps, unresolved, date, schemaVersion. |
| **Legacy path** | `memory_update_daily` with `activeProjects` → `{ ok: false, code: "USE_MEMORY_ACTIVE_PROJECTS" }`. Summary-only updates remain allowed. |
| **Cross-feature linking** | No WC→project promote/link; no project→priority promote. WC `relatedProject` string qualifiers remain free-text and are not rewritten when projects rename/remove. |

---

## 1. Current-state architecture and legacy failure mode

### 1.1 File location and containing object

| Path | Role |
|---|---|
| `{cwd}/data/memory/daily.json` | Live daily working context including `activeProjects` |
| `{cwd}/data/memory/archive/daily-YYYY-MM-DD.json` | Full prior-day snapshot on date rollover |
| `{cwd}/data/memory/future/daily-YYYY-MM-DD.json` | Future **priorities** only (Phase 13); not a projects writer |
| `{cwd}/data/memory/backups/{iso}-{reason}.json` | Full memory snapshots (include entire `daily`) |

Root: `createMemoryStore({ rootDir: path.join(dataDir, "memory") })` in `electron/main.cjs`.

**Containing object:** `daily` (`schemaVersion: 1`) with `priorities`, `activeProjects`, `commitments`, `followUps`, `unresolved`, `summary`, `date`, `updatedAt`.

### 1.2 Current project shape after `normalizeDaily`

From `electron/memory.cjs`:

| Field | Rules today |
|---|---|
| `id` | String UUID; generated if missing |
| `name` | `String(item.name \|\| item.text \|\| "Untitled project")` |
| `note` | `String(item.note \|\| "")` |
| `updatedAt` | From work-item normalize / write path |

**Not stored on projects today (and must not be added in Phase 15):** `status`, `due`, `deferredUntil`, `createdAt`, `completedAt`, `text` (as a first-class field), `linkedPriorityId`, source/sensitivity, related person/project on the project row itself.

### 1.3 Existing tools and handlers

| Surface | Reads projects | Writes projects |
|---|---|---|
| `memory_view` | Yes (daily JSON) | No |
| `memory_update_daily` | Returns full `daily` | **Yes — upsert only** |
| `memory_priorities` | Asserts `activeProjects` unchanged | No |
| `working_context_items` | Asserts `activeProjects` unchanged | No |
| Personal-context injection | Yes (`Active projects:` lines) | No |
| Phase 12 `planBroadPriorityAnswer` | Yes (fallback category `active_projects`) | No |
| Rollover `openDailyItems` | Carries **all** `activeProjects` (no status filter) | Rewrites carried list |

**Tool schema today (`memory_update_daily`):** accepts `summary`, `activeProjects`. Already rejects `priorities` (`USE_MEMORY_PRIORITIES`) and WC arrays (`USE_WORKING_CONTEXT_ITEMS`).

### 1.4 Legacy merge failure mode (`upsertWorkList`)

| Behavior | Yes / No |
|---|---|
| Append when no match | **Yes** |
| Merge by ID | **Yes** |
| Merge by exact `name` / `text` | **Yes** |
| Replace arrays | **No** |
| Empty array clears list | **No** |
| Backup before write | **No** |
| Deterministic ordinal / phrase resolution | **No** |
| Preview / confirm | **No** |

**Critical failure modes:** intended rename without id → silent append; intended replace → silent merge/append; cannot remove or reorder reliably without hand-editing JSON.

### 1.5 Text and voice sharing (today)

| Layer | Shared? |
|---|---|
| Tool specs | Yes (`toolSpecs` in `main.cjs`) |
| Handlers | Yes (`executeTrustedTool` → `memoryStore`) |
| Session instructions + personal context | Yes (`buildSharedSessionInstructions`) |

No project-specific divergence between text and Realtime beyond transport. Phase 15 must preserve that.

---

## 2. Exact project schema and invariants

### 2.1 Canonical stored shape

```json
{
  "id": "uuid-string",
  "name": "nonempty display name",
  "note": "string, may be empty",
  "updatedAt": "ISO-8601"
}
```

### 2.2 Invariants

1. **Unique ids** within `activeProjects`.
2. **Nonempty `name`** after trim; reject empty/whitespace names with `VALIDATION_FAILED`.
3. **`note` is always a string**; missing note normalizes to `""`.
4. **No extra lifecycle fields** written by Phase 15 ops. Unknown legacy keys on read may be dropped by normalize (same spirit as current project mapper) — do not invent new fields.
5. **Array order is canonical.** Index 0 is “first active project” for Phase 12 fallback and speech (“my first project”).
6. **Edit preserves `id`.** New ids only for genuinely new projects (add/insert/new rows in replace).
7. **Replace is strict:** resulting array membership equals the request after normalization; no leftover prior projects.
8. **Duplicate names** are allowed in storage (Sarah may have similarly named projects) but phrase resolution that matches ≥2 → `AMBIGUOUS_MATCH` (no silent pick).
9. **`daily.date` / `schemaVersion` / unrelated arrays / `summary`** are never modified by project lifecycle ops (except `daily.updatedAt` on successful write).

### 2.3 Normalization rules

| Input | Behavior |
|---|---|
| `name` present | Trim; required nonempty |
| `name` missing, `text` present | Treat `text` as `name` for **incoming** add/insert/edit/replace inputs only (compatibility with model habits); store as `name` |
| `note` missing | `""` |
| Client-supplied `id` on **new** row (add/insert) | **Ignore**; generate UUID (same Phase 13 rule: never trust client ids for new rows) |
| Client-supplied `id` on replace row | Used only for id-continuity matching per §3.2 replace rules |
| `edit` target identity | Comes from `reference` resolution only; ignore `item.id` if present |
| Status / due / defer / complete / link fields in payload | **Ignore** (do not store); never persist. Phase 15 default: ignore unknown keys (do not hard-fail) |
| Legacy empty/missing name on **read** normalize | Keep today’s `"Untitled project"` fallback for already-stored legacy rows only; Phase 15 **writes** never emit empty names or invent Untitled for new/edited rows |

---

## 3. Complete operation contracts and payloads

### 3.1 Tool name and top-level args

**Tool:** `memory_active_projects`

```text
memory_active_projects
  operation: enum [
    list,
    add,
    insert,
    edit,
    remove,
    reorder,
    replace,
    restore_backup,
    preview
  ]
  confirmed?: boolean
  expectedUpdatedAt?: string
  items?: ProjectInput[]          # add / replace
  item?: ProjectInput             # single add/insert/edit fields
  reference?: ProjectReference    # edit / remove / reorder single
  atPosition?: number             # 1-based insert / reorder target
  order?: ProjectReference[]      # full reorder
  backupId?: string               # restore (optional; default latest eligible)
  previewToken?: string
  previewOperation?: string       # when operation === "preview"
```

**`ProjectInput`:** `{ name?: string, text?: string, note?: string, id?: string }`
- `name` preferred; `text` accepted as name alias on input only; never stored as a separate field.
- `note` optional.

**`ProjectReference`:**
`{ by?: "id"|"ordinal"|"text"|"phrase"|"name"|"recent", value?: string|number, query?: string, text?: string, name?: string }`
Normalization accepts `by: "text"|"phrase"|"name"` as name-resolution aliases (projects resolve against **`name`**, not a separate `text` field).

**Confirmation is not a separate `operation` value.** Destructive ops are confirmed by a **second call** with the same `operation` (`remove` | `replace` | `restore_backup`), plus `confirmed: true` and the matching `previewToken` (see §5).

**`add` / `insert` input shape:** accept `item` (single) and/or `items` (array), same as Phase 13 priorities. Empty `items` / missing both → `VALIDATION_FAILED`.

### 3.2 Operation semantics

| Operation | Confirm? | Behavior |
|---|---|---|
| `list` | No | Return canonical ordered projects `{ order, id, name, note, updatedAt }` + artifact. |
| `add` | No | Append one or more **new** ids; require nonempty name per row; does not reorder existing items. |
| `insert` | No | Insert at 1-based `atPosition` (1 = first); shift others; new id(s). Reject out-of-range (`atPosition < 1` or `> length+1`) with `VALIDATION_FAILED` — never clamp. |
| `edit` | No | Resolve **`reference`** (not `item.id`) → change `name` and/or `note` from `item` as provided; **preserve id**; refresh `updatedAt`. If neither name nor note provided → `VALIDATION_FAILED`. Omitting `note` leaves note unchanged; omitting `name` leaves name unchanged. Setting `note: ""` clears note. |
| `remove` | **Yes** (§5) | Resolve reference → delete from array. |
| `reorder` | No | Move one resolved `reference` to `atPosition`, **or** full `order` list of references covering every current project exactly once. Incomplete coverage, duplicates in `order`, or unresolvable refs → `VALIDATION_FAILED` / `NOT_FOUND` / `AMBIGUOUS_MATCH` as applicable; no write. |
| `replace` | **Yes** (§5) | Strict set `activeProjects` to exactly provided `items` (required nonempty array; empty array is a valid strict clear and still requires confirm). **Id continuity rules (in order per incoming row):** (1) if `id` matches an existing project not yet claimed by an earlier row, preserve that id; (2) else if exact case-insensitive `name` matches **exactly one** still-unclaimed existing project, preserve that id; (3) else generate a new id. Duplicate exact-name matches among remaining projects → **do not guess**; generate a new id for that incoming row (old duplicates may drop if not otherwise claimed). Never reuse the same existing id twice in one replace. |
| `restore_backup` | **Yes** (§5) | Restore **only** `activeProjects` from backup; see §6. |
| `preview` | N/A | Dry-run via `previewOperation` set to a mutating op. For destructive target ops, **must** mint a confirmable `previewToken` with `requiresConfirmation: true`. For direct target ops, return before/after without requiring confirm; applying still uses the normal direct path (not confirm-with-token). Missing/unknown `previewOperation` → `UNSUPPORTED_OPERATION` or `VALIDATION_FAILED`. |

### 3.3 Success / failure envelope

Align with Phase 13/14:

```text
ok: boolean
operation: string
code?: string
message / confirmation?: string
projects?: CanonicalProject[]
before?: CanonicalProject[]
after?: CanonicalProject[]
previewToken?: string
requiresConfirmation?: boolean
candidates?: Candidate[]
dailyUpdatedAt?: string
artifact?: { title, kind, content }
```

**Canonical project:** `{ order: 1-based, id, name, note, updatedAt }`

**Artifact title:** `Active Projects` (markdown numbered list: name + optional note).

### 3.4 Write pipeline (every successful mutation)

1. `enqueue`
2. `ensureMemoryUnlocked` + `rolloverDailyIfNeeded`
3. Read + normalize daily
4. Optional `expectedUpdatedAt` check → `STALE_WRITE`
5. Plan mutation (pure)
6. If destructive and not confirmed → store preview → return `ok: false`, `code: "CONFIRMATION_REQUIRED"` (no write)
7. If confirmed → validate preview token binding → apply **stored plan** (ignore conflicting re-sent payload fields that disagree with bound plan; mismatch → `STALE_PREVIEW` — same Phase 13 behavior)
8. `assertUnrelatedUnchanged` with `activeProjects` (+ `updatedAt`) allowed
9. Validate projects array
10. `createBackupSnapshot("active-projects-{operation}")` — fail closed on backup failure
11. `atomicWriteJson`
12. Reread + normalize
13. Update session `recentActiveProjectId` per §4.4
14. Return canonical list + artifact

---

## 4. Reference-resolution rules and error codes

### 4.1 Resolution order

Resolve against the **full** `activeProjects` array (there is no open/done split and no status filter):

1. **`by: "recent"`** — last project id recorded in §4.4; missing or id not in array → `NOT_FOUND`.
2. **`by: "id"`** — exact id over full array.
3. **`by: "ordinal"`** — 1-based index into **full stored order** (matches “first project” / Phase 12 first-project meaning).
4. **Name / phrase** (`by: "text"|"phrase"|"name"` or bare query value):
   1. Case-insensitive **exact name** match → 1 hit success; ≥2 → `AMBIGUOUS_MATCH`; 0 → continue.
   2. If query length ≥ 3: **substring** match on `name` → 1 hit success; ≥2 → `AMBIGUOUS_MATCH`; 0 → continue.
   3. **Significant-token overlap** on `name` (reuse Phase 14 stopword / significant-token approach) → 1 hit success; ≥2 → `AMBIGUOUS_MATCH`; 0 → `NOT_FOUND`.

At every stage, ≥2 matches → `AMBIGUOUS_MATCH` + candidates and **no write**. Do not fall through after ambiguity.

**Model instruction:** Pass Sarah’s reference phrase as supplied; do **not** invent a narrower phrase to force a unique match.

**Notes are not resolution targets** in Phase 15 (name-only matching). Note-field resolution remains out of scope.

### 4.2 Candidate payload

```text
{ order, id, name, note }
```

### 4.3 Error taxonomy

| Code | Meaning |
|---|---|
| `NOT_FOUND` | Reference resolved to zero projects |
| `AMBIGUOUS_MATCH` | Multiple candidates; no write |
| `CONFIRMATION_REQUIRED` | Destructive op without valid confirm |
| `STALE_PREVIEW` | previewToken missing/mismatch/expired/wrong op/wrong daily.updatedAt binding |
| `STALE_WRITE` | `expectedUpdatedAt` mismatch |
| `VALIDATION_FAILED` | Invalid name, position, order coverage, shape, empty add/insert payload |
| `BACKUP_FAILED` | Backup could not be created (fail closed) |
| `WRITE_FAILED` | Atomic write/rename failed |
| `RESTORE_FAILED` | Backup missing/corrupt/invalid projects |
| `UNSUPPORTED_OPERATION` | Unknown operation or missing `previewOperation` on `preview` |
| `USE_MEMORY_ACTIVE_PROJECTS` | Legacy `memory_update_daily.activeProjects` rejected |

Do **not** invent `DUPLICATE_NAME` rejection in Phase 15 (duplicates allowed; ambiguity handled at resolve time).

### 4.4 Recent-reference updates

Maintain process-local `recentActiveProjectId` (same lifetime as Phase 13/14 recent ids):

| Successful op | Recent id becomes |
|---|---|
| `add` / `insert` | Last newly created project id in that call |
| `edit` | Edited project id |
| `reorder` (single move) | Moved project id |
| `reorder` (full order) | **Leave unchanged** |
| `remove` | Clear if it equaled the removed id; otherwise unchanged |
| `replace` / `restore_backup` | Clear, then set to first project id if the resulting list is nonempty; else null |

---

## 5. Preview-token and confirmation behavior

### 5.1 Ops requiring preview + confirm

| Operation | Gate |
|---|---|
| `remove` | Always |
| `replace` | Always (including strict empty list) |
| `restore_backup` | Always |

### 5.2 Direct ops (no confirm)

`list`, `add`, `insert`, `edit`, `reorder`, and `preview` (dry-run only)

### 5.3 Confirmation contract (second call)

There is **no** `operation: "confirm"`. To apply a destructive preview:

1. First call: `{ operation: "remove"|"replace"|"restore_backup", … }` without a valid confirm (`confirmed` not true) **or** `{ operation: "preview", previewOperation: "remove"|"replace"|"restore_backup", … }` → returns Phase 13/14-compatible envelope: `ok: false`, `code: "CONFIRMATION_REQUIRED"`, `requiresConfirmation: true`, `previewToken`, `before`, `after`, `projects` (current), `dailyUpdatedAt`, artifact for the **after** plan. Disk unchanged.
2. Sarah explicitly confirms in conversation.
3. Second call: **same** destructive `operation`, with `confirmed: true` and `previewToken` equal to the token from step 1.
4. Handler validates token (§5.4) and applies the **stored after plan**; success returns `ok: true`.

Calling a destructive op with `confirmed` not true → `CONFIRMATION_REQUIRED` (mint/refresh preview as Phase 13/14 do).
Calling with `confirmed: true` but missing/invalid/expired/mismatched token → `STALE_PREVIEW`.

### 5.4 Token rules

- Tokens live in the existing in-memory `previewStore` (process-local; not persisted across restart — same Phase 13/14 limitation; persistence is out of Phase 15 scope).
- TTL: reuse shared `PREVIEW_TTL_MS` (**10 minutes**, from `priority-lifecycle.cjs` export). Expired → `STALE_PREVIEW`.
- Binding includes: operation, `daily.updatedAt` at preview time, before/after project snapshots, and request binding fields needed to prevent payload swap (mirror priorities/WC). For restore, bind `backupId` / selected backup file identity.
- Confirm requires `confirmed: true` + matching `previewToken`.
- Intervening successful daily write that changes `daily.updatedAt`, consumed token, wrong operation, or TTL expiry → `STALE_PREVIEW`.
- On confirm, apply the **stored after plan**, not a newly reinterpreted reference (prevents TOCTOU / swapped remove targets).
- Mismatched confirm payload fields vs binding → `STALE_PREVIEW` (same Phase 13 behavior).

### 5.5 Nested `operation: "preview"`

Dry-run any mutating operation via `previewOperation`. For destructive target ops, **must** mint a confirmable `previewToken` with `requiresConfirmation: true`. For direct target ops, return before/after without requiring confirm to apply (apply still uses the normal direct path).

---

## 6. Backup and scoped-restore behavior

### 6.1 Backup-before-write

Before every **successful** mutating `memory_active_projects` write: `createBackupSnapshot("active-projects-{operation}")`.
If backup fails → return `BACKUP_FAILED` and **do not mutate**.

Retain existing `MAX_BACKUPS` policy unless tests prove a need to bump (default: keep current).

### 6.2 Scoped restore

`restore_backup`:

1. **Backup selection:** If `backupId` is provided, resolve via the same matcher as Phase 13 priorities (`name.includes`, exact `name`, or `full.endsWith`). If omitted, use **newest** backup by mtime (`listBackupFiles()[0]`). No file → `RESTORE_FAILED`.
2. Parse snapshot JSON; require `snapshot.daily` object. Extract projects as `Array.isArray(snapshot.daily.activeProjects) ? snapshot.daily.activeProjects : []` (same missing/non-array → `[]` pattern as Phase 13/14 scoped restore).
3. Normalize + `validateActiveProjectsArray`; failure → `RESTORE_FAILED`.
4. Preview before/after **projects only**; mint token; bind selected backup identity.
5. On confirm: set `daily.activeProjects` to restored list; **preserve** priorities, commitments, followUps, unresolved, summary, date, schemaVersion.
6. Backup current before applying restore write (`active-projects-restore_backup`).
7. Fail with `RESTORE_FAILED` if backup missing, unreadable, or projects fail validation.

**Not in scope:** restoring summary together with projects; restoring full daily; multi-scope restore.

---

## 7. Legacy-path rejection behavior

### 7.1 `memory_update_daily`

Detection must use **own-property** presence, matching priorities/WC:

`Object.prototype.hasOwnProperty.call(args, "activeProjects")`

| Args | Behavior after Phase 15 |
|---|---|
| `{ summary }` only (no `activeProjects` key) | Allowed (unchanged) |
| `activeProjects` key present — including `[]`, `null`, or nonempty — alone or with `summary` | **Reject entire call** with `USE_MEMORY_ACTIVE_PROJECTS` — do **not** partially apply summary |
| `{ priorities }` | Existing `USE_MEMORY_PRIORITIES` |
| WC arrays | Existing `USE_WORKING_CONTEXT_ITEMS` |

**Rejection shape** (align with existing priority/WC rejections in `memoryUpdateDaily`):

```text
{
  ok: false,
  code: "USE_MEMORY_ACTIVE_PROJECTS",
  error: "Use memory_active_projects for active project lifecycle. memory_update_daily no longer accepts activeProjects."
}
```

### 7.2 Consistency across surfaces

| Surface | Required change |
|---|---|
| Tool schema (`toolSpecs` in `main.cjs`) | Remove `activeProjects` from `memory_update_daily` parameters; description = summary only |
| Orchestration (`memoryUpdateDaily`) | Own-property rejection before any write (§7.1) |
| Instructions (`JARVIS_INSTRUCTIONS`) | Route all project lifecycle to `memory_active_projects`; forbid `memory_update_daily.activeProjects` |
| Automated tests | T21 / T22 (§13) |
| Live validation | Steps covering model routing + diagnostic rejection (§14) |

### 7.3 Instruction + tool description updates

- `memory_update_daily` description: summary **only**.
- `JARVIS_INSTRUCTIONS`: use `memory_active_projects` for all active-project lifecycle requests; never pass `activeProjects` to `memory_update_daily`; never ask for UUIDs; on `AMBIGUOUS_MATCH` ask one clarification; only claim success when `ok: true`.

---

## 8. Tool specification and routing instructions

### 8.1 Shared routing

```text
Text:  text-session → executeTool → executeTrustedTool → memoryStore.memoryActiveProjects
Voice: Realtime data channel → tools:execute IPC → executeTrustedTool → same handler
```

No voice-specific project handler. No Realtime schema fork.

### 8.2 Instruction bullets to add (shared)

- Use `memory_active_projects` for list/add/insert/edit/remove/reorder/replace/restore/preview of active projects.
- Never use `memory_update_daily.activeProjects`.
- Array order is project order; “first project” means ordinal 1 / index 0.
- Pass Sarah’s project name phrase as supplied; do not narrow phrases to force a match.
- For remove/replace/restore_backup: present preview, wait for explicit confirmation, then call with `confirmed=true` and matching `previewToken`.
- Execute add/insert/edit/reorder directly.
- Only report success when the tool result has `ok: true`.

### 8.3 Menu / capability docs

If `buildMenuMarkdown` (or equivalent) lists memory tools, add active-projects lifecycle alongside priorities and working context.

---

## 9. Text and voice command examples

| User speech / text | Intended tool call |
|---|---|
| “What are my active projects?” | `{ operation: "list" }` |
| “Add active project Jarvis desktop assistant” | `{ operation: "add", items: [{ name: "Jarvis desktop assistant" }] }` |
| “Add project Website with note redesign homepage” | `{ operation: "add", items: [{ name: "Website", note: "redesign homepage" }] }` |
| “Insert Estate planning as my first project” | `{ operation: "insert", atPosition: 1, item: { name: "Estate planning" } }` |
| “Rename the Website project to Website redesign” | `{ operation: "edit", reference: { by: "text", value: "Website" }, item: { name: "Website redesign" } }` |
| “Update the note on Jarvis to Phase 15 audit” | `{ operation: "edit", reference: { by: "text", value: "Jarvis" }, item: { note: "Phase 15 audit" } }` |
| “Clear the note on Website” | `{ operation: "edit", reference: { by: "text", value: "Website" }, item: { note: "" } }` |
| “Make Website my first project” | `{ operation: "reorder", reference: { by: "text", value: "Website" }, atPosition: 1 }` |
| “Remove the Estate planning project” | preview remove → confirm |
| “Replace my active projects with only Jarvis and Website” | preview replace → confirm |
| “Restore my active projects from the last backup” | preview restore_backup → confirm |
| “Edit the project I just added” | `{ operation: "edit", reference: { by: "recent" }, item: { ... } }` |

Voice examples are identical at the tool layer; only transport differs.

---

## 10. Unrelated-field preservation requirements

### 10.1 Project writes preserve other daily fields

Every successful `memory_active_projects` mutation (including scoped restore) **must not** change:

| Field | Requirement |
|---|---|
| `priorities` | Byte-identical JSON vs pre-write daily |
| `commitments` | Unchanged |
| `followUps` | Unchanged |
| `unresolved` | Unchanged |
| `summary` | Unchanged |
| `date` | Unchanged |
| `schemaVersion` | Unchanged |

Allowed to change: `activeProjects`, `daily.updatedAt`.

Implement via `assertUnrelatedUnchanged` / `assertUnchangedFields` analogue with `allowedKeys: ["activeProjects", "updatedAt"]`.

### 10.2 Priority and working-context writes preserve projects

| Writer | Existing guard | Phase 15 requirement |
|---|---|---|
| `memory_priorities` | `assertUnchangedFields` includes `activeProjects` | **Keep**; regression test T20 |
| `working_context_items` | `assertUnrelatedUnchanged` treats `activeProjects` as protected unless allowed | **Keep**; regression test T20 |
| `memory_update_daily` (summary-only) | Does not touch projects after Phase 15 rejection of `activeProjects` | Summary-only must leave projects unchanged (T22) |

No intentional change to Phase 13/14 assert lists is required unless a shared-helper refactor needs an export tweak (§12).

---

## 11. Rollover, personal-context, relatedProject, and Phase 12 interactions

### 11.1 Rollover

`openDailyItems` currently carries **all** `activeProjects` into the next day (no status filter — projects have no status). Phase 15 **preserves** that behavior:

- Reorder persists across rollover via carried array order.
- Remove means the project does not exist to carry.
- No project-specific future-file merge (future files remain priorities-only).

### 11.2 Personal-context injection

`formatDailyWorkingContext` continues to emit:

```text
Active projects:
- {name}: {note}   # note suffix only when nonempty
```

After Phase 15 writes, the next text turn sees fresh injection; voice still refreshes at Realtime token mint (existing staleness limitation — not fixed in Phase 15).

### 11.3 Phase 12 selection

`planBroadPriorityAnswer` fallback:

- Category `active_projects`
- `leadText` / first item = `activeProjects[0].name`
- Reorder that puts project X first **must** make X the Phase 12 fallback lead when higher categories are empty
- Empty projects list → fall through to `category: "none"` as today

No Phase 12 code change required unless injection/selection currently assumes fields Phase 15 removes (it uses `name` only — compatible).

### 11.4 WC `relatedProject`

Working-context items may store optional string `relatedProject` for qualifier resolution (`by: "project"`). Phase 15 rules:

- Renaming/removing an active project does **not** rewrite WC `relatedProject` strings (no cascading update).
- Orphan strings are acceptable; WC project-qualifier matching remains string match against the qualifier field, not a live join to `activeProjects`.
- Do not add bidirectional links in Phase 15.

---

## 12. Exact files expected to change

| File | Expected change |
|---|---|
| `docs/phase-15-active-projects-lifecycle-audit.md` | This audit (design lock) |
| `electron/active-projects-lifecycle.cjs` | **New** pure planning / resolution / validation helpers (`planActiveProjectsMutation`, `resolveActiveProjectReference`, `validateActiveProjectsArray`, etc.) |
| `electron/active-projects-lifecycle.test.cjs` | **New** unit + store orchestration tests (pattern of Phase 13/14 lifecycle tests) |
| `electron/memory.cjs` | Handler **`memoryActiveProjects`** (tool name `memory_active_projects`); preview/recent wiring; reject legacy upsert; normalize/validate hooks |
| `electron/main.cjs` | `toolSpecs` entry, `executeTrustedTool` branch, `JARVIS_INSTRUCTIONS` updates, narrow `memory_update_daily` schema/description |
| `electron/session-instructions.cjs` | Only if it duplicates project rules beyond `JARVIS_INSTRUCTIONS` |
| `electron/memory.test.cjs` | Regression for rejection, rollover carry, injection |
| `electron/priority-lifecycle.cjs` / `working-context-lifecycle.cjs` | Only if shared assert helpers need export tweaks — prefer reuse without behavior change |
| `docs/phase-15-active-projects-lifecycle-implementation-report.md` | **After** implementation + live validation (not part of this audit deliverable) |

**Not expected to change for Phase 15 core:** `src/lib/realtime.ts`, `electron/text-session.cjs`, packaging, OAuth, UI chrome (beyond consuming tool artifacts as today).

---

## 13. Automated-test matrix

| # | Case | Expectation |
|---|---|---|
| T1 | `list` empty / nonempty | Canonical order, artifact; schema fields only `order,id,name,note,updatedAt` |
| T2 | `add` via `item` and via `items` | New ids; append; names/notes stored |
| T3 | `insert` at 1, middle, end | Positions correct; existing ids preserved |
| T4 | `insert` invalid `atPosition` | `VALIDATION_FAILED`; no write |
| T5 | `edit` name only / note only / both / clear note | Id preserved; omitted field unchanged |
| T6 | Ordinal resolve | 1-based full-list ordinals |
| T6b | Id resolve | Exact id hit; unknown id → `NOT_FOUND` |
| T7 | Exact name resolve | Case-insensitive |
| T8 | Distinctive phrase (≥3) unique | Resolves |
| T8b | Short non-exact phrase (<3, no exact) | `NOT_FOUND` (no substring / no silent pick) |
| T9 | Ambiguous exact / partial / significant-token | `AMBIGUOUS_MATCH`; no write |
| T10 | `recent` after add/edit | Resolves last touched |
| T11 | `recent` with none / after remove of recent | `NOT_FOUND` |
| T12 | `remove` first call without confirm | `CONFIRMATION_REQUIRED` + token; no write |
| T12b | `remove` confirm success | Deletes; unrelated fields unchanged |
| T13 | Confirm with swapped payload | Applies bound plan or `STALE_PREVIEW`; never wrong target |
| T14 | Stale token after intervening write | `STALE_PREVIEW` |
| T14b | Expired preview token (TTL) | `STALE_PREVIEW` after `PREVIEW_TTL_MS` |
| T15 | `replace` strict | Length/membership exact; id continuity for unique matched names / explicit ids |
| T15b | `replace` with duplicate existing names, no ids | Does not assign same existing id twice; unclaimed duplicates may drop |
| T15c | `replace` with empty `items` after confirm | Clears all projects |
| T16 | `reorder` single to position | Order updated; ids preserved |
| T17 | `reorder` full `order` | Exact permutation; incomplete → `VALIDATION_FAILED` |
| T18 | `restore_backup` omit `backupId` | Uses newest mtime backup; projects restored; priorities/WC/summary unchanged |
| T18b | `restore_backup` explicit `backupId` | Selects matching file; wrong id → `RESTORE_FAILED` |
| T18c | `restore_backup` no backups | `RESTORE_FAILED` |
| T19 | Unrelated-field guard on project write | Priorities/WC/summary unchanged |
| T20 | Priority/WC writes still leave projects unchanged | Existing asserts still pass |
| T21 | `memory_update_daily` with `activeProjects` key (`[]` / null / nonempty) ± summary | `USE_MEMORY_ACTIVE_PROJECTS`; no partial summary apply |
| T22 | `memory_update_daily` summary-only | Still works; projects unchanged |
| T23 | Backup-before-write | Snapshot created; backup failure blocks write |
| T24 | Atomic write + reread | Returned list matches disk |
| T25 | Rollover carries projects in order | Order preserved into new day |
| T26 | Phase 12 fallback after reorder | First project name is new lead when higher categories empty |
| T27 | Empty name rejected | `VALIDATION_FAILED` |
| T28 | Unknown op / preview without `previewOperation` | `UNSUPPORTED_OPERATION` (or documented `VALIDATION_FAILED`) |
| T29 | Client id on new add ignored | Server generates id |
| T30 | Duplicate names allowed on add; later phrase ambiguous | Add ok; resolve returns `AMBIGUOUS_MATCH` |
| T31 | `preview` of destructive op | Token + before/after; disk unchanged until confirm |
| T32 | `preview` of direct op | before/after; no confirm required to later execute direct path |
| T33 | Status/due/defer keys in input ignored | Not persisted on stored project |
| T34 | Schema on disk after write | Only `id,name,note,updatedAt` per project |

---

## 14. Ordered live-validation checklist

**Preconditions:** Automated tests green; Jarvis started only for this checklist; do not hand-edit `daily.json` during the run.

### Text path

1. List active projects (establish baseline).
2. Add a uniquely named project by ordinary language.
3. Add a second project with a note.
4. Insert a third project as position 1; confirm list order.
5. Edit name by distinctive phrase; confirm continuity via “the one I just renamed” / recent speech.
6. Edit note only; clear note.
7. Reorder (“make X my first project”); ask a broad “what should I work on?” with empty higher categories **or** inspect injection — first project must match.
8. Remove with preview → explicit confirm; verify project gone; priorities/WC/summary unchanged (`memory_view` or list tools).
9. Replace with preview → confirm (nonempty set).
10. Restore projects from backup with preview → confirm (omit backup id / “last backup”); verify other daily fields untouched.
11. Model routing: ask to change projects in ordinary language — tool must be `memory_active_projects`, not `memory_update_daily`.
12. Diagnostic: if a forced `memory_update_daily` with `activeProjects` is exercised in tests/console, expect `USE_MEMORY_ACTIVE_PROJECTS` and unchanged summary when both were sent.
13. Summary-only daily update still works and leaves projects unchanged.
14. Create two similarly named projects; refer with shared phrase → clarification (`AMBIGUOUS_MATCH`), no silent write.

### Voice path (same critical path once)

15. List / add / edit / reorder / remove-confirm once over Realtime using the shared tool path.
16. Do **not** expand into Phase 8 audio debugging (echo, reconnect, VAD).

### Completion gate for live

All text steps pass; voice smoke (step 15) passes without tool-path divergence; no JSON hand-edits required.

---

## 15. Explicit out-of-scope items

- Project status, completion, reopen, due dates, deferral, carry-to-future, clear_completed
- WC → project promote/link; project → priority promote; cascading `relatedProject` rewrites
- `all_working_context` restore; full-daily restore via this tool
- Day briefing artifact; archive browse; `memory_view` future dates
- Preview/recent persistence across app restart
- Voice audio stabilization (Phase 8)
- Connected accounts / OAuth / calendar / email / integrations
- Packaging, installers, `userData` path migration
- Conversation transcript persistence; text streaming
- Soft UI panels for projects
- schemaVersion bump unless validation proves necessity
- Editing live `data/memory/*` as part of implementation
- Note-field primary reference resolution
- Auto-deduping project names

---

## 16. Implementation sequence and completion criteria

### 16.1 Sequence

1. **Audit lock** — this document (complete).
2. **Pure module** — `electron/active-projects-lifecycle.cjs` (resolve, plan, validate, assert helpers).
3. **Memory orchestration** — `memoryActiveProjects` in `memory.cjs`; recent id; preview store reuse; backup/atomic/reread.
4. **Legacy rejection** — block `memory_update_daily.activeProjects`.
5. **Tool + instructions** — `main.cjs` `toolSpecs`, `executeTrustedTool`, `JARVIS_INSTRUCTIONS`, narrow daily tool schema.
6. **Automated tests** — matrix §13.
7. **Live validation** — checklist §14.
8. **Implementation report** — mirror Phase 13 report; record outcomes and residual limitations.

### 16.2 Completion criteria

Phase 15 is complete when **all** of the following are true:

1. `memory_active_projects` implements every in-scope operation with the contracts in §3–§6.
2. Legacy `activeProjects` upsert is structurally rejected.
3. Automated matrix §13 passes.
4. Live checklist §14 passes for text and voice smoke.
5. Unrelated daily fields remain preserved under project writes and scoped restore.
6. Phase 12 project fallback still uses stored order / first name.
7. No out-of-scope features from §15 were implemented.
8. Implementation report committed on `phase-15` (documentation only after code lands).

---

## 17. Design review (contradictions, gaps, unsafe defaults, scope creep)

### 17.1 Contradictions checked

| Topic | Resolution |
|---|---|
| Status vs name-note-only | No status ops; rollover carries all projects — consistent |
| `text` vs `name` | Input alias `text`→`name`; storage is `name` only |
| Ordinals vs Phase 12 | Both use full stored order / first = index 0 |
| Restore vs unrelated fields | Scoped projects-only restore — consistent with Phase 14 pattern |
| Summary + activeProjects on legacy call | Reject entire call — avoids partial apply surprise |
| Voice parity | Shared tool path only; no audio work |

### 17.2 Lifecycle cases covered

Add, insert, edit name/note, remove, reorder (single + full), replace, list, preview, scoped restore, recent/id/ordinal/name/phrase/ambiguous, legacy rejection, backup-before-write, atomic+reread, unrelated preservation, rollover order, Phase 12 first-project, duplicate names.

### 17.3 Unsafe defaults avoided

- No silent upsert merge.
- No trusting client ids for new rows.
- No applying summary when legacy projects payload present.
- Destructive ops require preview token bound to plan.
- Backup failure fails closed.
- Ambiguity never auto-picks.
- Replace id-continuity never reuses one existing id twice; ambiguous exact-name continuity generates a new id rather than guessing.

### 17.4 Scope-creep pressures explicitly refused

Status/due/defer/complete, promote/link, note-as-primary-resolve, restart-persistent previews, integrations, packaging, day briefing/archive, Phase 8 audio.

### 17.5 Residual limitations (accepted)

- Preview/recent state is process-local (restart loses confirm tokens / recent).
- Voice personal context can be stale until Realtime reconnect.
- WC `relatedProject` strings can orphan on rename/remove.
- Duplicate project names allowed (clarification UX required).

### 17.6 Non-blocking implementer defaults (locked here)

| Question | Audit default |
|---|---|
| Tool arg list vs return field | Args use `items` / `item`; success payload field is `projects` |
| Latest backup when `backupId` omitted | `listBackupFiles()[0]` (newest mtime) — same as priorities |
| `expectedUpdatedAt` | **Optional** |
| Unknown input keys (status/due/etc.) | **Ignore**; never persist |
| `preview` without `previewOperation` | `UNSUPPORTED_OPERATION` |
| Replace with empty `items` | Allowed after confirm (clears list) |
| Full reorder recent id | Leave unchanged (§4.4) |
| Handler / tool naming | `memoryActiveProjects` / `memory_active_projects` (Appendix C) |

No Sarah product decision remains open for Phase 15 scope.

---

## Appendix A — Authority trail

| Source | Role |
|---|---|
| Phase 15 planning report (approved) | Active Projects Lifecycle objective |
| Sarah locked decisions (this phase kickoff) | Schema, no promote/link, deferred integrations/packaging, shared voice path |
| `docs/phase-13-daily-priority-lifecycle-audit.md` + implementation report | Pattern for ops, confirm, backup, errors |
| `docs/phase-14-working-context-lifecycle-audit.md` | Scoped restore, significant-token ambiguity, unrelated asserts |
| `electron/memory.cjs` | Current project normalize, upsert, rollover, injection, Phase 12 planner |

---

## Appendix B — Speech → op quick map

| Intent | Op | Confirm |
|---|---|---|
| Show projects | `list` | No |
| Add | `add` | No |
| Put at position | `insert` | No |
| Rename / change note | `edit` | No |
| Delete | `remove` | Yes (second call) |
| Change order | `reorder` | No |
| Set exact list | `replace` | Yes (second call) |
| Undo via backup | `restore_backup` | Yes (second call) |
| Dry-run | `preview` | N/A |

---

## Appendix C — Naming cheat sheet

| Kind | Name |
|---|---|
| Tool (schema / model) | `memory_active_projects` |
| Store handler | `memoryActiveProjects` |
| Pure module | `electron/active-projects-lifecycle.cjs` |
| Validator | `validateActiveProjectsArray` |
| Recent session var | `recentActiveProjectId` |
| Legacy reject code | `USE_MEMORY_ACTIVE_PROJECTS` |
| Backup reason prefix | `active-projects-{operation}` |

---

*End of Phase 15 active-projects lifecycle audit.*
