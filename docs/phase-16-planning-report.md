# Phase 16 planning report

**Status:** Planning only. No audit lock, implementation, Jarvis start, commit, or push.

---

## Baseline confirmation

| Check | Result |
|---|---|
| Active branch | `phase-16` |
| Working tree | Clean (`git status -sb` shows only `## phase-16`) |
| HEAD vs `main` | Identical at `660da15` (`Merge branch 'phase-15'`); `0 0` ahead/behind |
| Phase 16 work | None started; no Jarvis/`npm run dev` assumed/running |

---

## Evidence map (before scope choice)

### What Phases 13–15 closed

Deterministic lifecycle write paths now cover the full daily working set:

- Priorities → `memory_priorities`
- Commitments / follow-ups / unresolved → `working_context_items`
- Active projects → `memory_active_projects`
- `memory_update_daily` is summary-only

Rollover already **writes** `data/memory/archive/daily-YYYY-MM-DD.json` (local archives exist for 2026-07-22 … 07-27). Injection already formats labeled daily sections via `formatDailyWorkingContext`, but that is **prompt injection**, not a user-facing briefing/archive product.

### Explicitly deferred across audits/reports

Repeatedly pushed out of Phases 13–15:

- Day briefing artifact + archive browse
- Preview/recent persistence across restart
- Voice personal-context freshness (mint-only)
- Integrations / OAuth / packaging / installer
- Phase 8 residual audio work

### Live Phase 15 findings (not blockers for 15, still real)

- 429 friction during confirm sequences
- Process-local preview/recent loss on restart
- Compound voice multi-op planning omission (instruction bias, not store bug)
- Optional polish: preview diagnostics, backup retention, restore id matching

### Candidate evaluation

| Candidate | Bucket | Verdict |
|---|---|---|
| **Daily Executive Briefing + archive continuity** | User-facing capability gap | **Highest next value** — lifecycle write parity is done; read/orient across days is the missing product surface named since Phase 13 |
| Persistence/restart for previews + recent refs | Reliability / technical debt | High value, cross-cutting; real live pain; better as hardening after briefing or as Alt #1 |
| OpenAI rate-limit / retry / pending-op preservation | Reliability defect | Confirmed live; text classifies 429 but has no wait/retry UX preserving confirm flow; Alt #2 |
| Compound multi-action planning/verification | Optional enhancement / instruction debt | Narrow; store already supports sequential calls; not a full phase |
| Realtime memory freshness / session refresh | Required architectural gap (voice) | Important for long voice sessions; higher Realtime risk/API cost; Alt #3 |
| Phase 8 voice stabilization debt | Deferred residual | 8 + 8b already shipped media lifecycle + barge-in gate; remaining echo/mic work is expensive live validation |
| Connected-account / integration architecture | Deferred | Explicitly deferred; no OAuth/packaging foundation |
| Startup / packaging / installer | Deferred | No `electron-builder`/Forge; still `npm run dev` — premature vs daily UX continuity |
| Stronger alternate | — | No stronger Phase 16 than briefing/archive after 13–15 lifecycle completion |

---

## 1. Recommended Phase 16 title and objective

**Title:** Daily Executive Briefing and Archive Continuity

**Objective:** Sarah can ask Jarvis for a deterministic executive briefing of a day (today, and prior archived days) and browse archive continuity without editing JSON, inventing memory, or depending only on silent prompt injection.

---

## 2. Why this is the correct next phase

1. **Product continuity:** Phases 13–15 finished *managing* daily work. The next missing capability is *orienting* across that work and prior days.
2. **Repository evidence:** Phase 13 §20 already proposed “archive browse + day briefing”; Phase 15 audit/report explicitly kept that deferred.
3. **Infrastructure already exists:** archive files, `formatDailyWorkingContext`, future-date priority listing, shared text/voice tool path — Phase 16 can compose and expose, not invent storage.
4. **Avoids premature leaps:** packaging, OAuth, and Phase 8 audio remain correctly deferred; reliability hardening is valuable but secondary to the user-facing gap now that lifecycle parity exists.

---

