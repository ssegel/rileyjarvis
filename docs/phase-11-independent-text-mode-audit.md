# Phase 11 independent text mode audit

**Phase 11 scope report (read-only).** No application edits, commits, or pushes.

---

## 1. Confirmed current architecture

### Typed-submission path (today)

```
Keyboard field (App.tsx)
  → sendTextPrompt()
    → gate: connectionState === "connected"
    → clientRef.current.sendText(trimmed)
      → RickyRealtimeClient.sendText()
        → requires open RTCDataChannel
        → conversation.item.create (input_text)
        → response.create (client)
        → Realtime server events on data channel
          → transcript / mood / artifacts
          → function_call → window.jarvis.executeTool (IPC tools:execute)
          → function_call_output via data channel
          → optional response.create follow-up
```

| Stage | File / function | Behavior |
|---|---|---|
| UI field | `src/App.tsx` `textPrompt`, `showTypeInput` | Keyboard toggle; Enter / Send |
| Submit gate | `App.sendTextPrompt` | If not connected → `"Connect voice first."`; preserve text; no Network call |
| Realtime send | `src/lib/realtime.ts` `sendText` | Fails if `dc.readyState !== "open"` |
| User message | data channel `conversation.item.create` | Typed text as `input_text` |
| Response | `requestClientResponseCreate` → `response.create` | Same path as voice turn follow-ups; gated by `responseInFlight` (Phase 8B) |
| Audio / VAD | Realtime session | Session already has `semantic_vad`, `output_modalities: ["audio"]`, voice `cedar` — typed turns still ride the live Realtime session |
| Tools | `executeFunctionCalls` → `window.jarvis.executeTool` | Main `tools:execute`; confirmation gates in main/memory |
| Artifacts | `onArtifact` / `ArtifactPanel` | Same as voice |
| Transcript | `onTranscript` roles user / ricky(display Jarvis) / tool / system | Live log |
| Memory context | Injected only at Realtime token mint | `buildPersonalContextForSession()` inside `realtime:create-token` |

### Why typed input requires an active Realtime connection

1. **App gate:** `isConnected` must be true before calling `sendText`.
2. **Transport:** `sendText` requires an open WebRTC data channel.
3. **Model session:** Instructions, tools, and memory context are bound into the Realtime client secret at mint time — there is **no** separate text completion IPC.
4. **Response loop:** Assistant output and tool round-trips are Realtime events (`response.*`, function calls), not a standalone HTTP chat path.
5. **Tests encode the gate:** `electron/text-prompt-submit.test.cjs` asserts disconnected submit shows `"Connect voice first."` and does not call send.

### Current model / instructions / memory / tools (typed via voice session)

| Concern | Current source |
|---|---|
| Model | `gpt-realtime-2` (Realtime only) |
| Instructions | `JARVIS_INSTRUCTIONS` + personal memory block + thumbnail board instructions |
| Memory | `memoryStore.buildPersonalContextForSession()` at token mint |
| Tools | Shared `toolSpecs` embedded in Realtime session; execution via `tools:execute` |
| Confirmations | Tool schemas + main/memory `confirmed === true` checks (unchanged by transport) |
| Artifacts | Tool results return `artifact`; renderer shows in `ArtifactPanel` |
| Response-state | Phase 8B: `activeResponseId`, `supersededResponseIds`, `responseInFlight`, barge-in flush |

### Shared vs WebRTC-coupled

**Sharable across text and voice**

- `JARVIS_INSTRUCTIONS`
- `memoryStore.buildPersonalContextForSession` / memory tools
- `toolSpecs` + `tools:execute` / confirmation rules
- Artifact kinds and `ArtifactPanel`
- Transcript UI patterns
- Phase 9 error taxonomy / diagnostics patterns (extend with text-specific events)
- Clipboard diagnostics bridge (already mode-agnostic)

**Coupled to Realtime / WebRTC / audio / VAD / data channel**

- `realtime:create-token`, SDP `/v1/realtime/calls`, `RTCPeerConnection`, mic `getUserMedia`
- Data-channel event protocol and Phase 8B interrupt gating on audio responses
- Mouth meter / remote audio element
- Session moods driven by `input_audio_buffer.*` and `response.audio.*`
- Typed path today only as a passenger on that session

### Exact files / functions / IPC / UI / tests involved

