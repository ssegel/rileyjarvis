# Phase 16 audit: Daily Executive Briefing and Archive Continuity

**Status:** Audit and design only. No application-code or runtime-memory edits.
**Goal:** Sarah can ask Jarvis for a deterministic executive briefing of today or a prior archived day, and list available archive dates, without editing JSON, inventing work items, or mutating archives.
**Architectural reference:** `formatDailyWorkingContext` / `isCommitmentDueNow` / rollover archive writes in `electron/memory.cjs`; Phase 12–15 lifecycle tools; shared `executeTrustedTool` path.
**Branch context:** Documentation for Phase 16 implementation on `phase-16`.
**Planning reference:** `docs/phase-16-planning-report.md` (approved).

---

## Locked product decisions (Sarah)

| # | Decision |
|---|---|
| 1 | Phase 16 covers today’s deterministic executive briefing; listing archived daily dates; briefing a specific archived date; and **yesterday** as an NL alias for the previous calendar date when that archive exists. |
| 2 | **Tomorrow and future-file briefings are out of scope.** |
| 3 | Archive access is **read-only**: list dates; generate a briefing for an archived date; **no** archive editing, deletion, restore, mutation, or raw structured memory dump. |
| 4 | Dedicated shared tool: **`memory_day_briefing`**. |
| 5 | Briefing is composed **entirely from persisted memory data**; may not invent, infer, or silently add work items. |
| 6 | Artifact sections (stable order): summary; open priorities; commitments due now; other open commitments; open follow-ups; open unresolved items; active projects; **stable empty-state wording** where applicable. |
| 7 | Text and Realtime share the same trusted tool path. |
| 8 | Sensitivity/redaction matches existing memory-view and prompt-injection rules (see §8). |
| 9 | Phase 15 follow-up polish remains **separate** (compound multi-action instructions, preview diagnostics, backup retention, restore-ID normalization). |
| 10 | Live validation minimizes OpenAI usage: one today brief; one archive list; one archived-day brief; optional single Realtime smoke only if no rate limiting. |

---

## Executive summary

Phases 13–15 delivered deterministic **write/lifecycle** tools for priorities, working context, and active projects. Rollover already **persists** prior days under `data/memory/archive/daily-YYYY-MM-DD.json`, and prompt injection already formats labeled daily sections via `formatDailyWorkingContext` — but Sarah has **no first-class tool** to request a day briefing artifact or browse archives.

Phase 16 adds **`memory_day_briefing`**: a read-oriented composer and archive lister. Content is assembled in code from disk; the model must call the tool and must not invent items. Tomorrow/`future/` briefings, archive mutation/restore, and Phase 15 polish remain out of scope.

---

## 1. Current architecture and the user-facing gap

### 1.1 Current architecture

| Path / system | Role today |
|---|---|
| `data/memory/daily.json` | Live day (`date`, `summary`, priorities, commitments, followUps, unresolved, activeProjects) |
| `data/memory/archive/daily-YYYY-MM-DD.json` | Full prior-day snapshot written on calendar rollover |
| `data/memory/future/daily-YYYY-MM-DD.json` | Future **priorities** planning (Phase 13); **not** a Phase 16 briefing source |
| `formatDailyWorkingContext(daily, today)` | Builds labeled sections for **prompt injection** (omits many empty sections) |
| `isCommitmentDueNow(item, today)` | `due` present and `due <= today` (string compare on ISO dates) |
| `isFutureDeferred(item, today)` | `deferredUntil` valid ISO and `> today` → excluded from default open lists |
| `memory_view` | Raw/JSON-ish dump of scopes; today-centric daily; not a briefing product |
| Lifecycle tools | `memory_priorities`, `working_context_items`, `memory_active_projects` — mutate today (and priority future files) |
| Text / Realtime | Shared instructions via `buildSessionInstructions`; tools via `executeTrustedTool` |

Rollover (`rolloverDailyIfNeeded`): when `daily.date !== todayDate()`, writes the prior daily object to `archive/daily-{priorDate}.json`, then creates a new today file carrying open/blocked/(legacy active) work and all projects.

