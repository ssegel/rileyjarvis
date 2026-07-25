# Phase 13 audit: reliable daily-priority lifecycle management

**Status:** Audit and design only. No application code, memory data, commit, or push.  
**Goal:** Sarah can manage daily priorities through ordinary text and voice without editing `data/memory/daily.json` in Cursor.  
**Branch context:** Documentation for Phase 13 implementation planning.

---

## 1. Executive summary

### Confirmed current state

Daily priorities live in `data/memory/daily.json` and are updated almost exclusively through the single tool **`memory_update_daily`**. That tool **upserts / merges** priority objects by `id` or exact `text` match. It **cannot**:

- strictly replace the entire priority list;
- remove an item by ordinal;
- reorder the list;
- clear only completed items;
- wipe the list via `priorities: []` (empty updates leave the list unchanged);
- resolve “the second priority” or “the website item” in code.

Natural-language reference resolution is **entirely model-side**. The model must invent or reuse IDs/text correctly. Missing ID + changed wording → **silent append**. Intended replace → **silent merge/append**. Exact IDs are effectively required for reliable edits because text-match upsert is brittle.

Backups are **not** created on every daily write. Atomic write (temp + rename) and a write queue exist, but Phase 13 still needs backup-before-write, preview/confirm for destructive ops, and deterministic reference resolution.

Phase 12 already fixed **read-side** priority *selection* (what to answer when asked “what is my first priority?”). Phase 13 must fix **write-side** lifecycle management.

---

## 2. Complete current daily-memory data model

### 2.1 File location

| Path | Role |
|---|---|
| `{cwd}/data/memory/daily.json` | Current daily working context |
| `{cwd}/data/memory/archive/daily-YYYY-MM-DD.json` | Prior-day snapshots on date rollover |
| `{cwd}/data/memory/backups/{iso}-{reason}.json` | Full memory snapshots (limited cases) |
| `{cwd}/data/memory/instructions.md` | Personal operating instructions |
| `{cwd}/data/memory/preferences.json` | Preferences / hard rules |
| `{cwd}/data/memory/profile.json` | Profile facts |
| `{cwd}/data/memory/entries.json` | Durable memory entries |

Root is configured in `electron/main.cjs` via `createMemoryStore({ rootDir: path.join(dataDir, "memory") })` with `dataDir = path.join(process.cwd(), "data")`.

### 2.2 Schema (`schemaVersion: 1`)

`defaultDaily` / `normalizeDaily` in `electron/memory.cjs`:

```json
{
  "schemaVersion": 1,
  "date": "YYYY-MM-DD",
  "summary": "",
  "priorities": [ /* work items */ ],
  "activeProjects": [ /* projects */ ],
  "commitments": [ /* commitments */ ],
  "followUps": [ /* work items */ ],
  "unresolved": [ /* work items */ ],
  "updatedAt": "ISO-8601"
}
```

### 2.3 Priority work-item fields (`normalizeWorkItem`)

| Field | Rules |
|---|---|
| `id` | String UUID; generated if missing |
| `text` | Trimmed string (from `text` / `name` / `note`) |
| `name` / `note` / `due` | Optional strings |
| `status` | Allowed: `active`, `corrected`, `cleared`, `open`, `done`, `blocked` (default `open`) |
| `updatedAt` | ISO timestamp |
| `source` | Optional `user` / `assistant` / `import` |
| `sensitivity` | Optional `normal` / `sensitive` / `secret` |

**Ordering:** Array order in `priorities` is the stored order. Open-priority display and Phase 12 selection preserve that order. There is **no** separate rank field.

**Dates:** `daily.date` is calendar day (`YYYY-MM-DD`). Item-level `due` is used for commitments, not priorities.

**Timestamps:** File-level `daily.updatedAt`; per-item `updatedAt` on upsert.

**Summaries:** `daily.summary` string; replaced wholesale when `memory_update_daily` receives `summary`.

### 2.4 Status semantics

| Context | Open treatment |
|---|---|
| Personal-context injection (`isOpenWorkStatus`) | `open` \| `blocked` |
| Rollover carry (`openDailyItems`) | `open` \| `blocked` \| `active` |
| Completed | `done` remains in array; omitted from open lists |

Done priorities are **not deleted**; they stay in `daily.json` until cleared/replaced by a future operation (none exists for priorities alone today except `memory_clear` of the whole daily scope).

