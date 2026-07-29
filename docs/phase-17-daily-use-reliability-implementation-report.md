# Phase 17 Implementation Report — Daily-Use Reliability

**Status:** Implementation complete; live validation (§18 L1–L8 + sanitized diagnostics) passed. Pre-merge correction pass applied (pending resume flag, dismiss vs remint, retryable session errors, exact composer text, per-chain cooldown). No live validation during this correction pass.
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
- `electron/main.cjs` — single-instance lock, build-info IPC, continuity IPC, pending attach on `text:run`, before-quit cancel, launch ready only after visible UI, refuse non-Jarvis app path
- `electron/memory.cjs` — pending projection, remint suppression, recent continuity load/save/flush, stale recent clear; instruction/schema mapping for `by: "recent"`
- `vite.config.ts` — `base: "./"` for Electron `file://` assets
- `scripts/start-jarvis.ps1` / `scripts/launch-helpers.cjs` — npm.cmd preference, explicit electron.exe + quoted absolute app path, process identity
- `electron/window-launch.cjs` — UI readiness / sanitized load-failure helpers (added)
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
- `scripts/start-jarvis.ps1` — daily built-renderer launcher (see Modified for launch hardening)
- `scripts/start-jarvis.bat` — shortcut-friendly wrapper
- `scripts/launch-helpers.cjs` — pure launch checks for tests
- `electron/window-launch.cjs` — visibility / readiness helpers
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
1. Verify Node, npm (for builds), project root, `node_modules/electron`, Electron `dist/electron.exe`, `.env.local`, non-empty `OPENAI_API_KEY` (never prints secrets)
2. Build only if `dist/index.html` missing or `-Rebuild` (via `npm.cmd`, never `npm.ps1`)
3. Clear `VITE_DEV_SERVER_URL`; start `node_modules\electron\dist\electron.exe` with the **absolute repository root** as one quoted `ProcessStartInfo.Arguments` token and `WorkingDirectory` set to that root
4. No Vite process; no `npm start` / `electron .` for the daily Electron child
5. Confirm process identity (repo app path / not `default_app.asar`) before treating the launch as successful; `main.cjs` prints `[jarvis-launch] ready` only after `app.getAppPath()` matches the repository
6. If Jarvis already appears running (strict identity), print `Jarvis is already running` then still start so Electron can focus the existing window
7. Ctrl+C / unclean stop uses `taskkill /T` to kill the launch process tree

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

Audit §18 live checklist (API-thrifty) completed for L1–L8 plus sanitized diagnostics proof.

| Check | Result |
|---|---|
| L1 Built UI via `scripts/start-jarvis.bat` | **Pass** (after npm.cmd → explicit electron.exe + absolute app path → Sarah Segel quoting → visible UI readiness fixes) |
| L2 Second launch focuses existing instance | **Pass** |
| L3 Simple text + build/version status | **Pass** |
| L4 Disposable preview + pending banner | **Pass** |
| L5 Live 429 not provoked | **Skipped** (automated §17.1 covers countdown; per audit) |
| L6 Same-token confirm succeeds; remint suppressed | **Pass** |
| L7 Restart: pending absent; recent continuity | **Pass after correction** (see Fifth finding + live re-check below) |
| L8 Quit; no orphan Electron/Node from daily launcher | **Pass** (repository-scoped Win32 query: no `electron.exe` / `node.exe`) |
| Sanitized diagnostics copy | **Pass** (DevTools console path; UI Copy diagnostics only when an error is set) |

### Initial recent-reference failure (L7) and final correction

**First L7 attempt (failed):** After pending-discard restart, `P17 restart continuity check` remained in daily priorities and the pending banner was correctly absent, but `What is the exact text of that one?` did not resolve — Jarvis asked which item.