### 1.2 User-facing gap

| Need | Today |
|---|---|
| “Brief me on today” | Model may paraphrase injection or call fragmented list tools; **no** stable multi-section briefing artifact |
| “What archives exist?” | No tool; requires filesystem knowledge |
| “Brief me on yesterday / 2026-07-25” | Archives are write-only from Sarah’s perspective; no brief-from-archive |
| Empty categories | Injection **omits** empty commitment/follow-up/unresolved/project sections; briefing must show **stable empty wording** |

---

## 2. Exact briefing source-of-truth rules

1. **Composer is code-owned.** All section lines are produced by deterministic helpers from a loaded daily object. The model must not append, reorder inventively, or invent items in speech beyond a short lead that points at the artifact.
2. **Sources by target:**
   - **Today:** `daily.json` after normal memory ensure/rollover (same load path other memory tools use).
   - **Yesterday / explicit past archive date:** read-only `archive/daily-YYYY-MM-DD.json` for that date.
   - **Never:** `future/` files, backups, entries, profile, preferences, instructions, or conversation transcript as briefing item sources.
3. **No inference:** Do not invent due dates, statuses, projects, or “likely” work. Do not promote Phase 12 priority-selection narrative into extra items.
4. **Filtering (same open-list spirit as `formatDailyWorkingContext`):**
   - Priorities: `isOpenPriorityStatus` → `open` \| `blocked` \| legacy `active`.
   - Commitments / follow-ups / unresolved: `isOpenWorkStatus` (`open` \| `blocked`) **and not** `isFutureDeferred(item, classificationDate)`.
   - Active projects: **all** stored projects in array order (projects have no open/done status).
   - Done / completed / cancelled-equivalent statuses: **excluded**.
5. **Classification date:** For due-now vs other commitments and for deferral exclusion, use the **source day’s `daily.date`** (today’s live date, or the archived snapshot’s `date` field after validation). Do **not** reclassify an archive against calendar-today in a way that moves historical due-now membership — membership is evaluated with `classificationDate = sourceDaily.date`.
6. **Order within sections:** Preserve **stored array order** after filters (same as injection).
7. **Summary:** Exact stored `summary` string when non-empty after trim; otherwise empty-state (no paraphrasing).

---

## 3. Complete `memory_day_briefing` tool schema and operation contracts

### 3.1 Tool identity

- **Name:** `memory_day_briefing`
- **Transport:** Listed in `toolSpecs`; executed only through `executeTrustedTool` (text session + Realtime).
- **Confirmation:** None. No `confirmed` / `previewToken`. Read-only product surface.

### 3.2 JSON Schema (contract)

```json
{
  "type": "function",
  "name": "memory_day_briefing",
  "description": "Compose a deterministic executive day briefing from persisted memory, or list archived daily dates. Operations: brief, list_archives. For brief, targetDate may be omitted/today, yesterday, or YYYY-MM-DD for an archive. Tomorrow and future dates are unsupported. Read-only: never invent work items; never edit archives or daily arrays. Only report success when ok:true.",
  "parameters": {
    "type": "object",
    "properties": {
      "operation": {
        "type": "string",
        "enum": ["brief", "list_archives"]
      },
      "targetDate": {
        "type": "string",
        "description": "For brief only: omit or \"today\" for live today; \"yesterday\" for previous calendar date archive; or YYYY-MM-DD archive/today date. Ignored for list_archives."
      }
    },
    "required": ["operation"],
    "additionalProperties": false
  }
}
```

### 3.3 Operation: `list_archives`

| Contract | Rule |
|---|---|
| Input | `operation: "list_archives"`; `targetDate` ignored if present (do not error solely for presence). |
| Behavior | Discover archive files (§5); return sorted date list + count; optional short artifact. |
| Writes | None to archive/daily content (rollover caveat in §11). |
| Success | `{ ok: true, operation: "list_archives", dates: string[], count: number, message, artifact? }` |

