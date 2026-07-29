# Phase 17 Audit — Daily-Use Reliability

**Status:** Design audit / implementation lock.  
**Branch:** `phase-17-daily-use-reliability`  
**Planning baseline:** `docs/phase-17-daily-use-reliability-planning-report.md`  
**Product decisions:** Locked by Sarah (text retry, pending continuity, limited restart, built-renderer launch, thin diagnostics).

This document is the implementation contract for Phase 17. It does not implement code.

---

## Locked product decisions (summary)

Phase 17 combines:

1. Text rate-limit and transient-failure resilience  
2. Same-process pending-confirmation continuity  
3. Limited restart continuity (recent IDs only; no preview disk persistence)  
4. Dependable lightweight Windows launch (built renderer)  
5. Thin daily-use diagnostics  

**Explicitly separate / out of scope:** aggressive automatic retry; disk persistence of preview tokens or destructive plans; preview-mint diagnostics; backup-retention changes; restore-ID normalization; Realtime memory refresh; Phase 8 audio; packaging/installer; OAuth/integrations; compound multi-action verification.

---

## 1. Current failure and launch architecture

### 1.1 Text request path (today)

| Layer | File | Behavior |
|---|---|---|
| UI | `src/App.tsx` | `sendTextPrompt()` → session lock → `TextClient.submit` → status/transcript on error |
| Client | `src/lib/textClient.ts` | Turn lock; IPC `runTextTurn`; delivers artifacts; `onError(message, code?)`; **no cooldown / Retry UI** |
| Preload | `electron/preload.cjs` | `text:run`, `text:cancel` |
| Main | `electron/main.cjs` | `createTextSessionController` |
| Backend | `electron/text-session.cjs` | OpenAI Responses API; tool loop; classifies HTTP failures including 429 / `Retry-After`; returns `ok:false` with `retryable`; **no auto-retry** |

**Composer:** cleared only after successful visible delivery. On failure, exact draft remains (keep as hard requirement).

**Duplicate in-flight prevention (partial today):** `textTurnActive`, `TextClient.isActive()`, Electron `activeTurns`, session owner lock. **Missing:** cooldown after rate-limit that blocks Send/Retry until wait ends.

### 1.2 Realtime path (today; mostly unchanged)

- Connect retries already exist (`src/lib/realtime.ts` + `src/lib/realtimeErrors.ts`): up to 3 attempts, backoff `[1000,2000,4000]`, `Retry-After` capped at 30s.
- Voice error strip: Retry / Dismiss / Copy diagnostics.
- Phase 17 does **not** redesign Realtime connect retry. Shared taxonomy/helpers may be reused for text cooldown display.

### 1.3 Preview / recent (today)

- `previewStore` = process-local `Map` in `electron/memory.cjs`.
- `PREVIEW_TTL_MS = 10 * 60 * 1000` (`electron/priority-lifecycle.cjs`).
- Successful writes call `invalidatePreviews()`.
- Recent IDs: `recentPriorityId`, `recentActiveProjectId`, `recentWcIds` — process-local only.
- Restart clears all of the above.

### 1.4 Launch (today)

- Daily/dev docs point at `npm run dev` (Vite `:5173` + Electron).
- `npm start` → `electron .` loads `dist/index.html` (requires prior `npm run build`).
- No single-instance lock, no Windows launcher script, no startup health checks, no installer.

### 1.5 Diagnostics (today)

- Shared ring buffer (`RealtimeDiagnosticsBuffer`); voice Copy wired; text errors mostly status + transcript.
- App version string hardcoded `"1.0.0"` in clients.

---

## 2. Exact error taxonomy and retryability rules

Reuse Phase 9 codes from `src/lib/realtimeErrors.ts` for text turn failures. Phase 17 adds **text-specific policy** on top of classification (classification alone must not auto-fire OpenAI).

| Code | Typical source | User message (canonical) | Manual Retry after cooldown? | Auto network retry? |
|---|---|---|---|---|
| `rate_limited` | HTTP 429 (non-quota) | OpenAI is rate-limiting requests. Wait, then retry. | **Yes** (after countdown) | **Never** |
| `quota.exhausted` | HTTP 429 quota/billing | OpenAI quota is exhausted. Check billing/limits. | **No** (non-retryable) | **Never** |
| `network.offline` | `fetch` throw / transport failure before usable response | Network connection looks down. | Yes | **At most one**, only if §4 allows |
| `server.unavailable` | 500/502/503/504 | OpenAI is temporarily unavailable. | Yes (honor `Retry-After` if present) | **Never** |
| `api.bad_response` | HTML/non-JSON body | OpenAI returned an unreadable response. | Yes | **Never** |
| `config.missing_api_key` | Missing key | Add your OpenAI API key in `.env.local`, then try again. | No until fixed | Never |
| `config.invalid_api_key` | 401/403 | OpenAI rejected the API key. Check `.env.local`. | No until fixed | Never |
| `session.error` | Busy / cancel / session | Existing messages | Case-by-case; no auto | Never |
| `unknown` | Fallback | Sanitized generic failure | Yes (short cooldown) | Never |

