# Phase 17 Implementation Report — Daily-Use Reliability

**Status:** Implementation complete; pre-commit review corrections applied. Live validation not run (per instructions).  
**Branch:** `phase-17-daily-use-reliability`  
**Baseline:** `4d36e5c` — *Add Phase 17 daily-use reliability design*  
**Audit contract:** `docs/phase-17-daily-use-reliability-audit.md`

---

## Branch and baseline

| Item | Value |
|---|---|
| Branch | `phase-17-daily-use-reliability` |
| Baseline commit | `4d36e5c` |
| Working tree before start | Clean; local/origin synchronized |
| Jarvis during implementation | Not started |
| Live `data/memory` | Not modified |

---

## Files changed

### Modified
- `README.md` — daily vs development launch
- `electron/main.cjs` — single-instance lock, build-info IPC, continuity IPC, pending attach on `text:run`, before-quit cancel, launch ready log
- `electron/memory.cjs` — pending projection, remint suppression, recent continuity load/save/flush, stale recent clear
- `electron/preload.cjs` — `getContinuity`, `dismissPendingConfirmation`, `getBuildInfo`
- `electron/realtime-errors.cjs` — text cooldown policy helpers; uncapped Retry-After parse for classification
- `electron/text-session.cjs` — `safeForAutoNetworkRetry`, `retryAfterMs`, pending hint injection, cancel-all
- `electron/text-delivery.test.cjs` / `electron/text-history.test.cjs` — source assertions updated for guarded delivery
- `src/App.tsx` — cooldown UI, text Retry, pending banner, thin diagnostics strip, Send gates
- `src/lib/realtimeErrors.ts` — mirrored text cooldown policy
- `src/lib/textClient.ts` — one safe network auto-retry, cooldown enrichment, diagnostics extras
- `src/styles.css` — meta row, pending banner, disabled send styling
- `src/vite-env.d.ts` — continuity / build / enriched text error types

### Added
- `electron/session-continuity.cjs` — schema load/save/validate + launch prerequisite helpers
- `electron/single-instance.cjs` — testable lock/focus helper
- `electron/phase-17-daily-use-reliability.test.cjs` — audit §17 matrix
- `scripts/start-jarvis.ps1` — daily built-renderer launcher
- `scripts/start-jarvis.bat` — shortcut-friendly wrapper
- `scripts/launch-helpers.cjs` — pure launch checks for tests
- `docs/phase-17-daily-use-reliability-implementation-report.md` — this report

---

## Architecture and data flow

```
UI (App.tsx)
  ├─ Composer editable during cooldown; Send/Retry gated by textTurnActive + textCooldownUntilMs
  ├─ TextClient.submit(exact composer text, history)
  │    └─ optional one auto network retry (client-side, flag-gated)
  └─ window.jarvis.runTextTurn
       └─ main: attach getPendingConfirmationInternal() token (never shown in UI)
            └─ text-session Responses API loop
                 ├─ classify errors + retryAfterMs + safeForAutoNetworkRetry
                 └─ tools → memoryStore (previewStore + pending projection)

Restart path:
  ensureMemory → load session-continuity.json → hydrate recent IDs only
  previewStore + pendingConfirmation start empty
```

---

## Error taxonomy and cooldown policy

| Code | Manual Retry | Countdown | Auto network retry |
|---|---|---|---|
| `rate_limited` | Yes after cooldown | Yes — “You can retry in Ns” | Never |
| `quota.exhausted` | No | No | Never |
| `network.offline` | Yes | Yes | At most one if `safeForAutoNetworkRetry` |
| `server.unavailable` | Yes | Yes | Never |
| `api.bad_response` | Yes | Yes | Never |
| `config.*` | No until fixed | No | Never |
| `session.error` | Case-by-case (`retryable`) | If retryable | Never |
| `unknown` | Yes | Yes (short fallback) | Never |

Constants:
- `TEXT_RETRY_AFTER_CAP_MS = 60_000`
- `TEXT_COOLDOWN_FALLBACK_MS = [1000, 2000, 4000, 8000]`
- `TEXT_REPEATED_429_FLOOR_MS = 30_000` after 3 consecutive `rate_limited`
- Realtime connect policy unchanged (`RETRY_AFTER_CAP_MS = 30_000`)

Copy never says “Retrying in…” for 429; it says the user **may** retry after the wait.

---

## Retry safety model

1. **Manual Retry** — primary path; exact composer text; pending token attached by main when still valid.
2. **Single automatic network retry** — only when:
   - code is `network.offline`
   - `safeForAutoNetworkRetry === true` (fetch threw before any HTTP response; no tools; no parsed 2xx body)
   - `autoNetworkRetriesUsed < 1`
