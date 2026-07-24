# Phase 9 diagnostics, readable errors, and recovery audit

**Phase 9 scope report (read-only).** No edits, commits, or pushes.

---

## 1. Confirmed current behavior

### Visible connection / status surfaces

| Signal | Where | Notes |
|---|---|---|
| `RickyConnectionState` | `idle \| connecting \| connected \| error` | Set in `RickyRealtimeClient`; App only treats `connected` vs not for the mic button |
| `RickyMood` | face CSS (`face-error`, etc.) | Includes listening/thinking/speaking/working/error |
| `status` string | `App.tsx` `<small role="status">` | **Only when keyboard input is open** (`showTypeInput`) |
| Live log | optional History panel | `onStatus` / transcripts append system lines |

Status strings today include: `"Idle"`, `"Minting a Realtime client secret."`, `"Ricky is live…"`, `"Disconnected"`, `"Connect voice first."`, plus raw `Error.message` on connect failure and Realtime `error` events.

### Error-path matrix (as implemented)

| Failure | What happens | Raw body/HTML to UI? | Resources released? |
|---|---|---|---|
| **429 / quota / rate limit** (token or SDP) | Thrown as ``Realtime token request failed: ${status} ${text}`` or ``Realtime WebRTC call failed: ${status} ${text}`` → `onStatus(full message)` | **Yes** — full `response.text()` | Connect `catch` → `disconnect()` → `releaseAllResources` |
| **500/502/503/504** | Same pattern | **Yes** if body is HTML | Same |
| **Malformed HTML / non-JSON** on token | `response.json()` throws → stringified exception to status | Partial / opaque; HTML path if `!ok` uses `.text()` | Same |
| **Mic permission denial** | `getUserMedia` reject → message to status | Browser message only | Same |
| **Missing/invalid API key** | Main throws `"OPENAI_API_KEY is missing…"` or API error body via token path | Missing key is clean; invalid key may include API body | Same |
| **WebRTC / SDP failure** | Status + error/mood then disconnect | Status + body text | Same |
| **Data-channel close mid-session** | **No listener** | Silent until user notices | **Not cleaned until manual disconnect** |
| **Network loss mid-session** | **No `connectionstatechange` / ICE handlers** | Silent | **Not auto-cleaned** |
| **Failed reconnect** | New `connect()` after prior disconnect; failures same as connect | Same as connect | Phase 8 cleanup on fail |
| **Renderer/main uncaught exceptions** | **No** `unhandledRejection` / crash hooks found in `main.cjs` | N/A | N/A |

### Critical confirmed bug: error state is wiped

On connect failure:

```198:202:src/lib/realtime.ts
    } catch (error) {
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
      this.disconnect();
```

`disconnect()` → `releaseAllResources({ emitIdle: true })` sets **`connectionState` and `mood` back to `idle`**. So the UI does **not** stay in `error`; only the status/transcript line may retain the message (and status is hidden unless type input is open).

### Retry / backoff / timeout / cancel

- **None** for token or SDP fetch (no timeout, no retry, no AbortController).
- Manual “retry” = click Connect again.
- No dedicated dismiss-error control.

### Logging

- Renderer: `console.debug("[jarvis-realtime]", …)` — connect/disconnect, barge-in, response ids on some events, resource counts on connect/disconnect.
- **No** structured log store, **no** connection ID, **no** explicit ISO timestamps in the log payload, **no** HTTP error-code taxonomy, **no** copyable diagnostic artifact.
- Main: token failures throw; no diagnostic ring buffer; no process-level error telemetry hooks found.

### Copy diagnostic

**None.**

---

## 2. Gaps and failure modes

1. Raw API/HTML bodies can surface in status + live log.
2. `error` connection state is not durable (cleared by `disconnect`).
3. Mid-session DC/PC failure is silent.
4. No readable categories (quota vs network vs mic vs config).
5. No bounded auto-retry for transient 429/5xx/network.
6. No always-visible error banner / Retry / Dismiss.
7. No copyable diagnostics.
8. Status UI gated behind keyboard mode.
9. Server `error` events set mood/status but do not force cleanup or reconnect UX.
10. Event-handler failures only `console.debug` (near-silent).

---

## 3. Smallest corrective file scope

| File | Role |
|---|---|
| `src/lib/realtimeErrors.ts` (new) | Classify errors; user messages; retryability |
| `src/lib/realtimeDiagnostics.ts` (new) | Ring buffer + copyable report builder |
| `src/lib/realtime.ts` | Map failures; preserve `error` state option; PC/DC watchers; safe cleanup; optional bounded retry |
| `src/App.tsx` | Always-visible state/error strip; Retry / Dismiss / Copy diagnostics |
| `electron/main.cjs` | Sanitize token errors (status + short code, no raw HTML body in thrown message); optional structured log line |
| `electron/*.test.cjs` | Classifier + sanitizer + retry-policy tests |

Out of scope for Phase 9 unless needed: branding rename, VAD/model/voice, memory tools, computer-use.

---

## 4. Proposed error taxonomy