Mic/WebRTC codes remain voice-only; text path must not surface them for text turns.

**Hard rule:** `retryable: true` in classification means “user may Retry after policy,” **not** “system may auto-resubmit,” except the single network case in §4.

---

## 3. Retry-After parsing, fallback cooldowns, caps, and repeated-failure behavior

### 3.1 Parsing

Reuse `parseRetryAfterMs`:

- Integer seconds → ms  
- HTTP-date → delta ms  
- Invalid/missing → `undefined`

### 3.2 Caps and fallbacks (text policy constants)

| Constant | Value | Role |
|---|---|---|
| `TEXT_RETRY_AFTER_CAP_MS` | `60_000` | Cap honored `Retry-After` for **text** cooldown UI (slightly above Realtime’s 30s connect cap; still bounded) |
| `TEXT_COOLDOWN_FALLBACK_MS` | `[1000, 2000, 4000, 8000]` | Suggested wait when no `Retry-After` |
| `TEXT_REPEATED_429_FLOOR_MS` | `30_000` | After **3 consecutive** user-facing `rate_limited` failures in one cooldown chain, minimum suggested wait |
| `TEXT_REPEATED_429_MESSAGE_AFTER` | `3` | After this many consecutive rate limits, add durable “wait longer / try later” copy while still allowing eventual manual Retry |

`computeTextCooldownMs(attemptIndex, retryAfterMs)`:

1. If `retryAfterMs` finite → `min(retryAfterMs, TEXT_RETRY_AFTER_CAP_MS)`  
2. Else → `TEXT_COOLDOWN_FALLBACK_MS[min(attemptIndex, last)]`  
3. If consecutive `rate_limited` count ≥ 3 → `max(computed, TEXT_REPEATED_429_FLOOR_MS)`

### 3.3 Countdown display rules (anti-misleading)

- Show **remaining seconds** and/or **next permitted retry clock time** derived from `cooldownUntilMs`.  
- Do **not** show a retry countdown for `quota.exhausted` or other non-retryable codes.  
- Do **not** imply an automatic resubmit (“Retrying in…”) for 429 — copy must be “You can retry in Ns” / “Retry available at HH:MM:SS”.  
- Countdown may tick in UI; Send and Retry stay disabled until `Date.now() >= cooldownUntilMs`.  
- Cancel does not bypass cooldown for a new Send of the same failed turn’s automatic path; user may edit text but Send remains disabled until cooldown ends (prevents hammering). Optional: allow Cancel only to abort an **in-flight** turn, not to clear cooldown.

### 3.4 Repeated failure behavior

| Situation | Behavior |
|---|---|
| First `rate_limited` | Countdown from §3.2; composer preserved; pending preview (if any) remains valid |
| Repeated `rate_limited` | Attempt index advances fallback; after 3, floor 30s + durable wait message |
| Alternating network/5xx | Each failure type uses its own policy; consecutive 429 counter resets when a non-429 failure intervenes or a successful turn completes |
| Success | Clear cooldown, consecutive counters, and error strip retry state |

---

## 4. Manual Retry and the single permitted automatic network retry

### 4.1 Manual Retry (primary recovery)

**When enabled:**

- Cooldown elapsed (`Date.now() >= cooldownUntilMs`)  
- Last text error code is retryable per §2  
- No text turn in flight  
- Not voice-busy / session-locked  

**Action:**

1. Resubmit the **exact preserved composer text** (byte-for-byte trim-stable: same string currently in the composer; Retry must not clear or alter it).  
2. If same-process pending confirmation exists and is still valid (§6–7), attach pending context to the turn so the model **must reuse** `previewToken` / confirm args and **must not remint** while valid (see §7.3).  
3. Never auto-fire a destructive tool confirm without this user-initiated Retry (or an explicit Confirm control if implemented as the same user gesture).

**Quota / config errors:** Retry control hidden or disabled with billing/config message only.

### 4.2 Single automatic network retry (narrow)

**Allowed only when all are true:**

1. Classified code is `network.offline` (transport/`fetch` failure).  
2. The failed attempt is marked `safeForAutoNetworkRetry === true` (see below).  
3. No prior auto-network retry has been consumed for this user submit (`autoNetworkRetriesUsed < 1`).  
4. Failure is **not** HTTP 429, 5xx, timeout-after-response, or abort after partial tool work.

**`safeForAutoNetworkRetry` definition (critical):**

Set `true` only if the text turn attempt **never obtained a successful HTTP response body from OpenAI for that attempt** — i.e. `fetch` threw before `response.ok` handling completed.  

Set **`false` (never auto-retry)** if any of:

- Any HTTP response was received (including 429/5xx/4xx)  
- Any tool call in the loop was invoked  
- Any assistant/tool output was parsed from a 2xx response  
- Turn timed out / aborted after the request was sent (ambiguous whether mutation ran)  
- Pending confirmation confirm call may have been issued  