### 3.4 Operation: `brief`

| Contract | Rule |
|---|---|
| Input | `operation: "brief"`; optional `targetDate`. |
| Resolve date | §4. |
| Load source | Today → live daily; archive date → archive file. |
| Compose | §6–§9. |
| Success | `{ ok: true, operation: "brief", targetDate, source: "today"\|"archive", dailyDate, sections meta?, message, artifact }` |

### 3.5 Unsupported operations

Any other `operation` → `UNSUPPORTED_OPERATION`.

---

## 4. Date targeting and normalization rules

Let `calendarToday = todayDate()` (local calendar YYYY-MM-DD from store `now()`, same as existing memory).

### 4.1 Normalization table

| Input `targetDate` | Resolved date | Source | Notes |
|---|---|---|---|
| omitted / `""` / `"today"` (case-insensitive trim) | `calendarToday` | Live `daily.json` | After ensure/rollover, `daily.date` must equal `calendarToday`; if mismatch after rollover attempt → `READ_FAILED` |
| `"yesterday"` (case-insensitive) | `addDaysToDate(calendarToday, -1)` | Archive only | Requires archive file for that date; else `ARCHIVE_NOT_FOUND` |
| `YYYY-MM-DD` equal to `calendarToday` | that date | Live `daily.json` | Same as today |
| `YYYY-MM-DD` **&lt;** `calendarToday` | that date | Archive | Missing → `ARCHIVE_NOT_FOUND`; malformed → `ARCHIVE_MALFORMED` |
| `YYYY-MM-DD` **&gt;** `calendarToday` | — | — | `UNSUPPORTED_DATE` (tomorrow/future out of scope) |
| `"tomorrow"` or other non-ISO tokens | — | — | `UNSUPPORTED_DATE` or `VALIDATION_FAILED` (lock: `"tomorrow"` → `UNSUPPORTED_DATE`; garbage → `VALIDATION_FAILED`) |

### 4.2 ISO validation

`YYYY-MM-DD` must match existing date helpers (`isValidIsoDate` / equivalent used by WC dates). Invalid shape → `VALIDATION_FAILED`.

### 4.3 Yesterday semantics (locked)

- Yesterday means **previous calendar day relative to `calendarToday`**, not “previous daily.date before rollover.”
- Implementation must run the same ensure/rollover path used by other memory reads **before** resolving yesterday, so a pending rollover archives the prior live day first when appropriate.
- If yesterday’s archive still does not exist after that → `ARCHIVE_NOT_FOUND` (e.g. first-ever day).

### 4.4 Explicit past date that is not yesterday

Allowed. Any `YYYY-MM-DD < calendarToday` uses archive path.

---

## 5. Archive discovery, sorting, validation, and malformed-file handling

### 5.1 Discovery

- Directory: `{memoryRoot}/archive/`
- Filename pattern: `daily-YYYY-MM-DD.json` where the date group is a valid ISO date.
- Ignore non-matching names.

### 5.2 Sorting

- `list_archives` returns dates **descending** (newest first).
- `count` = `dates.length`.

### 5.3 Validation when briefing an archive

1. Path = `archive/daily-{resolvedDate}.json`.
2. Missing file → `ARCHIVE_NOT_FOUND`.
3. Unreadable / JSON parse failure → `ARCHIVE_MALFORMED` (do not write repair; do not delete).
4. Parse success → run **read-only** normalize via existing `normalizeDaily(raw, resolvedDate)` (or equivalent) **in memory only** — never write back the archive.
5. After normalize, if `daily.date` is present and differs from `resolvedDate`, still brief using normalized content but set artifact subtitle to show both **requested** and **snapshot date** if different; prefer requiring `daily.date === resolvedDate` and failing `ARCHIVE_MALFORMED` on mismatch — **locked default: mismatch → `ARCHIVE_MALFORMED`** (avoids silent wrong-day briefs).

### 5.4 Malformed files during `list_archives`

