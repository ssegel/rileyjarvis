# Phase 14 audit: reliable working-context lifecycle

**Status:** Audit and design only. No application-code or runtime-memory edits.  
**Goal:** Sarah can manage commitments, follow-ups, and unresolved items through ordinary text and voice without editing JSON or knowing internal IDs.  
**Architectural reference:** Phase 13 `memory_priorities` deterministic lifecycle (`docs/phase-13-daily-priority-lifecycle-implementation-report.md`, `electron/priority-lifecycle.cjs`, `electron/memory.cjs`).  
**Branch context:** Documentation for Phase 14 implementation planning.

---

## Executive summary

### Confirmed current state

Commitments, follow-ups, and unresolved items live only on **`data/memory/daily.json`** as three separate arrays:

| Scope (storage key) | Canonical name in product speech |
|---|---|
| `commitments` | commitments |
| `followUps` | follow-ups |
| `unresolved` | unresolved items |

There is **no** `unresolvedItems` key and **no** dedicated lifecycle tool. The only normal writer is **`memory_update_daily`**, which **upserts / merges** by `id` or exact `text`/`name`. It cannot:

- strictly replace a scope array;
- remove by ordinal;
- reorder;
- clear completed-only;
- clear via empty array (`[]` leaves the list unchanged);
- defer, set/clear due dates as first-class ops;
- convert between scopes;
- promote to a daily priority with linkage;
- resolve references deterministically in code.

Natural-language reference resolution is **entirely model-side**. Missing ID + changed wording → **silent append**. Intended replace → **silent merge/append**. Exact IDs are effectively required for reliable edits.

Phase 13 already proved a robust pattern for daily **priorities**. Phase 14 must bring **parity of lifecycle reliability** to these three scopes, with additional semantics for **due dates, deferral, conversion, and promotion into Phase 13 priorities**.

### Design recommendation (preview)

**One shared tool** `working_context_items` with an explicit `scope` enum (`commitments` | `follow_ups` | `unresolved_items`) is preferable to three nearly identical tools. Reuse Phase 13 resolution, preview tokens, backup/atomic/reread, and confirmation gates. Add date, conversion, and promote-to-priority operations with narrow, testable semantics.

### Final Phase 14 design decisions

| Topic | Locked rule |
|---|---|
| **Lifecycle timestamps** | New items get `createdAt` + `updatedAt`. Complete sets `done` + `completedAt`. Reopen sets `open` and clears `completedAt`. Legacy items without `createdAt` remain valid; read-only normalization must not fabricate historical creation dates; a legacy item may receive `createdAt` on its next material rewrite. |
| **Deferral and rollover** | Deferral uses `deferredUntil`; status stays `open` or `blocked`. Future-deferred items remain stored and roll forward; default open lists exclude them; deferred/all filters may show them. When `deferredUntil` is today or earlier, the item returns to ordinary open-list results. Clearing deferral sets `deferredUntil` to `null` without changing ID, wording, order, or due. |
| **Cross-scope conversion** | **Move**, not copy: same ID; remove from source; insert into destination; preview + confirm required; record `previousScope`, `originScope`, `convertedAt`; preserve timestamps, wording, note, due, deferredUntil, source, sensitivity, related person/project, and applicable status. Same-scope or unsupported conversion → `INVALID_CONVERSION`. |
| **Backup restoration** | `restore_backup` requires a **specific scope** and restores **only that scope** from a validated backup. Preserve priorities, summary, activeProjects, and the other two working-context scopes. Preview shows that scope before/after. An `all_working_context` restore of all three scopes is a future option, **out of initial Phase 14 scope**. |
| **Promotion linkage** | Creates a **new** priority ID; source stays in original scope/status; source stores `linkedPriorityId`; priority stores `sourceScope` + `sourceId`. Completing one side does **not** auto-complete the other. Existing linked priority → `ALREADY_PROMOTED`. Single promotion may execute directly; **bulk** promotion requires preview + confirm. |

---

## 1. Current data model

### 1.1 File location and containing object

| Path | Role |
|---|---|
| `{cwd}/data/memory/daily.json` | Live daily working context (all three scopes) |
| `{cwd}/data/memory/archive/daily-YYYY-MM-DD.json` | Full prior-day snapshot on date rollover |
| `{cwd}/data/memory/future/daily-YYYY-MM-DD.json` | Future **priorities** planning (Phase 13 carry); not a writer for these three scopes |
| `{cwd}/data/memory/backups/{iso}-{reason}.json` | Full memory snapshots (include entire `daily`) |
| `{cwd}/data/memory/instructions.md` | Mentions commitments / follow-ups |
| `{cwd}/data/memory/preferences.json` | Hard rule “Never invent commitments” |

Root: `createMemoryStore({ rootDir: path.join(dataDir, "memory") })` in `electron/main.cjs`.

**Containing object:** `daily` (`schemaVersion: 1`) with arrays `commitments`, `followUps`, `unresolved` alongside `priorities`, `activeProjects`, `summary`, `date`, `updatedAt`.