**On auto-retry:** wait a short fixed delay (e.g. 500–1000 ms, no long countdown UI required), resubmit **once** with same text/history, then fall back to manual Retry policy if it fails again.

**Never** automatically retry `rate_limited`, `quota.exhausted`, `server.unavailable`, confirm turns after tools ran, or any turn where mutation/confirmation may have executed.

---

## 5. Duplicate-submission prevention and composer preservation

### 5.1 Layers (all required)

| Layer | Rule |
|---|---|
| UI Send | Disabled while `textTurnActive` **or** `textCooldownActive` |
| UI Retry | Disabled while cooldown active, turn active, or non-retryable |
| `TextClient` | Reject submit if already active |
| Electron | Reject second `text:run` while `activeTurns` non-empty |
| Session owner | Existing text vs voice lock unchanged |
| Cooldown store | Main or renderer authoritative `cooldownUntilMs`; both Send and Retry consult it |

### 5.2 Composer preservation

- On any classified text failure (including 429, network, 5xx, auto-retry failure): **do not** call `setTextPrompt("")`.  
- Retry uses the current composer value; implementation must not replace user edits made during cooldown (if user edits during cooldown, Retry/Send still wait for cooldown; edited text is what gets sent).  
- Successful delivery clears composer as today.

### 5.3 Duplicate mutation risk controls

- No parallel text turns.  
- No auto-retry after any tool invocation.  
- Confirm resume must use existing `previewToken`; successful confirm invalidates all previews.  
- Remint suppression while pending valid (§7.3) reduces double-plan confusion.

---

## 6. Same-process pending-confirmation state model

### 6.1 Source of truth

- **Authoritative plans/tokens:** existing in-memory `previewStore` (unchanged TTL / invalidate semantics).  
- **UI/continuity projection:** `pendingConfirmation` object derived from the latest `CONFIRMATION_REQUIRED` result and current store validity.

### 6.2 `pendingConfirmation` shape (process memory only)

```ts
{
  toolName: "memory_priorities" | "working_context_items" | "memory_active_projects";
  operation: string;           // e.g. remove | replace | restore_backup | carry | convert | ...
  scope?: string | null;       // WC only
  previewToken: string;        // process memory only — never write to disk
  expiresAt: number;           // epoch ms; mirrors preview entry
  redactedSummary: string;     // short, no secret bodies
  dailyUpdatedAt?: string;     // binding hint for staleness messaging
  createdAt: number;
}
```

**Redacted summary rules:** operation label + count/ordinal/name snippets already safe for ordinary speech; apply existing sensitivity redaction; never include raw `secret` values, full before/after dumps, or token strings in the visible banner (token may exist in process state for confirm resume, not in Copy diagnostics — see §15).

### 6.3 Lifecycle

| Event | Action |
|---|---|
| Tool returns `CONFIRMATION_REQUIRED` + token | Set/replace `pendingConfirmation` |
| Successful confirmed write / any `invalidatePreviews()` | Clear pending |
| TTL expiry on read or timer | Clear pending; user-visible expired message if banner was showing |
| Explicit user cancel of pending (Dismiss pending) | Clear pending UI; **do not** delete preview entry unless product adds explicit discard — default: Dismiss hides banner but token may remain until TTL/invalidate; **preferred Phase 17:** Dismiss clears pending projection only; optional “Cancel confirmation” clears pending + deletes that token from store |
| Restart | Entire store + pending gone (§9) |
| Temporary API/network failure mid-confirm turn | **Keep** pending if token still in store and unexpired |

### 6.4 Visibility

Banner/status must show: pending operation, redacted summary, expiry (relative and/or absolute).  
While pending valid after a failed confirm turn: copy must **not** urge “ask me to preview again.”

---

## 7. Confirmation retry contracts and stale/expired handling

### 7.1 Confirm retry contract

When the user Retries after a failure and `pendingConfirmation` is still valid:

1. Attach pending context to the text turn (IPC/main → instructions or structured turn hint).  
2. Model/tool path must call the **same** tool with `confirmed: true` and the **same** `previewToken` and binding fields.  
3. Existing `readPreview` / binding checks remain the final authority (`STALE_PREVIEW` if mismatch/TTL/`dailyUpdatedAt` drift).

### 7.2 Stale / expired handling

| Condition | Result | User-visible |
|---|---|---|
| Token missing | `STALE_PREVIEW` | Confirmation expired or no longer valid. Ask to preview again. Clear pending. |
| TTL exceeded | `STALE_PREVIEW` | Same |
| `dailyUpdatedAt` mismatch / binding mismatch | `STALE_PREVIEW` | Confirmation is out of date. Ask to preview again. Clear pending. |
| Success | apply plan | Clear pending; normal success |

### 7.3 Remint suppression (same-process)

While a pending confirmation is valid, if the model requests a **new** preview for the **same** tool + operation + equivalent binding:

