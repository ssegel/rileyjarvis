# Realtime voice stabilization audit

**Date:** 2026-07-23  
**Branch context:** repository `main` / current workspace at time of audit  
**Scope:** Read-only inspection of Jarvis OpenAI Realtime WebRTC voice path  
**Application code modified:** none  

---

## 1. Confirmed findings vs hypotheses

### Confirmed from repository code

| Finding | Evidence |
|---|---|
| Mic uses only three boolean constraints; no deviceId, channelCount, or sampleRate | `src/lib/realtime.ts` `getUserMedia` |
| Remote playback is a single detached `<audio autoplay>` created per `connect()` | `RickyRealtimeClient.connect` |
| That audio element is not stored on the client and is not cleaned in `disconnect()` | `connect` / `disconnect` |
| Mouth meter opens a second consumer on the **same** remote `MediaStream` via `AudioContext.createMediaStreamSource` | `startOutputMeter` |
| Session uses `semantic_vad` with `create_response: true` and `interrupt_response: true` | `electron/main.cjs` `realtime:create-token` |
| Model `gpt-realtime-2`, voice `cedar`, `output_modalities: ["audio"]`; no explicit PCM/format fields | same handler |
| Client never mutes, disables, or ducks the mic while assistant audio plays | no `track.enabled` / session update on speech events |
| Client never sends `response.cancel` | no matches in `realtime.ts` |
| `response.create` is sent from typed text and from tool completion; VAD also auto-creates responses | `sendText`, `executeFunctionCalls`, session `create_response` |
| `disconnect` closes DC/PC, stops mic tracks, stops meter; does not clear remote audio element | `disconnect` |
| Reconnect path in UI creates a **new** `RickyRealtimeClient` and replaces `clientRef` | `src/App.tsx` `connect` |
| Almost no diagnostic logging for event timelines, response ids, or track/audio-element counts | `realtime.ts` / `main.cjs` |

### Hypotheses (plausible, not proven in-repo)

| Hypothesis | Why it fits | How to confirm |
|---|---|---|
| Speaker echo is interpreted as user speech and interrupts Jarvis | Mic stays live + `interrupt_response: true` | Headphones A/B; log `speech_started` while speaking |
| Dual MediaStream consumers cause stutter on Electron/Chromium | HTML audio + `createMediaStreamSource` on same stream | Switch meter to `createMediaElementSource` or cloned track |
| Orphan `<audio>` after reconnect causes overlapping/repeated playback | Element not retained or torn down | Reconnect and count live `HTMLAudioElement` with `srcObject` |
| Stacked `response.create` after tools overlaps VAD speech | Multiple create paths, no in-flight guard | Log response ids around tool `response.create` |
| Long pauses partly from large instructions + `reasoning.effort: "low"` | Token payload includes full personal context | Compare latency with minimal instructions |

---

## 2. Microphone capture (exact)

**File / function:** `src/lib/realtime.ts` → `RickyRealtimeClient.connect`

```ts
this.micStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});
pc.addTrack(this.micStream.getAudioTracks()[0], this.micStream);
```

| Constraint / option | Value in repo |
|---|---|
| `echoCancellation` | `true` |
| `noiseSuppression` | `true` |
| `autoGainControl` | `true` |
| Device selection (`deviceId`) | **not set** (browser/OS default input) |
| `channelCount` | **not set** |
| `sampleRate` | **not set** |
| `latency` / `goog*` extras | **not set** |
| Video | not requested |

Only the first audio track is added to the peer connection.

---

## 3. WebRTC peer-connection lifecycle (exact)

**File / class:** `src/lib/realtime.ts` → `RickyRealtimeClient`

### Creation

1. Guard: `if (this.pc) return;` (same instance will not create a second PC).
2. `onConnectionState("connecting")`, mood `thinking`.
3. Fetch tool specs + ephemeral token via `window.ricky.createRealtimeToken()`.
4. `const pc = new RTCPeerConnection()` — default config (no custom ICE servers in code).
5. Create detached `<audio autoplay>`.
6. Assign `pc.ontrack`.
7. `getUserMedia` → `pc.addTrack(micTrack, micStream)`.
8. `pc.createDataChannel("oai-events")` with `open` and `message` listeners.
9. `createOffer` → `setLocalDescription` → POST SDP to `https://api.openai.com/v1/realtime/calls` with Bearer client secret.
10. `setRemoteDescription(answer)`.
11. Assign `this.pc = pc`, `this.dc = dc`.