### 2.5 Backup behavior (today)

| Trigger | Backup? |
|---|---|
| `memory_update_daily` | **No** |
| Date rollover | Archives prior day to `archive/` (not `backups/`) |
| `memory_clear` (confirmed) | Yes — `clear-{scope}` |
| `memory_set_instructions` replace (confirmed) | Yes — `instructions-replace` |
| Malformed JSON recovery | Yes — `malformed-daily` etc. |

`MAX_BACKUPS = 10`; pruned by mtime. Snapshot includes instructions, preferences, profile, daily, entries.

### 2.6 Migration / compatibility

- `SCHEMA_VERSION = 1` only.
- `normalizeDaily` coerces missing/invalid shapes to defaults; generates IDs for items lacking them.
- No versioned migrations beyond normalize-on-read.
- Runtime memory under `data/` is gitignored; not part of source schema migrations.

---

## 3. Every tool that can read or modify daily priorities

| Tool | Read | Write priorities | Confirmation |
|---|---|---|---|
| `memory_view` | Yes (`scope: daily` / `all`) | No | Soft: `confirmed=true` only to reveal secrets |
| `memory_update_daily` | Returns full `daily` after write | **Yes — upsert merge** | **None** |
| `memory_clear` | No | Yes — wipes entire daily (or all memory) | **Required** `confirmed=true` |
| `memory_remember` / `memory_correct` | No | No (entries/profile only) | None / id required for correct |
| `memory_set_preference` / `memory_set_instructions` | No | No | Replace instructions requires confirm |

Text (`electron/text-session.cjs`) and Realtime (`src/lib/realtime.ts` → `tools:execute`) both call the same `executeTrustedTool` / `memoryStore` path. Tool specs are shared from `main.cjs` `toolSpecs`.

---

## 4. Current `memory_update_daily` write semantics

### 4.1 Schema (current)

```text
memory_update_daily
  summary?: string
  priorities?: object[]
  activeProjects?: object[]
  commitments?: object[]
  followUps?: object[]
  unresolved?: object[]
```

No `mode`, `operation`, `replace`, `reorder`, `confirmed`, or `expectedUpdatedAt`.

### 4.2 Handler flow

1. `enqueue` (serialize writers)
2. `ensureMemoryUnlocked`
3. `rolloverDailyIfNeeded`
4. Read + normalize `daily.json`
5. If field present → apply (summary replace; lists via `upsertWorkList`)
6. Bump `daily.updatedAt`
7. `atomicWriteJson` (temp + rename)
8. Return `{ ok: true, message, daily }` — **no artifact**, **no backup**, **no post-write reread beyond the in-memory object just written**

### 4.3 `upsertWorkList` (root cause of non-strict behavior)

For each update item:

1. Normalize (new UUID if no `id`).
2. Find existing by **`id` OR exact `text` OR exact `name`**.
3. If found → shallow merge `{ ...existing, ...mapped, updatedAt }`.
4. If not found → **append**.
5. Empty `updates` array → **no changes**.

### 4.4 Why prior replace/modify attempts behaved non-strictly

| User intent | What the model typically sends | Actual result |
|---|---|---|
| Replace all priorities with three new ones | `priorities: [{text:A},{text:B},{text:C}]` without old IDs | **Appends** three new items; old items remain |
| “Make website my first priority” | New item or partial text mismatch | Append or wrong match; **no reorder API** |
| “Mark diagnostics done” without exact stored text/id | New UUID + slightly different text | **Appends** a new open item instead of completing the old one |
| “Remove the second priority” | Omit item or send empty list | **No-op** or wrong upsert; cannot remove by ordinal |
| “Clear completed” | `status` updates only if IDs/text match | Partial; no dedicated clear-completed |

**Exact IDs help** only when the model copies them from `memory_view` / prior tool results. Ordinary speech does not include IDs; text-equality matching fails on paraphrase → silent append.

### 4.5 Field preservation

- Omitted top-level fields (`followUps`, `commitments`, etc.) are **untouched**.
- Within a matched priority, unspecified fields survive via shallow merge **except** normalize may rewrite `text`/`status` from the payload.
- There is **no** way to delete a single priority object without `memory_clear` or inventing a non-existent “delete” status that still leaves the item in the array (done keeps it).

---

## 5. Natural-language reference resolution (today)