- **Do not** mint a replacement token by default.  
- Return the existing `CONFIRMATION_REQUIRED` payload (same `previewToken`, same plan summary) **or** a clear code such as `PENDING_CONFIRMATION_ACTIVE` with the existing token/summary.  

If binding/args differ materially, invalidate or supersede per existing preview rules (new mint allowed; update pending to the new token).

**Goal:** remove Phase 15 remint → `STALE_PREVIEW` pressure during 429 recovery.

### 7.4 Failed confirmation (API failure before apply)

If confirm tool was **not** successfully applied (turn failed at HTTP/transport, or model never reached confirm):

- Pending remains.  
- User Retries per §4.  
- Disk unchanged.

If confirm **succeeded** on server but UI failed to display: existing delivery diagnostics apply; pending already cleared by successful write — do not re-confirm.

---

## 8. Recent-reference persistence schema, storage path, validation, expiry, corruption

### 8.1 What persists

**Only** recent reference UUIDs:

- `recentPriorityId`  
- `recentActiveProjectId`  
- `recentWcIds.commitments` / `follow_ups` / `unresolved_items`  

**Never persist:** preview tokens, bound plans, before/after arrays, hashes of plans, transcripts, composer drafts, diagnostics buffers, API keys.

### 8.2 Storage path

`data/memory/session-continuity.json` under the existing memory root (`path.join(dataDir, "memory")`).

- Lives under gitignored `data/` (already in `.gitignore`).  
- Local-only; no sync protocol in Phase 17.

