# Phase 11 independent text mode — live-test failure diagnosis

**Status:** Diagnosis only. No application code changes.  
**Context:** Live test with voice connected (`LISTENING`), typed prompt `What is my first priority?`, Send clicked.

---

## Confirmed cause

The typed turn **did enter Phase 11 text mode** and **failed inside the main-process Responses turn**, returning a Phase 9 **`unknown`** error. That maps to the exact status string observed:

> Something went wrong connecting Jarvis.

It was **not** a session-owner reject for `LISTENING`, and **not** a silent drop.

The voice reply about the click (“I heard a click but no clear speech”) is a **parallel Realtime side effect** of the Send click (mic noise), which completed **after** the short-lived text lock was released.

---

## Exact runtime error and HTTP status

### User-facing / sanitized runtime error

| Field | Value |
|---|---|
| **Path** | `TextClient.submit` → `window.jarvis.runTextTurn` → `text:run` → `text-session.runTextTurn` → failure return |
| **Result** | `{ ok: false, outcome: "error" }` |
| **Error code** | `"unknown"` |
| **Error message** | `"Something went wrong connecting Jarvis."` (Phase 9 `USER_MESSAGES.unknown`) |

### HTTP status

**Not observed in available on-disk runtime logs** for this live attempt (no captured `[jarvis-text] usage` line with `httpStatus` / `bodyHash` in the repo or recent TEMP logs).

Inference from code:

- Missing API key would return a **different** message (`Add your OpenAI API key…`).
- Busy/session-owner reject would return **`Jarvis is busy with a voice response.`** / **`Jarvis is busy with another text turn.`**
- Network offline would return **`Network connection looks down.`**
- Explicit model-not-found body matching would return the configured-text-model unavailable message.

Therefore the live string matches **`classifyHttpFailure` → `unknown`**, which is the default for **non-OK HTTP with JSON body** that is not classified as 401/403, 429, 5xx, or HTML/non-JSON — commonly **400 invalid_request** or **404 / model-permission** responses whose body did not match the narrow `model_not_found` detector.

**Exact HTTP status for this live run: unknown / not captured.** Re-test with main-process console open to record `[jarvis-text] usage` / future `httpStatus` logging.

---

## Exact failure path

```
App.sendTextPrompt
  → voiceBusy?  no (LISTENING alone is not busy)
  → tryAcquireText()  ok
  → TextClient.submit
       → onUserText (user line may be in Live Log)
       → window.jarvis.runTextTurn  (IPC text:run)
            → text-session.runTextTurn
                 → buildSharedSessionInstructions()
                 → POST /v1/responses   ← failed (HTTP non-OK or thrown classify path)
                 → classifyHttpFailure → code "unknown"
                 → return { ok:false, outcome:"error",
                            error.message: "Something went wrong connecting Jarvis." }
       → onError(message) → setLastError + setStatus
  → finally releaseText()
  → field kept (outcome === "error")
```

Meanwhile:

```
Send click → mic hears click → Realtime VAD → assistant:
  "I heard a click but no clear speech."
```

Text lock is released as soon as the Responses call fails, so that voice response is **not** suppressed and can show in the UI.

---

## Relevant files and functions

| File | Functions / symbols |
|---|---|
| `src/App.tsx` | `sendTextPrompt`, `statusLine`, `lastError` / `setLastError` |
| `src/lib/textClient.ts` | `submit`, `onError` fallback to unknown message, diagnostics `mode=text` |
| `src/lib/sessionOwner.ts` | `tryAcquireText`, `isVoiceBusy`, `releaseText`, `canStartVoiceResponse` |
| `electron/preload.cjs` | `runTextTurn` → `text:run` |
| `electron/main.cjs` | `ipcMain.handle("text:run")`, `createTextSessionController`, `buildSharedSessionInstructions` |
| `electron/text-session.cjs` | `runTextTurn`, `callResponsesApi`, `classifyThrown`, usage log |
| `electron/realtime-errors.cjs` | `classifyHttpFailure`, `USER_MESSAGES.unknown` |
| `electron/session-instructions.cjs` | `buildSessionInstructions` |
| `src/lib/realtime.ts` | `isVoiceTurnBusy`, voice response after unlock; click-driven VAD path |
| `src/lib/realtimeErrors.ts` | shared unknown user message (renderer taxonomy) |

---

## Request-payload / tool-schema findings

| Item | Finding |
|---|---|
| **Endpoint** | `POST https://api.openai.com/v1/responses` |
| **Default model** | `gpt-4.1` (`OPENAI_TEXT_MODEL` unset in `.env.local` → main fallback) |
| **API key** | Present (Realtime voice connect succeeded with same dotenv load) |
| **Tools** | Canonical `toolSpecs` mapped via `mapToolsForResponses` to `{ type: "function", name, description, parameters }` — matches current Responses function-tool shape |
| **Continuation** | Official input accumulation with `store: false` (relevant to later tool loops; **this live failure is consistent with first-request failure**, before tool continuation) |
| **Instructions** | Shared `buildSessionInstructions()` (Jarvis + personal memory + thumbnails); same builder as Realtime mint |
| **Likely reject class** | First-request Responses rejection (model access / invalid_request / permissions), **not** a tool-loop `call_id` continuation bug |