## 3. Exact in-scope functionality

1. **Deterministic day briefing** (new tool, e.g. `memory_day_briefing` or equivalent ops under a small briefing module):
   - Compose from stored daily data only (no invented items).
   - Default target: **today** after rollover/load.
   - Sections aligned with existing injection categories: summary, open priorities, commitments due now / other open commitments, open follow-ups, open unresolved, active projects (and empty-state lines where needed).
   - Emit a **markdown artifact** suitable for the panel + concise spoken/text lead.
2. **Archive continuity (read-only):**
   - List available `archive/daily-YYYY-MM-DD.json` dates.
   - Brief/view a specific prior date from archive.
   - Clear errors for missing/malformed archive dates.
3. **Optional narrow date targets (if low-risk):**
   - `yesterday` → archive of previous calendar day when present.
   - `tomorrow` → read-only compose from `future/daily-YYYY-MM-DD.json` (and/or empty future) without mutating today — only if it reuses existing future-file helpers cleanly.
4. **Shared path:** text + Realtime via `executeTrustedTool`; instruction examples for “brief me”, “what did yesterday look like”, “show archives”.
5. **Sensitivity rules:** match existing memory redaction (`secret`/`sensitive`); no secret payload in ordinary briefing without confirmed view rules.
6. **Automated coverage** for composition, archive list/read, empty days, unrelated-field non-mutation, and instruction routing examples.
7. **Tiny instruction hygiene only if briefing instructions are already open:** one line clarifying multi-action sequential tool calls — not a full compound-planning subsystem.

---

## 4. Explicit out-of-scope functionality

- Editing, deleting, or rewriting archive files
- Full-day restore-from-archive (or any new destructive restore path)
- Preview/recent persistence across restart
- Text/Realtime 429 auto-retry / pending-confirm UX redesign
- Realtime `session.update` memory refresh / voice context refresh
- Compound multi-action completion verification engine
- Phase 8 echo/mic mute / audio experiments
- Connected accounts, OAuth, calendar, email, integrations
- Packaging, installer, `userData` migration
- Soft calendar UI / dashboard chrome
- Expanding project status/due/complete or WC→project promote/link
- Conversation transcript persistence
- Raising backup retention / Phase 15 diagnostic logging (unless Sarah later asks)

---

## 5. Likely files and systems affected

| Area | Likely touch |
|---|---|
| New module | `electron/day-briefing-lifecycle.cjs` (or similar) |
| Memory IO | `electron/memory.cjs` — archive list/read; briefing orchestration; reuse `formatDailyWorkingContext` / normalize helpers |
| Tools + instructions | `electron/main.cjs` — tool spec, `executeTrustedTool`, `JARVIS_INSTRUCTIONS` |
| Tests | `electron/day-briefing*.test.cjs` (+ light `memory.test.cjs` archive cases) |
| Docs | Phase 16 audit + implementation report under `docs/` (after kickoff) |
| Unchanged by design | `src/lib/realtime.ts` audio path, packaging, OAuth, lifecycle write semantics for 13–15 tools |

---

## 6. Main risks and dependencies

| Risk | Mitigation |
|---|---|
| Model invents briefing content instead of calling the tool | Strong tool description + examples; briefing content built in code |
| Archive vs today vs future confusion | Explicit `targetDate` / `source` in tool args and artifact title |
| Sensitivity leaks in briefing | Reuse redaction rules from injection/`memory_view` |
| Scope creep into restore/edit archive | Hard out-of-scope; read-only |
| Overlap with Phase 12 “what’s my priority?” | Briefing is full orientation artifact; priority selection rules unchanged |
| Live API 429 during validation | Minimize live turns; prefer automated composition tests |

**Dependencies:** Phase 15 merged baseline (already true); existing archive/future on-disk layout; shared instruction builder.

---

## 7. Proposed implementation sequence

1. Audit lock (Phase 16 design doc on `phase-16`) — Sarah decisions below.
2. Pure briefing composer + archive list/read helpers (no tool wiring yet).
3. Memory orchestration + tool route in `main.cjs`.
4. Instructions/examples for briefing + archive browse.
5. Automated test matrix.
6. Minimal live validation (API-thrifty).
7. Implementation report; optional PR when requested.