### 8.3 Schema

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-28T21:00:00.000Z",
  "recent": {
    "priorityId": null,
    "activeProjectId": null,
    "workingContext": {
      "commitments": null,
      "follow_ups": null,
      "unresolved_items": null
    }
  }
}
```

- IDs must be strings matching existing UUID-like ids or `null`.  
- Unknown `schemaVersion` → treat as corruption (§8.5).  
- **No time-based expiry** on recent IDs; validity is existence in current records.

### 8.4 Load / save / validate

| Hook | Behavior |
|---|---|
| Startup (`ensureMemory`) | Load file; hydrate in-memory recent scalars if valid |
| After successful touch that updates recent | Write-through atomic save (temp + rename pattern consistent with memory writes) |
| Resolve `reference: "recent"` / `{ by: "recent" }` | Use hydrated id; if id missing in current list → normal `NOT_FOUND` (deterministic); clear that stale id from memory + persist |

### 8.5 Corruption handling

- Missing file → start with nulls; create on first update.  
- Invalid JSON / wrong shape / non-string ids → ignore file, start fresh, log sanitized warn (`session-continuity.load_failed`), do not crash.  
- Partial scopes allowed; coerce missing keys to `null`.

---

## 9. Explicit restart behavior for discarded pending confirmations

On Jarvis process exit/restart:

1. In-memory `previewStore` is empty (not restored).  
2. `pendingConfirmation` is empty (not restored).  
3. Recent IDs reload from `session-continuity.json` only.  
4. On first UI ready after restart, if continuity file loaded successfully, no pending banner.  
5. **Do not** persist any pending marker or “had pending” boolean to disk (that would encode confirmation state on disk).  
6. After restart there is simply **no** pending banner.  
7. Status/diagnostics may include a static capability note: “Pending confirmations do not survive restart.” (not an alarming toast on every launch).  
8. Live-validation: kill Jarvis mid-pending → relaunch → banner absent; confirm without new preview fails stale path; user must preview again.

---

## 10. Security and privacy guarantees

| Data | Disk? | Logs/diagnostics? | UI? |
|---|---|---|---|
| Recent UUIDs | Yes (`session-continuity.json`) | Ids only OK in debug logs sparingly | Not shown as raw ids in banner |
| Preview tokens / plans | **Never** | Never full plans; no tokens in Copy diagnostics | Banner: redacted summary only |
| Composer / transcript | Never (Phase 17) | Never full user text in Copy | Composer local only |
| API keys | Never | Redact via existing sanitizer | Never |
| Secret memory | Never via continuity | Never | Redact in summaries |
| Build/version | OK | OK | OK |

Additional:

- Continuity file must remain under gitignored `data/`.  
- Atomic writes; no cloud upload.  
- Copy diagnostics must run through sanitization (§15).

---

## 11. IPC contracts and frontend state

### 11.1 New / extended IPC (illustrative names; implement consistently)

| Channel | Direction | Purpose |
|---|---|---|
| `text:run` / `text:cancel` | existing | Extend result/`onError` path with `retryAfterMs`, `cooldownMs`, `safeForAutoNetworkRetry`, `error.code` |
| `continuity:get` | renderer→main | `{ recent, pendingConfirmation, cooldown, buildInfo, restartPolicyNote }` |
| `continuity:subscribe` or push events | main→renderer | Pending/cooldown updates |
| `continuity:dismiss-pending` | renderer→main | Clear pending projection (and optionally token — per §6.3 preferred dismiss policy) |
| `app:get-build-info` | renderer→main | `{ version, gitSha?, branch? }` best-effort |

Preload exposes safe wrappers on `window.jarvis`.

### 11.2 Text turn result error enrichment

```ts
error?: {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  cooldownMs?: number;
  safeForAutoNetworkRetry?: boolean;
}
```

### 11.3 Frontend state (`App.tsx` / text client)

| State | Meaning |
|---|---|
| `textCooldownUntilMs` | Send/Retry gated |
| `lastTextError` | `{ code, message, retryable }` |
| `pendingConfirmation` | Banner model (no raw token display) |
| `buildInfo` | Version / sha for strip |
| `autoNetworkRetriesUsed` | Per submit attempt counter |

**Text Retry control:** visible when `lastTextError.retryable && !cooldownActive && !textTurnActive` (and not quota/config).

**Copy diagnostics:** available for text failures (parity with voice), sanitized.

---

## 12. Windows launch architecture

### 12.1 Built renderer (daily path)

Ordinary daily use:

1. Ensure `dist/index.html` exists (run `npm run build` if missing, or when `-Rebuild` switch passed).  
2. Start Electron via `npm start` (`electron .`) with **no** `VITE_DEV_SERVER_URL` so `loadFile(dist/index.html)` is used.  
3. **No Vite process** in the daily path → eliminates the primary orphan-Vite failure mode for pilot use.

### 12.2 PowerShell launcher

`scripts/start-jarvis.ps1`:

- Resolve repo root from script location.  
- Prerequisite checks (§12.4).  
- Optional `-Rebuild` to force `npm run build`.  
- If `dist/index.html` missing → build; on build failure → readable error, exit nonzero.  
- Start `npm start` (or `npx electron .`) as child; wait; on Ctrl+C, stop child process tree.  
- If single-instance lock fails because app already running, print “Jarvis is already running” and exit 0 (Electron second instance focuses window).

### 12.3 Batch wrapper

`scripts/start-jarvis.bat`:

- `cd` to repo / call PowerShell with `-NoProfile -ExecutionPolicy Bypass -File "%~dp0start-jarvis.ps1" %*`.  
- Suitable target for a Windows desktop shortcut (shortcut creation itself is **out of band** unless Sarah later requests a helper; scripts must be shortcut-ready).

### 12.4 Prerequisite checks (readable failures)

Before start, verify and print plain-language errors for:

| Check | Failure message (example) |
|---|---|
| `node` on PATH | Node.js was not found. Install Node.js, then try again. |
| `npm` on PATH | npm was not found. |
| `package.json` in root | Launch script could not find the Jarvis project root. |
| `node_modules/electron` present | Dependencies missing. Run npm install in the Jarvis folder. |
| `.env.local` exists | Missing .env.local. Copy .env.example to .env.local and add OPENAI_API_KEY. |
| `OPENAI_API_KEY` non-empty (dotenv parse or simple line check) | OPENAI_API_KEY is missing in .env.local. |
| Build failure | Jarvis could not build. See messages above. |
| Electron exit nonzero | Jarvis exited with an error (code N). |

Do not print secret key values.

### 12.5 Health checks

- After Electron ready: window created; memory `ensureMemory` as today.  
- Optional: main logs `[jarvis-launch] ready` with build info.  
- Dist presence check before Electron spawn.

### 12.6 Single-instance lock and second-instance focus

In `electron/main.cjs` early:

- `const gotLock = app.requestSingleInstanceLock()`.  
- If `!gotLock` → `app.quit()`.  
- On `second-instance` → focus existing `BrowserWindow` (show, restore if minimized, `focus()`).

Applies to **both** daily and dev launches (prevents duplicate stacks).

### 12.7 Clean shutdown

| Concern | Daily built path | Dev `npm run dev` |
|---|---|---|
| Vite orphans | N/A (no Vite) | Unchanged `concurrently -k` responsibility; Phase 17 does not redesign dev orchestration beyond single-instance |
| Electron | `window-all-closed` → quit (non-Darwin); cancel active text turns on `before-quit` | Same |
| Script Ctrl+C | Kill Electron child tree | Dev users still use npm/Cursor |

**Do not** leave intentional background Node servers in daily path.

---

## 13. Development-launch versus daily-launch behavior

| Aspect | Daily (pilot) | Development |
|---|---|---|
| Entry | `scripts/start-jarvis.bat` / `.ps1` | `npm run dev` from repo / Cursor |
| Renderer | Built `dist/` | Vite `http://127.0.0.1:5173` |
| HMR | No | Yes |
| Audience | Sarah everyday use | Implementers |
| Vite | Not started | Started |
| Single-instance | Yes | Yes |
| Docs/README | Prefer daily scripts for ordinary use; keep `npm run dev` under Development | Unchanged purpose |

**Anti-confusion rules:**

