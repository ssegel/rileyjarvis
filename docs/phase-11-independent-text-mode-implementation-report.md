# Phase 11 independent text mode — implementation report

**Branch:** `phase-11-independent-text-mode`  
**Status:** Implementation reviewed and tightened; not committed.  
**Authoritative scope:** `docs/phase-11-independent-text-mode-audit.md`

---

## Summary

Phase 11 adds an **independent text API path** so every keyboard submission runs through the OpenAI **Responses API** in the Electron main process. Typed turns work while Realtime voice is disconnected, do not request the microphone, do not create WebRTC, do not mint a Realtime client secret, and do not send text on the Realtime data channel.

Voice, interruption, diagnostics, recovery, clipboard, memory, tools, artifacts, computer-use, Realtime model/voice/VAD, and Jarvis branding behavior are preserved. Application-level session ownership (`idle | text | voice`) allows only one active model-driven response or tool loop at a time.

---

## Complete changed-file list (with justification)

| File | Why required |
|---|---|
| `electron/session-instructions.cjs` | Shared `buildSessionInstructions()` so Realtime mint and text turns get identical Jarvis + memory + thumbnail instructions |
| `electron/text-session.cjs` | Main-process Responses turn loop, tool execution, cancel/timeout, usage logging |
| `electron/main.cjs` | Registers `text:run` / `text:cancel`; wires shared instructions; exposes `executeTrustedTool` to text session |
| `electron/preload.cjs` | Narrow renderer bridge: `runTextTurn` / `cancelTextTurn` only |
| `electron/text-mode.test.cjs` | Focused Phase 11 regression coverage |
| `electron/text-prompt-submit.test.cjs` | Replaces Connect-voice-first expectations with independent text IPC |
| `src/lib/sessionOwner.ts` | Global turn owner lock across text and voice |
| `src/lib/textClient.ts` | Renderer text state machine, cancel generation guard, diagnostics |
| `src/lib/realtime.ts` | Suppresses voice tools/assistant output while text owns; diagnostic suppression events |
| `src/App.tsx` | Routes all keyboard submits through text path; busy messages; Cancel; history slice |
| `src/vite-env.d.ts` | Precise text IPC request/response types |
| `.env.example` | Documents optional `OPENAI_TEXT_MODEL` (no real credentials) |
| `docs/phase-11-independent-text-mode-implementation-report.md` | This report |

No other uncommitted files are in scope.

---

## Selected text model and configuration

| Concern | Value |
|---|---|
| **Default text model** | `gpt-4.1` (`DEFAULT_TEXT_MODEL` in `electron/text-session.cjs`) |
| **Configuration** | `process.env.OPENAI_TEXT_MODEL \|\| "gpt-4.1"` in `electron/main.cjs` |
| **Env docs** | `.env.example` → `OPENAI_TEXT_MODEL=gpt-4.1` (placeholder only) |
| **Invalid / unavailable model** | HTTP failure body matching model-not-found → readable message: “The configured text model is unavailable. Check OPENAI_TEXT_MODEL in `.env.local`.” via Phase 9 `createTokenError` / sanitization |
| **Realtime model** | Unchanged: `gpt-realtime-2` |
| **Realtime voice / VAD** | Unchanged: `cedar`, `semantic_vad`, `interrupt_response: true` |

Default retained: current OpenAI Responses function-calling docs still demonstrate GPT-4.1-class / GPT-5-class Responses models; `gpt-4.1` remains appropriate for this path.

---

## Exact IPC surface

```js
// main
ipcMain.handle("text:run", …)    // → textSession.runTextTurn(request)
ipcMain.handle("text:cancel", …) // → textSession.cancelTextTurn(clientTurnId)

// preload / window.jarvis
runTextTurn(request)
cancelTextTurn(clientTurnId)
```

**Request:** `{ clientTurnId, text, history? }`  
**Result:** `ok`, `assistantText`, `artifacts`, `toolTrace`, `usage`, `durationMs`, `outcome`, `cancelled`, sanitized `error?`

API key never enters the renderer.

---

## Instruction and memory-context construction

`buildSessionInstructions()` builds:

```
JARVIS_INSTRUCTIONS
+ memoryStore.buildPersonalContextForSession().text
+ buildThumbnailBoardInstructions(db)
```

Used by both `realtime:create-token` and each text turn (`buildSharedSessionInstructions`). Memory is rebuilt per text turn. **Injected memory blocks are not logged.**

---

## Verified Responses API / tool-loop behavior

Aligned with current OpenAI function-calling (Responses) documentation:

| Concern | Implementation |
|---|---|
| **Function-tool schema** | `{ type: "function", name, description, parameters }` from canonical `toolSpecs` |
| **function_call parsing** | `output` items with `type === "function_call"`; `name`, `call_id`, JSON `arguments` |
| **function_call_output** | `{ type: "function_call_output", call_id, output: string }` |
| **Continuation** | Official accumulation: `input = [...input, ...response.output, ...function_call_outputs]` with `store: false` (does **not** rely on `previous_response_id` server cache) |
| **Usage fields** | Sums `usage.input_tokens` / `usage.output_tokens` (also accepts camelCase) |
| **Cancellation** | `AbortController` aborts in-flight `fetch`; abort reason `"cancel"` vs `"timeout"` |