3. **Never auto-retry** after HTTP response (incl. 429/5xx), tool calls, timeouts after send, confirm attempts, or ambiguous failures.
4. Duplicate submission blocked at UI, TextClient, Electron `activeTurns`, and session owner lock.

---

## Pending-confirmation continuity

- Authoritative plans remain in process-local `previewStore` (TTL unchanged).
- `pendingConfirmation` projection set on mint / `CONFIRMATION_REQUIRED`.
- Remint suppression returns the same token for equivalent tool+operation+binding while valid.
- Survives temporary API/network failures in-process.
- Cleared on success / `invalidatePreviews`, TTL, stale binding/`dailyUpdatedAt`, or confirm `STALE_PREVIEW`.
- Dismiss clears UI projection only (token may remain until TTL).
- Banner shows operation, redacted summary, expiry — never preview tokens or plans.

---

## Recent-reference persistence

- Path: `data/memory/session-continuity.json` (gitignored `data/`)
- Schema v1: `recent.priorityId`, `recent.activeProjectId`, `recent.workingContext.{commitments,follow_ups,unresolved_items}`
- Atomic write via existing memory `atomicWriteJson`
- Load on `ensureMemory`; validate/coerce; corrupt/missing → empty nulls
- Stale `by:"recent"` NOT_FOUND clears that id and persists
- Never writes preview tokens, pending confirmation, plans, transcripts, or composer drafts
- Writes flushed at end of lifecycle enqueue tasks; dirty flag retained if a save fails so a later flush retries

---

## Restart behavior

| State | After restart |
|---|---|
| `previewStore` | Empty |
| `pendingConfirmation` | Absent (no disk marker) |
| Recent IDs | Reloaded from continuity file if valid |
| Confirm without new preview | `STALE_PREVIEW` |
| Diagnostics note | “Pending confirmations do not survive restart.” |

---

## Launch architecture

Daily path (`scripts/start-jarvis.ps1` / `.bat`):
1. Verify Node, npm, project root, `node_modules/electron`, `.env.local`, non-empty `OPENAI_API_KEY` (never prints secrets)
2. Build only if `dist/index.html` missing or `-Rebuild`
3. Clear `VITE_DEV_SERVER_URL`; run `npm start` (Electron loads built `dist/`)
4. No Vite process
5. If Jarvis already appears running, print `Jarvis is already running` then still start so Electron can focus the existing window
6. Ctrl+C / unclean stop uses `taskkill /T` to kill the launch process tree

Development path remains `npm run dev` (Vite + Electron).

---

## Single-instance behavior

- `app.requestSingleInstanceLock()` early in `main.cjs`
- Second instance prints `Jarvis is already running`, then quits; first focuses/restores/shows existing window
- Applies to daily and dev launches
- `before-quit` cancels active text turns

---

## Composer and cooldown UX

- On text failure the composer string is preserved (cleared only after successful visible delivery)
- During cooldown the composer remains **editable**; Send and Retry stay disabled until cooldown ends
- Cancel applies only to an in-flight turn and does not clear cooldown

---

## Diagnostics and privacy exclusions

**Included:** connection state, build/version (+ best-effort git sha/branch), last sanitized error code, cooldown/next retry, pending op/summary/expiry (no token), artifact/title metadata already used.

**Excluded:** API keys, preview tokens, bound plans, secret memory values, full composer text, full transcripts (optional `composerChars` length only).

Text failures get Retry (when policy allows) + Copy diagnostics parity with voice, without overwriting Realtime voice error state.

---

## Automated tests and exact results

### Phase 17 matrix (`electron/phase-17-daily-use-reliability.test.cjs`)
```
tests 24
pass 24
fail 0
```

Covers §17.1–17.8: classification/cooldown, auto-retry safety, duplicate submission, pending/remint/TTL/drift, continuity round-trip/corrupt/stale/attack extras, restart policy, launch checks, single-instance, diagnostics sanitization.

### Text / client / diagnostics / continuity suites
```
node --test electron/phase-17-daily-use-reliability.test.cjs \
  electron/text-mode.test.cjs electron/text-prompt-submit.test.cjs \
  electron/text-history.test.cjs electron/text-delivery.test.cjs \
  electron/text-panel-activation.test.cjs \
  electron/realtime-diagnostics-recovery.test.cjs \
  electron/clipboard-diagnostics.test.cjs
→ tests 102 / pass 102 / fail 0
```

