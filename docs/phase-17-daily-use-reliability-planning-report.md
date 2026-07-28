# Phase 17 Planning Report — Daily-Use Reliability

**Status:** Planning only. No files modified, no Jarvis start, no commit/push, no implementation.

---

## Baseline confirmation

| Check | Result |
|---|---|
| Active branch | `phase-17-daily-use-reliability` |
| Working tree | Clean (`git status --porcelain` empty) |
| HEAD vs `main` | Identical at `edbb24c` (`Merge branch 'phase-16'`) |
| Jarvis / `npm run dev` | No `node`/`electron` processes running; prior terminal `npm run dev` sessions are stopped/failed |
| Phase 17 work | None started |

---

## Evidence map (before scope choice)

### What Phases 8–16 closed that matters here

| Phase | Relevant outcome |
|---|---|
| **9** | Realtime error taxonomy, bounded connect retry (1s→2s→4s, `Retry-After` cap 30s), durable error UI, Copy diagnostics |
| **11** | Independent text mode; turn lock; composer preserved on failure; text errors classified but **no** text retry UX |
| **13–15** | Lifecycle write parity + preview tokens (10‑min TTL, process-local `Map`) + recent references (process-local) |
| **16** | Briefing/archive continuity; artifact selection/panel activation fixes; **explicitly deferred** 429 UX, preview/recent restart, packaging |

### Live findings that drive Phase 17

**Phase 15:** Multiple text `rate_limited` / HTTP 429 during remove/restore confirms; tokens were not cleared by 429 alone, but remints/retries caused `STALE_PREVIEW` friction and a wrong-direction restore retry. Restart would wipe preview/recent state.

**Phase 16:** Live blockers were panel reliability (fixed). Realtime smoke skipped under rate-limit minimization. Remaining: process-local/packaging debt.

**Phase 16 planning** already ranked reliability Alts as: (1) preview/recent restart, (2) text 429 + pending-op preservation, (3) Realtime memory freshness — with packaging still deferred as premature vs continuity. That ranking assumed product briefing was next; briefing is now done. For a **one-week unsupervised pilot**, reliability + launch are now first-class.

### Current code facts (verified)

- Text: classifies 429/`Retry-After`; **no auto-retry**; composer kept on failure; busy lock prevents duplicate in-flight turns; **no cooldown UI**.
- Realtime connect: bounded retry already exists (`realtimeErrors.ts` / `realtime.ts`).
- Previews: `previewStore = new Map()` in `electron/memory.cjs`; `PREVIEW_TTL_MS = 10m`; cleared on successful write / restart.
- Launch: `npm run dev` only (Vite + Electron); no single-instance lock; no health check; no Windows launcher script; no installer.
- Diagnostics: voice has Retry/Dismiss/Copy; text mostly status + transcript line; version hardcoded `"1.0.0"`.

---

## Findings by bucket

### Daily-use blockers
1. Ordinary start still requires terminal + `npm run dev` (not pilot-safe).
2. Text 429 during destructive confirm has no wait/countdown/cooldown → users remint and hit `STALE_PREVIEW`.
3. No second-instance protection (duplicate Electron/Vite is easy and confusing).

### Significant reliability risks
4. Preview tokens + recent refs lost on restart mid-confirm / mid-“that one”.
5. Text network/5xx failures: retryable flag exists, but no structured recovery UX.
6. Long sessions can prune useful backups (`MAX_BACKUPS = 10`) — pilot risk, not first-scope.
7. Realtime memory still mint-time only (stale over long voice days).

### Usability friction
8. Text errors lack voice-parity recovery controls.
9. Unclear “what is still pending / when it expires” after a failed confirm turn.
10. Compound multi-action voice instruction bias (Phase 15).

### Optional polish
11. Preview mint / `STALE_PREVIEW` reason logging.
12. Branch/build in status strip; richer diagnostics panel.
13. Restore `backupId` normalization; higher backup retention.