### Remote audio reception

- `pc.ontrack`: `audio.srcObject = event.streams[0]`; `this.startOutputMeter(event.streams[0])`.
- No `pc.onconnectionstatechange`, `onicecandidate`, or ICE restart handling.

### Disconnect / cleanup

`disconnect()`:

- `this.dc?.close()`
- `this.pc?.close()`
- stop all `micStream` tracks
- `stopOutputMeter()` (cancel rAF, `audioContext.close()`)
- null `dc`, `pc`, `micStream`; clear assistant text buffer
- UI callbacks → idle

**Not done on disconnect:** pause/clear remote `<audio>`, remove `ontrack`/DC listeners explicitly, revoke object URLs (N/A), null a stored audio ref (none exists).

### Reconnect behavior

- **No automatic reconnect** in client or main process.
- UI: mic button calls `disconnect()` when connected, or `connect()` when idle.
- `App.connect()` always `new RickyRealtimeClient(...)`, assigns `clientRef`, then `await client.connect()`.
- Previous client is only cleaned if `disconnect()` ran first. If `connect()` were invoked without disconnect while a prior client still held resources, the prior PC/mic/audio would not be released by the new instance (UI currently disables connect while `connectionState === "connecting"` and uses disconnect when connected).

### Error path

On connect failure: set error state/mood/status, then `disconnect()`.

---

## 4. Remote-audio playback (exact)

| Aspect | Implementation |
|---|---|
| Element count per successful `connect()` | **1** newly created `document.createElement("audio")` |
| Stored on instance? | **No** — local variable closed over by `ontrack` |
| Appended to DOM? | **No** |
| `autoplay` | `true` |
| Explicit `audio.play()` | **No** |
| Volume / mute API | **None** (`volume`, `muted` never set) |
| Playback path | WebRTC remote MediaStream → HTMLAudioElement |
| Analysis path | Same MediaStream → `AudioContext` → `MediaStreamSource` → `AnalyserNode` → rAF mouth shapes |
| Analyser connected to `destination`? | **No** (analyse only) |
| Cleanup | Meter stopped; **audio element not paused / srcObject not cleared** |

---

## 5. OpenAI Realtime session configuration (exact)

**File / handler:** `electron/main.cjs` → `ipcMain.handle("realtime:create-token")`  
**Preload:** `electron/preload.cjs` → `createRealtimeToken`

