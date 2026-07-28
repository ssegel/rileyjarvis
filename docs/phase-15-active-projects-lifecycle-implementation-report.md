# Phase 15 implementation report: active-projects lifecycle

**Status:** Phase 15 production implementation complete on branch `phase-15` as uncommitted working-tree changes atop audit commit `7c478a7`. This report documents that implementation.  
**Authority:** `docs/phase-15-active-projects-lifecycle-audit.md`, repository code on `phase-15`, and automated tests run in the implementing Agent conversation.  
**Scope of this document:** Report only. No further application-code or runtime-memory changes in this documentation step.

---

## 1. Branch and baseline

| Item | Value |
|---|---|
| Branch | `phase-15` |
| Tracking | `origin/phase-15` (audit already pushed) |
| Baseline HEAD at implementation start | `7c478a7 Add Phase 15 active-projects lifecycle audit` |
| Working tree at implementation start | Clean |
| Jarvis / `npm run dev` | Not running; not started for this phase |
| Live validation | **Not performed** (deferred by implementation instructions) |
| Commit / push of implementation | **Not performed** |

---

## 2. Objective and delivered capability

### Objective

Sarah can manage `activeProjects` through ordinary **text and voice** with the same deterministic lifecycle pattern as Phase 13 priorities and Phase 14 working context — without editing JSON, without UUIDs, and without silent upsert/merge via `memory_update_daily`.

### Delivered capability

| Capability | Delivered |
|---|---|
| Dedicated lifecycle tool | `memory_active_projects` (text + Realtime share one schema/handler) |
| Project schema | `id`, `name`, `note`, `updatedAt` only |
| Ordinary writes without confirm | `list`, `add`, `insert`, `edit`, `reorder` |
| Destructive writes with preview | `remove`, `replace`, `restore_backup` |
| Natural-language references | ID, ordinal, exact name, distinctive phrase, significant-token overlap, recent |
| Safety | Preview tokens, stale guards, backup-before-write, atomic write, reread, validation |
| Prior path retired | `memory_update_daily.activeProjects` → `USE_MEMORY_ACTIVE_PROJECTS` |
| Summary path retained | `memory_update_daily.summary` still works |

Locked out of Phase 15 (honored): project status/due/defer/complete, WC→project promote/link, integrations/packaging, Phase 8 audio work.

---

## 3. Files changed

| File | Change |
|---|---|
| `electron/active-projects-lifecycle.cjs` | **Added** — pure resolve/plan/validate helpers |
| `electron/active-projects-lifecycle.test.cjs` | **Added** — Phase 15 automated suite |
| `electron/memory.cjs` | `memoryActiveProjects` orchestration, preview/confirm, scoped restore, `recentActiveProjectId`, legacy rejection |
| `electron/main.cjs` | Tool spec, `executeTrustedTool` route, shared `JARVIS_INSTRUCTIONS`, menu copy, summary-only `memory_update_daily` schema |
| `electron/memory.test.cjs` | Seed projects via `memoryActiveProjects` instead of retired upsert |
| `electron/priority-lifecycle.test.cjs` | Same seeding update for unrelated-field fixtures |
| `electron/working-context-lifecycle.test.cjs` | Seeding update + instruction-string assertion for active-projects wording |
| `docs/phase-15-active-projects-lifecycle-implementation-report.md` | **This report** |

Approximate tracked diff at report time (excluding this new report and untracked pure module/tests until staged):  
`electron/main.cjs`, `electron/memory.cjs`, and regression test edits — **+736 / −22** on the five previously modified tracked files; plus two new untracked implementation files.

---

## 4. Implementation summary

1. **Pure module** (`active-projects-lifecycle.cjs`) implements reference normalization/resolution, canonicalization, artifact formatting, `planActiveProjectsMutation`, and `validateActiveProjectsArray`.
2. **Memory orchestration** (`memoryActiveProjects` in `memory.cjs`) implements the audit write pipeline: enqueue → unlock/rollover → optional `expectedUpdatedAt` → plan → confirm gate → unrelated-field assert → validate → backup → atomic write → reread → recent-id update.
3. **Tool surface** registers `memory_active_projects` beside priorities/WC; text and Realtime both call `executeTrustedTool` → `memoryStore.memoryActiveProjects`.
4. **Legacy upsert** removed from `memoryUpdateDaily`; own-property presence of `activeProjects` (including `[]` / `null`) rejects the entire call.
5. **Regression fixtures** that previously seeded projects through `memory_update_daily.activeProjects` now use `memoryActiveProjects`.

---

## 5. Audit requirements satisfied