### Phase 13–16 regression
```
node --test electron/priority-lifecycle.test.cjs \
  electron/working-context-lifecycle.test.cjs \
  electron/active-projects-lifecycle.test.cjs \
  electron/day-briefing.test.cjs electron/memory.test.cjs
→ tests 126 / pass 126 / fail 0
```

---

## Build result

```
npm run build
→ tsc --noEmit OK
→ vite build OK (built in ~372ms)
```

---

## git diff --check result

```
DIFF_CHECK_EXIT:0
(no whitespace errors reported)
```

---

## git status --short result

```
 M README.md
 M electron/main.cjs
 M electron/memory.cjs
 M electron/preload.cjs
 M electron/realtime-errors.cjs
 M electron/text-delivery.test.cjs
 M electron/text-history.test.cjs
 M electron/text-session.cjs
 M src/App.tsx
 M src/lib/realtimeErrors.ts
 M src/lib/textClient.ts
 M src/styles.css
 M src/vite-env.d.ts
?? docs/phase-17-daily-use-reliability-implementation-report.md
?? electron/phase-17-daily-use-reliability.test.cjs
?? electron/session-continuity.cjs
?? electron/single-instance.cjs
?? scripts/
```

(Not committed; not pushed — per instructions. No `data/`, `.env`, or `node_modules` included.)

---

## Remaining risks

1. **Windows atomic rename under OneDrive/temp** — mitigated by queue-flushed continuity writes and retained dirty flag on failure; still environment-sensitive.
2. **LLM may ignore pending hint** — remint suppression reduces STALE pressure; deterministic Confirm button remains optional (audit default: Manual Retry + hint).
3. **Daily launcher process detection** — “already running” heuristics plus Electron single-instance lock; live focus path still needs §18 confirmation.
4. **Build freshness** — daily path rebuilds only when dist missing / `-Rebuild`; stale UI possible until rebuild.
5. **Live 429 UX** — verified in automation only; natural live 429 not provoked.

---

## Live-validation status

**Not performed** (explicitly out of scope for this stop point).  
Audit §18 checklist remains for a later thrifty live pass (daily launcher, second-instance focus, one confirm chain, restart pending absent, no orphan processes).

---

## One-week pilot readiness status

| Criterion | Status |
|---|---|
| Daily scripts without Cursor/`npm run dev` | Implemented (not live-checked) |
| Second launch focuses instance | Implemented + unit-tested |
| Built renderer, no Vite on daily path | Implemented |
| Text 429 UX / composer / no auto 429 | Implemented + automated |
| Quota without retry loop | Implemented + automated |
| Same-process pending + remint suppression | Implemented + automated |
| Restart drops pending; recent IDs persist | Implemented + automated |
| No preview/plans on disk | Implemented + automated |
| Thin sanitized diagnostics | Implemented + automated |
| Clean shutdown / no intentional daily orphans | Implemented (live check pending) |
| §17 automated green | **Yes (24/24)** |
| §18 live checklist | **Pending** |
| No §20 out-of-scope items | **Yes** |

**Pilot readiness:** Ready for automated-backed pilot engineering; **not** fully certified until §18 live validation.

---

## Recommended next step

1. Commit Phase 17 implementation (when requested).
2. Run audit §18 live checklist once with the daily launcher (API-thrifty; do not provoke 429s).
3. Optionally create the Windows desktop shortcut pointing at `scripts/start-jarvis.bat` (out of band).
4. Begin the one-week pilot only after L1–L8 live checks pass.

---

## Audit-to-code review notes (defects corrected)

| Finding | Fix |
|---|---|
| Source tests expected `onAssistantText(plan.assistantText…)` | Updated to `guardedText` (behavior preserved) |
| Async continuity writes raced temp-dir cleanup (`ENOTEMPTY`) | Dirty-flag + flush inside lifecycle enqueue |
| Concurrent continuity rename races | Persist serialized through memory write queue / flush |
| TS nullability on buildInfo git fields | Accept `string \| null` in `setBuildInfo` |
| Preview token must not reach renderer diagnostics | Public projection strips token; main injects internal pending on `text:run` |
| Composer disabled during cooldown (audit §3.3/§5.2) | Input editable during cooldown; only Send/Retry gated |
| Missing “Jarvis is already running” on second launch | Printed by `main.cjs` and `start-jarvis.ps1` |
| Launcher Ctrl+C left possible Electron orphans | `taskkill /T` process-tree stop |
| Busy `session.error` marked retryable | Electron busy/rejected now `retryable: false` |
| Continuity dirty cleared after save failure | Dirty flag retained so a later flush retries |

---

## Pre-commit review status

Pre-commit review completed against the audit and this report. Substantive corrections above were applied before the final automated validation pass.