- If filename date is valid but file is unreadable/malformed: **omit** from `dates` (do not invent). Do not fail the whole list.
- Optional internal log line; do not put raw file bodies in tool results.

### 5.5 Empty archive directory

Success with `dates: []`, `count: 0`, message like `No archived days found.`

---

## 6. Exact briefing section order and empty-state wording

### 6.1 Artifact structure (markdown)

Title: `Day briefing — {dailyDate}` with source qualifier in body header.

```markdown
# Day briefing — {YYYY-MM-DD}
Source: {today|archive}

## Summary
{summary body or empty-state}

## Open priorities
{bullets or empty-state}

## Commitments due now
{bullets or empty-state}

## Other open commitments
{bullets or empty-state}

## Open follow-ups
{bullets or empty-state}

## Open unresolved items
{bullets or empty-state}

## Active projects
{bullets or empty-state}
```

**All seven sections always appear** (unlike injection, which omits some empties).

### 6.2 Locked empty-state lines (exact)

| Section | Empty-state line (sole content under heading) |
|---|---|
| Summary | `none.` |
| Open priorities | `none.` |
| Commitments due now | `none.` |
| Other open commitments | `none.` |
| Open follow-ups | `none.` |
| Open unresolved items | `none.` |
| Active projects | `none.` |

When non-empty:

| Section | Line format |
|---|---|
| Summary | Plain summary text (no leading `Summary:` prefix under the heading) |
| Open priorities | `- {text}` per open priority |
| Commitments due now / other | Commitment lines per §7–§8 (include `(due YYYY-MM-DD)` when due present and not redacted away) |
| Open follow-ups | `- {text}` (plus due suffix if stored `due` present and item not redacted — **match injection: follow-ups currently show text only; lock text-only**) |
| Open unresolved items | `- {text}` |
| Active projects | `- {name}` or `- {name}: {note}` when note non-empty |

### 6.3 Explicit non-goals for wording

- Do **not** include the injection meta line `Priority selection order: ...` in the artifact.
- Do **not** use Phase 12 reply string `You currently have no open daily priorities.` inside the artifact (that remains priority-selection speech policy). Artifact empty priorities use `none.` under **Open priorities**.

---

## 7. Commitment classification rules (“due now” vs other open)

Reuse existing helpers; do not fork semantics.

1. Start from commitments where `isOpenWorkStatus(status)` and `!isFutureDeferred(item, classificationDate)`.
2. **Due now:** `isCommitmentDueNow(item, classificationDate)`  
   - `due` trimmed non-empty **and** `due <= classificationDate` (lexicographic ISO date compare — existing behavior).
3. **Other open commitments:** open + not future-deferred + **not** due now (includes open commitments with **no** due date).
4. A commitment appears in **at most one** of the two commitment sections.
5. Stored order preserved within each subset (stable filter over array order).

---

## 8. Sensitivity and redaction rules

### 8.1 Locked alignment

Match **prompt injection** and **`memory_view` daily** behavior as implemented today (locked decision 8). Do not invent a stricter briefing-only redaction policy in Phase 16.

| Surface | Rule for Phase 16 briefing |
|---|---|
| Commitments | Match injection `formatCommitmentLine`: `secret` → `- [secret commitment stored] ({id})`; `sensitive` → `- [sensitive commitment stored] ({id})`; else normal text + optional due. Aligns with `memory_view` commitment text redaction for non-confirmed views. |
| Follow-ups / unresolved | Match injection + `memory_view`: show stored `text` (no sensitivity placeholder path exists on these lists today). Do **not** add briefing-only redaction in Phase 16. |
| Priorities | No sensitivity field in normal schema; show `text` as stored |
| Active projects | Show `name` / `note` as stored (no sensitivity field) |
| Summary | Show as stored (treat as normal text; no secret channel on summary today) |

### 8.2 No secret reveal on this tool

- **No** `confirmed=true` parameter.
- Briefing **never** returns raw secret payloads.
- To view secrets, Sarah continues to use confirmed `memory_view` (unchanged; not part of Phase 16 dump-for-date).