**Cause:** Continuity persistence was healthy (`session-continuity.json` held the matching `priorityId`). Instructions and `memory_priorities` schema did not map “that one” / “that” / “the recent one” to `reference: {"by":"recent"}`, so the model clarified instead of calling the tool.

**Fix:** Instruction mapping + schema acceptance of `{"by":"recent"}` / `"recent"` (Fifth finding). `data/memory` not modified by the fix.

**Re-check:** After the correction, recent-reference resolution on the last touched priority succeeded without asking which item.

### Sanitized diagnostics live proof

- UI **Copy diagnostics** only appears when `lastTextError` / voice error is set; double-submit while busy does not surface that control (early return on `textTurnActive`).
- Chrome `chrome://inspect` / remote-debugging against Electron 42.5.1 produced 404 / non-functional Inspect — not used for the proof.
- Temporary local hook `win.webContents.openDevTools({ mode: "detach" })` in `did-finish-load` opened Electron’s own DevTools; preload checks `getBuildInfo` / `getContinuity` passed.
- Console-built sanitized report (matching `textClient.getDiagnosticReport` safe fields) copied via `window.jarvis.copyTextToClipboard`.
- Observed report included: Realtime Diagnostics header, `generatedAt`, `appVersion` 1.0.0, `branch` `phase-17-daily-use-reliability`, `gitSha` `4016e46`, `lastErrorCode` null, empty Events, `connectionState` null, `cooldownUntilMs` null, `pendingOperation` null, `composerChars` 0, `restartPolicyNote` “Pending confirmations do not survive restart.”
- Confirmed absent: `previewToken`, destructive plans / before-after arrays, API keys / auth values, full composer text, transcripts, durable-memory contents.
- Temporary `openDevTools` hook **removed** after validation; no temporary diagnostics code remains in `main.cjs`.

---

## One-week pilot readiness status

| Criterion | Status |
|---|---|
| Daily scripts without Cursor/`npm run dev` | **Live-checked** |
| Second launch focuses instance | **Live-checked** + unit-tested |
| Built renderer, no Vite on daily path | **Live-checked** |
| Text 429 UX / composer / no auto 429 | Implemented + automated (live 429 not provoked) |
| Quota without retry loop | Implemented + automated |
| Same-process pending + remint suppression | **Live-checked** + automated |
| Restart drops pending; recent IDs persist | **Live-checked** (after instruction/schema fix) + automated |
| No preview/plans on disk | Implemented + automated |
| Thin sanitized diagnostics | **Live-checked** (DevTools path) + automated |
| Clean shutdown / no intentional daily orphans | **Live-checked** |
| §17 automated green | **Yes (36/36)** |
| §18 live checklist | **Pass (L1–L8 + sanitized diagnostics)** |
| No §20 out-of-scope items | **Yes** |

**Pilot readiness:** Phase 17 engineering and live validation complete; ready to commit when requested.

---

## Recommended next step

1. Commit Phase 17 launch/visibility/recent-reference corrections and live-validation report (when requested).
2. Optionally create the Windows desktop shortcut pointing at `scripts/start-jarvis.bat` (out of band).
3. Begin the one-week pilot.

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

---

## Live-validation L1 failure and launcher correction

### First live-launch attempt (failed) — npm.ps1 via Start-Process

Attempted `scripts/start-jarvis.bat` on Windows during audit §18 L1 prep.

Observed:
- Banner `Starting Jarvis (built UI)…` printed
- Prerequisite checks appeared to run
- No Electron/Vite/Node/start-jarvis process remained afterward
- Memory files under `data/memory` were unchanged

Exact launcher error:
```
Start-Process : This command cannot be run due to the error: %1 is not a valid Win32 application.
At scripts\start-jarvis.ps1:123
$proc = Start-Process -FilePath $npmPath -ArgumentList @("start") ...
```

#### Root cause