### Remain deferred (even after Phase 17)
14. Full packaging/installer/`userData` migration.
15. Phase 8 residual echo/mic work.
16. OAuth/integrations.
17. Archive mutate/restore; transcript persistence; project status expansion; FU/unresolved sensitivity unification; Realtime session memory refresh as a full subsystem.

---

## Evaluation of proposed components A–F

| Component | Verdict |
|---|---|
| **A. 429 / transient handling** | **In scope — required.** Classification exists; text UX does not. Prefer **manual Retry after countdown** (honor `Retry-After`, bounded backoff display) over aggressive automatic text retries that burn quota during confirm loops. |
| **B. Pending-operation continuity** | **In scope — required.** Tightly coupled to A: keep valid preview + confirm intent through temporary API failure; block needless remint; show expiry. |
| **C. Restart continuity** | **In scope — partial.** Persist **recent references** (UUID-only). Preview-token disk persistence is valuable but security-sensitive — recommend Sarah decision (see §13). Minimum: clear restart messaging + safe expiry if anything is persisted. |
| **D. Dependable launch** | **In scope — lightweight.** Windows `.ps1`/`.bat` + optional desktop shortcut, single-instance lock, startup health, clear failure, clean shutdown. **Not** electron-builder/installer. |
| **E. Daily-use diagnostics** | **In scope — thin.** Extend existing strip: connection, last API error/retry countdown, pending op + expiry, branch/version; copyable sanitized diagnostics for text too. No sensitive memory bodies. |
| **F. Stronger coherent scope** | Combined A+B+C(partial)+D+E **is** the coherent Phase 17 for a pilot. Do **not** fold in Realtime memory refresh, packaging, or Phase 8 audio. |

---

## 1. Recommended title and objective

**Title:** Daily-Use Reliability

**Objective:** Make Jarvis dependable enough for a one-week real-world daily-use pilot without constant technical supervision — specifically by surviving OpenAI rate limits and transient failures without breaking confirm flows, preserving enough session continuity across short interruptions/restarts, and providing a safe one-click Windows launch routine with basic health and diagnostics.

---

## 2. Should Phase 17 combine all three core targets?

**Yes — with a deliberate partial on restart.**

| Core target | Include? | Why |
|---|---|---|
| Rate-limit resilience | **Yes** | Confirmed live Phase 15 blocker for daily destructive use |
| Pending / restart continuity | **Yes (pending must; restart partial)** | Pending continuity unlocks rate-limit work; full preview disk persist needs Sarah’s security call |
| Dependable launch routine | **Yes (lightweight)** | Pilot objective fails if start still means “open terminal, npm run dev” |

Splitting them into three micro-phases would delay pilot readiness and leave the worst live friction (429 mid-confirm) half-fixed.

---

## 3. Exact in-scope functionality

1. **Text transient-failure UX**
   - Distinguish `rate_limited` vs `quota.exhausted` vs network vs 5xx vs other.
   - Surface `Retry-After` when present; otherwise show bounded suggested wait (reuse Phase 9 backoff schedule for display).
   - Countdown / “Retry after Ns” in status UI.
   - Cooldown: block Send / suppress duplicate submits during wait.
   - Preserve composer text (already true; keep as hard requirement).
   - **Default: no automatic OpenAI re-fire for text turns** after 429 (user or explicit Retry after countdown). Optional single automatic retry only for clear network blips if low-risk — Sarah decision.
2. **Pending-operation continuity (same process)**
   - Track last `CONFIRMATION_REQUIRED` context (scope, op, summary, token id, expiresAt) in main process.
   - On text 429/network failure during confirm turn: do **not** instruct remint; tell user preview still valid until TTL; Retry resumes confirm path.
   - Clear pending on success, explicit cancel, TTL expiry, or successful unrelated write that invalidates previews.