### 8.3 Logging

Do not log briefing bodies that may contain sensitive text. Prefer existing style: operation, ok, code, date, source, counts only.

---

## 9. Artifact and concise spoken/text response shapes

### 9.1 Artifact

```js
{
  title: "Day briefing — YYYY-MM-DD",
  kind: "text",
  content: "<markdown from §6>"
}
```

### 9.2 Tool `message` / model lead (instructions)

Success examples (deterministic enough for instructions; exact string may be composed in code as `message`):

- Today: `Day briefing for today ({date}).`
- Archive: `Day briefing for archived day {date}.`
- List: `Found {n} archived day(s).` or `No archived days found.`

**Model instructions:** Call `memory_day_briefing`; show the artifact; give a **short** spoken/text lead from `message` (optionally name the first open priority text only if present and not redacted). Do **not** re-list every bullet in speech. Do **not** invent items missing from the artifact. On failure, report the tool error once; do not retry identical args.

### 9.3 Structured success fields (brief)

Include at least: `ok`, `operation`, `targetDate` (resolved ISO), `source`, `dailyDate`, `counts` (optional per-section counts), `message`, `artifact`.

Do **not** return a parallel raw JSON dump of the full daily object (locked: no raw structured memory dump).

---

## 10. Error codes and failure responses

| Code | When |
|---|---|
| `UNSUPPORTED_OPERATION` | Unknown `operation` |
| `VALIDATION_FAILED` | Invalid `targetDate` shape / empty garbage token |
| `UNSUPPORTED_DATE` | `tomorrow`, or any resolved date **&gt;** `calendarToday`, or explicit future ISO |
| `ARCHIVE_NOT_FOUND` | Yesterday/past date with no archive file |
| `ARCHIVE_MALFORMED` | Archive exists but unreadable, invalid JSON, or date mismatch after parse |
| `READ_FAILED` | Unexpected IO failure reading live daily after ensure |
| `UNKNOWN` | Only as last resort |

Failure shape:

```js
{
  ok: false,
  operation,
  code,
  message, // short, user-safe, no file contents
  error: message
}
```

No artifact on failure (or optional tiny error artifact — **lock: no artifact on failure**).

---

## 11. Read-only and non-mutation guarantees

Phase 16 **`memory_day_briefing` must not:**

- Create, edit, delete, rename, or rewrite archive files
- Restore archive → daily
- Mutate `daily.json` arrays or summary as part of briefing composition
- Write backups for briefing ops
- Write `future/` files
- Perform lifecycle mutations (those remain Phase 13–15 tools)

**Allowed existing platform side effect:** calling `ensureMemory` / `rolloverDailyIfNeeded` may archive a stale live day and create a new today file when the calendar advanced — the same side effect other memory tools already trigger. Phase 16 must not add **additional** writes beyond that shared ensure/rollover path.

**Verification:** Automated tests assert archive file bytes and `daily.json` content hash unchanged across `brief`/`list_archives` when no rollover is needed; when rollover is forced in a fixture, assert only the normal rollover write set occurs (one new archive + new daily), not briefing-specific writes.

---

## 12. Text and Realtime routing instructions and examples

### 12.1 Routing

| Path | Requirement |
|---|---|
| Text | `text-session` → `executeTrustedTool` → `memory_day_briefing` |
| Realtime | Function call → `executeTrustedTool` → same handler |
| Instructions | `JARVIS_INSTRUCTIONS` examples; tool description; menu copy if applicable |

### 12.2 Instruction bullets (to add)

- For “brief me”, “daily briefing”, “what does my day look like”, call `memory_day_briefing` with `operation: "brief"` (today).
- For “brief me on yesterday”, use `targetDate: "yesterday"`.
- For “brief me on July 25, 2026” / ISO date, pass `targetDate: "YYYY-MM-DD"`.
- For “list archives” / “what days are archived”, use `operation: "list_archives"`.
- Never invent briefing bullets; never use `future`/tomorrow briefing; never dump raw daily JSON for this purpose.
- Do not use lifecycle tools when Sarah only asked for a briefing/list of archives.