`Get-Command npm` on this Windows host resolves to `C:\Program Files\nodejs\npm.ps1` (`CommandType=ExternalScript`).
`Start-Process` / CreateProcess cannot execute a PowerShell script as a Win32 application.
`npm.cmd` exists beside it and is the correct Start-Process target for npm builds.

#### First correction

- Prefer `npm.cmd` for `npm run build` (never Start-Process `npm.ps1`)
- `-LiteralPath` for roots that contain spaces
- Daily path still clears `VITE_DEV_SERVER_URL` and never sets it

---

### Second live-launch attempt (failed) — Electron default welcome app

After the npm.cmd fix, `scripts\start-jarvis.bat` appeared to succeed.

Observed:
- Terminal showed `npm start` / `electron .`, dotenv `.env.local` injection, and `[jarvis-launch] ready`
- Visible window was Electron’s default welcome page (“To run a local app, execute electron.exe path-to-app”)
- Jarvis UI did not load

#### Exact root cause

Live process inspection found:

```text
electron.exe   (no application argument)
--app-path=...\node_modules\electron\dist\resources\default_app.asar
--user-data-dir=...\AppData\Roaming\Electron
window title: Electron
```

A correct Jarvis process looks like:

```text
electron.exe "<absolute repository root>"
--app-path=<repository root>
--user-data-dir=...\AppData\Roaming\rileyjarvis
window title: Jarvis
```

`Start-Process` → `npm.cmd start` → `electron .` did not reliably leave a child whose command line included the repository app path. A bare `electron.exe` loads `default_app.asar`. Manual `npm.cmd start` from the repository root did open Jarvis, but the daily launcher path must not depend on `.` resolution through Start-Process.

Additional defect: already-running detection treated a bare `...\rileyjarvis\node_modules\electron\dist\electron.exe` command line as Jarvis because the exe path contains the repository string.

#### Explicit-app-path correction

Daily launch now invokes:

```text
node_modules\electron\dist\electron.exe <absolute repository root>
WorkingDirectory = <absolute repository root>
```

- Does not use bare `electron.exe`, `electron .`, or `npm start` for the Electron child
- `npm.cmd` remains only for optional `-Rebuild` / missing-dist builds

#### Process-identity and readiness safeguards

- Already-running detection matches only command lines that identify this repository as the Electron **app** (`--app-path=<repo>`, absolute repo argument after `electron.exe`, or `electron/main.cjs` under the repo)
- Bare Electron / `default_app.asar` never counts as Jarvis
- Launcher waits for Jarvis process identity after start; otherwise kills the child tree and fails with a readable error
- `main.cjs` prints `[jarvis-launch] ready` only after `app.getAppPath()` equals the repository cwd (refuses `default_app.asar`)
- Second valid Jarvis launch still starts Electron so the single-instance lock focuses the existing window

---

### Third live-launch attempt (failed) — spaced path split at “Sarah”

Observed after the explicit-app-path correction:

```text
Unable to find Electron app at C:\Users\Sarah
Cannot find module 'C:\Users\Sarah'
```

Actual repository root: `C:\Users\Sarah Segel\OneDrive\Cursor\rileyjarvis`.

#### Exact root cause

Windows PowerShell `Start-Process -ArgumentList @($RepoRoot)` does **not** quote arguments that contain spaces. CreateProcess therefore received two tokens (`C:\Users\Sarah` and `Segel\OneDrive\Cursor\rileyjarvis`) instead of one application path. Electron treated `C:\Users\Sarah` as the app path.

#### Quoting correction

Daily launch now starts Electron via `System.Diagnostics.ProcessStartInfo`:

```text
FileName          = <repo>\node_modules\electron\dist\electron.exe
WorkingDirectory  = <absolute repository root>
Arguments         = "<absolute repository root>"   # one quoted CreateProcess argument
UseShellExecute   = false
```

- Does not concatenate an unquoted command string
- Does not use `Start-Process -ArgumentList @($RepoRoot)` for the Electron child
- Helpers `quoteWindowsProcessArgument` / `buildWindowsStartProcessArgumentList` document and test the quoted form

