# Phase 18 Audit — Pilot Safety Net & Lightweight Observability

**Status:** Design audit / implementation lock.
**Branch baseline:** `main` @ `e35e25b` (*Add Phase 17 daily-use reliability (#1)*)
**Planning baseline:** Phase 18 planning report (agent response; not yet a committed doc)
**Product decisions:** Locked by Sarah (see §3).

This document is the implementation contract for Phase 18. It does not implement code.

---

## 1. Verified baseline

| Check | Result |
|---|---|
| Active branch | `main` |
| HEAD | `e35e25b63c6c6413f0ea3dc863d00e228a606da4` |
| `origin/main` | Identical (`0 0` ahead/behind) |
| Working tree at audit start | Clean |
| Jarvis / OpenAI | Not started; no live requests |
| Live `data/memory` | Not inspected or modified |

### Verified Phase 17 foundation (code)

| Capability | Evidence |
|---|---|
| Built-renderer daily launch | `scripts/start-jarvis.ps1` / `.bat`, `scripts/launch-helpers.cjs` |
| Single-instance | `electron/single-instance.cjs` + `requestSingleInstanceLock` in `main.cjs` |
| Text cooldown + Manual Retry | `realtime-errors.cjs` / `App.tsx` / `textClient.ts` |
| One safe network auto-retry | `safeForAutoNetworkRetry` in `text-session.cjs` |
| Same-process pending + remint suppression | `pendingConfirmation` + `tryReusePendingPreview` in `memory.cjs` |
| Resume only on Manual Retry + exact failed text | `text-run-request.cjs`, `pendingResume.ts` |
| Recent-ID restart continuity | `session-continuity.cjs` → `session-continuity.json` |
| Thin sanitized diagnostics | `TextClient.getDiagnosticReport` extras; public pending strips token |
| Dismiss = visibility only | `dismissPendingConfirmation` sets `pendingBannerDismissed` |

### Verified gaps this phase closes

| Gap | Evidence |
|---|---|
| `MAX_BACKUPS = 10` rolling prune by mtime | `memory.cjs` `pruneBackups`; test keeps last 10 of 12 |
| Restore ID first-match / `includes` heuristics | `loadValidatedBackupPriorities` / Scope / Projects — no ambiguity reject |
| Success `backupId` is `snapshot.createdAt` (ISO with `:`) while filenames use dashed stamps | `createBackupSnapshot` stamp vs `backupId = snapshot.createdAt` — known Phase 15 friction |
| No deterministic Confirm | Banner has Dismiss only; confirm requires LLM `confirmed=true` + `previewToken` |
| No pilot journal | No issue-file writer under `data/` |
| No desktop shortcut helper | Phase 17 out-of-band; scripts are shortcut-ready only |
| No stale-build detection | `inspectLaunchEnvironment.willRebuild` only when dist missing or `-Rebuild` |

---

## 2. Exact Phase 18 objective

Make Jarvis safe enough to begin Sarah’s one-week unsupervised pilot by:

1. Preventing ordinary rolling backup prune from destroying protected baselines, and raising ordinary retention with evidence-based count and byte caps.
2. Making restore identifiers unambiguous and normalized.
3. Providing a **deterministic Confirm** control that applies the current valid pending preview via main-process IPC — never via another LLM turn and never by exposing the preview token to the renderer.
4. Providing a **manually triggered**, sanitized local pilot issue journal.
5. Providing a Windows desktop shortcut helper and clear stale-build indication with explicit rebuild — without an installer or auto-rebuild-every-launch.

Phase 18 is an engineering pass **before** the one-week pilot. Realtime memory freshness remains the default Phase 19.

---

## 3. Locked product decisions

1. Implement Phase 18 before beginning the one-week pilot.
2. Pilot modality is **mixed**, with **text preferred for destructive confirmations**.
3. Add a deterministic Confirm pending control under the safety rules in §7–§8.
4. Backup policy uses **both** higher ordinary retention **and** explicitly protected baselines.
5. Local sanitized pilot issue journal is **manual-trigger only** (no automatic activity logging).
6. Realtime memory freshness remains separate (default Phase 19).
7. Out of scope: packaging, installer, code signing, auto-update, autonomy, integrations, OAuth, transcript persistence, preview-token disk persistence, Phase 8 audio work.

---

## 4. Current backup architecture and pruning behavior

### 4.1 Layout (verified)

| Item | Behavior |
|---|---|
| Root | `options.rootDir \|\| path.join(process.cwd(), "data", "memory")` |
| Directory | `data/memory/backups/` (under gitignored `data/`) |
| Filename | `{isoStamp}-{reason}.json` where stamp = `isoNow().replace(/[:.]/g, "-")` and reason is sanitized (`[^a-z0-9_-]` stripped, max 40) |
| Snapshot body | `schemaVersion`, `reason`, `createdAt` (ISO), `instructions`, `preferences`, `profile`, `daily`, `entries`, plus optional extras |
| Create sites | Before successful mutating writes (`priorities-*`, `working-context-*`, `active-projects-*`, instructions replace, clear-*, carry-future, raw reset) |
| Prune | After every `createBackupSnapshot`: list by **mtime desc**, `unlink` everything after index `MAX_BACKUPS` |
| Cap today | `MAX_BACKUPS = 10` |
| Test | `memory.test.cjs`: 12 snapshots → length 10 |

### 4.2 Restore ID behavior today (verified)

For priorities / WC / active projects loaders:

1. If `backupId` provided: **first** `files.find` where `name.includes(id) \|\| name === id \|\| full.endsWith(id)`.
2. If omitted: newest by mtime (`files[0]`).
3. No multi-match rejection; substring collisions can silently pick the wrong file.
4. Tool success surfaces `backupId: snapshot.createdAt` (colon ISO), which does **not** substring-match dashed filename stamps without further normalization — callers in tests often pass `files[0].name` instead.

### 4.3 Evidence for a higher ordinary retention cap (code/tests/reports only — no live data)

| Evidence | Implication |
|---|---|
| Every successful mutating lifecycle write creates one full-memory snapshot then prunes | Busy sessions burn the cap quickly |
| Phase 15 live validation: `MAX_BACKUPS = 10` pruned the session-start baseline mid-run | Cap of 10 is insufficient for a real pilot day |
| Confirm chains mint previews without backup, but each applied confirm + ordinary edits still write snapshots | Pilot days with briefing + edits + confirms easily exceed 10 |
| Snapshot is full memory JSON (instructions + prefs + profile + daily + entries), not a delta | Size grows with memory content; still local-only |
| Fixture-scale snapshots in tests are small; personal daily JSON is typically far below media sizes | Disk pressure is dominated by **count**, not multi‑MB files, for pilot scale |

**Locked ordinary retention for Phase 18:**

| Constant | Value | Rationale |
|---|---|---|
| `MAX_ORDINARY_BACKUPS` | **40** | 4× current cap; headroom for Phase 15-style thrash plus a busy pilot day of lifecycle writes without pretending infinite history |
| `MAX_ORDINARY_BACKUP_BYTES` | **64 MiB** | Pilot default: current code/test fixtures are JSON-only and expected in the tens-to-hundreds-of-KiB range; 64 MiB leaves substantial headroom while bounding full-snapshot accumulation |
| `MAX_SINGLE_BACKUP_BYTES` | **8 MiB** | Fail closed before a mutation if its required pre-write snapshot exceeds this pilot safety ceiling |
| Protected baselines | **Excluded from ordinary prune** (see §5) | Rolling retention must never delete them |
| `MAX_PROTECTED_BASELINES` | **8** | Enough for week-start + mid-week checkpoints without unbounded growth |
| `MAX_PROTECTED_BASELINE_BYTES` | **64 MiB total** | Separate protected budget; creation is rejected rather than auto-pruning a baseline |

**Size basis and pilot-default status (no live inspection):** Current test fixtures exercise JSON snapshots containing instructions, preferences, profile, daily arrays, and entries; there are no binary/media payloads in the snapshot model. Their structure supports an expected tens-to-hundreds-of-KiB range, but existing tests do not record exact bytes. The **40 / 64 MiB ordinary**, **8 / 64 MiB protected**, and **8 MiB single-file** ceilings are therefore conservative pilot defaults, not permanent product limits. During implementation, a representative and an oversized fixture must report/assert serialized bytes. If the representative fixture exceeds 2 MiB, pause and revise these ceilings in the audit before shipping.

**Ordinary prune contract:** after a successful snapshot write, list ordinary backup files only, compute each file’s byte size, sort oldest-first for removal, and prune until **both** `count <= 40` and `totalBytes <= 64 MiB`. Protected baselines are excluded. If the required pre-mutation snapshot itself exceeds 8 MiB or cannot be statted/written, fail closed and do not perform the mutation. Prune failures remain best-effort only for older files; the new required backup must already be durable.

**Protected budget contract:** before baseline creation, calculate registered plus recovered valid baseline count/bytes. Reject with `BASELINE_BUDGET_FULL` if adding the candidate would exceed either 8 files or 64 MiB. Never auto-delete a protected baseline.

Rename in code: replace bare `MAX_BACKUPS` with `MAX_ORDINARY_BACKUPS` (keep export alias `MAX_BACKUPS = MAX_ORDINARY_BACKUPS` only if needed for test compatibility during transition).

---

## 5. Protected-baseline data model and lifecycle

### 5.1 Storage

All under existing gitignored runtime path:

```text
data/memory/backups/                         # ordinary rolling snapshots (unchanged location)
data/memory/backups/baselines/               # protected baseline snapshot files
data/memory/backup-baselines.json            # registry (schema below)
```

Ordinary `listBackupFiles()` / prune **must not** recurse into `baselines/` or delete anything there. Directory placement is authoritative for prune protection; the registry is authoritative only for registered identity/display metadata. Recovered unregistered files remain protected by directory placement until explicitly re-registered or deleted.

### 5.2 Registry schema (`backup-baselines.json`)

```json
{
  "schemaVersion": 1,
  "updatedAt": "ISO-8601",
  "baselines": [
    {
      "id": "bl_…",
      "name": "sanitized-display-name",
      "fileName": "2026-07-29T18-00-00-000Z-baseline-week-start.json",
      "createdAt": "ISO-8601",
      "createdBy": "user" | "system",
      "note": "optional short sanitized note"
    }
  ]
}
```

Rules:

- `id`: opaque stable id (`bl_` + random), never a preview token.
- `name`: user-facing label; sanitize with `sanitizeDiagnosticText` (max 80); reject empty.
- `fileName`: basename only under `backups/baselines/`.
- Missing registry: scan `backups/baselines/` and expose valid files as `recovered` entries; write a new empty registry only when the user explicitly re-registers one or creates a new baseline.
- Corrupt/invalid registry: atomically rename it, where supported, to `backup-baselines.corrupt-{timestamp}.json` **before** writing a replacement. If preservation rename fails, do not overwrite the corrupt registry; return `BASELINE_REGISTRY_RECOVERY_FAILED` and leave baseline files untouched.
- Registry recovery scans only direct child files of `backups/baselines/`. Read at most a bounded header prefix (pilot default **64 KiB**) with a safe metadata extractor/streaming parser for `schemaVersion`, `reason`, `createdAt`, and optional baseline id/name metadata; do not deserialize or return snapshot bodies during scanning. A file whose safe header cannot be established within the bound is `invalid` until explicitly inspected in a future recovery flow. Valid unregistered files appear as `recovered: true, registered: false` and require explicit **Re-register** or **Delete**.
- Invalid/unparseable files appear as metadata-only `invalid: true` entries (basename + sanitized reason); they are never auto-deleted or restorable.
- Duplicate IDs or case-insensitive names: mark every conflicting entry `conflict: true`; none is restorable/deletable by ambiguous id/name until the user resolves/re-registers it by exact file selection.
- Registry entry whose file is missing appears `missing: true`; explicit cleanup removes only the registry entry.
- Every registry `fileName` must equal `path.basename(fileName)`, contain no separators or `..`, resolve under the canonical baseline directory, and refer to a direct child. Absolute paths, traversal, symlinks/reparse points escaping the baseline directory, and outside-directory targets are rejected as `BASELINE_PATH_INVALID`; they are never read, renamed, or deleted.
- Atomic write via existing `atomicWriteJson`.

### 5.3 Lifecycle

| Action | How | Behavior |
|---|---|---|
| **Create** | IPC `backups:create-baseline` (UI “Save baseline”) and optional thin memory helper used only by that IPC | Copy current memory set into a new baseline snapshot file (same payload shape as `createBackupSnapshot`); register entry; reject if count, total-byte, or single-file budget would be exceeded; never auto-delete |
| **Name** | Required on create; optional rename IPC later out of scope unless trivial | Unique `name` case-insensitive among baselines; conflict → `BASELINE_NAME_EXISTS` |
| **List** | IPC `backups:list` | Returns ordinary recent summaries plus registered, recovered, invalid, conflicting, and missing baseline metadata — **no** snapshot bodies or secret values |
| **Re-register** | IPC `backups:reregister-baseline` with an exact recovered basename plus new unique name | Validates direct-child path and safe header; assigns a new registry id; does not rewrite snapshot content |
| **Restore** | Existing scoped `restore_backup` operations only, using §6 shared resolver | Priorities, WC, and active-project restore semantics remain scoped and retain existing preview/confirmation safety |
| **Delete** | IPC `backups:delete-baseline` with exact registered id, or exact recovered basename after explicit confirmation | Requires explicit user action; never ordinary prune; ambiguous/conflicting id/name is rejected |

### 5.4 Broad emergency restore is deferred

Phase 18 does **not** add `backups:restore` or a full-daily-working-set restore UI. Protected baselines are created, listed, re-registered, explicitly deleted, and made addressable to the **existing scoped** restore operations through the shared resolver.

A future recovery phase may add broad UI restore only after atomicity across scopes, rollback, scope selection, preview semantics, and partial-failure behavior are designed. This deferral prevents Phase 18 from introducing a second restore subsystem beside the already tested scoped lifecycle paths.

### 5.5 Tool surface

Phase 18 **does not** require new public model tools for baselines. Model may continue to use `restore_backup` with normalized ordinary or baseline identifiers once list metadata is available via existing patterns / briefing is unchanged. Baseline **create/delete** are UI/IPC-only for pilot control.

---

## 6. Restore identifier normalization rules

Shared pure helper (e.g. `electron/backup-ids.cjs`) used by all three existing scoped lifecycle restore loaders.

### 6.1 Candidate identity forms (all supported)

Given a backup file `{ name, full, mtimeMs }` and optional parsed `createdAt` from snapshot header when already loaded:

| Form | Example |
|---|---|
| Full basename | `2026-07-29T12-00-00-000Z-priorities-remove.json` |
| Basename without `.json` | `2026-07-29T12-00-00-000Z-priorities-remove` |
| Stamp prefix (through first reason segment) | `2026-07-29T12-00-00-000Z` |
| Snapshot `createdAt` ISO | `2026-07-29T12:00:00.000Z` |
| ISO↔stamp equivalent | Colon/dot ISO maps to dashed stamp for equality |
| Baseline `id` | `bl_…` (registry only) |
| Baseline `name` | Exact case-insensitive match when unique |

### 6.2 Match algorithm

1. Expand search set = ordinary direct-child files in `backups/` ∪ registered/recovered valid direct-child baseline files. Reject invalid, conflicting, missing, traversal, or outside-directory entries.
2. Normalize query: trim; reject empty → `RESTORE_FAILED`.
3. Collect **all** files/baselines that **exactly** match any supported form after normalization (equality on stamp/ISO equivalence, exact basename, exact baseline id, exact unique name).
4. **Do not** use bare `includes` / fuzzy substring as a primary matcher.
5. If match count === 0 → `RESTORE_FAILED` (“No backup was found…”).
6. If match count > 1 → **`AMBIGUOUS_BACKUP_ID`** (new code) with candidate basenames/ids only (no bodies).
7. If match count === 1 → that file.

Optional: if query is omitted for tool `restore_backup`, keep today’s behavior (newest **ordinary** backup by mtime) — baselines are never implicit “latest.” Document that omission never selects a protected baseline.

### 6.3 Ambiguity examples that must reject

- Query `2026-07-29` matching multiple same-day stamps.
- Query substring that formerly matched via `includes` across reasons.
- Two baselines with names that collide after sanitization (prevented at create).

---

## 7. Deterministic Confirm architecture and IPC contract

### 7.1 Goal

Sarah presses **Confirm** on the pending banner → main applies **exactly** the currently valid pending preview → success/failure returns without an LLM turn and without the renderer ever seeing `previewToken`.

### 7.2 IPC

| Channel | Direction | Payload |
|---|---|---|
| `continuity:confirm-pending` | renderer → main | `{ clientConfirmId?: string }` only — **no** token, tool, operation, or plan fields accepted from renderer |
| Response | main → renderer | Closed public shape only: `{ ok, code?, message, toolName?, operation?, scope?, dailyUpdatedAt?, artifactDelivery? }`; `artifactDelivery` is an existing sanitized/selected panel-delivery projection, never a raw artifact or tool result |

Preload: `confirmPendingConfirmation: () => ipcRenderer.invoke("continuity:confirm-pending", …)`.

### 7.3 Queue boundary and internal operation dispatch

**Exactly one memory-queue entry is permitted.** `memoryStore.confirmPendingConfirmation()` first atomically checks/acquires deterministic-confirm ownership against the shared execution/mutation owner; only then does it call `enqueue(confirmPendingInternal)` once. If another owner is active, it returns §7.4’s busy result without entering the queue. The queued task must never call `memoryPriorities`, `workingContextItems`, or `memoryActiveProjects`, because those public wrappers enqueue and would self-deadlock.

Required refactor:

- Split each lifecycle public wrapper into:
  - public enqueuing wrapper (existing external behavior);
  - non-enqueuing internal operation function that assumes the caller already owns the memory write queue and shared mutation lock.
- Ordinary public calls: wrapper → `enqueue(() => internalOperation(args))`.
- Deterministic Confirm: wrapper → **one** `enqueue(confirmPendingInternal)` → validate pending → dispatch directly to the matching internal operation.
- Internal functions must not call `enqueue` directly or indirectly.

Queued `confirmPendingInternal` algorithm:

1. Re-check that this request still owns the deterministic-confirm/shared mutation lease inside the queued task. Any mismatch returns the busy result without touching pending state.
2. `pending = getPendingConfirmationInternal()`; if null → `{ ok:false, code:"STALE_PREVIEW", message:"Nothing to confirm." }`.
3. `entry = previewStore.get(pending.previewToken)`; validate TTL, operation match, `dailyUpdatedAt` vs current daily after the same ensure/rollover boundary used by lifecycle internals. Fail → `STALE_PREVIEW` and clear pending as existing `readPreview` does.
4. Verify exact `pending.toolName`, operation, scope, binding key, internal token, and stored request binding against the preview entry. Drift → `STALE_PREVIEW`.
5. Build confirm args **only from internal state**:
   - `operation`, `confirmed: true`, `previewToken: pending.previewToken`
   - `scope` if working-context
   - Rehydrate binding fields from `entry.meta.request` (and carry meta) so `confirmationConflictsWithPreview` is satisfied without renderer input
6. Dispatch directly to `memoryPrioritiesInternal`, `workingContextItemsInternal`, or `memoryActiveProjectsInternal`; **never** a public wrapper.
7. On success, preserve existing backup/write/reread/invalidation semantics.
8. Project the internal result through §7.5’s public-result builder.
9. Release confirm/shared ownership in `finally`. Never auto-call from Send, Retry, cooldown expiry, or remint.

### 7.4 Concurrency, ownership, duplicate-click, and UI rules

- Text cooldown **alone does not block Confirm**; Confirm makes no OpenAI request.
- Confirm is blocked while any text turn, memory mutation, deterministic confirm, or conflicting voice/tool execution actively owns the shared execution/mutation lock. The pre-enqueue ownership acquisition is authoritative, so Confirm does not merely wait behind an already-active mutation and then apply stale intent.
- Main maintains a confirm-in-flight guard in addition to queue serialization. The first request receives a unique internal operation id; duplicate clicks while it is active are rejected idempotently (no second queue entry) with:
  `{ ok:false, code:"session.busy", message:"A confirmation is already in progress.", retryable:false }`.
- A different shared-lock conflict returns:
  `{ ok:false, code:"session.busy", message:"Jarvis is busy. Wait for the current action to finish.", retryable:false }`.
- The renderer disables **Confirm** immediately on click and while `confirmPendingActive`, `textTurnActive`, memory mutation/tool busy, or conflicting voice execution is active. Cooldown state is not part of this disabled predicate.
- Main is authoritative: forged/repeated IPC still hits the in-flight and shared-lock checks.

- Pending banner: **Confirm** | **Dismiss**.
- Confirm does **not** clear or require composer text.
- Manual Retry remains separate (may still resume pending via LLM path with exact failed text).
- Fresh Send never sets `resumePendingConfirmation` (Phase 17 unchanged) and never triggers Confirm.
- On Confirm success: refresh continuity/pending UI; route `artifactDelivery` through the existing artifact selection, sanitization, and panel-delivery guards; set a short status like “Confirmed: {operation}.”
- On `STALE_PREVIEW`: clear/hide pending as store dictates; message to ask Jarvis again to preview.

### 7.5 Public result and artifact constraints

`buildPublicConfirmResult(internalResult)` uses an allowlist only:

- `ok`, sanitized `code`, sanitized short `message`;
- `toolName`, `operation`, `scope`, `dailyUpdatedAt`;
- optional `artifactDelivery` produced by existing `selectTurnArtifacts` / delivery metadata and sanitization guards.

It must never return arbitrary raw artifacts, full tool results, preview tokens, request/binding objects, before/after arrays, backup bodies, memory item bodies, or secret values. If existing artifact selection cannot safely project the result, omit `artifactDelivery`; confirmation success is still reported through safe fields.

### 7.6 Relationship to Manual Retry

| Path | Uses LLM? | Attaches token how? |
|---|---|---|
| Confirm | No | Main internal only |
| Manual Retry | Yes | `resumePendingConfirmation` + exact failed composer; main injects token in `prepareTextRunPayload` |
| Fresh Send | Yes | Never attaches pending |

---

## 8. Pending-state safety and stale-state matrix

| Condition | Confirm result | Pending after | Notes |
|---|---|---|---|
| Valid pending + valid preview + matching `dailyUpdatedAt` / binding | Apply plan | Cleared on success | Happy path |
| TTL expired (`PREVIEW_TTL_MS` = 10m) | `STALE_PREVIEW` | Cleared | Same as `readPreview` |
| Restart / process death | No pending | Absent | No disk preview persist (Phase 17) |
| Superseding preview minted | Banner shows new pending | Old token not confirmable | New binding |
| Unrelated successful mutation invalidated previews | `STALE_PREVIEW` | Cleared | Existing `invalidatePreviews` |
| Binding drift (`bindingKey` / request mismatch) | `STALE_PREVIEW` | Cleared or left invalid | Fail closed |
| `dailyUpdatedAt` mismatch | `STALE_PREVIEW` | Cleared | |
| Dismiss pressed | N/A | Internal pending **retained** | Visibility only |
| Confirm while dismissed but internal valid | **Allowed** if UI still offers Confirm after re-show; if banner dismissed, Confirm control is hidden unless continuity refresh re-shows — **Default:** dismissed banner hides Confirm; user can undismiss by new preview only. Do not confirm from a hidden control. |
| Renderer forges IPC with token fields | Ignored | Unchanged | Strip unknown fields |
| Text cooldown only | Allowed | Normal result | No OpenAI request |
| Concurrent text turn / memory mutation / voice tool | `session.busy` | Unchanged | No queue-side mutation |
| Duplicate Confirm click | `session.busy` for duplicate | First request owns operation | At most one queue entry/apply |
| Automatic / timer confirm | Forbidden | — | |
| Fresh Send | Forbidden | Unchanged | |

---

## 9. Pilot journal schema, storage, sanitization, corruption handling, and retention

### 9.1 Storage

| Item | Value |
|---|---|
| Path | `data/memory/pilot-issues.jsonl` (gitignored via `data/`) |
| Format | Append-only JSON Lines |
| Trigger | Manual UI only: **Record issue** (optional short note prompt) |
| Not written on | Connect, Send, tool success, errors alone, Confirm, dismiss, launch |

### 9.2 Record schema

```json
{
  "schemaVersion": 1,
  "id": "iss_…",
  "recordedAt": "ISO-8601",
  "build": { "version": "1.0.0", "branch": "main|null", "gitSha": "abc|null" },
  "errorCode": "rate_limited|null",
  "httpStatus": 429,
  "cooldownUntilMs": 123,
  "connectionState": "connected|null",
  "pending": {
    "toolName": "memory_priorities|null",
    "operation": "remove|null",
    "scope": null,
    "expiresAt": 123
  },
  "note": "sanitized user note ≤240 chars",
  "staleBuild": false
}
```

`httpStatus` only when already present on the classified error object; otherwise omit/null.

### 9.3 Exclusions (hard)

Never write: API keys, credentials, preview tokens, plans, before/after arrays, secret memory values, full composer text, transcripts, OpenAI request/response bodies, `.env` contents, raw diagnostic event dumps beyond the fields above.

### 9.4 Sanitization

- Every free-form string (`note`, connection state labels, errorCode string) through `sanitizeDiagnosticText`.
- Pending block mirrors public pending projection fields only.
- Reuse diagnostic redaction patterns from Phase 9/17.

### 9.5 IPC

`pilot:record-issue` with `{ note?: string }` plus main gathers build info + last known sanitized error/cooldown/pending/connection from a small main-side snapshot the renderer may pass as **already-sanitized structured fields** (whitelist). Main re-sanitizes and drops unknown keys.

Response: `{ ok:true, id }` or `{ ok:false, code, message }`.

### 9.6 Corruption and retention

| Case | Behavior |
|---|---|
| Missing file | Create on first record |
| Truncated last line | Skip bad line on read; append continues |
| Non-JSON line | Skip; do not delete file |
| File exceeds **512 KB** or **200** lines | Rollover: rename to `pilot-issues-YYYYMMDDTHHmmss.jsonl` archive beside it; start fresh file; keep at most **5** rolled archives (delete oldest archive files) |
| Read for UI | Optional “last N issues” list showing timestamp + errorCode + note only |

All append, pre-append size/line check, rollover, archive prune, and append-after-rollover operations run through one module-local journal write queue. Repeated manual clicks are serialized; each accepted click produces at most one record id/line.

Rollover uses atomic rename in the same directory where supported. If rename fails, leave the active file untouched, do not truncate it, return `{ ok:false, code:"PILOT_JOURNAL_WRITE_FAILED" }`, and skip append. If archive pruning fails, keep extra archives and continue only if the active-file rollover and append are safe. If append fails after successful rollover, retain the rolled archive and return failure; a later click may create/append a fresh active file. Journal failures never block or roll back Jarvis memory, pending state, or normal text/voice operation.

No cloud upload. No background logger.

---

## 10. Shortcut-helper and stale-build architecture

### 10.1 Shortcut helper

| Item | Spec |
|---|---|
| Script | `scripts/create-desktop-shortcut.ps1` |
| Target | Absolute path to `scripts\start-jarvis.bat` (quoted / `LiteralPath` safe) |
| Working directory | Absolute repository root (handles `Sarah Segel` spaces) |
| Link location | Current user Desktop (`[Environment]::GetFolderPath('Desktop')`) |
| Name | `Jarvis.lnk` |
| Installer | **Not** required |
| Failure | Readable error if Desktop unavailable / COM WScript.Shell fails |

Replacement contract:

1. If `Jarvis.lnk` does not exist, create it.
2. If it exists and its canonical target equals this repository’s `scripts\start-jarvis.bat`, update target, working directory, and description in place.
3. If it exists but targets anything else, stop with a readable collision error and require explicit `-Replace`.
4. `-Replace` may overwrite only after reporting the existing target; never silently overwrite an unrelated shortcut.
5. Canonical comparisons and COM arguments must preserve repository paths containing spaces.

An optional `-Rebuild` shortcut variant is out of scope; default shortcut launches the ordinary daily bat.

### 10.2 Stale-build detection

Pure helper in `launch-helpers.cjs` (testable):

`evaluateRendererBuildFreshness(repoRoot, options)`:

1. If `dist/index.html` missing → `{ stale: true, reason: "dist_missing", willRebuildOnLaunch: true }` (existing behavior).
2. Compare `mtimeMs` of `dist/index.html` to the **newest** mtime among watched roots: `src/`, `electron/` (non-test optional), `package.json`, `vite.config.ts`, `index.html` (project root if present).
3. If any watched source mtime > dist mtime → `{ stale: true, reason: "sources_newer_than_dist" }`.
4. Else `{ stale: false }`.

**Launch behavior:**

- Do **not** auto-rebuild on every stale detection (avoids surprise long launches / API-unrelated delay).
- Print clear message:
  `Built UI may be stale (source files newer than dist). Run: .\scripts\start-jarvis.ps1 -Rebuild`
- `-Rebuild` / missing dist still rebuild as today.

**In-app:**

- Extend `getBuildInfo()` / continuity with `staleBuild: boolean` (best-effort; computed in main).
- Status strip shows `build stale` when true.

**Locked deferral:** Phase 18 does not add in-process npm build IPC or automatic reload. Process ownership/file-lock complexity, partial-build risk, and duplicate npm-resolution logic make that path less safe than the already validated launcher. Explicit rebuild remains `.\scripts\start-jarvis.ps1 -Rebuild`.

---

## 11. Exact user-visible behavior

| Scenario | Behavior |
|---|---|
| Destructive preview succeeds | Pending banner: operation, redacted summary, expiry; **Confirm** and **Dismiss** |
| Press Confirm (valid) | No LLM call; mutation applies; banner clears; status/artifact update |
| Press Confirm (stale) | Error message; pending cleared/hidden; ask to preview again |
| Press Dismiss | Banner hides; no mutation; Manual Retry may still resume if eligibility remains |
| Manual Retry after failure | Unchanged Phase 17 path |
| Fresh Send with pending | Unchanged — does not confirm, does not attach token |
| Save baseline | Prompt for name → success or cap/name error |
| List backups (UI) | Ordinary recent + baselines; no bodies |
| Restore baseline/ordinary | Use existing scoped restore operation with normalized metadata identifier and existing preview/confirmation safety |
| Record issue | Prompt for optional note → “Issue recorded” / failure |
| Stale build | Status + launcher warning; rebuild only via explicit launcher `-Rebuild` |
| Create desktop shortcut | Script creates/updates matching `Jarvis.lnk`; unrelated collision requires `-Replace` |
| Restart mid-pending | Pending gone; Confirm unavailable; recent IDs persist |

---

## 12. Security and privacy guarantees

1. Preview tokens never in renderer state, diagnostics, journal, backup list UI, or shortcut metadata.
2. Confirm IPC accepts no token from renderer; main loads internal pending only on explicit Confirm.
3. Journal and diagnostics use `sanitizeDiagnosticText` / Phase 17 exclusion set.
4. Backups/baselines/journal remain under gitignored `data/`; no cloud telemetry.
5. Backup-list IPC never returns secret memory values or full instructions/snapshot bodies (metadata only); no broad restore IPC exists.
6. Dismiss never mutates durable memory.
7. No automatic confirmation or automatic journal writes.
8. Protected baselines cannot be removed by ordinary prune.

---

## 13. Exact files expected to change

### Likely modify

| File | Role |
|---|---|
| `electron/memory.cjs` | Retention, prune exclusions, baseline helpers, confirmPending, restore ID usage |
| `electron/main.cjs` | IPC: confirm-pending, baselines, journal; staleBuild in getBuildInfo |
| `electron/preload.cjs` | Expose new IPC |
| `src/App.tsx` | Confirm button; baseline/issue/stale UI affordances (minimal) |
| `src/styles.css` | Banner/actions styling |
| `src/vite-env.d.ts` | Types |
| `src/lib/textClient.ts` | Optional: strip tokens if confirm results flow through shared helpers |
| `scripts/launch-helpers.cjs` | Stale-build evaluation |
| `scripts/start-jarvis.ps1` | Print stale-build warning |
| `README.md` | Shortcut helper + baseline/journal/confirm notes (brief) |
| Existing lifecycle tests | Restore ID / retention expectations |

### Likely add

| File | Role |
|---|---|
| `electron/backup-ids.cjs` | Normalize/match/ambiguity |
| `electron/backup-baselines.cjs` | Registry + create/list/delete |
| `electron/pilot-journal.cjs` | Append/sanitize/rollover |
| `electron/phase-18-pilot-safety-net.test.cjs` | §14 matrix |
| `scripts/create-desktop-shortcut.ps1` | Desktop `.lnk` helper |
| `docs/phase-18-pilot-safety-net-audit.md` | This audit |

### Explicitly unchanged by design

Realtime audio path, `session.update` freshness, packaging toolchain, OAuth, transcript persistence, preview disk persistence, lifecycle write semantics beyond confirm/restore-id/backup policy.

---

## 14. Complete automated-test matrix

### 14.1 Backups / baselines

| ID | Assertion |
|---|---|
| B01 | Ordinary create still works; prune keeps ≤40 ordinary files |
| B02 | Creating 45 ordinary snapshots leaves 40; baselines untouched |
| B03 | Baseline create registers file under `baselines/` and registry |
| B04 | Ordinary prune never deletes baseline files |
| B05 | Baseline create rejected at `MAX_PROTECTED_BASELINES` without deleting others |
| B06 | Duplicate baseline name → `BASELINE_NAME_EXISTS` |
| B07 | Explicit baseline delete removes file + registry entry |
| B08 | Corrupt registry is preserved and valid baseline files are exposed as recovered without deletion |
| B09 | Ordinary prune satisfies both count ≤40 and bytes ≤64 MiB |
| B10 | Oversized required snapshot (>8 MiB) fails closed before mutation |
| B11 | Protected create rejected at count or 64 MiB byte budget |
| B12 | Missing/corrupt registry scan exposes valid files as recovered, never deletes files |
| B13 | Corrupt registry preserved by timestamped rename before replacement |
| B14 | Invalid files, duplicate ids/names, and missing registry targets are marked and not implicitly restorable |
| B15 | Absolute/traversal/outside-directory/symlink escape entries rejected |
| B16 | Recovery scanner reads only bounded safe header metadata and never returns/deserializes snapshot bodies |

### 14.2 Restore IDs

| ID | Assertion |
|---|---|
| R01 | Match full filename |
| R02 | Match dashed stamp ↔ ISO `createdAt` equivalence |
| R03 | Match baseline `id` and unique `name` |
| R04 | Ambiguous query → `AMBIGUOUS_BACKUP_ID` (no write) |
| R05 | Unknown id → `RESTORE_FAILED` |
| R06 | Omitted tool `backupId` selects newest ordinary only (not baseline) |
| R07 | Priorities/WC/projects loaders all use shared helper |

### 14.3 Deterministic Confirm

| ID | Assertion |
|---|---|
| C01 | Valid pending Confirm applies mutation without LLM mocks |
| C02 | Renderer payload token fields ignored; internal token used |
| C03 | Public IPC response has no `previewToken` / before/after arrays |
| C04 | TTL expiry → `STALE_PREVIEW` |
| C05 | Restart simulation (clear process maps) → Confirm fails stale |
| C06 | After unrelated invalidate → stale |
| C07 | Binding/`dailyUpdatedAt` drift → stale |
| C08 | Dismiss does not clear internal pending; hidden Confirm not exposed |
| C09 | Confirm rejected while text turn active |
| C10 | Fresh Send path still does not attach pending (Phase 17 regression) |
| C11 | Manual Retry resume still works (Phase 17 regression) |
| C12 | Works for priorities, one WC scope op, and active-projects remove |
| C13 | Confirm enters memory queue exactly once and dispatches only non-enqueuing internals (no nested enqueue/deadlock) |
| C14 | Confirm completes under timeout guard; public wrappers still enqueue once |
| C15 | Duplicate Confirm clicks produce one apply/backup and deterministic `session.busy` duplicate response |
| C16 | Shared busy lock blocks text turn, memory mutation, and conflicting voice/tool cases; cooldown alone does not block |
| C17 | Public result allowlist excludes raw artifacts/tool bodies/bindings/backups/secrets |
| C18 | Optional artifact uses existing selected/sanitized panel-delivery projection |

### 14.4 Journal

| ID | Assertion |
|---|---|
| J01 | Manual record appends one sanitized line |
| J02 | Note with API key pattern redacted |
| J03 | Record omits token/plan/composer/transcript fields even if attacker passes them in IPC |
| J04 | Corrupt mid-file line skipped; append still works |
| J05 | Oversize triggers rollover; ≤5 archives |
| J06 | Concurrent manual clicks serialize and append one valid line per accepted click |
| J07 | Rollover rename failure leaves active file intact and does not affect memory operation |
| J08 | Append failure after rollover preserves archive and returns journal-only failure |

### 14.5 Shortcut / stale build

| ID | Assertion |
|---|---|
| S01 | Stale when source mtime > dist mtime |
| S02 | Not stale when dist newer |
| S03 | Dist missing → stale + willRebuild |
| S04 | Launcher plan/message includes stale warning string when stale |
| S05 | Shortcut script targets absolute `.bat` and spaced repo root (dry assertions / helper pure functions) |
| S06 | Existing matching shortcut updates in place |
| S07 | Unrelated `Jarvis.lnk` refuses overwrite without `-Replace`; explicit replacement succeeds |
| S08 | No in-process build IPC / automatic reload added |

### 14.6 Regressions

Phase 13–17 suites green; `git diff --check` clean; `npm run build` OK after implementation.

---

## 15. Minimal API-thrifty live-validation plan

**Prep:** Stop Jarvis. Prefer text. Do not provoke 429s.

| Step | API budget | Check |
|---|---|---|
| L1 | 0 | Shortcut or `.bat` launch; note stale-build messaging if applicable |
| L2 | 1 | Simple text ping |
| L3 | 1–2 | Disposable destructive preview → **Confirm** applies without second LLM confirm turn; banner clears |
| L4 | 0 | Save baseline; list shows it; create enough ordinary backups in **automated** harness for prune (not live thrash) |
| L5 | 0–1 | Optional existing scoped restore using a protected baseline identifier; verify normal preview/Confirm path (skip if L3 already used the API budget) |
| L6 | 0 | Record issue with note containing fake `sk-…` → journal redacts; file under `data/memory/` |
| L7 | 0 | Quit/relaunch: pending absent; recent continuity still works |
| L8 | skip | Realtime — skip by default |

**Stop:** Unexpected real 429 → halt further live API; rely on automation.

---

## 16. One-week pilot readiness criteria

1. Phase 18 automated matrix green; live checklist L1–L7 passed as applicable.
2. Ordinary retention satisfies 40-count and 64-MiB ceilings; baselines are immune to rolling prune and obey their separate 8-count/64-MiB budget.
3. Restore IDs normalized; ambiguous ids rejected.
4. Deterministic Confirm works for pending destructive previews without LLM and without token leakage.
5. Manual Retry / dismiss / fresh Send behavior preserved.
6. Manual pilot journal works with sanitization + rollover.
7. Desktop shortcut helper works on spaced paths.
8. Stale-build is visible; rebuild is explicit.
9. No out-of-scope items from §17 shipped.
10. Sarah can begin the one-week pilot without Cursor-supervised `npm run dev`.

---

## 17. Explicit out-of-scope items

- Packaging, installer, code signing, auto-update, `userData` migration
- Realtime `session.update` / memory freshness (Phase 19 default)
- Phase 8 residual audio / echo / mic work
- Autonomy / multi-step workflow engine
- OAuth / email / calendar / browser integrations
- Transcript or composer disk persistence
- Preview-token / plan disk persistence
- Automatic journal/telemetry / cloud logging
- Auto-rebuild on every launch when stale
- In-process npm build IPC / automatic renderer reload
- Broad emergency/full-working-set backup restore IPC or UI
- Archive mutate/restore-from-archive product
- Project status expansion / WC→project promote
- FU/unresolved sensitivity unification (unless hitchhiked by accident — **do not**)
- Changing Phase 17 cooldown / auto-network-retry policy

---

## 18. Implementation sequence

1. Audit lock accepted (this document).
2. `backup-ids.cjs` + wire into three restore loaders + tests R01–R07.
3. Count+byte ordinary retention + baseline module/registry recovery/path safety + tests B01–B16.
4. Extract non-enqueuing lifecycle internals; add single-boundary `confirmPendingConfirmation` + busy ownership + safe public projection + tests C01–C18.
5. Queued `pilot-journal.cjs` + Record issue UI + tests J01–J08.
6. Stale-build helper + launcher warning + status only + tests S01–S04/S08.
7. `create-desktop-shortcut.ps1` + collision/spaced-path assertions S05–S07.
8. README brief updates.
9. Full regression + `npm run build` + `git diff --check`.
10. Live validation §15.
11. Implementation report when requested; commit/PR only when requested.
12. Begin one-week pilot.

---

## 19. Completion criteria

Phase 18 is complete when:

1. All locked decisions in §3 and architectures in §§4–10 are implemented as specified.
2. Confirm has exactly one queue boundary, calls only non-enqueuing internals, rejects duplicate/conflicting ownership, and returns only the closed public result.
3. Ordinary and protected stores satisfy both count and byte ceilings; corrupt-registry recovery, bounded scanning, and traversal protections pass.
4. Journal writes/rollovers are serialized and failures remain isolated from Jarvis memory and operation.
5. Shortcut collision/replacement and spaced-path behavior pass; stale-build warning/status exists; rebuild remains launcher-only.
6. §14 automated matrix passes.
7. §15 live checklist passes (API-thrifty).
8. §12 security/privacy guarantees hold under test.
9. §16 pilot readiness criteria satisfied.
10. No §17 out-of-scope deliverables shipped.
11. Implementation report exists when Sarah requests it.

---

## 20. Design-review findings and unresolved questions

### 20.1 Design-review findings (incorporated)

| Risk | Control |
|---|---|
| Confirm becomes a second LLM turn | Dedicated IPC; no `text:run` |
| Confirm self-deadlocks in nested queue | Exactly one public queue boundary; dispatch only non-enqueuing lifecycle internals |
| Duplicate Confirm applies twice | Main in-flight guard + shared ownership + duplicate busy response |
| Token leaks to renderer | Internal pending only; strip responses; journal whitelist |
| Raw tool/artifact result leaks | Closed public result; existing selected/sanitized artifact-delivery projection only |
| Dismiss accidentally confirms | Dismiss visibility-only; Confirm separate |
| Fresh Send confirms | Forbidden; Phase 17 resume flag unchanged |
| Prune deletes baselines | Separate dir + registry; prune skips |
| Count-only prune grows disk | Independent ordinary/protected byte budgets; oversized fixture coverage |
| Corrupt registry strands or deletes files | Preserve corrupt registry; safe direct-child scan; explicit re-register/delete |
| Fuzzy restore guesses wrong file | Exact normalized match; `AMBIGUOUS_BACKUP_ID` |
| Auto/in-process rebuild risks partial build | Warn/status only; explicit validated launcher `-Rebuild` |
| Journal becomes surveillance log | Manual trigger only; size rollover |
| Concurrent journal rollover corrupts records | One journal queue; atomic rename; failures isolated from Jarvis |
| Emergency IPC restore too broad | Deferred; existing scoped restores only |
| Shortcut overwrites unrelated link | Matching target updates; collision needs explicit `-Replace` |
| Arbitrary retention without evidence | Cap 40 grounded in Phase 15 prune failure + write-frequency; size soft-check via fixture |

### 20.2 Unresolved questions (non-blocking; implementer defaults)

1. **Baseline create naming UX:** modal prompt vs inline field?
   - **Default:** Simple modal/prompt with sanitized name.

2. **Expose ordinary backup list in UI beyond baselines?**
   - **Default:** Yes, last ~10 ordinary metadata rows plus all baselines (still no bodies).

3. **Tool-visible baseline ids in model instructions?**
   - **Default:** Minimal — do not expand JARVIS_INSTRUCTIONS heavily; restore normalization alone is enough for tool path.

4. **Post-pilot byte ceilings:** retain 64 MiB ordinary/protected or revise from observed pilot sizes?
   - **Default:** Keep pilot defaults during Phase 18; review only after pilot metrics are available.

---

## Bottom line

Phase 18 is locked as **Pilot Safety Net & Lightweight Observability**: evidence-based ordinary backup retention (40) plus protected baselines, unambiguous restore IDs, deterministic token-safe Confirm IPC, manual sanitized pilot journal, and shortcut/stale-build hygiene — sufficient to start the one-week pilot without packaging, Realtime freshness, or Phase 8 audio scope.

No production implementation in this audit step.