- Launcher names must say Jarvis start, not “dev”.  
- Script banner: “Starting Jarvis (built UI)…”.  
- Do not set `VITE_DEV_SERVER_URL` in daily launcher.  
- Phase 17 README touch (when implementing): Quick Start for daily use → scripts; Development section → `npm run dev`.

---

## 14. User-visible behavior matrix

| Scenario | Behavior |
|---|---|
| **First 429** | Sanitized rate-limit message; countdown from `Retry-After` or fallback; Send/Retry disabled during cooldown; composer unchanged; pending confirm (if any) stays valid with banner; **no** auto resubmit; **no** remint pressure |
| **Repeated 429s** | Same; backoff/floor per §3; after 3 consecutive, durable “wait longer / try later”; still manual Retry only after cooldown |
| **Quota exhaustion** | Billing/quota message; **no** countdown; Retry hidden/disabled; composer preserved; pending remains until TTL but user informed API cannot proceed until quota fixed |
| **Network interruption** | Network message; at most one auto-retry if `safeForAutoNetworkRetry`; else manual Retry; pending preserved if process alive |
| **5xx failure** | Server unavailable; cooldown from `Retry-After` or fallback; manual Retry only; no auto; pending preserved |
| **Failed confirmation** | If preview valid: banner shows pending op + expiry; Retry reuses token/intent; disk unchanged |
| **Expired confirmation** | Pending cleared; message to preview again; confirm without valid token → `STALE_PREVIEW` |
| **Restart with pending** | Pending discarded; no restored banner; static policy: confirmations do not survive restart; user must preview again; recent IDs still available |
| **Recent reference after restart** | “that one” / recent resolves if id still exists; else normal `NOT_FOUND` and stale id cleared |
| **Attempted second launch** | Existing window focused; no second Electron/Vite daily stack; script reports already running |

---

## 15. Sanitized diagnostic content and exclusion rules

### 15.1 Include in Copy diagnostics / status where applicable

- Timestamped ring events (existing schema)  
- Connection / session UI state  
- Build: `package.json` version + best-effort git sha/branch  
- Last error **code** + sanitized **userMessage**  
- `httpStatus` when known  
- `retryAfterMs` / `cooldownUntilMs`  
- Pending: toolName, operation, scope, **expiresAt** — **not** previewToken, **not** plan bodies  
- Text delivery metadata already used (artifact counts/titles only)

### 15.2 Exclude always

- API keys, bearer tokens, client secrets  
- Full OpenAI request/response bodies  
- Preview tokens and bound destructive plans / before-after lists  
- Secret/sensitive memory field values  
- Full composer text and full transcript dumps (optional short length-only: `composerChars: N`)  
- Raw HTML error bodies (existing `[html-omitted]`)

Reuse `sanitizeDiagnosticText` for any free-form strings.

---

## 16. Exact files expected to change

| File | Expected change |
|---|---|
| `src/lib/realtimeErrors.ts` | Shared cooldown helpers / text constants **or** extract shared module; keep Realtime connect policy intact |
| `src/lib/textClient.ts` | Cooldown-aware error surfacing; optional auto network retry once; diagnostics parity |
| `src/App.tsx` | Cooldown UI; text Retry; pending banner; build info; Send disable rules |
| `src/vite-env.d.ts` | IPC/result typing |
| `electron/text-session.cjs` | Enrich errors; `safeForAutoNetworkRetry`; pass `retryAfterMs` |
| `electron/memory.cjs` | Load/save recent continuity; remint suppression; pending projection hooks |
| `electron/priority-lifecycle.cjs` | Export TTL already; helpers if needed |
| `electron/session-continuity.cjs` | **New** — schema load/save/validate for recent IDs only |
| `electron/main.cjs` | Single-instance lock; before-quit cancel; build-info IPC; continuity IPC; wire continuity into memory store |
| `electron/preload.cjs` | Expose new IPC |
| `scripts/start-jarvis.ps1` | **New** daily launcher |
| `scripts/start-jarvis.bat` | **New** shortcut-friendly wrapper |
| `package.json` | Optional script aliases e.g. `"jarvis": "electron ."` only if needed; avoid forcing Vite |
| `README.md` | Daily vs development launch (when implementing docs) |
| `electron/*continuity*.test.cjs` / text-session / App policy tests | **New/extended** automated matrix |
| `docs/phase-17-daily-use-reliability-audit.md` | This file |
| Later | Implementation report (not part of audit creation) |

**Unchanged by design:** day-briefing semantics, lifecycle write semantics (except remint suppression / continuity hooks), packaging toolchain, Realtime audio, OAuth, backup retention.

---

## 17. Complete automated-test matrix

### 17.1 Classification and cooldown

1. 429 rate limit vs quota body → codes; quota non-retryable; rate limit cooldown ms from `Retry-After` capped at 60s.  
2. Missing `Retry-After` → fallback schedule by attempt index.  
3. Consecutive 429 → floor 30s after 3.  
4. Quota → no countdown fields / Retry disabled policy helper.  
5. 5xx → retryable manual; uses `Retry-After` when present.  

