# Phase 15 implementation report: active-projects lifecycle

**Status:** Phase 15 complete on branch `phase-15`. Implementation is committed and pushed (`15b6f27`); automated tests passed; live validation (text + Realtime smoke) passed; cleanup restored the original three-project list.
**Authority:** `docs/phase-15-active-projects-lifecycle-audit.md`, repository code on `phase-15`, automated tests, and live validation performed in the implementing Agent conversations.
**Scope of this document update:** Report only. No production-code changes in this documentation step.

---

## 1. Branch and baseline

| Item | Value |
|---|---|
| Branch | `phase-15` |
| Tracking | `origin/phase-15` (synchronized after push) |
| Audit commit | `7c478a7 Add Phase 15 active-projects lifecycle audit` |
| Implementation commit | `15b6f27 Implement Phase 15 active-projects lifecycle` |
| Jarvis / `npm run dev` | Started for live validation; stopped after finalization |
| Live validation | **Passed** (see §15) |
| Merge to `main` | Not performed (out of this step) |

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
| `docs/phase-15-active-projects-lifecycle-implementation-report.md` | **This report** (updated after live validation) |

Implementation commit `15b6f27`: **8 files changed, 2282 insertions(+), 22 deletions(-)**.

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
| Preview tokens, stale rejection, bound-plan confirm | Satisfied (live + automated) |
| Backup-before-write + fail-closed | Satisfied |
| Scoped restore (projects only) | Satisfied (live) |
| Legacy `USE_MEMORY_ACTIVE_PROJECTS` rejection | Satisfied (automated; not forced live) |
| Unrelated-field preservation both directions | Satisfied (live + automated) |
| Rollover / personal context / Phase 12 first-project / no WC link cascade | Satisfied |
| Shared text/Realtime tool path | Satisfied (live) |
| Automated test matrix | Satisfied (`103` combined pass) |
| Live validation checklist | **Satisfied** (see §15; minimal voice smoke accepted) |

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

### Live confirmation

During live validation, priorities, working-context arrays, empty summary, `date`, and `schemaVersion` remained unchanged across project mutations after day rollover (verified against mid-session backups and post-restore/cleanup snapshots).

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

Checked at implementation pre-commit and again after this live-validation report update.

```text
git diff --check
```

**Result:** clean (no trailing-whitespace / conflict-marker warnings reported).

---

## 13. Repository state after live-validation report update

Implementation remains at `15b6f27`. This documentation update is the only expected working-tree change:

```text
 M docs/phase-15-active-projects-lifecycle-implementation-report.md
```

`data/memory`, `.env`, `node_modules`, and unrelated paths must remain untracked/unmodified in Git.

---

## 14. Remaining risks or unresolved issues

| Item | Notes |
|---|---|
| Preview/recent process-local | Restart loses confirm tokens and recent id (audit-accepted; observed live) |
| Voice context staleness | Realtime still injects memory at token mint; text refreshes each turn (audit-accepted) |
| Orphan WC `relatedProject` strings | Rename/remove does not cascade (by design) |
| Duplicate project names | Allowed; resolution returns `AMBIGUOUS_MATCH` (live-confirmed) |
| Compound multi-action model planning | Voice compound edit+reorder+list omitted edit; single-op voice rename passed (instruction follow-up) |
| Backup retention (`MAX_BACKUPS = 10`) | Long live session pruned the exact pre-validation three-project snapshot; cleanup used replace |
| Merge to `main` | Not yet requested |

No open Sarah product decisions for Phase 15 scope; implementer defaults from audit §17.6 were followed.

---

## 15. Live validation

**Result:** Passed. Jarvis was started with `npm run dev` for this checklist only; `daily.json` was not hand-edited.

### 15.1 Validated operations and results

| Operation / check | Path | Result |
|---|---|---|
| `list` | Text | Baseline established (`itemCount` progressed correctly through the session) |
| `add` | Text | Unique project added (`ok:true`) |
| `insert` | Text | Insert at position 1 (`ok:true`) |
| `edit` | Text | Name/note edits (`ok:true`) |
| `reorder` | Text | Order changed (`ok:true`) |
| `remove` preview → confirm | Text | Preview then confirmed removal (`ok:true`) |
| Stale-preview rejection | Text | `STALE_PREVIEW` observed; disk unchanged until valid confirm |
| `replace` preview → confirm | Text | Nonempty replace applied (`ok:true`) |
| Expired / invalid preview rejection | Text | Confirm with stale/invalid token → `STALE_PREVIEW`; no wrong write |
| `restore_backup` (explicit backup file) | Text | Scoped restore to four-project pre-replace state (`ok:true`) |
| Ambiguous reference | Text | `AMBIGUOUS_MATCH` on shared “website” phrase; no removal write |
| Realtime routing | Voice | Tool calls used `memory_active_projects` (shared `executeTrustedTool` path) |
| Single-operation voice rename | Voice | Edit renamed project (`ok:true`) |
| Cleanup `replace` | Text | Restored original three-project list (`ok:true`) |