### 1.2 Shared work-item base (`normalizeWorkItem`)

Defined in `electron/memory.cjs`:

| Field | Rules today |
|---|---|
| `id` | String UUID; generated if missing |
| `text` | From `text` \| `name` \| `note` |
| `name` | Optional string |
| `note` | Optional string |
| `due` | Optional string |
| `status` | `active` \| `corrected` \| `cleared` \| `open` \| `done` \| `blocked` (via `normalizeStatus`) |
| `updatedAt` | ISO timestamp |
| `source` | Optional `user` \| `assistant` \| `import` |
| `sensitivity` | Optional `normal` \| `sensitive` \| `secret` |

**Does not exist on work items today:** `createdAt`, `completedAt`, `deferredUntil` / `deferUntil`, `relatedPerson`, `relatedProject`, `linkedPriorityId`, `originScope`, `originId`, `resolvedAt`, `cancelledAt`.

### 1.3 Per-scope stored shape after `normalizeDaily` / write mappers

| Concern | commitments | followUps | unresolved |
|---|---|---|---|
| **Field names** | `id`, `text`, `due`, `status`, `updatedAt`, `source`, `sensitivity` | Full `normalizeWorkItem` (optional `name`/`note`/`due`/`source`/`sensitivity`) | Same as followUps |
| **IDs** | Stable UUID strings | Same | Same |
| **Status values** | Forced to `open` \| `done` \| `blocked` (else → `open`) | Full normalizeStatus set retained | Same as followUps |
| **Ordering** | Array order in `daily.commitments` | Array order in `daily.followUps` | Array order in `daily.unresolved` |
| **Wording** | `text` only (`name`/`note` stripped) | `text` (+ optional `name`/`note`) | Same as followUps |
| **Notes** | Not stored | Optional `note` | Optional `note` |
| **Dates / due** | `due` string or `null` | Optional `due` (unused in selection) | Optional `due` (unused in selection) |
| **Defer dates** | **None** | **None** | **None** |
| **createdAt** | **None** | **None** | **None** |
| **updatedAt** | Yes | Yes | Yes |
| **completedAt** | **None** | **None** | **None** |
| **Source / provenance** | Default `user` | Optional | Optional |
| **Related project / person** | **None** on item (projects are separate `activeProjects`; person/project are entry kinds) | **None** | **None** |
| **Rollover** | Open statuses carried (see §1.4) | Same | Same |
| **Archive** | Whole prior `daily` archived | Same | Same |
| **Backup** | Included in full memory snapshots | Same | Same |
| **Migration / compatibility** | Unknown statuses coerced on commitments; followUps/unresolved keep broader status set | Soft normalize | Soft normalize |

### 1.4 Rollover, archive, backup behavior

| Mechanism | Behavior for these scopes |
|---|---|
| `openDailyItems` | Carries items with status `open` \| `blocked` \| `active` |
| `rolloverDailyIfNeeded` | Archives full prior daily; new day gets carried lists; **done dropped**; summary cleared |
| Future-file merge on rollover | Merges **priorities only** from `future/daily-{today}.json` |
| `createBackupSnapshot` | Snapshots entire `daily` (all scopes) |
| `memory_priorities` `restore_backup` | Restores **priorities only**; commitments/followUps/unresolved **unchanged** |
| `memory_clear` (`daily` / `all`) | Backup then `defaultDaily()` (empties all three) |

### 1.5 Validation gap

`validateDailyShape` (`priority-lifecycle.cjs`) requires the three arrays to exist but **does not** validate item fields for them. Full item validation is Phase 14 work (mirroring `validatePrioritiesArray`).

---

## 2. Existing tools and handlers

| Surface | Path | Reads | Writes these scopes |
|---|---|---|---|
| `memory_view` | `memory.cjs` `memoryView` | Yes (daily JSON) | No |
| `memory_update_daily` | `memory.cjs` `memoryUpdateDaily` | Yes | **Yes** (upsert only) |
| `memory_priorities` | `memory.cjs` / Phase 13 | Asserts unchanged | **No** |
| `memory_remember` / `memory_correct` | entries/profile | No | No |
| `memory_clear` | clear scopes | — | Yes (wipe daily) |
| `memory_set_preference` / `memory_set_instructions` | prefs/instructions | Mentions only | No |
| Shared instructions | `JARVIS_INSTRUCTIONS` + `buildSharedSessionInstructions` | Selection / hard rules | No direct write |
| Artifact rendering | `memory_view` artifact; context injection text | Yes | No dedicated Commitments/Follow-ups artifacts |
| Backup / restore | `createBackupSnapshot`; Phase 13 restore | Full daily in backup | Restore priorities only |
| Rollover / archive | `rolloverDailyIfNeeded` | — | Rewrites carried open items |

**Tool schema (`memory_update_daily`):** accepts `summary`, `activeProjects`, `commitments`, `followUps`, `unresolved`. Rejects `priorities` with `USE_MEMORY_PRIORITIES`.