### 17.2 Auto network retry safety

6. `fetch` throw before response → `safeForAutoNetworkRetry true` → exactly one auto retry.  
7. After 2xx with tool call → flag false → zero auto retries.  
8. HTTP 429 response → zero auto retries.  
9. Timeout/abort after send → zero auto retries.  

### 17.3 Duplicate submission / composer

10. Cooldown active → Send rejected; composer string unchanged.  
11. In-flight turn → second submit rejected.  

### 17.4 Pending confirmation

12. Mint preview → pending projection set with expiry.  
13. Inject transport failure → pending remains; remint suppression returns same token.  
14. Successful confirm → pending cleared; store invalidated.  
15. TTL expiry → pending cleared; confirm → `STALE_PREVIEW`.  
16. `dailyUpdatedAt` drift → `STALE_PREVIEW`; pending cleared.  

### 17.5 Recent continuity

17. Save/load round-trip of recent IDs.  
18. Corrupt JSON → safe reset.  
19. Stale id resolve → `NOT_FOUND` + id cleared + persisted.  
20. File contains no preview keys even if attacker-crafted extras ignored.  

### 17.6 Restart policy

21. Pending is not present in continuity file schema/writer.  
22. After simulated restart (new store), preview confirm fails without remint; recent still loads.  

### 17.7 Launch / single-instance

23. Script dry-run checks: missing node_modules / missing dist messaging (testable pure functions preferred).  
24. `requestSingleInstanceLock` false path quits; `second-instance` focuses window (unit or thin integration).  

### 17.8 Diagnostics

25. Copy report excludes tokens/keys/plans; includes code + cooldown + build.  

### 17.9 Regression

26. Phase 13–16 suites remain green; briefing/lifecycle semantics unchanged aside from remint suppression.

---

## 18. Minimal live-validation plan (do not intentionally provoke real 429s)

**Prep:** Stop any running Jarvis. Use **daily launcher** once. Prefer text-only. **Do not** loop requests to burn quota. Use injectable/simulated errors in automated tests for 429; live path verifies UX wiring with **at most one** real confirm chain.

| Step | API budget | Action / check |
|---|---|---|
| L1 | 0 | `start-jarvis.bat` starts built UI; readable failure if prerequisites wrong (optional negative: already covered by automation) |
| L2 | 0 | Second launch focuses existing window; no duplicate Electron |
| L3 | 1 | Simple text ping; status shows build/version; Copy diagnostics sanitized |
| L4 | 1–2 | Disposable preview (e.g. remove a throwaway test item); pending banner shows op + expiry |
| L5 | 0 | Simulate failure path if test hook available; else skip live 429 — **do not** hammer API. Confirm automated tests cover countdown. |
| L6 | ≤1 | Confirm **same** pending preview succeeds |
| L7 | 0 | Restart via clean quit; relaunch; pending banner absent; “that one”/recent still works for last touched item |
| L8 | 0 | Quit Jarvis; confirm no orphan Electron/Node from daily launcher (Task Manager / process check) |
| L9 | skip | Realtime smoke optional; skip by default |

**Stop rules:** Any unexpected real 429 → stop further live API calls; rely on automation; do not remint thrash.

---

## 19. One-week pilot readiness criteria

1. Sarah starts/stops Jarvis daily via `.bat`/`.ps1` without Cursor or typing `npm run dev`.  
2. Second launch focuses existing instance.  
3. Daily path uses built renderer (no Vite).  
4. Text 429 UX (verified in automation; live if naturally encountered) shows countdown, preserves composer, blocks duplicate Send/Retry, no auto resubmit.  
5. Quota shows billing message without retry loop.  
6. Same-process pending confirm survives temporary API/network failure for remaining TTL; Retry reuses token/intent; remint not required while valid.  
7. Restart drops pending; recent IDs persist and validate.  
8. No preview/plans/transcripts on disk.  
9. Status strip: connection, build/version, last error category, countdown/next retry, pending summary+expiry; text Retry + Copy diagnostics sanitized.  
10. Clean shutdown leaves no orphan daily-launch processes.  
11. Automated matrix §17 green; live checklist §18 passed.  
12. No out-of-scope items from §20 shipped.

---

## 20. Explicit out-of-scope items

- Aggressive automatic retry (multi-attempt text auto-resubmit, 429 auto-resubmit)  
- Disk persistence of preview tokens or destructive bound plans  
- Preview-mint / `STALE_PREVIEW` reason logging expansion (beyond what continuity needs)  
- Backup retention changes; restore-ID normalization  
- Realtime memory session refresh / `session.update`  
- Phase 8 residual audio / echo / mic experiments  
- Full packaging, installer, code signing, auto-update, `userData` migration  
- OAuth / connected integrations  
- Compound multi-action verification engine  
- Archive mutate/restore; transcript/composer disk persistence  
- Creating the actual Desktop `.lnk` file in-repo (scripts must be shortcut-ready; shortcut placement is user/OS step unless Sarah later asks for a helper)  
- Changing lifecycle write semantics beyond remint suppression + recent persistence hooks  

