# Phase 13 implementation report: daily-priority lifecycle

**Status:** Phase 13 implementation complete on `main` through `ecf521c`. This report is pending documentation commit.  
**Authority:** Repository commits, automated tests, shared tool/instruction sources, and the completed live-validation sequence.  
**Scope of this document:** Report only. No application code or runtime memory changes.

---

## 1. Objective and final delivered capability

### Objective

Sarah can manage daily priorities through ordinary **text and voice** without editing `data/memory/daily.json` in Cursor, without asking for UUIDs, and with deterministic reference resolution, confirmation for destructive ops, backup-before-write, and reliable copy/move across dates.

### Delivered capability

| Capability | Delivered |
|---|---|
| Dedicated lifecycle tool | `memory_priorities` (text + Realtime share one schema/handler) |
| Ordinary writes without confirm | `list`, `add`, `insert`, `edit`, `complete`, `reopen`, `reorder` |
| Destructive writes with preview | `remove`, `replace`, `clear_completed`, `carry`, `restore_backup` |
| Natural-language references | ID, ordinal, exact text, distinctive phrase, recent item |
| Status-aware complete / reopen | Open-like vs done candidate pools |
| Copy vs move across dates | Default copy; explicit move removes from today |
| Date-aware list | Today (default); tomorrow / `YYYY-MM-DD` via future files |
| Safety | Preview tokens, stale guards, backup, atomic write, reread, validation |
| Prior path retired | `memory_update_daily.priorities` → `USE_MEMORY_PRIORITIES` |

Phase 12 remains the **read-side** answer policy for “What is my first priority?”. Phase 13 is the **write-side** lifecycle.

---

## 2. Complete implemented operation set

| Operation | Confirm? | Behavior |
|---|---|---|
| `list` | No | Today’s priorities by default; `targetDate` reads future-date file |
| `add` | No | Append one or more items; stable new IDs |
| `insert` | No | Insert at exact 1-based `atPosition` |
| `edit` | No | Change wording; preserve ID, order, status |
| `complete` | No | Prefer open/blocked/active; set status `done` |
| `reopen` | No | Prefer `done`; set status `open`; preserve ID/position |
| `remove` | Yes | Delete resolved item after preview |
| `reorder` | No | Move one item to `atPosition`, or full `order` list |
| `replace` | Yes | Strict list replacement; preserve matched IDs |
| `clear_completed` | Yes | Remove `done` items; keep open/blocked |
| `carry` (copy) | Yes | Default / `move:false`: keep today; add to target date |
| `carry` (move) | Yes | `move:true`: remove from today; add to target date |
| `restore_backup` | Yes | Restore priorities from a validated backup snapshot |
| `preview` | N/A | Dry-run / nested preview for an operation |

---

## 3. Final tool schema and operation semantics

**Tool:** `memory_priorities` in `electron/main.cjs`  
**Handler:** `memoryStore.memoryPriorities` in `electron/memory.cjs`  
**Helpers:** `electron/priority-lifecycle.cjs`

### Parameters (high level)

| Field | Role |
|---|---|
| `operation` | Required enum (see §2) |
| `reference` / `item` | Source identity (string or object) |
| `items` / `order` | Bulk add / full reorder / multi-carry |
| `atPosition` | 1-based insert or reorder destination |
| `targetDate` | `"tomorrow"` or `YYYY-MM-DD` (carry + list) |
| `move` | Carry only: omit/`false` = copy; `true` = move |
| `listScope` | `open` \| `done` \| `all` (resolution pool override) |
| `confirmed` / `previewToken` | Destructive confirm binding |
| `expectedUpdatedAt` | Optional optimistic concurrency |
| `allowDuplicates` | Allow duplicate wording when true |
| `backupId` | Restore target |

### Semantics highlights

- Ordinals and phrases resolve against an **operation-default pool** unless `listScope` overrides.
- Successful writes: backup → atomic write → reread → invalidate previews.
- Destructive ops: first call returns `CONFIRMATION_REQUIRED` + preview; second call with matching `previewToken` applies the **stored** plan.

---

## 4. Natural-language reference resolution

Implemented in `normalizePriorityReference` / `resolvePriorityReference` (`priority-lifecycle.cjs`).

| Reference form | Resolution |
|---|---|
| Canonical ID / UUID string | Match by `id` (global id search) |
| Ordinal (`2`, `{by:"ordinal",value:2}`) | 1-based index into scoped pool |
| Exact wording | Case-insensitive exact text in pool |
| Distinctive phrase (≥3 chars) | Unique substring match in pool |
| `recent` | Last touched priority id |
| Shapes accepted | `{by,value}`, `{text}`, `{name}`, bare string/number, `item:{text}` |

### Ambiguity / miss