### 12.3 Examples

| User | Tool args |
|---|---|
| Brief me on today | `{"operation":"brief"}` or `{"operation":"brief","targetDate":"today"}` |
| What did yesterday look like? | `{"operation":"brief","targetDate":"yesterday"}` |
| Brief me on 2026-07-25 | `{"operation":"brief","targetDate":"2026-07-25"}` |
| List my daily archives | `{"operation":"list_archives"}` |

---

## 13. Interactions with rollover, current-day memory, archive files, and lifecycle tools

| Interaction | Rule |
|---|---|
| Rollover | Briefing/list may trigger shared ensure/rollover; afterwards today brief reads new daily; yesterday brief reads newly created archive when applicable |
| Current-day memory | Today brief reflects post-lifecycle disk state; does not bypass tools |
| Archive files | Read-only inputs for past briefs; listing is discovery only |
| `memory_priorities` / WC / projects | Unchanged; still the writers. Briefing never substitutes for mutations |
| `memory_view` | Remains today-centric dump + confirmed secrets; Phase 16 does **not** add archive dump to `memory_view` |
| `memory_update_daily` | Summary-only remains; unrelated |
| Phase 12 priority selection | Unchanged; briefing is orientation, not a replacement for “what is my first priority?” speech policy |
| Personal-context injection | Unchanged in Phase 16 (still mint/per-text-turn). Briefing artifact is separate |

---

## 14. Exact files expected to change

| File | Expected change |
|---|---|
| `electron/day-briefing.cjs` (new) **or** `electron/day-briefing-lifecycle.cjs` (new) | Pure compose, archive list/read helpers, empty-state constants, redaction line helpers |
| `electron/memory.cjs` | `memoryDayBriefing(args)` orchestration; export wiring; reuse `formatCommitmentLine` / due-now / defer helpers (export or share as needed) |
| `electron/main.cjs` | `toolSpecs` entry; `executeTrustedTool` branch; `JARVIS_INSTRUCTIONS` + menu mentions |
| `electron/day-briefing.test.cjs` (new) | Automated matrix §15 |
| `docs/phase-16-daily-briefing-archive-continuity-audit.md` | This audit |
| Later (not this step) | Implementation report after code lands |

**Not expected:** `src/lib/realtime.ts` audio path, packaging, OAuth, Phase 13–15 lifecycle semantics, `future/` briefing support.

---

## 15. Automated-test matrix

| ID | Case | Expect |
|---|---|---|
| T01 | Brief today with mixed filled sections | All 7 headings; correct bullets; order preserved |
| T02 | Brief today all-empty daily | All 7 sections show `none.` |
| T03 | Due now vs other split | Due `<= date` in due-now; undated + future-due-after-date in other; future-deferred excluded |
| T04 | Done priorities/WC excluded | Not listed |
| T05 | Legacy priority `active` included | Treated open |
| T06 | Projects all listed in stored order | Including notes formatting |
| T07 | Commitment secret/sensitive redaction | Placeholder lines with ids; no raw text |
| T08 | Follow-up/unresolved with sensitivity set | Shown as stored text (match injection/`memory_view`; no new placeholder policy) |
| T09 | `list_archives` sorting | Descending ISO dates; ignores junk filenames |
| T10 | Malformed archive omitted from list | List still ok |
| T11 | Brief missing archive | `ARCHIVE_NOT_FOUND`; disk unchanged |
| T12 | Brief malformed archive | `ARCHIVE_MALFORMED`; disk unchanged |
| T13 | Brief yesterday alias | Resolves to `calendarToday-1` archive content |
| T14 | Brief explicit past ISO | Archive content for that date |
| T15 | Brief `tomorrow` / future ISO | `UNSUPPORTED_DATE`; no future file read |
| T16 | Brief today via explicit ISO = calendarToday | Live daily source |
| T17 | Invalid targetDate token | `VALIDATION_FAILED` |
| T18 | Unknown operation | `UNSUPPORTED_OPERATION` |
| T19 | Non-mutation (no rollover) | `daily.json` + archives byte-identical after brief/list |
| T20 | Archive date field mismatch | `ARCHIVE_MALFORMED` |
| T21 | Tool schema / instructions present in `main.cjs` | Name `memory_day_briefing`; examples exist |
| T22 | No raw daily JSON dump in success payload | Absent full daily object dump |
| T23 | Regression | Existing memory / priority / WC / active-projects suites still pass |