**No** work-item-specific tools exist today.

---

## 3. Existing operation behavior (by scope)

For **all three scopes**, current support is identical unless noted:

| Operation | Current support |
|---|---|
| list | Indirect: `memory_view` / injected context / model paraphrase — **no** dedicated list op |
| add | Model sends partial array → upsert **append** if no id/text match |
| insert | **Missing** |
| edit | Upsert merge by id/exact text (brittle) |
| complete | Model must send `{status:"done", …}` via upsert |
| reopen | Model must send `{status:"open", …}` via upsert |
| remove | **Missing** (cannot delete via empty/partial arrays) |
| reorder | **Missing** |
| replace | **Missing** (empty `[]` is a no-op) |
| clear completed | **Missing** |
| defer | **Missing** (no field) |
| set / change due date | Commitments: via upsert `due`; followUps/unresolved: optional field but unused in UX |
| remove due date | Possible only if merge sets `due: null` (commitments) — undocumented |
| promote to daily priority | **Missing** (model may separately call `memory_priorities` add — no link) |
| demote from daily priority | **Missing** |
| convert between scopes | **Missing** (model may delete+add incorrectly) |
| restore backup | Full-file clear/restore only; Phase 13 restore **does not** restore these scopes |

---

## 4. Current merge semantics

`upsertWorkList` (`memory.cjs`):

| Behavior | Yes / No |
|---|---|
| Append when no match | **Yes** |
| Merge by ID | **Yes** |
| Merge by exact `text` | **Yes** |
| Merge by exact `name` | **Yes** (projects / optional follow-up names) |
| Replace arrays | **No** |
| Preserve unspecified items | **Yes** (omitted keys / unmatched rows kept) |
| Silently retain omitted items on “replace intent” | **Yes** — critical failure mode |
| Silently create duplicates | **Yes** if wording changes without id |
| Require exact IDs for reliability | **Effectively yes** |
| Empty array clears list | **No** |
| Backup before write | **No** |
| `expectedUpdatedAt` | **No** |

---

## 5. Natural-language reference resolution (today)

| User phrase | Current resolution |
|---|---|
| the first commitment | Model-side ordinal over injected open list — **not deterministic in store** |
| the Cecilia follow-up | Model phrase match — may upsert wrong item or append |
| the website item | Ambiguous across scopes; model may pick priority vs follow-up |
| that unresolved issue | Model-side only |
| the one I just added | No `recentId` tracking for these scopes (Phase 13 has `recentPriorityId` only) |
| the overdue commitment | Model uses injected “due now” lines; store has no overdue query API |
| the item due Friday | No relative-date parser in store |
| the second completed follow-up | Done items omitted from injection open lists; hard for model; no scoped list API |

**Ambiguity:** No `AMBIGUOUS_MATCH` / candidate payload for these scopes. Model guesses or asks ad hoc.

**Candidate ordering:** Injected context preserves **stored array order** within each open category; “due now” commitments are listed before other open commitments.

---

## 6. Status semantics

### Allowed / used today

| Status | commitments | followUps / unresolved | Open for injection | Carried on rollover |
|---|---|---|---|---|
| `open` | Yes | Yes | Yes | Yes |
| `blocked` | Yes | Yes | Yes | Yes |
| `done` | Yes | Yes | No | No |
| `active` | Coerced → `open` on write | Allowed | **No** (`isOpenWorkStatus`) | **Yes** |
| `corrected` / `cleared` | Coerced → `open` | Allowed | No | No |

### Product concepts vs storage

| Concept | Current mapping |
|---|---|
| open | `open` (and blocked treated as open work) |
| active | Inconsistent: allowed on followUps/unresolved; coerced away on commitments; carried but not injected |
| blocked | Stored; treated as open work |
| deferred | **No status / field today**; Phase 14 uses `deferredUntil` while status stays `open`/`blocked` |
| waiting | **No** |
| done | `done` |
| resolved | **No distinct status** (speech may say “resolve” → model sets `done`) |
| cancelled | **No** |

**Phase 14 must normalize** shared open-like vs terminal statuses. Deferral is **not** a separate status: it uses `deferredUntil` while status remains `open` or `blocked` (see Final design decisions).

---

## 7. Date semantics (today)

| Concern | Current treatment |
|---|---|
| Due dates | Commitment `due` string (ideally `YYYY-MM-DD`); optional unused `due` on followUps/unresolved |
| Relative dates | **Model-only** (no store parser) |
| Defer-until | **None** |
| Overdue | `due <= today` string compare for commitments → “due now” / overdue-ish |
| No-date items | Commitments without due appear under plain `Commitments:` |
| Date rollover | Calendar `daily.date` change archives and carries open work |
| Locale / timezone | `todayDate()` uses local `Date` getters in store clock |
| Date parsing | **None** beyond string compare |
| Date display | `(due YYYY-MM-DD)` on commitment lines in context |

---

## 8. Cross-scope relationships (today)