| Result | Behavior |
|---|---|
| `NOT_FOUND` | No write; report once; identical/near-identical retries suppressed in-turn |
| `AMBIGUOUS_MATCH` | Candidates returned; no write; ask one clarification |

Never ask Sarah for UUIDs in ordinary speech.

---

## 5. Status-aware complete and reopen

| Operation | Default pool | Notes |
|---|---|---|
| `complete` | `open`, `blocked`, `active` | Done items excluded from preferred set |
| `reopen` | `done` | Phrase/ordinal/exact/ID/recent against completed items |
| Explicit `listScope` | `open` / `done` / `all` | Honored when supplied |

Reopen flips **only** status `done` → `open`; preserves ID, wording, array index, and unrelated fields.

---

## 6. Confirmation and preview-token behavior

**Destructive set:** `remove`, `replace`, `clear_completed`, `carry`, `restore_backup`.

| Rule | Behavior |
|---|---|
| TTL | 10 minutes (`PREVIEW_TTL_MS`) |
| Binding | Operation, request args, and (for carry) mode/move, target date, source ids, today-after, tomorrow-after, `carryBindingVersion` |
| Confirm | Applies stored plan exactly; does not re-plan from a later bare `Confirm.` |
| Mismatch / flip move / wrong date / intervening write / expired / missing binding | `STALE_PREVIEW`, no write |
| Insert with legacy previewToken | Compatibility path applies stored insert plan; mismatched position rejected |

Carry preview artifact title: `Carry preview (copy)` or `Carry preview (move)`, with today/tomorrow before/after sections.

---

## 7. Backup, validation, atomic-write, reread, stale-write

| Protection | Behavior |
|---|---|
| Backup | Snapshot before every successful priority write (`priorities-{operation}`; carry also snapshots before future write) |
| Validation | Priority array + daily shape checks; unchanged non-priority fields asserted |
| Atomic write | Temp file + rename |
| Reread | Post-write reread; failure → `WRITE_FAILED` |
| Stale write | Optional `expectedUpdatedAt` mismatch → `STALE_WRITE` |
| Queue | Serialized memory writes via `enqueue` |
| Backup retention | Last 10 snapshots |

---

## 8. Copy-versus-move semantics

| User wording | Tool args | Today | Tomorrow |
|---|---|---|---|
| Carry / carry forward / copy | omit `move` or `move:false` | Unchanged | Selected item added |
| Move / transfer / remove-from-today-and-put-tomorrow | `move:true` | Selected item removed | Selected item added |

Shared instructions and tool description include exact JSON examples for Call Cecilia copy and move. Store default remains: omitted `move` ⇒ copy (`args.move === true` only).

---

## 9. Today, tomorrow, and explicit-date list behavior

| Call | Source |
|---|---|
| `{operation:"list"}` | `data/memory/daily.json` (today) |
| `{operation:"list",targetDate:"tomorrow"}` | `data/memory/future/daily-YYYY-MM-DD.json` |
| `{operation:"list",targetDate:"YYYY-MM-DD"}` | Same future path for that date; empty if missing |

Instructions: never answer a tomorrow/future list from today’s priorities or injected today context.

---

## 10. Rollover and deduplication behavior

| Mechanism | Behavior |
|---|---|
| Midnight rollover | Archives prior day; carries open/blocked/active priorities (and other open work categories) into the new `daily.json` |
| Future merge | If `future/daily-{today}.json` exists, merges those priorities by id (dedupe), then deletes the future file |
| Carry into future | Writes/merges into `future/daily-{target}.json` using previewed tomorrow-after list |
| Duplicate text | Rejected on add/insert/edit unless `allowDuplicates:true` |
| Carry id dedupe | Future file skips items whose id already exists |

---

## 11. Artifact and Running Response Log behavior

| Surface | Behavior |
|---|---|
| Priority artifacts | Markdown ordered list (`Daily Priorities` or date-labeled / carry-preview titles) |
| Confirmation string | Set on successful writes and lists |
| Running Response Log | Text replies deliver assistant text/artifacts into the response-log panel (Phase 11 delivery fixes; required for usable Phase 13 text validation) |
| Tool results | Sanitized for model feedback; artifacts truncated when large |

---

## 12. Shared text and Realtime voice behavior

| Concern | Implementation |
|---|---|
| Instructions | `buildSharedSessionInstructions()` → `JARVIS_INSTRUCTIONS` + personal memory + thumbnails |
| Tools | Same `toolSpecs` for Realtime token mint and text Responses |
| Handler | Same `executeTrustedTool` → `memoryPriorities` |
| Text transport | Main-process Responses API (`electron/text-session.cjs`) |
| Voice transport | Realtime WebRTC; tools unchanged |