| Reference style | Code support |
|---|---|
| Ordinal (“first”, “second”) | **None** |
| Exact wording | Upsert match only if model supplies exact `text` |
| Distinctive phrase (“website”, “diagnostics”) | **None** (model must map → exact text/id) |
| Recent conversational (“that one”, “the item I just added”) | **None** in store; model memory only |
| Ambiguous matches | **No** clarification protocol in tools |

Ambiguity is handled only if the LLM asks; tools never return `AMBIGUOUS_MATCH`.

---

## 6. Completed vs open priorities

- Open for Q&A / context: `open` \| `blocked`.
- Done items remain in `daily.priorities` and appear in `memory_view` JSON.
- Phase 12 injects `Open daily priorities: none.` when no open items; follow-ups are separate.
- Rollover **drops** done items when carrying to a new day (`openDailyItems`).

---

## 7. Text and voice sharing

| Layer | Shared? |
|---|---|
| Tool specs | Yes (`toolSpecs` in `main.cjs`) |
| Handlers | Yes (`executeTrustedTool` → `memoryStore`) |
| Confirmation pattern | Same IPC; gates only where coded (`memory_clear`, instruction replace) |
| Session instructions + personal context | Yes (`buildSharedSessionInstructions`) |
| UI artifact / response log | Same renderer paths; tool artifacts vs Running Response Log rules in `App.tsx` |

No priority-specific divergence between text and Realtime beyond transport.

---

## 8. Surfacing changes in UI

| Surface | Behavior today |
|---|---|
| Running Response Log | Only if Jarvis speaks/types the change; no structured priority diff |
| Personal Memory artifact | Only when `memory_view` is called |
| `memory_update_daily` result | JSON in tool trace / model context; **no** auto artifact |
| Next turn personal context | Rebuilds open priorities from disk |

---

## 9. Failures, atomicity, diagnostics (today)

| Concern | Current behavior |
|---|---|
| Atomic write | Temp file + `rename` in `atomicWriteJson` / `atomicWriteText` |
| Write serialization | `enqueue` promise chain |
| Backup before daily write | **Missing** |
| Validate-before-replace | Normalize on read; no schema validation failure path that aborts write with taxonomy |
| Reread after write | Returns in-memory `daily`; does not re-read file |
| Duplicate wording | Allowed; second item with same text matches first on later upserts |
| Stale ID | Unknown id + new text → treated as new item (append) |
| Malformed daily.json | Backup raw + reset to default on ensure |
| Concurrent updates | Serialized by `enqueue`; no optimistic `expectedUpdatedAt` |
| Audit logging | No dedicated priority audit log; console usage elsewhere is unrelated |

Interrupted rename can leave a `.tmp` file; production path is still better than non-atomic write, but Phase 13 should define recovery.

---

## 10. Gap analysis vs Phase 13 required operations

| Required operation | Today |
|---|---|
| List current daily priorities | Partial — `memory_view` or model from context |
| Add one or more | Partial — upsert append (also used for “edits”) |
| Insert at position | **Missing** |
| Rename / edit wording | Partial — needs id/exact text; else appends |
| Mark done | Partial — same matching fragility |
| Reopen | Partial — status upsert |
| Remove | **Missing** (except clear all daily) |
| Reorder | **Missing** |
| Strict replace entire list | **Missing** (merge only) |
| Clear completed | **Missing** |
| Carry unfinished to another date | Partial — automatic midnight rollover only; no explicit “carry this into tomorrow” tool |
| Restore most recent backup | **Missing** (list/prune exist internally; no tool) |
| Preview destructive change | **Missing** for priorities |

---

## 11. Phase 13 design

### 11.1 Design principles

1. **One shared tool surface** for text and Realtime.
2. **Deterministic resolution** in main/store code — never rely on the model knowing UUIDs.
3. **Strict vs merge** modes are explicit; never silent.
4. **Stable IDs** on edit/reorder/complete/reopen; new IDs only for new items.
5. **Array order = priority order.**
6. **Backup before every successful mutating write** of daily priorities (and related daily mutations in this lifecycle).
7. **Validate → atomic write → reread → return canonical list.**
8. **Confirm destructive ops** with preview payload.

### 11.2 Canonical tool strategy (smallest safe surface)

Prefer **one** structured tool with an `operation` discriminator (keeps tool count small and shares confirmation/backup plumbing), plus keep `memory_view` for inspection.

**Recommended primary tool:** `memory_priorities`

