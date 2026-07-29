# Phase 18 Implementation Report — Pilot Safety Net & Lightweight Observability

**Status:** Implementation complete; pre-commit correction pass applied; automated validation green. Live validation deferred (not performed).
**Branch:** `phase-18-pilot-safety-net`
**Baseline:** `e35e25b63c6c6413f0ea3dc863d00e228a606da4`
**Audit contract:** `docs/phase-18-pilot-safety-net-audit.md`

---

## Branch and baseline

| Item | Value |
|---|---|
| Branch | `phase-18-pilot-safety-net` |
| Baseline commit | `e35e25b` (clean synchronized `main`) |
| Jarvis during implementation | Not started |
| Live OpenAI requests | None |
| Live `data/` | Not inspected or modified |
| Commit / push / PR | Not performed |

---

## Pre-commit correction pass (defects → fixes)

### 1. Explicit baseline selection in UI
- **Defect:** Delete/re-register used first eligible baseline.
- **Root cause:** Global buttons called `.find()` over the list.
- **Correction:** Per-row Delete / Re-register controls; pure helpers in `src/lib/pilotBaselines.ts` refuse null/empty selection and require exact `id`/`fileName`; delete confirm shows name + filename; status flags for conflict/invalid/missing/recovered.
- **Tests:** UI helper behavioral test + App source asserts no first-eligible `.find`.

### 2. Serialize baseline mutations
- **Defect:** Create/re-register/delete ran outside the memory queue.
- **Root cause:** Direct `baselineStore.*` calls from public APIs.
- **Correction:** `runSerializedBaselineMutation` via `enqueueTracked` + `memoryTaskActive`; snapshot component reads occur only while that task owns the queue.
- **Tests:** Concurrent creates; create vs delete; create while another tracked mutation holds the queue.

### 3. Shared execution ownership for Confirm
- **Defect:** `tryAcquireSharedOwner` / `releaseSharedOwner` unused; text/tools could start after Confirm began.
- **Root cause:** Confirm only checked external busy / queue depth, never acquired the shared owner.
- **Correction:** Confirm acquires `confirm` owner before `enqueueTracked`, releases in `finally`; text:run and `executeTrustedTool` reject while Confirm owns; lifecycle/baseline mutations reject `session.busy` while Confirm owns; ownership boolean fixed (`false \|\| null` bug).
- **Tests:** Confirm blocked during text; memory/baseline blocked while Confirm owner held; duplicate Confirm one apply; ownership null after success/stale.

### 4. Pilot-journal rollover accounting
- **Defect:** Rollover checked existing file only; line 201 / oversize append could exceed ceilings.
- **Root cause:** Append built the line after the ceiling check.
- **Correction:** Build sanitized record/line first; evaluate projected lines/bytes; rollover before append; reject a single line larger than the active-file budget.
- **Tests:** Exact 200→201 rollover; near-byte-limit seed + incoming record; oversized single-line failure.

### 5. Truthful baseline deletion
- **Defect:** Unlink failures ignored; success reported after registry removal.
- **Root cause:** Empty catch around `unlink`.
- **Correction:** Deletion is now a recoverable transaction: active file → same-directory `.deleting-<operation>-<basename>` quarantine → atomic registry removal → final quarantine cleanup. Initial rename failure preserves the registry. Registry-write failure rolls the quarantine back. Failed rollback returns `BASELINE_DELETE_RECOVERY_REQUIRED` with basename/operation metadata only. Final unlink failure is a logical success with `BASELINE_DELETE_CLEANUP_PENDING`.
- **Tests:** Initial rename EPERM; registry failure with successful rollback; registry failure with failed rollback; final cleanup failure.

### 6. Public vs internal backup metadata
- **Defect:** `listBaselines` absolute `full` paths reached the renderer via `backups:list`.
- **Root cause:** No public projection layer.
- **Correction:** `projectPublicBaselineMetadata` allowlist; `listBackupMetadata` maps through it; baseline errors closed.
- **Tests:** Attacker extras (`full`, `registryPath`, `snapshot`, …) stripped; IPC list has no `full`.