#### Regression coverage added (quoting)

- “Sarah Segel” repository path remains one decoded app argument
- Truncated `C:\Users\Sarah` cannot be produced by the quoted argument list
- Exactly one app-path argument in the generated process argument list
- Ordinary Windows paths with spaces (no apostrophes) work
- No `default_app.asar` fallback in the launch plan

#### Regression results (explicit-app-path + quoting corrections)

```
node --test electron/phase-17-daily-use-reliability.test.cjs
→ 30/30 pass

npm run build
→ tsc --noEmit OK; vite build OK

git diff --check
→ EXIT 0
```

Jarvis not relaunched after this quoting fix (per instructions).

### Fourth finding — ready without visible BrowserWindow

After the quoting fix, the launcher could report:

```text
[jarvis-launch] process identity confirmed
[jarvis-launch] ready
```

while no Jarvis UI was visible.

#### Exact root cause

1. `[jarvis-launch] ready` was printed in `app.whenReady()` **before** `createWindow()` completed or showed a window. Launcher “process identity confirmed” only proved the Electron process had the repository app path.
2. Daily UI uses a frameless transparent `BrowserWindow`. Vite’s default `base: "/"` emitted absolute `/assets/...` URLs in `dist/index.html`, which often fail under Electron `loadFile` (`file://`), leaving an empty transparent (effectively invisible) window. There was no `did-fail-load` handling and no explicit `ready-to-show` → `show()`/`focus()` path.

#### Visibility correction

- `vite.config.ts`: `base: "./"` so production assets resolve next to `dist/index.html` under `file://`
- `electron/window-launch.cjs`: pure visibility / readiness / sanitized load-failure helpers
- `electron/main.cjs`:
  - `show: false` until load succeeds
  - `did-finish-load` / `ready-to-show` → restore if minimized, center if off-screen, `show()` + `focus()`
  - `[jarvis-launch] ready` only after `evaluateJarvisUiReadiness` (loaded, shown, not minimized, visible, on-screen)
  - main-frame `did-fail-load` / load exceptions → sanitized `[jarvis-launch] renderer-load-failed` and **no** ready
- Single-instance focus behavior unchanged

#### Regression coverage added (visibility)

- Relative production asset URLs in Vite config and built `dist/index.html`
- Readiness only after successful show/visibility
- No readiness after renderer load failure (sanitized diagnostics)

#### Regression results (visibility correction)

```
node --test --test-name-pattern "17.7 relative production|17.7 UI readiness|17.7 no UI readiness|17.7 launch prerequisite|17.7 single-instance" electron/phase-17-daily-use-reliability.test.cjs
→ 5/5 pass

npm run build
→ OK (dist assets now ./assets/…)

git diff --check
→ EXIT 0
```

Jarvis not relaunched (per instructions).

---

### Fifth finding — recent “that one” failed after restart (live L7)

Observed after pending-discard restart passed:

- `P17 restart continuity check` remained in daily priorities.
- Pending banner correctly absent.
- Prompt `What is the exact text of that one?` did **not** resolve; Jarvis asked which item.

#### Exact root cause

Persistence/restore were healthy: `session-continuity.json` held `priorityId` matching the P17 item in `daily.json`. Preview-remove did not clear recent. Startup hydration loads that id into `recentPriorityId`, and `resolvePriorityReference` supports `by: "recent"`.

The live miss was **prompt-routing / schema gap**: instructions never mapped “that one” / “that” / “the recent one” to `reference: {"by":"recent"}`, and `memory_priorities` reference docs omitted `recent` (unlike working-context / active-projects). The model clarified instead of calling the tool with `by: "recent"`. Automated coverage exercised tool-level recent resolve, not the instruction mapping.

#### Correction