| Capability | Current |
|---|---|
| Become a daily priority | Manual: separate `memory_priorities` add — **no link** |
| Remain linked to origin | **No** |
| unresolved → commitment | **No** first-class conversion |
| follow-up → commitment | **No** |
| Preserve ID across conversion | **N/A** / accidental if model reuses id |
| Preserve provenance / history | **No** conversion history |

Phase 13 `assertUnchangedFields` freezes these scopes during priority writes — good isolation, but no promotion bridge.

---

## 9. Text and voice parity

| Concern | Status |
|---|---|
| Shared instructions | **Yes** — `buildSharedSessionInstructions` |
| Shared tool schemas | **Yes** — `toolSpecs` |
| Shared handlers | **Yes** — `executeTrustedTool` |
| Shared confirmation rules | **Weak** — no preview tokens for these scopes; prefs `confirmBefore` is soft guidance |
| Identical artifacts | View/context only; no dedicated scope artifacts |
| Equivalent NL confirmations | Model-authored; not structured like Phase 13 |

Parity infrastructure exists; **lifecycle reliability does not**.

---

## 10. Artifact behavior (today)

| Surface | How scopes appear |
|---|---|
| Personal Memory (`memory_view`) | Raw daily JSON including all arrays; commitment sensitivity redaction; followUps/unresolved **not** redacted |
| Running Response Log | Whatever assistant text/artifacts the model emits |
| Daily briefing / injection | Labeled sections: Commitments due now, Commitments, Follow-ups, Unresolved items |
| Dedicated artifact panel | **No** Commitments / Follow-ups / Unresolved / Preview artifacts |

---

## 11. Safety and persistence (today)

| Concern | `memory_update_daily` | Phase 13 priorities (reference) |
|---|---|---|
| Serialized writes | Yes (`enqueue`) | Yes |
| Atomic write | Yes | Yes |
| Backup before every write | **No** | Yes |
| Full daily validation | Soft normalize only | `validateDailyShape` on priority commits |
| Stale-write protection | **No** | Optional `expectedUpdatedAt` |
| Destructive preview / confirm | **No** | Yes |
| Partial writes | Per-key upsert; other scopes untouched if omitted | Scope-isolated by assertion |
| Restore | Clear/backup; Phase 13 restore priorities-only | Priorities restore |

---

## 12. Failure behavior (today)

| Failure | Current handling |
|---|---|
| NOT_FOUND | **None** (append instead) |
| Ambiguous matches | Model-side only |
| Duplicates | Silent append on wording change |
| Stale IDs | Treated as new append if text also differs |
| Invalid status | Coerced |
| Invalid date | Stored as opaque string; may break `due <= today` |
| Backup failure | N/A (no backup) |
| Write failure | Propagates / incomplete UX |
| Reread failure | No post-write reread contract |
| Malformed daily | Normalize/reset paths on ensure |
| Identical failed retries | **None** for these scopes |
| Wrong scope selected by model | Common risk; no `INVALID_SCOPE` |

---

## Proposed Phase 14 architecture

### Tool choice: one shared tool vs three

| Option | Pros | Cons |
|---|---|---|
| **One `working_context_items`** | Shared resolution, preview, errors, tests; one schema; matches Phase 13 lesson | Slightly richer schema (`scope` required) |
| Three tools | Very explicit names | Triple schema/instruction/test surface; drift risk |

**Recommendation:** **One shared tool** `working_context_items` with required `scope`. Smallest robust design. Mirror Phase 13 module split:

| Module | Role |
|---|---|
| `electron/working-context-lifecycle.cjs` (new) | Normalize references, scoped pools, date filters, conversion/promote plans, artifacts |
| `electron/memory.cjs` | Persist, backup, preview store, queue, rollover integration |
| `electron/main.cjs` | Schema + shared instructions |
| Tests | `working-context-lifecycle.test.cjs` (+ instruction/schema parity tests) |

**Do not** overload `memory_priorities`. **Do** keep `memory_update_daily` for `summary` / `activeProjects` only (and reject lifecycle arrays once Phase 14 ships, analogous to priorities → `USE_WORKING_CONTEXT_ITEMS`).

### Scopes (API)

| API `scope` | Storage key |
|---|---|
| `commitments` | `daily.commitments` |
| `follow_ups` | `daily.followUps` |
| `unresolved_items` | `daily.unresolved` |

### Operations

`list`, `add`, `insert`, `edit`, `complete`, `reopen`, `remove`, `reorder`, `replace`, `clear_completed`, `defer`, `set_due_date`, `clear_due_date`, `convert`, `promote_to_priority`, `restore_backup`, `preview`.

### Proposed item schema (Phase 14)