3. **Restart continuity (narrow)**
   - Persist recent reference IDs across restart (priorities / WC scopes / active projects) with stale-ID guards (`NOT_FOUND` if missing).
   - Preview tokens: either (preferred default pending Sarah) **do not persist plans to disk** and show “pending confirm expired on restart — ask again”, **or** persist preview store to a local session file with same 10‑min TTL + `expectedUpdatedAt` guards (see §6/§13).
4. **Windows launch routine**
   - `scripts/start-jarvis.ps1` (and/or `.bat` wrapper): ensure cwd, check Node, run `npm run dev` or `build`+`start` path, report failures plainly.
   - Electron `requestSingleInstanceLock`: second launch focuses existing window.
   - Startup health: Vite reachable (dev) or `dist` present (start); missing API key → clear message (already partially classified).
   - Clean shutdown: quit kills child Vite when launched via script; document Ctrl+C / window close.
5. **Thin daily diagnostics**
   - Status strip fields: connection, last text/voice error code, retry countdown, pending op one-liner + expiry, git branch or package version string.
   - Text path: Retry (when cooldown done) + Copy diagnostics parity with voice (sanitized).
6. **Automated tests** for classifier→UI policy, cooldown, pending continuity, recent persistence load/save, single-instance behavior where testable, launch script dry-run checks.

---

## 4. Explicit out-of-scope

- Full packaging, installer, code signing, auto-update, `userData` migration
- Phase 8 residual audio / echo / mic experiments
- Realtime `session.update` memory-refresh subsystem
- OAuth / calendar / email / integrations
- Archive edit/restore; transcript persistence
- Compound multi-action planning engine
- Raising backup retention / restore-ID normalization (unless trivial hitchhike)
- Changing lifecycle write semantics for priorities/WC/projects
- Tomorrow/future briefing expansion; soft calendar UI
- Aggressive automatic multi-retry storms on text 429

---

## 5. User-visible behavior

| Scenario | Expected behavior |
|---|---|
| **First 429** | Status: rate-limit message + countdown from `Retry-After` or default backoff. Composer keeps text. Send disabled until countdown ends. Pending preview (if any) remains valid; UI says so. No automatic re-fire. |
| **Repeated 429s** | Same pattern; backoff display may step up (1→2→4s floor, still honor larger `Retry-After` up to a cap, e.g. 30–60s). After N user-initiated retries still 429: durable message to wait longer / try later; still no remint pressure. Quota exhaustion: non-retryable billing message, no countdown loop. |
| **Network interruption** | Text: network message; composer preserved; Retry enabled when back. Voice: existing reconnect budget. No silent drop of pending preview while process alive. |
| **Failed confirmation request** | If preview still in store and unexpired: “Confirm still pending — retry when ready” + expiry time. Do not mint a new preview unless user changes the request or TTL/staleness requires it. |
| **Restart with pending operation** | If preview **not** persisted: “Previous confirmation expired after restart. Ask Jarvis again to preview.” Recent “that one” still works if recent IDs persisted. If preview **is** persisted (Sarah opt-in): restore pending banner with TTL remaining; stale `updatedAt` → force remint. |
| **Second Jarvis launch** | Single-instance lock: focus existing window; no second Vite/Electron stack. Script exits with a clear “Jarvis is already running” message if lock held. |

---

## 6. Persistence model and security implications

| Data | Persist? | Where | Risk |
|---|---|---|---|
| Recent item UUIDs | **Yes (recommended)** | Local file under existing memory/data dir or Electron `userData` | Low — IDs only; resolve must verify existence |
| Preview tokens + bound plans | **Sarah decision** | If yes: local-only file, 10‑min TTL, clear on write/expiry; never sync/cloud | **Medium–high** — plans include before/after wording of destructive ops; treat as sensitive local state |
| Pending UI summary (op + titles, no full bodies) | Optional even if tokens stay memory-only | Session or short-lived file | Lower sensitivity; still redact `secret` |
| Transcript / composer draft | Out of scope for disk | Memory/UI only | Avoid new PII store |
| Diagnostics ring buffer | Memory only (existing) | Copy on demand | Keep sanitization; no memory item bodies |