- Instructions: explicit mapping of “that one” / “that” / “the recent one” → most recently touched compatible item; require `reference: {"by":"recent"}`; do not ask which item while a valid recent reference exists.
- `memory_priorities` reference schema/description: explicitly accepts `{"by":"recent"}` / `"recent"`.
- Continuity file format unchanged; `data/memory` not modified by the fix.
- Focused regressions: instruction mapping, schema accepts recent, persisted recent resolves after simulated restart.

#### Regression results (recent-reference correction)

```
node --test --test-name-pattern "17.5 instruction maps|17.5 memory_priorities schema|17.5 persisted recent" electron/phase-17-daily-use-reliability.test.cjs
→ 3/3 pass

git diff --check
→ EXIT 0
```

(`npm run build` not required — Electron main/instruction changes only.)

### Temporary DevTools hook (diagnostics only; removed)

Inserted only for sanitized-diagnostics live proof:

```js
win.webContents.openDevTools({ mode: "detach" });
```

inside `did-finish-load` after `showJarvisWindowIfReady()`. Removed immediately after the clipboard report passed. No durable-memory changes. No temporary diagnostics code remains.

### Final clean-shutdown verification (L8) — passed

With Jarvis quit via the normal UI close path, repository-scoped Win32 process query:

```powershell
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(electron|node)\.exe$' -and
  [string]$_.CommandLine -match [regex]::Escape((Resolve-Path .).Path)
} | Select-Object ProcessId, Name, CommandLine
```

**Result:** no remaining `electron.exe` / `node.exe` processes for this repository. Jarvis fully closed.

---

## Pre-merge correction pass (draft PR #1)

**No live validation was run during this correction pass.** No Jarvis launch and no OpenAI requests. Live `data/memory` was not modified.

### Defect 1 — Pending confirmation injected into every text turn

| | |
|---|---|
| **Root cause** | `electron/main.cjs` `text:run` always copied `getPendingConfirmationInternal()` into the payload whenever a preview existed. |
| **Correction** | Added `resumePendingConfirmation` on the client request. `prepareTextRunPayload` (`electron/text-run-request.cjs`) injects the internal token **only** when that flag is `true`. Fresh Send leaves the flag false. App sets the flag only on manual Retry. Renderer-supplied `pendingConfirmation` is always stripped. |
| **Tests** | Behavioral: fresh payload has no token; resume attaches token; text-session hint appears only when pending is on the prepared request. |

### Defect 2 — Dismiss destroys remint suppression

| | |
|---|---|
| **Root cause** | `dismissPendingConfirmation()` called `clearPendingConfirmation()`, wiping internal continuity while leaving `previewStore` entries. |
| **Correction** | Banner visibility is separate (`pendingBannerDismissed`). Dismiss hides `getPendingConfirmation()` only. Internal pending + remint reuse remain until success, TTL, stale binding, restart, or `invalidatePreviews()`. New/superseding previews clear the dismiss flag and show again. |
| **Tests** | Dismiss hides public projection; internal token remains; equivalent remint reuses the same token. |

### Defect 3 — Retryable session errors blocked in the renderer

| | |
|---|---|
| **Root cause** | Manual retry treated `session.error` as non-retryable by code alone (or inconsistently), ignoring backend `retryable: true` (timeout). |
| **Correction** | `isTextManualRetryAllowed(code, retryable?)` uses the explicit `retryable` flag when present. Timeout (`retryable: true`) allows Retry; busy/cancel/reject (`retryable: false`) do not. Quota/config stay non-retryable even if a flag is wrongly true. |
| **Tests** | Timeout retryable vs busy/cancel non-retryable unit cases. |

### Defect 4 — Exact composer text trimmed before submission

| | |
|---|---|
| **Root cause** | App/TextClient/`buildInitialInput` trimmed the composer before `runTextTurn` / Responses input. |
| **Correction** | Trim only for emptiness / history dedup. Submit and API current-message use the exact composer string. Auto network retry resubmits the same string without duplicating `onUserText`. |
| **Tests** | Exact whitespace preserved in text-session request body; planner/source contracts for `exactText`. |