| Field | Required | Rules |
|---|---|---|
| `id` | Yes | Stable UUID; new only for genuinely new items |
| `text` | Yes | Canonical wording |
| `note` | No | Optional note (where scope supports it) |
| `status` | Yes | `open` \| `blocked` \| `done` (speech “resolved” → `done`) |
| `due` | No | `YYYY-MM-DD` or `null` — all three scopes |
| `deferredUntil` | No | `YYYY-MM-DD` or `null`; status stays `open`/`blocked` while deferred |
| `createdAt` | Soft | Set on new items; legacy may omit until next material rewrite |
| `updatedAt` | Yes | Refresh on every material write |
| `completedAt` | Soft | Set on complete; cleared on reopen; omit/`null` when open |
| `source` | Soft | Preserve across conversion |
| `sensitivity` | Soft | Preserve across conversion |
| `relatedPerson` / `relatedProject` | No | Optional qualifiers for resolution and display |
| `linkedPriorityId` | Soft | Set by `promote_to_priority`; points at priority id |
| `previousScope` / `originScope` / `convertedAt` | Soft | Set/updated by `convert` |

**Priority linkage fields (on priority rows):** optional `sourceScope`, `sourceId` (additive; normalize must tolerate absence).

### Operation semantics (Phase 14)

| Operation | Confirmation | Key semantics |
|---|---|---|
| `list` | None | Default open list **excludes** items with `deferredUntil` later than today. Filters: deferred, all, overdue, due today/tomorrow/this week, no due date, done/recently completed, phrase/person/project. |
| `add` / `insert` | Direct | New `id`, `createdAt`, `updatedAt`; status default `open`. |
| `edit` | Direct | Same `id`; refresh `updatedAt`; never fabricate missing `createdAt` unless this rewrite is treated as material (then may set `createdAt` once for legacy). |
| `complete` | Direct | `status: done`, set `completedAt`, refresh `updatedAt`. |
| `reopen` | Direct | `status: open`, clear `completedAt`, refresh `updatedAt`. |
| `remove` / `replace` / `clear_completed` | Preview + confirm | Scope-isolated; no silent append/replace confusion. |
| `reorder` | Direct | Same IDs; stored array order is canonical. |
| `defer` | Direct | Set `deferredUntil`; status remains `open` or `blocked`; ID/wording/order/`due` unchanged. |
| clear deferral (via defer/`clear` path) | Direct | `deferredUntil: null`; ID/wording/order/`due` unchanged. |
| `set_due_date` / `clear_due_date` | Direct | Change or null `due` only. |
| `convert` | Preview + confirm | **Move** same ID source→destination; see R5/R13. |
| `promote_to_priority` | Direct (single); preview + confirm (**bulk**) | New priority ID; source retained; linkage fields; see R14. |
| `restore_backup` | Preview + confirm | **Requires `scope`**; restores **only that scope**; preserves priorities, summary, activeProjects, and the other two working-context scopes. Preview shows selected scope before/after. `all_working_context` restore is **out of initial Phase 14**. |
| `preview` | N/A | Bind plan for destructive/convert/bulk-promote/restore confirms. |

---

## Required behavior (Phase 14)

### R1–R4 — Identity and resolution

1. Sarah never needs internal IDs.  
2. Deterministic resolution: exact ID; ordinal in scoped list; case-insensitive exact wording; unique distinctive phrase (≥3); person/project qualifier (new optional fields); due-date qualifier; recent-item reference (per-scope recent id).  
3. Multiple matches → `AMBIGUOUS_MATCH` + candidates; one clarification; no write.  
4. Preserve stable IDs across edit, status, reorder, defer, due-date changes.

### R4b — Lifecycle timestamps (**decision**)

- New working-context items receive `createdAt` and `updatedAt`.  
- Completing an item sets `status` to `done` and sets `completedAt`.  
- Reopening an item sets `status` to `open` and clears `completedAt`.  
- Existing legacy items without `createdAt` remain valid.  
- Do **not** fabricate historical creation dates during read-only normalization.  
- A legacy item may receive `createdAt` when it is next materially rewritten.

### R5 — Conversion ID rule (**decision**)

Cross-scope conversion between commitments, follow-ups, and unresolved items is a **move**, not a copy:

- Preserve the **same** item `id`.  
- Remove the item from the source scope array and insert it into the destination scope array.  
- Require **preview and confirmation** because the source item is deleted from its prior array.  
- Record `previousScope`, `originScope`, and `convertedAt`.  
- Preserve `createdAt`, wording, `note`, `due`, `deferredUntil`, `source`, `sensitivity`, related-person/project fields, and applicable `status`.  
- Reject unsupported or **same-scope** conversion with `INVALID_CONVERSION`.

**Justification:** Same ID preserves backup/restore identity, avoids duplicate rows, and matches Phase 13 “edit preserves ID” intuition. Copy-with-new-ID is rejected (orphans/duplicates).

Linked promotion to priorities is **not** conversion (see R14): it creates a **new** priority id while the source remains.

### R6–R10 — Mutations

6. New IDs only for genuinely new items.  
7. Stored array order is canonical within each scope.  
8. Strict replace never silently appends leftover items.  
9. Add never silently replaces an unmatched “almost same” item (match rules stay exact id/text; phrase is resolution-only).  
10. Never modify unrelated daily fields or unrelated scopes (`assertUnchangedFields` analogue). For `restore_backup`, restore **only** the selected scope; leave priorities, summary, activeProjects, and the other two scopes untouched.