```text
memory_priorities
  operation: enum [
    list,
    add,
    insert,
    edit,
    complete,
    reopen,
    remove,
    reorder,
    replace,
    clear_completed,
    carry,
    restore_backup,
    preview
  ]
  confirmed?: boolean
  expectedUpdatedAt?: string          # stale-write guard
  items?: PriorityInput[]             # add / replace
  item?: PriorityInput                # single-target ops
  reference?: PriorityReference       # ordinal | text | id | recent
  atPosition?: number                 # 1-based insert / reorder target
  order?: PriorityReference[]         # reorder full list
  targetDate?: string                 # carry destination YYYY-MM-DD
  backupId?: string                   # restore
  previewToken?: string               # bind confirm to prior preview
```

**`PriorityInput`:** `{ text: string, id?: string, status?: "open"|"done"|"blocked" }`  
**`PriorityReference`:**  
`{ by: "ordinal"|"text"|"id"|"recent", value: string|number, query?: string }`

Keep existing `memory_update_daily` for summary / projects / commitments / follow-ups / unresolved **or** narrow its description to “non-priority daily fields” to avoid two write paths fighting. **Smallest corrective path:** implement priority ops in `memory_priorities`; leave `memory_update_daily` but document/deprecate priority upserts in instructions (Phase 13 should stop the model from using upsert for priority lifecycle).

### 11.3 Operation semantics

| Operation | Behavior | Confirm? |
|---|---|---|
| `list` | Return canonical ordered list (id, text, status, order index) + artifact | No |
| `add` | Append one or more **new** IDs; reject empty text; allow duplicate wording only with explicit `allowDuplicates` or ask clarify | No |
| `insert` | Insert at 1-based `atPosition`; shift others; new IDs | No |
| `edit` | Resolve reference → change `text` only; **preserve id** | No |
| `complete` | Resolve → `status: done`; preserve id/order | No |
| `reopen` | Resolve → `status: open`; preserve id/order | No |
| `remove` | Resolve → delete from array | **Yes** + preview |
| `reorder` | Full new order via references or move one ref to `atPosition` | No (unless moving many via replace-like bulk — prefer no) |
| `replace` | **Strict** set `priorities` to exactly provided items; generate IDs for items without id; preserve ids when client supplies existing ids for continuity | **Yes** + preview |
| `clear_completed` | Remove all `done` (and optionally `cleared`) from priorities only | **Yes** + preview |
| `carry` | Copy/move selected open items onto `targetDate` daily file (create/normalize that date); default “tomorrow” | **Yes** if multiple or cross-date move |
| `restore_backup` | Restore daily (or full snapshot subset) from backup id / latest | **Yes** + preview |
| `preview` | Dry-run any mutating op; return diff + `previewToken` | No |

**Strict replace:** resulting array length and membership equal the request (after normalization). No leftover prior items.

**Add:** never deletes or reorders existing items except append/insert.

**Never** modify `followUps`, `commitments`, `unresolved`, `activeProjects`, or `summary` unless the operation explicitly targets them (`carry` may only touch priorities unless designed otherwise — Phase 13 default: **priorities only**).

### 11.4 Reference-resolution rules (code)

Resolve in order:

1. **`by: "id"`** — exact id; 0 matches → `NOT_FOUND`; 1 → success.
2. **`by: "ordinal"`** — 1-based index into **current full priorities array** or into **open-only** view?  
   **Decision:** Ordinals refer to the **list Jarvis last showed** / default **open priorities in stored order** for user speech (“second priority”), with `listScope: "open"|"all"` defaulting to **`open`** for complete/edit/remove speech and **`all`** when user says “second including done” or after `list` of all.  
   **Phase 13 default for spoken ordinals:** open list order (matches “my priorities” mental model). Tools accept `listScope`.
3. **`by: "text"`** — case-insensitive exact match; else unique substring/distinctive phrase match (≥1 token, length ≥ 3).
4. **`by: "recent"`** — last priority id created/edited in this app session (store session map in memory controller or main process), for “the one I just added”.

**Ambiguity:** ≥2 matches → return `{ ok: false, code: "AMBIGUOUS_MATCH", candidates: [...] }` and instruct Jarvis to ask **one** concise clarification. Do not write.

**Not found:** `{ ok: false, code: "NOT_FOUND" }`.

Sarah never needs to speak UUIDs; tools may still accept them.

### 11.5 Confirmation policy