### Defect 5 — Shared cooldown fallback across unrelated errors

| | |
|---|---|
| **Root cause** | Single `cooldownAttemptIndex` advanced across all failure codes. |
| **Correction** | `advanceTextCooldownChain` resets fallback index when the error code/category changes; consecutive 429 counter resets on non-429; success resets all chain state. |
| **Tests** | network→5xx, 5xx→network, 429→429→non-429→429 behavioral chain tests. |

### Defect 6 — Dead / misleading pending wiring

| | |
|---|---|
| **Root cause** | `pendingInternalRef`, `fetchPendingHint()`, and comments implied renderer access to internal tokens. |
| **Correction** | Removed dead refs/helpers. Flow is App (`resumePendingConfirmation`) → TextClient → `vite-env` request → main `prepareTextRunPayload` → text-session hint. |

### Command results (correction pass)

```
node --test electron/phase-17-daily-use-reliability.test.cjs
→ 43/43 pass

node --test electron/text-mode.test.cjs electron/text-prompt-submit.test.cjs electron/text-history.test.cjs electron/text-delivery.test.cjs electron/text-panel-activation.test.cjs electron/realtime-diagnostics-recovery.test.cjs electron/clipboard-diagnostics.test.cjs
→ 78/78 pass

node --test electron/priority-lifecycle.test.cjs electron/working-context-lifecycle.test.cjs electron/active-projects-lifecycle.test.cjs electron/day-briefing.test.cjs electron/memory.test.cjs
→ 126/126 pass

npm run build
→ tsc --noEmit OK; vite build OK

git diff --check
→ EXIT 0
```

### Follow-up correction — bind resume to the exact failed composer

| | |
|---|---|
| **Root cause** | App treated any Manual Retry as eligible for `resumePendingConfirmation`, so editing the composer could attach an older destructive preview token to materially different text. |
| **Correction** | `PendingResumeEligibility` stores only the exact composer string from the latest failed turn associated with pending confirmation (never the token). App requests resume only when Manual Retry is explicit and the current composer is byte-for-byte identical. TextClient independently enforces the same check. A fresh unrelated turn, cancellation, or success clears eligibility. Editing without submitting disables resume; restoring the exact string restores eligibility only while the same failed-turn state remains current. Main still performs the authoritative valid-internal-pending check before token injection. |
| **Automatic retry** | `autoNetworkRetryOptions()` preserves the original request's explicit resume boolean across the one permitted automatic transport retry and never infers or activates it. |
| **Tests** | Unedited retry attaches the same token; any edit prevents attachment; edit-then-restore behavior; unrelated fresh Send; success clear; auto retry preserve/never-invent. Exact whitespace/newline equality is covered. |

### Follow-up command results

```
node --test electron/phase-17-daily-use-reliability.test.cjs
→ 44/44 pass

node --test electron/text-mode.test.cjs electron/text-prompt-submit.test.cjs electron/text-history.test.cjs electron/text-delivery.test.cjs electron/text-panel-activation.test.cjs electron/realtime-diagnostics-recovery.test.cjs electron/clipboard-diagnostics.test.cjs
→ 78/78 pass

npm run build
→ tsc --noEmit OK; vite build OK

git diff --check
→ EXIT 0
```

### Remaining uncertainty / risk

- No substantive pending-confirmation resume risk remains from the reviewed path: renderer eligibility is exact-failed-text-bound and main independently requires a valid internal pending token.
- The focused Node test emits Node's non-failing `MODULE_TYPELESS_PACKAGE_JSON` warning when dynamically importing the TypeScript eligibility helper; production Vite/TypeScript build is unaffected.
- **No live validation was run during this follow-up correction pass.** Jarvis was not launched and no OpenAI request was made.