| Area | Items |
|---|---|
| UI | `App.tsx` keyboard strip, `sendTextPrompt`, mic connect/disconnect, session status strip |
| Client | `realtime.ts` `connect`, `sendText`, `handleServerEvent`, `executeFunctionCalls`, interrupt gate |
| Preload | `createRealtimeToken`, `executeTool`, `getToolSpecs`, `copyTextToClipboard` — **no text-chat IPC** |
| Main | `realtime:create-token`, `tools:list`, `tools:execute`, `JARVIS_INSTRUCTIONS`, `toolSpecs`, image/search helpers |
| Memory | `electron/memory.cjs` context builder + tool handlers |
| Types | `src/vite-env.d.ts` `Window.jarvis` |
| Tests | `text-prompt-submit.test.cjs` (gate); Phase 8/8B/9/9B suites (voice); **no** independent text suite |

---

## 2. Coupling and failure risks

| Risk | Why it matters |
|---|---|
| Text billed as Realtime | Every typed turn today burns Realtime session time / audio modality even when user only wanted text |
| Mic required for typed use | Product friction; fails Phase 11 requirement |
| No text path if voice down | Network/mic/WebRTC errors block typing entirely |
| Dual-mode races | If text HTTP and Realtime both create responses/tools without a session lock → duplicate artifacts / tool side effects |
| Memory divergence | Context only refreshed at Realtime mint; a long-lived voice session + new text path could see different memory unless text rebuilds context per request |
| Tool output protocol mismatch | Voice returns tool results over DC; text must loop tool results in HTTP Responses API without opening Realtime |
| History split | Session transcript is renderer-only; switching modes without a shared turn log risks inconsistent follow-ups |

---

## 3. Recommended text API architecture

### Verdict

**Main-process OpenAI Responses API** (`POST https://api.openai.com/v1/responses`) via a **narrow preload IPC** (e.g. `text:run` / `text:cancel`), **not** renderer-direct fetch, and **not** Realtime.

### Why this path

| Option | Recommendation |
|---|---|
| Main-process + preload IPC | **Preferred** — matches Electron security (`contextIsolation`, no key in renderer); same pattern as token mint / tools / clipboard |
| Renderer `fetch` with key | **Reject** — exposes or proxies secrets poorly; bypasses main logging |
| Realtime without mic | **Reject for text-only** — still creates WebRTC/Realtime cost; fails “no Realtime session for text-only” |
| Chat Completions | Acceptable fallback; **prefer Responses API** as current tool-calling surface aligned with function tools |

### Streaming vs non-streaming

- **Phase 11 v1:** non-streaming or single-stream aggregation in main is acceptable for reliability and simpler tool loops.
- **Optional streaming:** SSE/stream from main → renderer progress events for `streaming` UI state; not required for first ship if timeouts and cancel work.
- Tool loops: main (or a dedicated `textSession` module) runs: model → tool calls → `tools:execute` → append outputs → model again, bounded iterations.

### Suggested IPC shape (design only)

```ts
// preload: window.jarvis.runTextTurn / cancelTextTurn
runTextTurn({
  text: string,
  conversationId?: string,
  clientTurnId: string,
}): Promise<{
  ok: boolean;
  assistantText?: string;
  artifacts?: RickyArtifact[];
  toolTrace?: Array<{ name: string; ok: boolean }>;
  usage?: { inputTokens?: number; outputTokens?: number; model: string };
  error?: { code: string; message: string };
}>;

cancelTextTurn({ clientTurnId: string }): Promise<{ ok: boolean }>;
```

- API key stays in main.
- Rebuild instructions + memory context **per text turn** (or short TTL cache) so text does not depend on an old Realtime mint.
- Reuse identical `toolSpecs` and `tools:execute`.
- Log usage under workflow label e.g. `Jarvis Text` separate from `Jarvis Desktop Companion` (Realtime).

### Model choice (text)

- Prefer a current text-capable model configured in main only (e.g. a GPT-4.1 / GPT-5-class Responses model — pin at implementation time).
- Do **not** use `gpt-realtime-2` for text-only.
- Do **not** change Realtime model/voice/VAD in this phase.

---

## 4. Shared versus mode-specific components