| Requires `confirmed=true` + prior preview | Does not |
|---|---|
| `remove` | `list`, `add`, `insert`, `edit`, `complete`, `reopen`, `reorder` |
| `clear_completed` | |
| `replace` | |
| `carry` when multiple items or explicit move across dates | Single-item “remind me tomorrow” *copy* may be confirm-light — **Phase 13: confirm all carry** for safety |
| `restore_backup` | |

Preview must include before/after ordered texts + ids. Confirm must echo `previewToken` (or hash of preview payload) so stale confirms fail with `STALE_PREVIEW`.

### 11.6 Concurrency / stale writes

- Keep `enqueue`.
- Require optional `expectedUpdatedAt` matching `daily.updatedAt` for mutating ops; mismatch → `STALE_WRITE` (reread + return current list).
- Preview tokens expire after N minutes or after any successful intervening write.

### 11.7 Backup and rollback

- Before every **successful** mutating priority write: `createBackupSnapshot("priorities-{operation}")`.
- Restore: load backup daily section (or full snapshot), validate, backup current, atomic write, reread.
- Retain `MAX_BACKUPS` (raise only if tests prove need; default keep 10 unless Phase 13 explicitly bumps).

### 11.8 Atomic write + validation

1. Build next `daily` object in memory.  
2. Run `validateDaily(daily)` (schema, unique ids, non-empty texts, allowed statuses, date format).  
3. Fail → no write, `VALIDATION_FAILED`.  
4. Backup current.  
5. `atomicWriteJson`.  
6. Reread + normalize.  
7. Return canonical `{ priorities: [{ order, id, text, status, updatedAt }], dailyUpdatedAt }`.

### 11.9 Error taxonomy

| Code | Meaning |
|---|---|
| `NOT_FOUND` | Reference resolved to zero items |
| `AMBIGUOUS_MATCH` | Multiple candidates |
| `CONFIRMATION_REQUIRED` | Destructive op without confirm |
| `STALE_PREVIEW` | previewToken mismatch |
| `STALE_WRITE` | expectedUpdatedAt mismatch |
| `VALIDATION_FAILED` | Resulting daily invalid |
| `DUPLICATE_TEXT` | Add rejected without allowDuplicates |
| `BACKUP_FAILED` | Backup could not be created (fail closed: do not mutate) |
| `WRITE_FAILED` | Atomic write/rename failed |
| `RESTORE_FAILED` | Backup missing/corrupt |
| `UNSUPPORTED_OPERATION` | Unknown operation |

### 11.10 Audit logging

Emit sanitized structured logs (no secret memory content beyond priority **text** Sarah already stores as normal):

```text
[jarvis-memory] priorities
  operation, ok, code?, itemCount, backupId?, durationMs
```

Do not log full unrelated memory scopes.

### 11.11 Artifact / response log behavior

- Mutating success → return artifact `{ title: "Daily Priorities", kind: "markdown"|"text", content: numbered list with status }`.
- Also return machine-readable `priorities` array for the model.
- Jarvis should briefly confirm in speech/text (Running Response Log via normal assistant text).
- `list` always opens/refreshes Personal Memory–style priorities artifact (title **Daily Priorities** to distinguish from full `memory_view`).

### 11.12 Instruction updates (shared text + voice)

Extend `JARVIS_INSTRUCTIONS` Personal Memory section:

- Use `memory_priorities` for all daily-priority lifecycle requests.
- Do **not** use `memory_update_daily.priorities` for add/replace/complete/reorder/remove.
- Never ask Sarah for internal IDs.
- On `AMBIGUOUS_MATCH`, ask one clarification.
- On destructive ops, show preview and wait for confirm before `confirmed=true`.

---

## 12. Smallest corrective file scope

| File | Change |
|---|---|
| `electron/memory.cjs` | Priority lifecycle ops, resolve refs, validate, backup-before-write, restore, tests hooks |
| `electron/main.cjs` | Register `memory_priorities` tool; wire handler; JARVIS_INSTRUCTIONS lifecycle rules; optionally narrow `memory_update_daily` description |
| `electron/memory.test.cjs` / new `electron/priority-lifecycle.test.cjs` | Automated tests below |
| `electron/priority-selection.test.cjs` | Ensure Phase 12 rules still hold; no conflict |
| `docs/phase-13-daily-priority-lifecycle-audit.md` | This audit (docs only now) |