| Audit area | Status |
|---|---|
| Schema limited to id/name/note/updatedAt | Satisfied |
| Operations list/add/insert/edit/remove/reorder/replace/preview/restore | Satisfied |
| Confirmation only for remove/replace/restore | Satisfied |
| Reference resolution (ordinal/id/exact/phrase/ambiguous/recent + significant tokens) | Satisfied |
| Preview tokens, stale rejection, bound-plan confirm | Satisfied |
| Backup-before-write + fail-closed | Satisfied |
| Scoped restore (projects only) | Satisfied |
| Legacy `USE_MEMORY_ACTIVE_PROJECTS` rejection | Satisfied |
| Unrelated-field preservation both directions | Satisfied |
| Rollover / personal context / Phase 12 first-project / no WC link cascade | Satisfied (behavior preserved; no scope creep) |
| Shared text/Realtime tool path | Satisfied |
| Automated test matrix | Satisfied in suite (see §11) |
| Live validation checklist | **Deferred** (explicitly not run) |

---

## 6. Architecture and data-flow changes

```text
Text turn  → text-session → executeTool → executeTrustedTool
Voice turn → Realtime DC  → tools:execute IPC → executeTrustedTool
                                              ↓
                                    memoryStore.memoryActiveProjects
                                              ↓
                         planActiveProjectsMutation (pure)
                                              ↓
              previewStore (destructive)  or  commitActiveProjectsDaily
                                              ↓
                    backup → atomicWriteJson(daily.json) → reread
```

| Concern | Behavior |
|---|---|
| Storage | Still `data/memory/daily.json` → `activeProjects[]` |
| Process recent id | `recentActiveProjectId` (process-local) |
| Preview store | Shared in-memory `previewStore` with `kind: "active_projects"` |
| Unrelated asserts | Reuses WC `assertUnrelatedUnchanged` with `allowedKeys: ["activeProjects"]` |
| Priority/WC writers | Continue protecting `activeProjects` as unrelated |

---

## 7. Tool and instruction changes

### Tool: `memory_active_projects`

Operations enum: `list`, `add`, `insert`, `edit`, `remove`, `reorder`, `replace`, `restore_backup`, `preview`.

Key args: `reference`, `item` / `items`, `order`, `atPosition`, `backupId`, `confirmed`, `previewToken`, `previewOperation`, `expectedUpdatedAt`.

### `memory_update_daily`

- Description and schema narrowed to **summary only**.
- `activeProjects` property removed from tool parameters.

### Shared instructions (`JARVIS_INSTRUCTIONS`)

- Route all active-project lifecycle requests to `memory_active_projects`.
- Forbid `memory_update_daily.activeProjects`.
- Direct execute for add/insert/edit/reorder; preview+confirm for remove/replace/restore.
- Success claims require `ok:true`.
- Menu markdown documents active-project lifecycle capabilities.

---

## 8. Legacy-path rejection behavior

Detection:

```text
Object.prototype.hasOwnProperty.call(args, "activeProjects")
```

| Call | Result |
|---|---|
| `{ summary }` only | Allowed |
| `activeProjects` present (`[]`, `null`, or nonempty), alone or with summary | Entire call rejected; summary **not** partially applied |
| Response | `{ ok: false, code: "USE_MEMORY_ACTIVE_PROJECTS", error: "..." }` |

Destructive confirm gate: `confirmed !== true` → `CONFIRMATION_REQUIRED` (mint preview); `confirmed: true` without/`invalid`/`expired`/`mismatched` token → `STALE_PREVIEW`.

Legacy rejection and confirm-gate behavior are covered by automated tests and shared instructions/tool schema.

---

## 9. Unrelated-field preservation

### Project writes preserve

`priorities`, `commitments`, `followUps`, `unresolved`, `summary`, `date`, `schemaVersion`  
Allowed to change: `activeProjects`, `daily.updatedAt`.

### Priority / WC / summary-only writes preserve projects

Existing Phase 13/14 asserts remain; regression tests still verify `activeProjects` unchanged after priority/WC mutations. Summary-only `memory_update_daily` leaves projects unchanged.

---

## 10. Automated tests added

**Primary suite:** `electron/active-projects-lifecycle.test.cjs` (21 tests), covering:

- list / add (`item` + `items`) / insert / edit (name, note, clear note)
- invalid insert position; empty add
- ordinal, id, exact, phrase, short-phrase NOT_FOUND, ambiguous, recent, significant-token ambiguity
- remove preview/confirm; swapped confirm → `STALE_PREVIEW` (never wrong target)
- intervening-write stale token; confirmed-without-token and expired-token `STALE_PREVIEW`
- replace continuity with duplicate names; empty replace clear
- reorder single + full; incomplete full order
- scoped restore; unrelated field preservation
- explicit/missing backupId
- bidirectional unrelated preservation
- legacy rejection (`[]` / `null` / nonempty ± summary); summary-only success
- backup failure fail-closed; client id ignored on add
- rollover order carry; Phase 12 fallback lead after reorder
- empty name; unknown op; preview dry-run vs destructive mint; status/due keys ignored on disk
- add with empty `items` + `item` falls back to `item`
- duplicate names allowed; remove clears recent when removed

**Regression fixture updates:** `memory.test.cjs`, `priority-lifecycle.test.cjs`, `working-context-lifecycle.test.cjs`.

---

## 11. Exact test commands and results

### Phase 15 focused suite

```text
node --test electron/active-projects-lifecycle.test.cjs
```

**Result:** `21` pass, `0` fail.

### Combined Phase 15 + Phase 13/14 + memory regressions

```text
node --test electron/active-projects-lifecycle.test.cjs electron/priority-lifecycle.test.cjs electron/working-context-lifecycle.test.cjs electron/priority-selection.test.cjs electron/memory.test.cjs
```

**Result:** `103` pass, `0` fail.

---

## 12. `git diff --check` result

```text
git diff --check
```

**Result:** clean (no trailing-whitespace / conflict-marker warnings reported).

---

## 13. `git status --short` result (at report authoring)

Before this report file existed, implementation status was:

```text
 M electron/main.cjs
 M electron/memory.cjs
 M electron/memory.test.cjs
 M electron/priority-lifecycle.test.cjs
 M electron/working-context-lifecycle.test.cjs
?? electron/active-projects-lifecycle.cjs
?? electron/active-projects-lifecycle.test.cjs
```

After creating this report, expect the additional untracked path:

```text
?? docs/phase-15-active-projects-lifecycle-implementation-report.md
```

HEAD remains `7c478a7` until an implementation (+ report) commit is requested.

---

## 14. Remaining risks or unresolved issues

| Item | Notes |
|---|---|
| Preview/recent process-local | Restart loses confirm tokens and recent id (audit-accepted) |
| Voice context staleness | Realtime still injects memory at token mint; text refreshes each turn (audit-accepted) |
| Orphan WC `relatedProject` strings | Rename/remove does not cascade (by design) |
| Duplicate project names | Allowed; resolution returns `AMBIGUOUS_MATCH` |
| Implementation not yet committed/pushed | Working tree holds all Phase 15 code + this report |
| Live validation not run | Text/voice checklist in audit §14 still outstanding |

No open Sarah product decisions for Phase 15 scope; implementer defaults from audit §17.6 were followed (`items`/`item` args, `projects` return field, optional `expectedUpdatedAt`, ignore unknown keys, empty replace after confirm).

---

## 15. Live-validation status

**Not started.** Per implementation instructions: do not start Jarvis; do not perform live validation yet.

Outstanding when live validation is authorized (from audit §14):

1. Text path: list/add/insert/edit/reorder/remove-confirm/replace-confirm/restore-confirm, model routing to `memory_active_projects`, summary-only still works, ambiguous phrase clarification.
2. Voice smoke once over shared tool path (no Phase 8 audio debugging).

---

## 16. Recommended next step

1. **Commit** Phase 15 implementation files + this implementation report on `phase-15` (when Sarah requests).
2. **Push** `phase-15` (when Sarah requests).
3. **Run live validation** checklist from the audit (text first, then voice smoke).
4. Optionally open a PR to `main` after live validation passes.

Do **not** begin packaging, integrations, day-briefing/archive, or Phase 8 audio work as part of closing Phase 15.

---

## Appendix A — Operation confirm matrix

| Op | Confirm |
|---|---|
| `list` | No |
| `add` | No |
| `insert` | No |
| `edit` | No |
| `reorder` | No |
| `remove` | Yes |
| `replace` | Yes |
| `restore_backup` | Yes |
| `preview` | N/A |

## Appendix B — Error codes implemented

`NOT_FOUND`, `AMBIGUOUS_MATCH`, `CONFIRMATION_REQUIRED`, `STALE_PREVIEW`, `STALE_WRITE`, `VALIDATION_FAILED`, `BACKUP_FAILED`, `WRITE_FAILED`, `RESTORE_FAILED`, `UNSUPPORTED_OPERATION`, `USE_MEMORY_ACTIVE_PROJECTS`

---

*End of Phase 15 active-projects lifecycle implementation report.*