### R11–R12 — Confirmation gates

**Require preview + confirm:** `remove`, `replace`, `clear_completed`, `restore_backup` (scoped), `convert` (all moves), **bulk** promotion, and any bulk conversion.

**Execute directly:** `add`, `insert`, `edit`, `complete`, `reopen`, simple `reorder`, `defer` (including clear deferral), `set_due_date`, `clear_due_date`, and **single** `promote_to_priority` (source preserved; return structured confirmation with linkage).

### R13 — Conversion semantics

| Conversion | Meaning |
|---|---|
| unresolved → commitment | **Move** same ID into `commitments` |
| follow-up → commitment | **Move** same ID |
| commitment → follow-up | **Move** same ID |
| commitment ↔ unresolved / follow-up ↔ unresolved | **Move** same ID when supported |
| same-scope or unsupported pair | `INVALID_CONVERSION` |
| follow-up / commitment → daily priority | **Not conversion** — `promote_to_priority` (R14) |

Speech “resolve the email-access issue” → `complete` on unresolved (`done` + `completedAt`), not conversion.

### R14 — Promotion to daily priority (**decision**)

| Rule | Locked behavior |
|---|---|
| Priority ID | Always a **new** priority ID |
| Source | Remains in original scope with original status |
| Linkage | Source stores `linkedPriorityId`; priority stores `sourceScope` + `sourceId` |
| Cross-complete | Completing one side does **not** automatically complete the other in initial Phase 14 |
| Duplicate promotion | If `linkedPriorityId` points to an **existing** priority → `ALREADY_PROMOTED` |
| Confirmation | Single promotion may execute **directly**; **bulk** promotion requires preview + confirmation |
| Integration | Create priority via Phase 13 helpers **inside the same write queue**; validate full daily shape once |

### R15 — Date-aware behavior and deferral (**decision**)

Support filters/ops for: due today; due tomorrow; due this week; overdue; deferred until date; no due date; explicit `YYYY-MM-DD`; ordinary NL dates (**model resolves to ISO** before tool call; store accepts ISO and `"today"`/`"tomorrow"` tokens like Phase 13).

**Deferral / rollover:**

- Deferral uses `deferredUntil` while status remains `open` or `blocked` (no separate deferred status).  
- An item with `deferredUntil` later than today remains stored and **rolls forward** with other open/blocked work.  
- Default open-list results **exclude** future-deferred items.  
- Explicit deferred / all filters may display them.  
- When `deferredUntil` is **today or earlier**, the item automatically returns to ordinary open-list results.  
- Clearing deferral sets `deferredUntil` to `null` without changing ID, wording, order, or due date.

Timezone: continue store-local `todayDate()` consistency with Phase 13.

### R15b — Backup restoration (**decision**)

- `working_context_items` `restore_backup` **requires** a specific `scope`.  
- Restore **only** that selected scope from the validated backup.  
- Preserve `priorities`, `summary`, `activeProjects`, and the other two working-context scopes.  
- Confirmation preview shows the selected scope **before** and **after**.  
- A future explicit `all_working_context` restore may restore all three scopes; it is **outside initial Phase 14 scope**.

### R16–R17 — Preview binding

Previews show: scope, operation, selected items, before/after, due/defer changes, source and destination scopes for conversion, linked daily-priority effects for promotion (when previewed), restore before/after for the selected scope, preview token.

Tokens bind complete plan; stale on expiry, intervening write, scope/operation/source/destination/due/copy-versus-move mismatch (`STALE_PREVIEW`). Conversion is always move; any copy-versus-move mismatch in a bound plan is stale/invalid.

### R18 — Successful write pipeline

Same as Phase 13: enqueue → reread/normalize → optional `expectedUpdatedAt` → validate full daily → backup → atomic write → reread → return canonical scope list + artifact.

### R19 — Error taxonomy

`NOT_FOUND`, `AMBIGUOUS_MATCH`, `CONFIRMATION_REQUIRED`, `STALE_PREVIEW`, `STALE_WRITE`, `DUPLICATE_TEXT`, `INVALID_SCOPE`, `INVALID_STATUS`, `INVALID_DATE`, `INVALID_CONVERSION`, `ALREADY_PROMOTED`, `VALIDATION_FAILED`, `BACKUP_FAILED`, `WRITE_FAILED`, `RESTORE_FAILED`, `UNSUPPORTED_OPERATION`, plus `USE_WORKING_CONTEXT_ITEMS` when rejecting lifecycle arrays on `memory_update_daily`.

Suppress identical/near-identical failed retries in-turn (Phase 13 fingerprint pattern).

### R20 — Artifacts

| Artifact title | Content |
|---|---|
| Commitments | Order, wording, status, due/`deferredUntil`, overdue flag, person/project, linked priority, timestamps as needed |
| Follow-ups | Same |
| Unresolved Items | Same |
| Working Context Preview | Before→after for remove/replace/clear_completed/convert/bulk promote/scoped restore |