### 7. Confirm artifact-delivery pipeline
- **Defect:** `sanitizeDiagnosticText` flattened markdown content.
- **Root cause:** Parallel sanitization path.
- **Correction:** Allowlisted `{title,kind,content}` through `buildTurnArtifactDelivery` only; omit delivery when unsafe; preserve newlines/markdown.
- **Tests:** C18 asserts substantive delivery with preserved `\n`; no raw before/after/token leakage.

### 8. Review patch artifacts removed
- Deleted `phase-18-precommit-review.patch` and `phase-18-complete-precommit-review.patch`.
- Verified no other `*.patch` / review artifacts remain in the working tree root.

### 9. Transaction recovery scan
- **Risk removed:** A registry update can no longer leave a deleted active file that requires Sarah to retry Delete.
- **Correction:** Baseline scans exclude every `.deleting-*` file from ordinary recovery and restore candidates. If the registry still contains the original entry and the original file is absent, a single unambiguous quarantine is rolled back. If the registry entry is absent, the quarantine is safely cleaned. Original/quarantine conflicts, malformed artifacts, multiple quarantines, or rollback failures fail closed as non-restorable recovery metadata.
- **Concurrency:** Delete remains inside `runSerializedBaselineMutation`; duplicate requests serialize to one success plus one stale/not-found result. A baseline-store recovery queue prevents overlapping recovery passes, and active delete transactions are not mistaken for startup artifacts.
- **Tests:** Successful transaction; startup rollback; startup cleanup; conflict exclusion from listing/restore; duplicate delete.

---

## Architecture (post-correction)

```
Confirm: tryAcquireSharedOwner(confirm) → enqueueTracked(confirmPendingInternal) → lifecycle internals
         finally: release owner + clear in-flight
text:run / tools:execute: reject while Confirm owns shared boundary
Baselines: enqueueTracked mutation boundary; public metadata projection only
Delete: active → same-dir quarantine → registry commit → cleanup
Recovery scan: registry present → rollback; registry absent → cleanup; conflict → fail closed
Journal: build line → projected ceilings → rollover if needed → append
UI: per-row baseline actions; no first-eligible fallback
```

---

## Files changed (correction + prior Phase 18)

### Added
- `electron/backup-ids.cjs`
- `electron/backup-baselines.cjs`
- `electron/pilot-journal.cjs`
- `electron/phase-18-pilot-safety-net.test.cjs`
- `scripts/create-desktop-shortcut.ps1`
- `src/lib/pilotBaselines.ts`
- `docs/phase-18-pilot-safety-net-audit.md`
- `docs/phase-18-pilot-safety-net-implementation-report.md`

### Modified
- `electron/memory.cjs` — ownership, serialized baselines, public metadata, Confirm delivery
- `electron/main.cjs` — Confirm-busy gates on text:run + tools
- `electron/preload.cjs`, `src/App.tsx`, `src/styles.css`, `src/vite-env.d.ts`
- `electron/pilot-journal.cjs`, `electron/backup-baselines.cjs`
- `scripts/launch-helpers.cjs`, `scripts/start-jarvis.ps1`, `README.md`
- `electron/memory.test.cjs`, `electron/active-projects-lifecycle.test.cjs`

### Removed
- `phase-18-precommit-review.patch`
- `phase-18-complete-precommit-review.patch`

---

## Exact automated validation

| Suite | Result |
|---|---|
| `node --test electron/phase-18-pilot-safety-net.test.cjs` | **47 pass / 0 fail** |
| `node --test electron/phase-17-daily-use-reliability.test.cjs` | **44 pass / 0 fail** |
| Text + diagnostics (7 files) | **78 pass / 0 fail** |
| Phase 13–16 regression | **126 pass / 0 fail** |
| `npm run build` | **OK** |
| `git diff --check` | **clean** (no whitespace errors) |

---

## Remaining risks

1. Live validation (audit §15) still not run.
2. Baseline row actions are compact pilot UI, not a full management console.
3. Shortcut tests remain source-contract (no COM `.lnk` dry-run).
4. Voice conflict relies on `tools:execute` + Confirm ownership; non-tool voice activity is covered by existing external busy / session patterns.

---

## Live-validation status

**Not performed.** No Jarvis launch, no OpenAI calls, no live `data/` inspection/modification.