---

## 16. Ordered minimal-request live-validation checklist

**Prep:** Single `npm run dev`; prefer text-only; do not hand-edit memory during the checklist.

| Step | API turns | Action | Pass criteria |
|---|---|---|---|
| 1 | 1 | “Brief me on today” | `memory_day_briefing` brief; artifact has 7 sections; matches disk categories; no invented items |
| 2 | 1 | “List my daily archives” | `list_archives`; dates include known local archives |
| 3 | 1 | “Brief me on yesterday” **or** a specific archived ISO date known to exist | Archive briefing; content is that day, not today; archives/daily not mutated by the brief itself |
| 4 | 0 | Spot-check files | Read-only expectations hold |
| 5 | ≤1 optional | Realtime: “brief me” once | Same shared tool path; **skip entirely if rate-limited** |

**Stop on 429.** Do not add confirm chains, compound multi-ops, or packaging tests.

---

## 17. Explicit out-of-scope items

- Tomorrow / any future-date briefing; reading `future/` for briefing
- Archive edit, delete, rename, repair-write, restore-to-daily
- Raw structured daily dump for a date (including extending `memory_view` for archives)
- Preview/recent persistence; text 429 retry UX; Realtime memory session refresh
- Compound multi-action instruction hardening; preview diagnostics; backup retention; restore-ID normalization (Phase 15 follow-ups)
- Phase 8 audio work; OAuth/integrations; packaging/installer
- Soft calendar UI; transcript persistence
- Changing Phase 12 priority-selection speech rules
- Expanding project status/due/complete or WC→project promote/link
- Inventing empty-state synonyms or per-call wording drift

---

## 18. Implementation sequence and completion criteria

### 18.1 Sequence

1. **Audit lock** — this document (complete when Sarah accepts).
2. **Pure module** — section composer, empty-state constants, archive list/read, date resolve.
3. **Memory orchestration** — `memoryDayBriefing` in `memory.cjs`.
4. **Tool + instructions** — `main.cjs` schema, route, examples, menu if needed.
5. **Automated tests** — matrix §15.
6. **Live validation** — checklist §16 (API-thrifty).
7. **Implementation report** — outcomes and residual limitations.

### 18.2 Completion criteria

Phase 16 is complete when all of the following are true:

1. `memory_day_briefing` implements `brief` and `list_archives` per §§3–11.
2. Today / yesterday / past ISO / future rejection behave per §4.
3. Artifact always includes the seven sections with locked empty wording (§6).
4. Due-now classification matches existing helpers (§7).
5. Redaction rules in §8 hold; no secret reveal path on this tool.
6. Text and Realtime share `executeTrustedTool` routing.
7. Automated matrix §15 passes; lifecycle regressions green.
8. Live checklist §16 passes (Realtime smoke optional under rate limits).
9. No out-of-scope items from §17 shipped.
10. Implementation report committed when Sarah requests documentation commit.

---

## 19. Design review (contradictions, ambiguity, invented-content, sensitivity, wording, archive safety, scope creep)

### 19.1 Contradictions checked and resolutions