Runtime logs for the session showed only `[jarvis-memory] active-projects …` for project lifecycle work — no `memory_update_daily` project writes.

### 15.2 Confirmation and stale-preview behavior

- Destructive ops (`remove`, `replace`, `restore_backup`) minted previews and required `confirmed=true` + matching `previewToken`.
- Invalid or stale confirms returned `STALE_PREVIEW` and left disk unchanged.
- Successful confirms applied the bound plan and created pre-write backups under `data/memory/backups/`.
- `CONFIRMATION_REQUIRED` mint events are not separately logged today (diagnostic gap; optional follow-up).

### 15.3 Successful scoped restore

- Explicit restore from `2026-07-28T17-45-54-435Z-active-projects-replace.json` (and later successful restores) restored projects only.
- Unrelated daily fields remained intact relative to pre-restore snapshots.

### 15.4 Unrelated-field preservation findings

Across live project mutations after day rollover:

- **Unchanged:** priorities, commitments, follow-ups, unresolved, summary, `date`, `schemaVersion`
- **Allowed to change:** `activeProjects`, `daily.updatedAt`
- Day rollover earlier in the long-running session (date 2026-07-27 → 2026-07-28) is separate from project-tool side effects.

### 15.5 Text and Realtime routing

- Text and Realtime both used `memory_active_projects` via the shared trusted tool path.
- No live evidence of project writes through `memory_update_daily`.

### 15.6 Temporary OpenAI 429 rate limiting

- Multiple `jarvis-text` turns returned `errorCode: "rate_limited"` / HTTP 429 during remove and restore confirmation sequences.
- Rate limits did **not** clear in-memory preview tokens by themselves, but delayed turns and encouraged remints/retries that contributed to `STALE_PREVIEW` friction and one wrong-direction restore retry before a successful explicit restore.

### 15.7 Process-local preview-token behavior and confirmation timing

- Preview tokens live in process-local `previewStore` with shared `PREVIEW_TTL_MS` (10 minutes).
- Successful writes call `invalidatePreviews()` and clear pending tokens.
- Prompt confirms that failed with `STALE_PREVIEW` were primarily **missing/wrong/cleared tokens** (model/tool-routing), not TTL expiry; TTL and process-local design remain audit-accepted.
- Realtime reconnect does not clear the preview store; app restart would.

### 15.8 Compound vs single-operation voice

- Compound spoken request (rename + move to top + list) executed **reorder only**; edit was omitted; speech reported only the move. Tool did not reject a failed edit — edit was never called.
- Root cause: model planning / instruction bias (“call … once” for direct ops), not a `memory_active_projects` multi-op defect. Sequential tool calls are supported.
- **Single-operation voice rename passed**, satisfying minimal Realtime smoke for Phase 15 close.

### 15.9 Final cleanup state

After successful cleanup replacement, active projects are exactly:

1. Jarvis personal desktop assistant
2. APC website rebuild
3. AI consulting career transition

Note: the exact three-project-only backup from session start was pruned by `MAX_BACKUPS = 10` during the long validation run; cleanup therefore used **replace** rather than restore from that pruned snapshot.

### 15.10 Phase 15 completion conclusion and optional follow-ups

**Conclusion:** Phase 15 Active Projects Lifecycle is **complete** for audit scope: implementation shipped, automated tests green, live text checklist passed, Realtime shared-path smoke passed (single-op rename), cleanup restored the original three-project list. No production-code correction is required to close the phase.

**Optional follow-ups (not Phase 15 blockers):**

1. Instruction wording: multi-action requests must issue sequential `memory_active_projects` calls and not stop after one op.
2. Stronger preview diagnostics: log `CONFIRMATION_REQUIRED` mints and `STALE_PREVIEW` reason codes.
3. Normalize restore `backupId` matching (filename vs `createdAt` stamp forms).
4. Consider higher backup retention or protect baseline snapshots during long live sessions.

Do **not** treat packaging, integrations, day-briefing/archive, or Phase 8 audio as Phase 15 close work.

---

## 16. Recommended next step

1. **Commit** this live-validation report update on `phase-15` (when Sarah requests).
2. **Push** and optionally open a PR to merge `phase-15` into `main` (when Sarah requests).
3. Optionally schedule the instruction/diagnostics follow-ups above as a small polish change — not required to declare Phase 15 done.

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