**Security rules:** never log API keys, preview payloads, or secret memory fields; pending banners use redacted titles; persisted files must not be committed; clear on successful confirm and on TTL.

---

## 7. Likely files and systems affected

| Area | Likely touch |
|---|---|
| Text errors / retry policy | `electron/text-session.cjs`, `src/lib/textClient.ts`, shared `realtimeErrors.ts` (or shared extract) |
| UI status / cooldown / pending banner | `src/App.tsx` |
| Preview/recent persistence | `electron/memory.cjs`, `electron/priority-lifecycle.cjs` (TTL helpers), small new `electron/session-continuity.cjs` |
| Single-instance + shutdown | `electron/main.cjs` |
| Launch | `scripts/start-jarvis.ps1` (+ `.bat`), README launch note only if Sarah asks for docs |
| Diagnostics | `src/lib/realtimeDiagnostics.ts`, App error strip wiring for text |
| Tests | `electron/*continuity*.test.cjs`, text-session/realtime error tests, optional script lint |
| Docs | Phase 17 audit + implementation report **after** kickoff (not now) |

Unchanged by design: lifecycle write semantics, day-briefing composer, packaging toolchain, Realtime audio path (except shared error helpers if extracted).

---

## 8. Main risks and dependencies

| Risk | Mitigation |
|---|---|
| Auto-retry burns quota / worsens 429 | Prefer countdown + manual Retry for text |
| Persisted previews enable stale destructive confirms after restart | TTL + `expectedUpdatedAt` + invalidate on any write |
| Launch script leaves orphan Vite | `concurrently -k` / trap cleanup; single-instance |
| Scope creep into installer | Hard out-of-scope |
| Pending UI desync from real `previewStore` | Single source of truth in main; UI reads via IPC |
| Pilot still hits API limits from heavy live use | Thrifty live plan; teach wait/retry behavior |

**Dependencies:** Phase 16 merged baseline (true); Phase 9 taxonomy (reuse); existing preview TTL/invalidate semantics.

---

## 9. Recommended implementation sequence

1. Audit lock (Phase 17 design doc after Sarah accepts this plan).
2. Shared text retry policy + cooldown + UI countdown (no auto-fire).
3. Pending-confirm continuity IPC + banner (same-process).
4. Recent-reference persistence + stale guards.
5. Preview restart policy per Sarah decision.
6. Electron single-instance + launch script + basic health/failure messages.
7. Thin diagnostics (pending, countdown, version/branch, text Copy/Retry).
8. Automated tests.
9. Minimal live validation (API-thrifty).
10. Implementation report; commit/PR only when requested.

---

## 10. Automated-validation plan

- Classifier: quota vs rate_limit vs network vs 5xx; `Retry-After` parsing/cap.
- Text cooldown: Send rejected during wait; composer unchanged.
- Pending continuity: mint preview → inject 429 on confirm turn → store still valid → confirm succeeds without remint.
- Pending clear: success / TTL / `invalidatePreviews` clears banner.
- Recent persistence: set recent → simulate restart load → `reference: recent` resolves; deleted id → `NOT_FOUND`.
- Preview restart (if enabled): reload within TTL works; after TTL or mismatched `updatedAt` → `STALE_PREVIEW`.
- Single-instance: second `requestSingleInstanceLock` fails (unit/integration as feasible).
- Launch script: missing `node_modules` / missing `.env.local` key path reports readable errors (dry-run).
- Regression: Phase 13–16 suites green; no lifecycle semantic drift.

---

## 11. Minimal-request live-validation plan

**Prep:** one launch via new script; text-only; stop on real 429.