**Out of scope for Phase 13 code:** schema version bump unless validation requires it; editing live `data/memory/*` in repo; text/voice transport changes; artifact panel redesign beyond tool-returned artifacts; Windows/platform code.

---

## 13. Implementation sequence

1. Add pure helpers: `resolvePriorityReference`, `validateDaily`, `formatPrioritiesArtifact`, `planPriorityMutation` (preview).  
2. Implement `memoryPriorities({ operation, ... })` inside `createMemoryStore` with backup + atomic write + reread.  
3. Register tool + confirmation gate pattern in `main.cjs` (mirror `memory_clear`).  
4. Update shared JARVIS instructions.  
5. Deprecate priority upserts via `memory_update_daily` in tool description (hard-block optional: ignore `args.priorities` with explicit error `USE_MEMORY_PRIORITIES` — **recommended** to prevent regressions).  
6. Automated tests.  
7. Manual live validation.  
8. Docs/implementation report (separate from this audit).

---

## 14. Automated test plan (required)

| Test | Assert |
|---|---|
| add one | New id; length+1; order last |
| add several | Stable order; all new ids |
| insert at position | 1-based insert; neighbors shift |
| edit wording | Same id; text changed |
| complete | status done; id preserved |
| reopen | status open; id preserved |
| remove with confirmation | Without confirm → `CONFIRMATION_REQUIRED`; with preview+confirm → gone |
| reorder | Exact new order; ids preserved |
| strict replace with confirmation | Exact membership; no leftovers; confirm required |
| clear completed with confirmation | Only done removed; open preserved |
| carry forward | Open items on target date; source behavior per design |
| restore backup | Priorities restored; backup created before restore |
| ambiguous NL reference | `AMBIGUOUS_MATCH` + candidates |
| nonexistent reference | `NOT_FOUND` |
| duplicate wording | Policy enforced |
| stale ID | `NOT_FOUND` or no silent append |
| concurrent update | `STALE_WRITE` with expectedUpdatedAt |
| failed validation | No file change; no partial write |
| interrupted atomic write | Temp cleanup / no corrupt daily (simulate rename fail) |
| backup creation | Backup exists before mutate |
| no unintended field changes | followUps/commitments/summary unchanged |
| identical text and voice behavior | Same tool spec + handler path assertions |
| Running Response Log / artifact | Artifact title/content; instructions still shared |

Also keep all Phase 8–12, memory, branding, typecheck, build, `git diff --check` green.

---

## 15. Live manual-validation plan

1. Start Jarvis; ask **What are my current daily priorities?** → list artifact matches `memory_view` daily priorities.  
2. **Add call Cecilia to today’s priorities.** → appears last; backup created.  
3. **Make website work my first priority.** → reorder/insert; id stable if editing existing.  
4. **Mark the diagnostics priority done.** → done via phrase match; not appended.  
5. **Remove the second priority.** → preview → confirm → removed.  
6. **Replace today’s priorities with these three items…** → preview → confirm → exactly three.  
7. **Clear today’s completed priorities.** → preview → confirm.  
8. **Carry this unfinished priority into tomorrow.** → confirm → present on tomorrow’s daily.  
9. Repeat one flow by **voice** while connected; same results.  
10. Confirm unrelated follow-ups/projects unchanged.  
11. Restore most recent backup; verify recovery.  
12. Ambiguous phrase → one clarification; no write.

---

## 16. Rollback strategy

1. Feature-flag or ship on branch; revert commit restores prior `memory_update_daily` upsert-only behavior.  
2. Runtime: `restore_backup` / copy from `data/memory/backups/*` or `archive/daily-*.json`.  
3. If `memory_update_daily.priorities` hard-blocked, rollback must restore that path.  
4. Do not delete backups during Phase 13 rollout.

---

## 17. Why Phase 13 is necessary (cause statement)

The product already **stores** and **selects** daily priorities, but the only write API **merges by id/exact text** without ordinal resolution, strict replace, reorder, remove, clear-completed, backup-on-write, or confirmation previews. Ordinary language therefore cannot reliably manage priorities without Cursor or exact IDs — which violates the Phase 13 product requirement.

---

## 18. Document control

| Field | Value |
|---|---|
| Audit file | `docs/phase-13-daily-priority-lifecycle-audit.md` |
| Code changes in this step | **None** |
| Memory data changes | **None** |
| Commit / push | **None** |