| Topic | Resolution |
|---|---|
| Injection omits empty sections vs briefing requires empties | **Intentional.** Briefing always shows seven sections with `none.` |
| Injection/`memory_view` follow-up raw text vs desire to redact | **No Phase 16 strengthen.** Briefing matches existing surfaces (§8). Optional later: unify FU/unresolved redaction in injection + view + briefing together |
| `none.` vs `Open daily priorities: none.` | Artifact uses heading **Open priorities** + `none.`; injection constant unchanged |
| Read-only vs ensure/rollover writes | Documented as shared existing side effect only (§11) |
| Yesterday vs stale daily.date | Resolve yesterday against `calendarToday` after ensure/rollover (§4.3) |
| Archive brief classification date | Use snapshot `daily.date`, not calendar today (§2) |
| Tomorrow out of scope vs priority `targetDate: tomorrow` | Lifecycle carry/list unchanged; briefing rejects future (§4) |

### 19.2 Ambiguous date semantics — closed

- `today` / omit / ISO==calendarToday → live daily.
- `yesterday` → archive(`calendarToday-1`) only.
- Past ISO → archive only.
- Future / `tomorrow` → `UNSUPPORTED_DATE`.

### 19.3 Invented-content risk — mitigations

- Code-owned composer; instructions forbid narrating extra items; tests compare fixture bytes to artifact lines; no model-side merge of list tools into briefing content required.

### 19.4 Sensitivity leaks — mitigations

- No confirmed secret channel on this tool; commitment redaction via `formatCommitmentLine`; no raw daily dump field; avoid logging briefing bodies.
- Known inherited gap (out of Phase 16 scope to fix alone): follow-ups/unresolved can carry sensitivity in schema but injection/`memory_view` currently show raw text — briefing inherits that until a cross-cutting privacy pass.

### 19.5 Unstable wording — mitigations

- Exact empty-state `none.`; fixed headings; fixed project/priority bullet shapes.

### 19.6 Unsafe archive behavior — mitigations

- Read-only opens; malformed → error or omit from list; date mismatch → `ARCHIVE_MALFORMED`; no restore/edit.

### 19.7 Scope creep — rejected

- Future briefing, archive restore/dump, Phase 15 polish, voice freshness, packaging — remain out.

### 19.8 Implementer defaults (no Sarah blocker if audit accepted)

| Topic | Default |
|---|---|
| Module filename | `electron/day-briefing.cjs` |
| List sort | Descending |
| Archive date mismatch | `ARCHIVE_MALFORMED` |
| `targetDate` on `list_archives` | Ignore |
| Failure artifact | None |
| FU/unresolved due suffix | Text-only (match injection) |

### 19.9 Unresolved questions

None that block audit lock after Sarah’s product decisions above.

Optional later (explicitly **not** Phase 16): a cross-cutting privacy pass so follow-ups/unresolved with `sensitive`/`secret` are redacted consistently in injection, `memory_view`, and briefing.

---

## Appendix A — Helper reuse map

| Helper | Module | Phase 16 use |
|---|---|---|
| `todayDate` / `now` | `memory.cjs` | Calendar today |
| `addDaysToDate` | `priority-lifecycle.cjs` | Yesterday |
| `isCommitmentDueNow` | `memory.cjs` | Due-now split |
| `isFutureDeferred` | `working-context-lifecycle.cjs` | Exclude deferred |
| `isOpenPriorityStatus` | `memory.cjs` / priority-lifecycle | Open priorities |
| `isOpenWorkStatus` | `memory.cjs` | Open WC |
| `formatCommitmentLine` | `memory.cjs` | Commitment lines + pattern for other sensitivities |
| `normalizeDaily` | `memory.cjs` | Read-only normalize of archive JSON |
| `rolloverDailyIfNeeded` / `ensureMemory` | `memory.cjs` | Shared ensure path |

## Appendix B — Representative speech → tool args

| Speech | Args |
|---|---|
| Brief me | `brief` |
| Give me my executive briefing for today | `brief` + `today` |
| What did yesterday look like? | `brief` + `yesterday` |
| Brief me on 2026-07-26 | `brief` + `2026-07-26` |
| Show archived days | `list_archives` |
| Brief me on tomorrow | Must **not** succeed; `UNSUPPORTED_DATE` |

---

*End of Phase 16 daily briefing and archive continuity audit.*