| Step | API budget | Check |
|---|---|---|
| 1 | 0 | Launch script starts Jarvis once; second launch focuses existing / refuses duplicate |
| 2 | 1 | Simple text ping → success; note status strip version/branch |
| 3 | 1–2 | Mint one destructive preview (e.g. remove a disposable test item) → see pending banner + expiry |
| 4 | 0–1 | Simulate/force rate-limit path if injectable; else one confirm attempt — on 429, verify countdown + no remint pressure + composer preserved |
| 5 | ≤1 | After cooldown, confirm **same** preview succeeds |
| 6 | 0 | Restart: recent “that one” behavior + pending messaging per chosen persist policy |
| 7 | 0 | Diagnostics Copy: no secrets/memory bodies |
| 8 | skip | Realtime — skip unless Sarah wants one connect smoke |

**Avoid:** long Phase 15-style confirm chains, compound voice multi-ops, packaging builds, backup-pruning stress.

---

## 12. One-week pilot readiness criteria

Jarvis is pilot-ready when:

1. Sarah can start/stop daily via shortcut/script without opening a Cursor terminal workflow.
2. Second launch does not create a confusing duplicate stack.
3. Text 429 shows actionable wait + preserves draft; does not push remint of valid previews.
4. Same-process pending confirm survives transient API failure for the remaining TTL.
5. Restart behavior is defined, tested, and communicated (recent works; pending either restored safely or clearly expired).
6. Status strip answers: connected?, last error?, waiting to retry?, anything pending?, which build?
7. Automated suite green; live checklist passed with minimal API use.
8. No installer/OAuth/audio-debt scope leakage.

---

## 13. Decisions requiring Sarah’s input

1. **Confirm Phase 17 = Daily-Use Reliability** combining rate-limit + pending continuity + lightweight launch (+ partial restart).
2. **Text retry mode:** countdown + **manual Retry only** (recommended) vs one automatic network retry?
3. **Preview tokens across restart:** persist to local disk with TTL/stale guards, or expire on restart with clear messaging? (**Recommend expire on restart** for v1 pilot safety; persist recent IDs only.)
4. **Launch flavor:** always `npm run dev`, or `npm run build` once then `npm start` for stabler daily runs?
5. **Desktop shortcut:** create/script instructions only, or also generate a `.lnk` helper?
6. **Include thin diagnostics (E) now** (recommended) or defer UI polish?
7. **Any hitchhike** of Phase 15 preview-mint logging / backup retention? (Recommend **no**.)

---

## 14. Three ranked alternative scopes

1. **Recommended (this report):** Rate-limit UX + pending continuity + recent restart persist + lightweight Windows launch + thin diagnostics. Preview disk persist optional/off by default.
2. **Narrower Alt:** A+B only (429 + pending same-process). Fastest to ship core live pain; leaves pilot start friction and restart “recent” loss.
3. **Broader Alt:** Recommended + full preview disk persistence + Realtime memory refresh + backup retention. Higher risk/cost; delays pilot; refresh belongs in a later voice-continuity phase.

---

## 15. Deferred items that should remain separate after Phase 17

- Full packaging / installer / auto-update / `userData` migration  
- Realtime memory session refresh  
- Phase 8 residual audio  
- OAuth / integrations  
- Archive mutate/restore; transcript persistence  
- Compound multi-action verification  
- Backup retention + restore-ID normalization + preview mint diagnostics (unless later micro-pass)  
- FU/unresolved sensitivity unification; project status/promote expansion; tomorrow briefing  

---

## Bottom-line recommendation

**Proceed with Phase 17 as Daily-Use Reliability**, combining all three core targets, with restart continuity scoped to **recent references + clear pending expiry messaging**, and launch scoped to a **safe Windows script + single-instance lock** (not an installer). Treat aggressive text auto-retry and disk-persisted destructive preview plans as opt-in decisions, not defaults.

No implementation, docs, or Jarvis start until you accept the scope and answer the §13 decisions.