---

## 13. Live defects discovered and corrective commits

| Live defect | Cause class | Corrective commit |
|---|---|---|
| Text Responses `unknown_parameter` (tracing) | Phase 11 transport | `23d0d9e` Fix Phase 11 text Responses requests by removing unsupported tracing |
| Text history pollution / empty success | Phase 11 history | `48c0bd6` Fix text-mode history sanitization and empty-success handling |
| Text reply not reaching Running Response Log | Phase 11 delivery | `eb50b9b` Fix Phase 11 text reply delivery to the Running Response Log |
| Response Log panel not activating | Phase 11 UI | `d48cade` Fix text replies to activate the Running Response Log panel |
| Insert intended for position 2 landed at 1 | Preview/confirm re-plan | `71a1661` Fix insert preview/confirm so position-two inserts stay at position two |
| Reorder “call Cecilia to priority one” → `NOT_FOUND` | Reference shape normalization | `1381098` Fix reorder references so natural text shapes resolve instead of NOT_FOUND |
| Reopen scanner after complete → triple `NOT_FOUND` | Open-only resolution pool | `e9e2ef0` Fix reopen so completed priorities resolve by phrase, ID, and ordinal |
| Carry preview said “move” while plan was copy | Preview wording + payload | `5ffeff2` Fix carry previews so copy and move are distinct and bound |
| “Carry …” still sent `move:true` | Model language mapping | `43492b9` Teach carry language so carry means copy, not move |
| “Show tomorrow” returned today’s three items | List had no future-date read | `ecf521c` Let priority list read tomorrow from the future-date file |

**Note:** Independent inspection after the copy-confirm live failure showed `future/daily-2026-07-27.json` already contained **only** Call Cecilia; the visible bug was list routing, not over-copy on confirm.

### Core Phase 13 delivery commits

| Commit | Summary |
|---|---|
| `8859790` | Phase 13 audit document |
| `bc79b98` | Add `memory_priorities` lifecycle management |
| `71a1661` … `ecf521c` | Corrective subphases above |

---

## 14. Final live-validation results

Completed live sequence (text unless noted). Outcomes after the corresponding fixes:

| Scenario | Result |
|---|---|
| Add | Pass — items appended with stable IDs |
| Insert | Pass — exact 1-based position preserved |
| Reorder | Pass — natural text references resolve; destination not mistaken for source |
| Complete | Pass — open items preferred; status → `done` |
| Reopen | Pass — completed items resolve by phrase/ID/ordinal; ID/position preserved |
| Rename (edit) | Pass — wording changes; ID/order/status preserved |
| Strict replace | Pass — confirm required; matched IDs kept |
| Clear completed | Pass — done removed; open/blocked kept |
| Copy to tomorrow | Pass — today unchanged; tomorrow receives selected item only |
| Move to tomorrow | Pass — selected removed from today; present tomorrow |
| Today / tomorrow date-aware lists | Pass — tomorrow list reads future file; not today’s list |
| Rollover and deduplication | Pass — open work carries; future merge dedupes by id |
| Voice add and completion | Pass — same tool path as text |

---

## 15. Automated-test results and regression coverage

### Phase 13–focused suites (counts from repository)

| Suite | Tests |
|---|---|
| `electron/priority-lifecycle.test.cjs` | 42 |
| `electron/carry-language.test.cjs` | 4 |
| `electron/memory.test.cjs` | 15 |
| `electron/priority-selection.test.cjs` | 3 (Phase 12 regression) |

### Broader regressions exercised with Phase 13 work

| Suite family | Role |
|---|---|
| Text mode / delivery / history / prompt-submit | Phase 8–11 text path |
| Realtime voice / interrupt / diagnostics | Phase 8–9 voice path |
| Platform Windows / index | Computer-use adapters |
| Branding | Jarvis naming |
| `npm run typecheck` / `npm run build` / `git diff --check` | Ship gates |

Final corrective validation runs for Phase 13 subphases reported **all listed suites green** (lifecycle, memory, Phase 12 selection, Phase 8–11 regressions, branding, typecheck, build, diff check).

---

## 16. Final changed-file inventory

### Phase 13 core + corrections

| File | Role |
|---|---|
| `docs/phase-13-daily-priority-lifecycle-audit.md` | Design audit |
| `docs/phase-13-daily-priority-lifecycle-implementation-report.md` | This report |
| `electron/priority-lifecycle.cjs` | Resolution, pools, artifacts, destructive set |
| `electron/priority-lifecycle.test.cjs` | Lifecycle tests |
| `electron/carry-language.test.cjs` | NL carry copy/move tool-loop tests |
| `electron/memory.cjs` | `memoryPriorities`, carry, list-by-date, previews |
| `electron/memory.test.cjs` | Memory + priority-selection context tests |
| `electron/main.cjs` | Tool schema, JARVIS instructions, handler wiring |