Single `promote_to_priority` may return structured confirmation without requiring the preview artifact; bulk promotion and convert/restore use Working Context Preview.

### R21 — Logging

```text
[jarvis-memory] working_context
```

Fields: `scope`, `operation`, `ok`, `code`, `itemCount`, `backupId`, `durationMs`.

---

## 22. Smallest corrective file scope

| File | Action |
|---|---|
| `electron/working-context-lifecycle.cjs` | **Create** — resolution, filters, plans, artifacts, validation |
| `electron/working-context-lifecycle.test.cjs` | **Create** — comprehensive tests |
| `electron/memory.cjs` | **Modify** — `workingContextItems` handler, recent ids, reject lifecycle upserts on `memory_update_daily` |
| `electron/main.cjs` | **Modify** — tool schema, instructions, dispatch |
| `electron/memory.test.cjs` | **Modify** — rollover/injection regressions stay green |
| `electron/priority-lifecycle.test.cjs` / Phase 12–13 suites | **Regression only** — assert priorities untouched |
| `docs/phase-14-working-context-lifecycle-audit.md` | This audit |

Optional later: extend Phase 13 priority item shape with optional `sourceScope`/`sourceId` (required for promotion linkage; normalize must tolerate absence on legacy priority rows).

---

## 23. Implementation sequence (minimize regression)

1. **Schema + normalize** — unify item fields (`due`, `deferredUntil`, `createdAt`/`completedAt` soft, optional `relatedPerson`/`relatedProject`, link fields); legacy without `createdAt` stays valid; never fabricate `createdAt` on read-only normalize.  
2. **Read path** — `list` + filters (including deferred/all and auto-return when `deferredUntil <= today`) + artifacts; no writes yet.  
3. **Core mutations** — add/insert/edit/complete/reopen/reorder (direct); enforce timestamp rules on complete/reopen.  
4. **Destructive** — remove/replace/clear_completed + preview tokens.  
5. **Dates** — defer / clear deferral / set_due / clear_due + list filters; rollover keeps future-deferred items.  
6. **Convert** — move-same-ID between the three scopes; preview + confirm; provenance fields; `INVALID_CONVERSION`.  
7. **Promote** — linked priority creation via Phase 13 helpers; `ALREADY_PROMOTED`; single direct / bulk confirm.  
8. **Restore** — scoped `restore_backup` only (one of three arrays); preserve priorities, summary, activeProjects, and the other two scopes; preview before/after for that scope.  
9. **Retire upsert** — `memory_update_daily` rejects commitments/followUps/unresolved with `USE_WORKING_CONTEXT_ITEMS`.  
10. **Instructions + text/voice parity tests** — few-shot examples; regression Phase 8–13.

---

## 24. Automated-test plan

Cover at least:

- list each scope;  
- add one and several (assert `createdAt` + `updatedAt`);  
- insert by position;  
- edit wording (ID stable; legacy without `createdAt` remains valid on read-only paths);  
- complete sets `done` + `completedAt`; reopen sets `open` and clears `completedAt`;  
- remove with confirmation;  
- reorder one + full reorder;  
- strict replace;  
- clear completed;  
- defer until date; change defer; remove defer (`deferredUntil` null; ID/wording/order/due unchanged);  
- future-deferred excluded from default open list; included in deferred/all filters;  
- when `deferredUntil` is today or earlier, item appears in ordinary open list;  
- rollover retains future-deferred open/blocked items;  
- set / change / clear due date;  
- overdue / due-today / due-this-week / no-date filters;  
- unresolved → commitment; follow-up → commitment; commitment → follow-up (same ID; removed from source; provenance fields; preserved fields);  
- same-scope conversion → `INVALID_CONVERSION`;  
- follow-up → priority promotion; commitment → priority promotion (new priority ID; source retained; `linkedPriorityId` / `sourceScope` / `sourceId`);  
- completing priority does not auto-complete source (and converse);  
- duplicate promotion prevention (`ALREADY_PROMOTED`);  
- bulk promotion requires confirmation;  
- ambiguous wording; duplicate wording; nonexistent reference;  
- ordinal; person qualifier; project qualifier; due-date qualifier; recent-item;  
- stale preview; stale write; invalid date; invalid conversion;  
- scoped restore restores only selected scope; other scopes + priorities + summary + activeProjects unchanged;  
- backup creation; atomic-write failure; reread failure;  
- no unintended scope/priority/summary changes;  
- correct artifacts;  
- identical text and voice schema/instructions;  
- no repeated identical failed retries;  
- Phase 12 selection + Phase 13 priorities regressions still pass.

---

## 25. Live manual-validation plan

### Text