| Category | Examples | User message (example) | Retryable |
|---|---|---|---|
| `config.missing_api_key` | No `OPENAI_API_KEY` | Add your OpenAI API key in `.env.local`, then try again. | No |
| `config.invalid_api_key` | 401 | OpenAI rejected the API key. Check `.env.local`. | No |
| `quota.exhausted` | 429 insufficient_quota | OpenAI quota is exhausted. Check billing/limits. | No |
| `rate_limited` | 429 rate limit | OpenAI is rate-limiting requests. Wait, then retry. | Yes |
| `server.unavailable` | 500/502/503/504 | OpenAI is temporarily unavailable. | Yes |
| `api.bad_response` | HTML/non-JSON body | OpenAI returned an unreadable response. | Yes |
| `mic.permission_denied` | NotAllowedError | Microphone access was denied. Allow mic, then retry. | No* |
| `mic.unavailable` | NotFoundError | No microphone was found. | No |
| `webrtc.connect_failed` | SDP/PC failure | Could not start the voice connection. | Yes |
| `webrtc.disconnected` | PC/DC closed unexpectedly | Voice connection dropped. | Yes |
| `network.offline` | fetch failed / offline | Network connection looks down. | Yes |
| `session.error` | Realtime `error` event | Jarvis hit a session error. | Case-by-case |
| `unknown` | fallback | Something went wrong connecting Jarvis. | Yes |

\*Manual retry after user fixes OS permission.

Sanitization rule: never put raw HTML or full response bodies in UI; keep truncated body hash/snippet only in local diagnostics.

---

## 5. Canonical UI states and transitions

**States:** `disconnected` · `connecting` · `listening` · `thinking` · `speaking` · `reconnecting` · `error`  
(Map today’s `idle`→`disconnected`, keep mood for face; expose a single `sessionUiState` for chrome.)

**Rules (precise):**
- `disconnected` → `connecting` on Connect / Retry.
- `connecting` → listening/thinking/speaking via existing mood once DC open (`connected` internally).
- Any classified failure during connect → **`error`** (do **not** collapse to idle).
- Cleanup always runs on failure **before** settling in `error`.
- Mid-session PC/DC failure → cleanup → `error` or auto-`reconnecting` if retryable.
- `reconnecting` → same success path as connect, or `error` after budget exhausted.
- Dismiss → `disconnected` (clear banner; keep last diagnostic in buffer).
- Manual Retry from `error` → `connecting` / `reconnecting` after cleanup.

---

## 6. Retry policy

| Kind | Policy |
|---|---|
| Non-retryable | No auto-retry; show Fix + Retry (manual) |
| Retryable | Up to **3** attempts; backoff **1s → 2s → 4s** (+ small jitter); abort if user disconnects |
| 429 with `retry-after` | Honor header when present (cap e.g. 30s) |
| Between attempts | Full media/PC/DC/analyser release (Phase 8 `releaseAllResources`) |
| After budget | Stay in `error` with last category + Copy diagnostics |

No infinite reconnect loops.

---

## 7. Logging schema (local, structured)

Ring buffer (~100 events), each entry:

```ts
{
  ts: string;              // ISO
  level: "info" | "warn" | "error";
  event: string;           // e.g. connect.start, token.fail, webrtc.sdp.fail
  connectionId: string;    // uuid per connect attempt
  responseId?: string;
  httpStatus?: number;
  errorCode?: string;      // taxonomy category
  message: string;         // sanitized
  resourceCounts?: object;
}
```

Copyable artifact: last N events + app version/branch if available + OS + last error category — **no API keys, no full HTML bodies**.

---

## 8. Validation plan

1. Missing API key → readable config error; no stack/HTML; state stays `error`; resources empty.
2. Force 429 quota vs rate limit → correct category; quota non-retryable; rate limit retries with backoff.
3. Inject HTML 502 body → UI shows sanitized server.unavailable; diagnostics note non-JSON/HTML.
4. Deny mic → mic.permission_denied; Retry does not loop forever.
5. Kill network mid-call → webrtc.disconnected / network; cleanup; optional reconnect.
6. Close DC in DevTools → detected, not silent.
7. Copy diagnostics → clipboard contains schema fields, no secrets.
8. Happy path still connects; interruption (8B) unaffected.
9. Unit tests for classifier + sanitizer + retry budget.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Auto-retry burns quota on hard 429 | Separate quota vs rate_limit |
| Keeping `error` vs old idle assumptions | Update App button enablement carefully |
| Over-verbose banners | One line + optional details/copy |
| False reconnect loops | Hard cap + manual disconnect cancels |
| Logging PII | Sanitize; never log tokens/keys |

---

## 10. Exact files / functions (current)

| Location | Functions / handlers |
|---|---|
| `src/lib/realtime.ts` | `connect`, `disconnect`, `releaseAllResources`, `enqueueServerEvent`, `handleServerEvent` (`error`), `log` |
| `src/App.tsx` | `connect`, `disconnect`, `status` render, mic button |
| `electron/main.cjs` | `realtime:create-token` |
| `electron/preload.cjs` | `createRealtimeToken` IPC bridge |

---

**Stop.** Ready for approval before any Phase 9 implementation.