Tool execution always goes through `executeTrustedTool` / existing confirmation gates. Each `call_id` executes at most once per text turn (dedupe set).

---

## Text state transitions

`idle → sending → waiting → (tool-running) → completed | cancelled | error`

Cancel control shown while active. Readable busy messages when text or voice already owns the turn (no silent discard).

---

## Concurrency and cancellation findings

### Session owner (`idle | text | voice`)

- Releases after success, rejection, error, timeout, cancellation (`App` `finally` → `releaseText()`; main `activeTurns` cleared in `finally`).
- IPC throw in submit/cancel still releases App lock (`try/catch/finally`) and clears renderer turn id.
- Conflicting text+text / text+voice rejected with readable busy status.
- Idle voice **connection** is not disconnected when text runs.
- Spoken turns while text owns: `response.create` skipped/cancelled; assistant transcript **not** stored; tools skipped; diagnostic event `voice.suppressed_while_text` (no spoken content logged).

### Cancel / timeout → UI

- Main returns empty `assistantText` / `artifacts` on cancel and timeout.
- Renderer applies artifacts/assistant text **only** on successful `ok` results.
- Generation counter drops late results after cancel.

---

## Conversation-history behavior

- Live Log remains UX history; internal role may remain `ricky`, UI label **Jarvis**.
- Text history: filter `user`/`ricky` only → take 12 newest → **reverse to chronological** → map to `user`/`assistant`.
- `buildInitialInput` also rejects non-permitted roles (`tool`, `system`, etc.).
- Excludes tool internals, diagnostics, secrets, raw memory blocks, error payloads.
- Realtime server conversation and Responses conversation remain separate transports.

---

## Cost and usage logging

- Realtime tracing: `Jarvis Desktop Companion`
- Text tracing: `Jarvis Text`
- Console: `[jarvis-text] usage` with turn ID, model, duration, outcome, input/output tokens, tool call count, optional error code
- No prompts, API keys, memory context, credentials, raw bodies, or private tool payloads

---

## `.env.example`

Documents optional `OPENAI_TEXT_MODEL=gpt-4.1` with a Phase 11 comment. Existing placeholder keys (`OPENAI_API_KEY`, `EXA_API_KEY`) remain placeholders only — no real credentials.

---

## Tests and results

| Suite | Command / file | Result |
|---|---|---|
| Phase 11 | `electron/text-mode.test.cjs` | **18 pass / 0 fail** |
| Text-prompt | `electron/text-prompt-submit.test.cjs` | **6 pass / 0 fail** |
| Phase 8 | `electron/realtime-voice-stabilization.test.cjs` | **6 pass / 0 fail** |
| Phase 8B | `electron/realtime-interrupt-stabilization.test.cjs` | **7 pass / 0 fail** |
| Phase 9 | `electron/realtime-diagnostics-recovery.test.cjs` | **18 pass / 0 fail** |
| Phase 9B | `electron/clipboard-diagnostics.test.cjs` | **6 pass / 0 fail** |
| Branding | `electron/jarvis-branding.test.cjs` | **6 pass / 0 fail** |
| Typecheck | `npm run typecheck` | **pass** (exit 0) |
| Build | `npm run build` | **pass** (exit 0) |
| Whitespace | `git diff --check` | **pass** (exit 0) |

**Combined Node suites above: 67 pass / 0 fail.**

---

## Remaining manual validation

1. Cold start → type without Connect → reply; no mic / WebRTC.  
2. Voice connected → interrupt still works → type → text path answers; audio session stays up.  
3. Memory + menu tools from text; confirmation gates.  
4. Cancel long turn; lock releases; no late UI artifacts.  
5. Invalid `OPENAI_TEXT_MODEL` → readable error; Copy diagnostics has mode/turn/usage, no secrets.  
6. Usage: typing bills Responses / `Jarvis Text`, not Realtime.

---

## Review corrections and scope deviations

### Corrections applied in this review (tighten only)

1. Restored missing `DEFAULT_TEXT_MODEL = "gpt-4.1"` constant.  
2. Tool loop switched to official **input accumulation** (`response.output` + `function_call_output`) with `store: false` instead of `previous_response_id` chaining.  
3. `call_id` dedupe within a text turn.  
4. Cancel/timeout strip artifacts from main results; renderer ignores late/cancelled deliveries.  
5. Session owner always released on IPC throw; busy text submit no longer silently discarded.  
6. Voice suppression while text owns: no overlapping assistant transcript; diagnostic-only logging without spoken content.  
7. History builder rejects non user/assistant/ricky roles.  
8. Readable Phase 9-style error for unavailable/invalid text model.  
9. Branding-compatible `` `${JARVIS_INSTRUCTIONS}` `` wiring in `buildSharedSessionInstructions`.

### Retained deviations / compatibility

- Optional audit `conversationId` omitted; bounded `history` used.  
- Text diagnostics encode `mode=text` in message meta on the shared Phase 9 buffer.  
- Non-streaming Responses turns for v1.  
- `sendText` remains on Realtime client but unused by keyboard.  
- Intentional historical `ricky*` identifiers retained per branding policy.

---

**Stop.** No commit or push.