---

## 21. Implementation sequence and completion criteria

### 21.1 Sequence

1. **Audit lock** — this document accepted.  
2. **Shared text cooldown policy helpers** + enriched text-session errors (`retryAfterMs`, `safeForAutoNetworkRetry`).  
3. **UI cooldown + manual Retry + composer/Send gates** + thin diagnostics fields.  
4. **Single auto network retry** behind strict safety flag.  
5. **Pending confirmation projection + remint suppression + banner**.  
6. **`session-continuity.cjs` recent ID persist/validate**.  
7. **Electron single-instance + before-quit cleanup + build-info IPC**.  
8. **`start-jarvis.ps1` / `.bat`** built-renderer daily launch + prerequisite errors.  
9. **Automated matrix §17**.  
10. **Live validation §18** (API-thrifty).  
11. **Implementation report** when Sarah requests; commit/PR only when requested.

### 21.2 Completion criteria

Phase 17 is complete when:

1. All locked decisions in the preamble and §§2–15 are implemented as specified.  
2. Daily launch works via scripts without Cursor/`npm run dev`.  
3. Single-instance focus works.  
4. Text 429/quota/network/5xx behaviors match §14.  
5. Pending same-process continuity + remint suppression work; restart discards pending; recent IDs persist safely.  
6. Diagnostics meet §15 exclusions.  
7. §17 tests pass; §18 live checklist passes.  
8. No §20 out-of-scope deliverables shipped.  
9. Pilot readiness §19 satisfied.

---

## Design review (safety and scope)

Performed against the completed audit. Outcomes below are **design corrections incorporated into this document** (not code).

### Review checklist

| Risk | Finding | Audit control |
|---|---|---|
| **Unsafe retries** | Auto-retry on 429/5xx/timeout would be unsafe | Forbidden; only one `network.offline` auto-retry with `safeForAutoNetworkRetry` |
| **Duplicate mutation** | Auto-retry after tools/confirm could double-apply | Flag false after any response/tools/timeout-after-send; no parallel turns; confirm uses same token |
| **Stale confirmation reuse** | Restart or drifted `dailyUpdatedAt` | No disk preview persist; existing `STALE_PREVIEW` gates; clear pending on stale/TTL |
| **Sensitive disk persistence** | Plans/tokens on disk | **Forbidden**; only UUID recent file under `data/memory/` |
| **Misleading countdown** | “Retrying in…” implies auto | Copy must say user **may** retry; no countdown for quota |
| **Orphan-process risk** | Vite+Electron via `npm run dev` | Daily path **built renderer only**; script kills child tree; single-instance |
| **Dev vs daily confusion** | Same command for both | Distinct scripts; banner text; README split; no Vite env in daily launcher |
| **Scope creep** | Installer, audio, OAuth, preview disk, aggressive retry | Listed in §20; completion criteria forbid |

### Substantive design choices locked by this review

1. Text `Retry-After` **cap 60s** (display/cooldown), distinct from Realtime connect’s 30s cap.  
2. Auto-retry **only** for pre-response transport failure; timeouts after send are **manual-only**.  
3. Remint suppression while pending valid — required to meet “do not pressure remint.”  
4. **No** disk flag for “had pending”; restart simply has no pending; static capability note instead of alarming every launch.  
5. Daily launcher uses **built UI**; rebuild when dist missing or `-Rebuild`; not full installer.  
6. Dismiss pending: clear UI projection; token may remain until TTL unless explicit cancel-confirmation is added — prefer not deleting tokens on mere banner dismiss to avoid surprising `STALE_PREVIEW`, but never urge remint while valid.

### Unresolved questions (non-blocking; implementer defaults)

1. **Exact Confirm UX:** Is Manual Retry (resubmit text + pending hint) sufficient, or should a separate “Confirm pending” button call the tool deterministically without an LLM turn?  
   - **Default if Sarah does not decide:** Manual Retry + pending hint + remint suppression is sufficient for Phase 17.  
2. **Force rebuild policy:** Always rebuild on launch vs only when `dist` missing / `-Rebuild`?  
   - **Default:** build only if `dist/index.html` missing, unless `-Rebuild`.  
3. **Git sha in build info:** Best-effort; if git unavailable, version only — OK.  
4. **Banner dismiss vs cancel confirmation:**  
   - **Default:** Dismiss hides banner only; TTL/success/invalidate still govern store.

---

## Bottom line

Phase 17 is locked as **Daily-Use Reliability**: manual-first text rate-limit UX, one safe network auto-retry, same-process pending confirmation continuity without preview disk persistence, recent-ID restart continuity, built-renderer Windows launch with single-instance focus, and thin sanitized diagnostics — sufficient for a one-week pilot without Cursor-supervised `npm run dev`.