---

## 8. Automated-validation plan

- Compose today briefing from fixture daily → exact section membership/order; no invented items.
- Empty categories → stable empty wording.
- Archive list returns sorted dates present on disk.
- Archive brief by date loads that snapshot; wrong date → clear error; disk unchanged.
- Sensitivity redaction cases.
- Tool rejects write-like ops if any accidentally appear in schema.
- Regression: Phase 13/14/15 suites still green; rollover still archives; lifecycle writers untouched.
- Instruction/schema tests assert briefing tool presence and example shapes.

---

## 9. Live-validation plan (minimize OpenAI / rate-limit exposure)

**Prep:** one `npm run dev` session; prefer **text-only**; no voice until a single smoke if needed.

| Step | Turn budget | Check |
|---|---|---|
| 1 | 1 | “Brief me on today” → tool call + artifact; matches disk categories |
| 2 | 1 | “List my daily archives” → dates include known local archives |
| 3 | 1 | “Brief me on yesterday” / specific archive date → prior-day content, not today |
| 4 | 0 API | Spot-check `daily.json` / archives unchanged (read-only) |
| 5 | ≤1 optional | One Realtime smoke: “brief me” once on shared path — skip if rate-limited |

**Avoid:** long confirm chains, compound multi-ops, reconnect loops, Phase 8 A/B, packaging runs.

**If 429:** stop; rely on automated suite; do not burn retries reminting previews.

---

## 10. Decisions requiring Sarah’s input

1. **Confirm Phase 16 = Daily Executive Briefing + Archive Continuity** (vs Alt #1 persistence hardening).
2. **Tomorrow in briefing scope?** Include read-only future-file briefing now, or today+archive only.
3. **Archive depth:** list + brief only, or also raw structured `memory_view`-style dump for a date.
4. **Tool naming:** dedicated `memory_day_briefing` vs ops on an existing memory tool.
5. **Piggyback Phase 15 instruction line** for multi-action sequential calls? Recommend **no** unless you want a one-line hitchhike.
6. **Any restore-from-archive desire?** Recommend keep deferred.

---

## 11. Three alternatives (ranked behind the recommendation)

1. **Persistence and restart hardening (previews + recent references)** — Cross-cutting reliability; fixes live Phase 15 restart loss; less new user capability.
2. **Text rate-limit handling, retry timing, pending-operation preservation** — Directly addresses Phase 15 429 friction; reliability phase, not product continuity.
3. **Realtime memory freshness / session context refresh** — Closes mint-staleness; higher Realtime complexity and validation cost; do after briefing or with a narrow refresh design.

*(Compound multi-action, Phase 8 audio, integrations, packaging remain behind these.)*

---

## 12. Phase 15 follow-up: include or separate?

**Keep separate.** Phase 15 is complete and merged; optional follow-ups (multi-action instructions, preview mint diagnostics, backup retention, restore id normalization) are polish/reliability and should not gate or dilute Phase 16 briefing/archive scope.

Optional exception: a **single instruction sentence** about sequential multi-ops if `JARVIS_INSTRUCTIONS` is already being edited for briefing — still not required to open Phase 16.

---

## Work bucket summary

| Bucket | Items |
|---|---|
| Required next architectural / product work | Day briefing + archive browse continuity |
| User-facing capability gaps | Orient across today/prior days without JSON; briefing artifact |
| Reliability defects / debt | Preview/recent process-local; text 429 UX; voice context staleness; backup retention; preview diagnostics |
| Optional enhancements | Compound multi-action instructions; restore id matching; tomorrow briefing |
| Remain deferred | Phase 8 residual audio; OAuth/integrations; packaging/installer; archive mutate/restore; project status/promote |

---

**Stop point:** planning only — no files modified beyond this report document, no Jarvis started, no commits/pushes.

**Next step when ready:** approve the recommendation (and §10 decisions), then audit lock on `phase-16`.

---

*End of Phase 16 planning report.*