| Shared | Text-specific | Voice-specific |
|---|---|---|
| Instructions + memory builder | `text:run` IPC + Responses client | Realtime token + WebRTC |
| `toolSpecs` / `tools:execute` | Text turn state machine | DC events + interrupt gate |
| Artifacts / transcript append APIs | Text UI states; cancel/timeout | Mic, audio, VAD, mouth |
| Phase 9 classifiers (extend) | Text error codes / diagnostics events | Connection/reconnect states |
| Confirmation rules | — | Barge-in / audio flush |

---

## 5. Phase 11 design

### Explicit paths

1. **Voice path (unchanged):** Connect mic → Realtime WebRTC → audio + optional typed inject via `sendText` **or** deprecate typed-on-Realtime in favor of always using text path even when connected (see concurrency).
2. **Text path (new):** Keyboard submit → main Responses turn → tools → artifacts/transcript — **no** mic, **no** WebRTC, **no** Realtime client secret.

### Typed while voice disconnected

- Allowed; primary Phase 11 goal.
- Uses text IPC only.

### Typed while voice connected

**Policy (recommended):**

- Prefer routing **all keyboard submits through the text path**, even if voice is connected, to avoid Realtime charges for typing and to keep one tool/response owner.
- Voice continues for spoken turns only.
- Alternative (higher coupling): keep `sendText` on DC when connected — **not recommended** (duplicate protocols, Realtime cost).

### Shared memory and instructions

- Text turns call `buildPersonalContextForSession()` in main each run (or invalidate on memory tool writes).
- Same confirmation gates for memory clear / secrets / risky computer actions.

### Shared tools and artifacts

- Same `toolSpecs`; execute only through existing `tools:execute`.
- Artifacts pushed to App the same way (callback/events from text client).

### Canonical text states

`idle` → `sending` → `waiting` → (`streaming` optional) → `tool-running` ↔ `waiting` → `completed` | `cancelled` | `error`

| Transition | Rule |
|---|---|
| idle → sending | User submits non-empty text; acquire text-turn lock |
| sending → waiting | Request accepted by main |
| waiting → tool-running | Model returned function calls |
| tool-running → waiting | Tool results appended; continue model |
| * → completed | Final assistant message; release lock |
| * → cancelled | User cancel or disconnect-app policy; AbortController |
| * → error | Classified failure; Phase 9-style message; release lock |
| any → idle | Dismiss / after completed display settle |

### Cancellation / timeout / retry / diagnostics

- **Cancel:** Abort in-flight fetch; stop tool loop; mark turn cancelled; no Realtime teardown needed.
- **Timeout:** Bounded overall turn timeout (e.g. 60–120s) + per-HTTP timeout; surface readable error.
- **Retry:** Manual retry for retryable HTTP/network; reuse Phase 9 taxonomy where applicable; do not auto-retry non-retryable config/quota.
- **Diagnostics:** Extend ring buffer with `mode: "text"`, `turnId`, token usage summary (no secrets); Copy diagnostics includes last text error.

### Concurrency policy

| Scenario | Policy |
|---|---|
| Text turn in flight + new text | Reject or queue one; prefer reject with status “Jarvis is busy.” |
| Text turn in flight + voice speech | Allow voice barge-in on Realtime only if text lock not holding tools that mutate shared state; **safer v1:** pause text acceptance while Realtime `responseInFlight` / toolRunning, and pause new Realtime `response.create` from text while text lock held |
| Voice connect during text | Allowed; do not attach text to Realtime |
| Duplicate responses | Single `sessionLock`: `idle \| text \| voice-response`; only one owner creates assistant output/tools at a time |

### Conversation history across modes

- Maintain a **session transcript** in the renderer (existing live log) as the user-visible history.
- For model context:
  - **Voice:** Realtime conversation items (server-side session).
  - **Text:** Send a bounded recent transcript slice (text-only roles) with each Responses request, or maintain a main-process `textConversationId` store for the app session.
- Document that Realtime server history and text HTTP history are **not automatically identical**; App session log is the UX source of truth. Optional later: sync summaries into memory via tools.

### Cost / usage logging

- Realtime: existing tracing `Jarvis Desktop Companion`.
- Text: separate tracing/workflow or local log lines `[jarvis-text] usage …` with model + token counts.
- Never log API keys, full memory secrets, or raw HTML bodies (Phase 9 rules).

### Non-goals / constraints

- No mic activation for text-only.
- No Realtime WebRTC / client_secret for text-only.
- No new dependency unless Responses streaming client truly needs one (prefer `fetch`).
- Preserve Phase 8 / 8B / 9 / 9B / branding behavior.