1. List commitments / follow-ups / unresolved (default open list hides future-deferred).  
2. Add commitment with Friday due; verify artifact, due, `createdAt`/`updatedAt`.  
3. Complete / reopen a follow-up by phrase; verify `completedAt` set then cleared.  
4. Rename follow-up; confirm same ID via subsequent edit.  
5. Remove second unresolved (preview → confirm).  
6. Reorder commitments.  
7. Strict replace follow-ups (preview → confirm).  
8. Clear completed follow-ups.  
9. Defer a commitment until next Monday; default list hides it; deferred/all shows it; clear deferral restores open listing without changing wording/order/due.  
10. Promote follow-up to daily priority; list priorities; source still open with `linkedPriorityId`; completing priority leaves source open.  
11. Convert unresolved → commitment (preview → confirm); same ID; gone from unresolved; present in commitments with provenance.  
12. Filters: overdue, due this week, website-related phrase.  
13. Ambiguity: two “website” follow-ups → clarification.  
14. “What did I recently complete?” → list done / recent complete.  
15. Scoped restore of one scope from backup (preview before/after); confirm other scopes and priorities unchanged.

### Voice

Repeat: add commitment, complete follow-up, promote to priority (direct), convert with confirm, destructive remove confirm — same tools/artifacts.

### Safety

Confirm Phase 13 priority carry/list still works; `memory_update_daily.priorities` still rejected; working-context upsert path rejected after cutover.

---

## 26. Rollback and recovery

| Situation | Action |
|---|---|
| Bad Phase 14 write | `working_context_items` `restore_backup` with the affected **scope** (once shipped), or copy from `data/memory/backups/*` |
| Need all three scopes restored | Out of initial Phase 14; use backup file carefully or wait for future `all_working_context` restore |
| Code regression | Revert Phase 14 commits; temporarily re-enable `memory_update_daily` arrays only if needed for emergency |
| Linked priority orphan | Clear `linkedPriorityId` or remove orphan priority via Phase 13 |
| Full daily reset | `memory_clear` scope `daily` after backup |

Prefer tool restore over hand-editing JSON.

---

## Differences from Phase 13 priorities (must not ignore)

| Topic | Priorities (Phase 13) | Working context (Phase 14) |
|---|---|---|
| Primary tool | `memory_priorities` | `working_context_items` |
| Scopes | One array | Three arrays + conversion |
| Dates | Carry target dates | Due + `deferredUntil` + filters |
| Cross-tool | Future files | Promote into priorities (linked, not moved) |
| Status | open/done/blocked/active… | `open`/`blocked`/`done` + defer via `deferredUntil` |
| Timestamps | Priority `updatedAt` | `createdAt`/`updatedAt`/`completedAt` with legacy soft rules |
| Sensitivity | Less central | Commitments already sensitivity-aware — preserve |
| Restore | Priorities-only today | **Scoped** restore of one working-context array; never clobber priorities or sibling scopes |

---
## Appendix A — Current code anchors

| Symbol | File | Role |
|---|---|---|
| `normalizeWorkItem` / `normalizeDaily` | `electron/memory.cjs` | Shapes |
| `upsertWorkList` / `memoryUpdateDaily` | `electron/memory.cjs` | Current writer |
| `openDailyItems` / `rolloverDailyIfNeeded` | `electron/memory.cjs` | Carry-forward |
| `formatDailyWorkingContext` / `isCommitmentDueNow` | `electron/memory.cjs` | Injection + due-now |
| `assertUnchangedFields` / `validateDailyShape` | `electron/priority-lifecycle.cjs` | Priority isolation |
| `memory_update_daily` schema | `electron/main.cjs` | Tool surface |
| Phase 13 report §20 | `docs/phase-13-…-implementation-report.md` | Explicit Phase 14 suggestion |

## Appendix B — Representative speech → intended ops (Phase 14)

| Speech | Intended call |
|---|---|
| What commitments do I currently have? | `list` scope `commitments` |
| Add a commitment to send Greg… by Friday | `add` + `due` |
| Mark the Cecilia follow-up complete | `complete` scope `follow_ups` phrase Cecilia |
| Reopen the follow-up about the scanner | `reopen` |
| Rename the website follow-up to … | `edit` |
| Remove the second unresolved item | `remove` ordinal 2 + confirm |
| Move the Greg commitment above the website commitment | `reorder` |
| Replace my current follow-ups with these three | `replace` + confirm |
| Clear completed follow-ups | `clear_completed` + confirm |
| Deferred until next Monday | `defer` (`deferredUntil`; status stays open/blocked) |
| Promote this follow-up to a daily priority | `promote_to_priority` (direct; new priority ID; source retained) |
| Turn this unresolved item into a commitment | `convert` (move same ID; preview + confirm) |
| Resolve the email-access issue | `complete` on unresolved (`done` + `completedAt`) |
| Show commitments due this week / overdue | `list` + filter |
| Show all open follow-ups related to the website | `list` + phrase filter |
| What did I recently complete? | `list` listScope done / recent completes |
| Restore yesterday’s commitments from backup | `restore_backup` scope `commitments` + confirm |

---

*End of Phase 14 working-context lifecycle audit.*