Most plausible underlying API causes (ordered):

1. Account/org cannot use **`gpt-4.1`** on Responses while Realtime `gpt-realtime-2` still works.  
2. Responses **400** on request/tools validation (first call).  
3. Less likely: instruction/memory build throw → same `unknown` fallback.

---

## IPC and session-owner findings

| Question | Finding |
|---|---|
| Did `sendTextPrompt` call `TextClient.submit`? | **Yes.** Busy rejects use different copy. Field preserved on text `error`/`rejected`. |
| Does `window.jarvis.runTextTurn` exist? | **Yes** on current `main` / preload (`5ef64f0`). Missing method would show `…is not a function`. |
| Is `text:run` registered? | **Yes** — `electron/main.cjs` `ipcMain.handle("text:run", …)`. |
| Did owner treat `LISTENING` as busy? | **No.** `isVoiceTurnBusy` = `responseInFlight \|\| toolRunning`. LISTENING leaves both false. Reject copy would be busy-specific. |
| Did Send click start a voice turn? | **Yes (concurrent).** Explains click reply; does **not** produce the unknown status string. |
| Text diagnostics `mode=text`? | **Should have been written** on the error path (`text.turn.error` + `.meta` with `mode=text`, turnId, outcome). |

**Classification:** Primary = **model / Responses API configuration or request rejection**. Not primary = missing IPC or LISTENING-as-busy owner logic.

---

## UI error-mapping findings

| Behavior | Explanation |
|---|---|
| Status label still **Listening** | `sessionUiState` remains voice listening; connection not torn down |
| Status message = unknown connecting copy | `TextClient.onError` → `setLastError({ userMessage })`; `statusLine = lastError?.userMessage \|\| …` |
| Voice-oriented wording | Text reuses Phase 9 `USER_MESSAGES.unknown` (“Something went wrong **connecting** Jarvis”) even though this is a text/Responses failure |
| Field remained populated | **Expected** for `outcome: "error"` (preserve until main accepts a successful turn) |
| Voice click reply visible | Text `finally` → `releaseText()` after fast failure; later Realtime `response.done` no longer suppressed |

---

## Smallest corrective patch

1. **Surfacing:** On text failure, show a text-specific status (include `httpStatus` when present) and **don’t overwrite Realtime `lastError`** with text errors (separate `textError` state).  
2. **Classification:** Broaden Responses failure mapping (model not supported / invalid_request) to readable text messages; log `[jarvis-text]` with `httpStatus` + `bodyHash` (still no raw body).  
3. **Config:** Document/verify `OPENAI_TEXT_MODEL` against a model the key can call; keep default only if that model is available.  
4. **Click race (narrow):** On Send, briefly ignore/suppress voice `speech_started` / barge-in from the click (or pause mic input ~200–300ms) so Send doesn’t spawn “I heard a click…”.

Preserve Phase 8 / 8B / 9 / 9B / branding / memory / voice / interruption behavior; only gate the Send click side-effect and improve text error mapping/logging.

---

## Required tests

1. Mock Responses **400** JSON → UI shows non-generic text error (or at least preserves `httpStatus` in diagnostics meta).  
2. Mock Responses **model not supported** → readable model/config message.  
3. `LISTENING` + typed submit → acquires text; **not** busy reject.  
4. Text error does **not** set voice `sessionUiState` to `error` / does not clear voice connection.  
5. After text `outcome: "error"`, input field still has the prompt.  
6. Diagnostics meta contains `mode=text` + turnId on failure.  
7. (Optional) Simulated `speech_started` during Send while text owns → suppressed or deferred; no overlapping assistant line while lock held.

---

## Manual retest procedure

1. Fully quit Electron; start fresh (`npm run dev` preferred so preload/main/renderer match).  
2. Watch the **main process terminal** for `[jarvis-text] usage`.  
3. Connect voice → LISTENING.  
4. Type `What is my first priority?` → Send.  
5. Confirm either a text answer **or** a clearer text error; note any `[jarvis-text]` `errorCode` / whether a Responses HTTP status was logged after the patch.  
6. Confirm field clears only on success.  
7. Repeat Send with mic muted or after a short pause to see if the click reply disappears.  
8. Copy diagnostics → confirm `mode=text` and turn id.  
9. Disconnect voice and retry typed-only (isolates API/model from mic race).

---

## Summary classification

| Layer | Role |
|---|---|
| **Primary** | Model / Responses API configuration or request rejection (HTTP failure → `unknown`) |
| **Secondary** | UI error-state mapping (text failure reused voice `lastError` + generic connecting copy) |
| **Tertiary** | Mic click race (voice answer after text unlock) |
| **Not primary** | IPC missing; LISTENING-as-busy session-owner logic |

**Stop.** Diagnosis document only; no application edits, commit, or push.