| Setting | Value |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/realtime/client_secrets` |
| Session type | `"realtime"` |
| Model | `"gpt-realtime-2"` |
| Instructions | `RICKY_INSTRUCTIONS` + personal memory context + thumbnail board instructions |
| `output_modalities` | `["audio"]` |
| `reasoning` | `{ effort: "low" }` |
| `tool_choice` | `"auto"` |
| `tools` | full `toolSpecs` |
| Input turn detection | `type: "semantic_vad"` |
| VAD eagerness | `"medium"` |
| `create_response` | `true` (server auto-starts responses on end of user turn) |
| `interrupt_response` | `true` (user speech can cancel in-progress assistant response) |
| Output voice | `"cedar"` |
| Explicit input/output audio formats (e.g. pcm16) | **not set** in session body (WebRTC media path) |
| Client `response.cancel` | **not implemented** |
| Tracing | `workflow_name: "Ricky Desktop Companion"` |

---

## 6. Event / speech / response handlers (exact)

All in `RickyRealtimeClient.handleServerEvent` unless noted.

| Event / action | Handler behavior |
|---|---|
| `error` | mood `error`; status message |
| `input_audio_buffer.speech_started` | mood `listening` only — **no mic duck, no local playback stop, no `response.cancel`** |
| `input_audio_buffer.speech_stopped` | mood `thinking` |
| `response.audio.delta` / `response.output_audio.delta` | mood `speaking` |
| `response.audio.done` / `response.output_audio.done` | mood `idle` unless `toolRunning` |
| transcript deltas (`response.audio_transcript.delta`, etc.) | append to `currentAssistantText` |
| `conversation.item.input_audio_transcription.completed` | user transcript entry |
| `response.done` | flush assistant transcript; maybe `executeFunctionCalls` |
| Typed send | `conversation.item.create` + **`response.create`** (`sendText`) |
| After tools | optional **`response.create`** (`executeFunctionCalls`) |
| Interruption (client) | **none** beyond server `interrupt_response` |
| Cancellation (client) | **none** |
| Disconnect | `App.disconnect` → `client.disconnect` |
| Reconnect | new client + full `connect()` after prior disconnect |

`dc.onmessage` invokes `void this.handleServerEvent(...)` (async, not serialized).

---

## 7. Answers to required behavioral questions

### Does assistant playback stop or duck when Sarah begins speaking?

**Confirmed:** The app does **not** stop or duck local speaker playback on `speech_started`.  
**Server-side:** With `interrupt_response: true`, OpenAI may cancel the assistant **response** (and thus remote audio track content) when it detects user speech. That is server interrupt, not client-side ducking of the `<audio>` element.

### Can the app interpret its own speaker playback as user speech?

**Confirmed mechanism exists:** Mic remains enabled for the full call; AEC is requested but not verified; VAD has `interrupt_response: true`.  
**Hypothesis:** Acoustic echo from speakers can be treated as user speech → self-interrupt / cutoffs / stutter-restarts. Not proven without runtime A/B (headphones vs speakers).

### Can duplicate PC / tracks / audio elements / listeners survive reconnects?

| Resource | Same client instance | UI reconnect (new client after disconnect) |
|---|---|---|
| `RTCPeerConnection` | Guarded by `if (this.pc) return` | Prior PC closed if `disconnect()` ran |
| Mic tracks | Stopped on disconnect | New `getUserMedia` on next connect |
| DataChannel listeners | On closed channel | New DC on new connect |
| Remote `<audio>` | **Not cleaned** — can survive as orphan GC-only object still playing until GC / track end | **Yes, risk of overlap** if old element keeps `srcObject` briefly or longer |
| `AudioContext` meter | Closed on disconnect | New context on next `ontrack` |
| `App` clientRef | Replaced on each `connect()` without calling disconnect on previous if skipped | Unsafe if connect without disconnect |

---

## 8. Ranked root causes (stabilization)

1. **Echo + `interrupt_response: true` with always-hot mic** — cutoffs, self-interrupt, stutter/restart (hypothesis with strong code support).  
2. **Same remote stream consumed by HTMLAudioElement and `createMediaStreamSource`** — glitchy/stuttery playback (hypothesis with strong code support).  
3. **Remote audio element not owned/cleaned on disconnect** — overlapping or repeated audio after reconnect (confirmed lifecycle gap).  
4. **Multiple `response.create` paths without in-flight guard / cancel** — overlapping assistant turns after tools or barge-in races (confirmed code paths; overlap severity hypothesis).  
5. **`ontrack` re-entrancy restarting the meter mid-call** — brief glitches (possible).  
6. **Large session instructions + reasoning** — long pauses before speech (possible latency contributor).

---

## 9. Smallest corrective file scope

| File | Role in voice patch |
|---|---|
| `src/lib/realtime.ts` | **Primary** — audio element ownership/cleanup, meter sourcing, optional mic mute while speaking, response in-flight guard |
| `electron/main.cjs` | **Optional one-knob experiment** — e.g. temporarily `interrupt_response: false` or VAD eagerness tweak to validate echo hypothesis |

**Out of scope for voice patch (branding separate):** `src/App.tsx` labels, `RickyFace.tsx`, ArtifactPanel copy, tracing workflow name — unless App must call an explicit `disconnect` before `connect` hardening (only if required).

---

## 10. Precise proposed changes

### A. `src/lib/realtime.ts` (smallest durable fix set)

1. **Own remote audio**  
   - `private remoteAudio: HTMLAudioElement | null`  
   - Create once per connect; assign in `ontrack`  
   - On disconnect: `pause()`, `srcObject = null`, drop reference  

2. **Stabilize analyser**  
   - Prefer `audioContext.createMediaElementSource(this.remoteAudio)` → analyser  
   - Do **not** connect that graph to `destination` if the element already plays  
   - Or clone the remote audio track and analyse the clone only  

3. **Reduce echo barge-in**  
   - On assistant audio start (`response.output_audio.delta` / speaking): set mic track `enabled = false` (or soft-mute)  
   - On `response.output_audio.done` / `response.done` / disconnect: re-enable  
   - Keep deliberate interruption: re-enable mic after a short grace, or use push-to-talk later  

4. **Response create hygiene**  
   - Track `responseInFlight`  
   - Skip or `response.cancel` before a new client `response.create` when one is active  
   - Serialize `handleServerEvent` (message queue) to avoid overlapping tool/`response.done` handling  

### B. `electron/main.cjs` (diagnostic / optional)

- A/B: set `interrupt_response: false` once to confirm echo hypothesis, then restore with client mic-mute if confirmed.  
- Do not change model/voice in the first patch unless needed.

### C. Branding

- Keep Ricky→Jarvis copy changes in a separate change set.

---

## 11. Regression risks

| Change | Risk |
|---|---|
| Mic `enabled = false` while speaking | Harder barge-in; may feel less “interruptible” until re-enabled |
| `createMediaElementSource` | Can throw if called twice on same element; must create AudioContext graph once per element lifecycle |
| `response.cancel` / in-flight guard | Tool follow-up speech might be delayed or skipped if flag stuck true |
| `interrupt_response: false` experiment | User cannot interrupt Jarvis by voice until reverted |
| Stricter disconnect | Must not leave mic permission hung; always `stop()` tracks |

---

## 12. Validation plan

| Scenario | Steps | Pass criteria |
|---|---|---|
| Low-volume speakers | Speak quietly; ask short question | One clean reply; no mid-word cut |
| Normal-volume speakers | Normal desk volume | No self-restart stutter; no doubled voice |
| Deliberate interruption | Talk over Jarvis mid-sentence | Single cancel + one new reply (after patch: intentional only) |
| Silence | 10–15s quiet after reply | No spontaneous new utterance |
| Reconnect | Disconnect → connect → ask again | One audio path; no stacked players; mic works |
| Repeated app restarts | Quit/relaunch Electron 3×; connect each time | Stable connect; no orphan playback from prior session |
| Headphones A/B | Same prompts on headphones vs speakers | If headphones fix glitches pre-patch, echo hypothesis confirmed |

Optional diagnostics during validation: temporary event timeline log (`speech_started` while speaking, `ontrack` count, audio elements with `srcObject`).

---

## 13. Current logging / diagnostics available

- UI status + live log transcript (coarse).  
- No structured Realtime event logger.  
- No WebRTC `connectionstatechange` logging.  
- DevTools Network will not show media frames for the WebRTC audio path; SDP POST to `/v1/realtime/calls` appears once per connect.

---

## 14. Remaining visible Ricky branding (separate work)

| Location | Visible / user-facing text |
|---|---|
| `src/App.tsx` | “Ricky is ready…”, mini-mode Ricky labels, live log role `Ricky` |
| `src/lib/realtime.ts` | “Ricky is live…”, “Ricky is generating an image.” |
| `src/components/RickyFace.tsx` | `aria-label` “Ricky mood…” |
| `electron/main.cjs` | tracing workflow name (not UI) |

---

## 15. Modification map (exact symbols)

| File | Functions / regions |
|---|---|
| `src/lib/realtime.ts` | `connect`, `disconnect`, `ontrack` closure, `startOutputMeter`, `stopOutputMeter`, `handleServerEvent`, `sendText`, `executeFunctionCalls`, `sendEvent` |
| `electron/main.cjs` | `ipcMain.handle("realtime:create-token")` session `audio.input.turn_detection` |
| `src/App.tsx` | Only if hardening `connect` to always `disconnect()` previous client first |

---

## 16. Recommended first patch order

1. Remote audio ownership + disconnect cleanup.  
2. Analyser via media element or cloned track (not dual stream consumer).  
3. Mic disable while assistant audio active (or validated `interrupt_response` experiment).  
4. In-flight `response.create` guard.  
5. Branding PR separately.

---

*End of audit. Application code was not modified for this document.*