---

## 6. Smallest corrective file scope

| File | Role |
|---|---|
| `electron/text-session.cjs` (new) | Responses turn loop, timeout/cancel, usage log |
| `electron/main.cjs` | IPC `text:run` / `text:cancel`; shared instructions helper extracted from token mint |
| `electron/preload.cjs` | Narrow `runTextTurn` / `cancelTextTurn` |
| `src/vite-env.d.ts` | Types for text IPC |
| `src/lib/textClient.ts` (new) | Renderer state machine, lock coordination hooks |
| `src/App.tsx` | Route keyboard submit to text path; text states in status strip; cancel control |
| `src/lib/realtime.ts` | Optional: remove or stop using typed DC inject when text path owns keyboard (keep voice interrupt logic) |
| `src/lib/realtimeErrors.ts` / diagnostics | Extend codes/events for text mode |
| `electron/text-mode.test.cjs` (new) | Focused Phase 11 tests |
| Update `electron/text-prompt-submit.test.cjs` | Expect disconnected text **allowed** via new planner |

Out of scope: VAD/model/voice changes, broad Ricky symbol renames, memory schema changes, new npm deps unless justified.

---

## 7. Precise implementation sequence

1. Extract shared `buildSessionInstructions()` used by Realtime mint and text turns.
2. Implement main `text-session` Responses + tool loop with cancel/timeout/usage.
3. Expose narrow preload IPC + types.
4. Add renderer `textClient` state machine + App wiring; **allow submit while disconnected**.
5. Add session lock so text and voice response/tool ownership do not overlap.
6. Stop routing keyboard through Realtime `sendText` (or gate it off) once text path is primary.
7. Extend Phase 9 diagnostics for text events; keep sanitization.
8. Tests + typecheck/build; manual validation.

---

## 8. Test plan

1. Disconnected typed submit succeeds without `getUserMedia`, peer connection, or `realtime:create-token`.
2. Connected typed submit uses text IPC (not data channel) under recommended policy.
3. Tool call (e.g. `show_menu` / `artifact_show`) returns artifact; confirmation-required tools still gate.
4. Memory context present in text instructions builder (unit).
5. Cancel aborts in-flight text turn; no duplicate completion.
6. Timeout surfaces readable error; resources/locks released.
7. Concurrent text+text rejected; text vs voice lock prevents double tool execution.
8. Phase 8 / 8B / 9 / 9B / branding suites still pass.
9. Usage log distinguishes text vs Realtime.
10. Update former “Connect voice first” tests to new expected behavior.

---

## 9. Manual validation plan

1. Cold start → type without Connect → Jarvis replies; no mic prompt; no WebRTC in DevTools.
2. Connect voice → speak → interrupt still works → type a request → text path answers without breaking audio session.
3. Run a memory and a menu tool from text; confirm artifacts and confirmations.
4. Cancel a long text turn; confirm UI returns to idle.
5. Force API error; readable message + Copy diagnostics includes text turn fields, no secrets.
6. Compare OpenAI usage: typing does not create Realtime calls.

---

## 10. Cost and privacy implications

| Topic | Implication |
|---|---|
| Cost | Text turns bill Responses/text tokens only; avoids Realtime session cost for typing |
| Privacy | Key remains in main; per-turn memory injection must still omit secrets unless `confirmed` tools |
| Logging | Separate text usage logs; apply Phase 9 sanitization |
| Data retention | Session transcript still local/renderer; durable memory only via explicit memory tools |

---

## 11. Risks and rollback

| Risk | Mitigation / rollback |
|---|---|
| Responses API tool schema mismatch vs Realtime tools | Share one `toolSpecs` normalizer; integration test |
| Lock too aggressive (blocks voice) | Tune lock to response/tool phases only |
| History weaker on text | Pass recent transcript slice; document limits |
| Regress “Connect voice first” UX expectation | Ship explicit status “Sending…” / text states |
| Rollback | Feature-flag text path; restore App gate + `sendText` DC path |

---

## 12. Summary verdict

Today, typed input is **not** independent: it is a Realtime data-channel inject gated on an active WebRTC voice session. Phase 11 should add a **main-process Responses API text path** with shared instructions, memory, tools, artifacts, and Phase 9 diagnostics, a clear session lock against voice races, and keyboard submit that works while disconnected—without mic or Realtime for text-only turns.

**Stop.** Ready for implementation approval.