### Prerequisite text-path fixes used during Phase 13 validation

| File | Commits |
|---|---|
| `electron/text-session.cjs`, `electron/text-mode.test.cjs`, … | `23d0d9e`, `48c0bd6`, `eb50b9b` |
| `src/App.tsx`, `src/lib/textClient.ts`, `src/lib/textHistory.ts`, `src/lib/textDelivery.ts`, `src/lib/responseLogArtifact.ts` | History / delivery / panel |
| `electron/text-delivery.test.cjs`, `electron/text-history.test.cjs`, `electron/response-log-panel.test.cjs`, … | Coverage |

---

## 17. Known limitations and deferred work

| Item | Notes |
|---|---|
| Model still chooses tool args | Instructions/examples reduce error rate; store cannot infer “carry” vs “move” from speech without the model’s `move` flag |
| No interactive future-date editor UI | Future days are file-backed via carry + list; not a full calendar UI |
| `memory_view` daily scope | Still today-centric; tomorrow listing is via `memory_priorities` list + `targetDate` |
| Archive browse | Prior days in `archive/` are not a first-class list operation |
| Bulk carry without references | Omitting reference selects all open/blocked — intentional but powerful |
| OneDrive sync | Local `data/memory/` remains subject to sync races (existing platform note) |

---

## 18. Operational guidance for ordinary use

1. Prefer natural language: “Add …”, “Insert … as priority 2”, “Move call Cecilia to priority one”, “Mark the scanner item done”, “Reopen the scanner priority”.
2. **Carry** / **copy** into tomorrow keeps today; **move** / **transfer** removes from today.
3. Confirm only when Jarvis shows a destructive preview (remove, replace, clear completed, carry, restore).
4. “Show tomorrow’s priorities” must use date-aware list (`targetDate: "tomorrow"`), not today’s list.
5. Do not ask Jarvis for UUIDs; use wording, ordinals, or “the one we just changed”.
6. After ambiguous matches, answer the clarification once; do not retry identical failed tool args.
7. Prefer app text or voice over hand-editing `daily.json`.

---

## 19. Rollback and recovery procedure

| Situation | Action |
|---|---|
| Bad priority write | Restore via `memory_priorities` `restore_backup` (preview + confirm), or copy from `data/memory/backups/*` |
| Bad day | Use `archive/daily-YYYY-MM-DD.json` as reference; restore carefully |
| Bad tomorrow plan | Delete or edit `data/memory/future/daily-YYYY-MM-DD.json`, or re-carry after cleanup |
| Code regression | `git revert` the offending Phase 13 commit(s); prefer reverting corrective commits individually |
| Full tool rollback | Revert from `bc79b98` forward only with awareness that `memory_update_daily.priorities` remains rejected |

Always prefer restore-backup over manual JSON surgery when the app is running.

---

## 20. Recommended next phase

**Phase 14 (suggested): Daily working-context lifecycle parity**

Extend the same deterministic pattern beyond priorities to commitments, follow-ups, and unresolved items (list/add/edit/complete/clear with previews), plus optional archive browse and a single “day briefing” artifact — without weakening Phase 12/13 priority selection or carry/list date rules.

Alternative narrow follow-ups if Phase 14 is deferred:

- Server-side carry intent guard keyed off user utterance (stronger than instructions alone).
- `memory_view` support for future dates.
- Soft UI chrome for today vs tomorrow priority panels.

---

## Appendix A — Key commit chain (newest first)

```
ecf521c Let priority list read tomorrow from the future-date file.
43492b9 Teach carry language so carry means copy, not move.
5ffeff2 Fix carry previews so copy and move are distinct and bound.
e9e2ef0 Fix reopen so completed priorities resolve by phrase, ID, and ordinal.
1381098 Fix reorder references so natural text shapes resolve instead of NOT_FOUND.
71a1661 Fix insert preview/confirm so position-two inserts stay at position two.
bc79b98 Add memory_priorities for reliable daily-priority lifecycle management.
8859790 Add Phase 13 daily-priority lifecycle management audit.
```

## Appendix B — Primary modules

| Module | Responsibility |
|---|---|
| `electron/main.cjs` | Schema, shared instructions, tool dispatch |
| `electron/memory.cjs` | Persistence, carry/list/preview/confirm |
| `electron/priority-lifecycle.cjs` | Resolution pools, normalization, artifacts |
| `electron/session-instructions.cjs` | Shared text + Realtime instruction assembly |
| `electron/text-session.cjs` | Independent text tool loop |

---

*End of Phase 13 daily-priority lifecycle implementation report.*
