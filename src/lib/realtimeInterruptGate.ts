/**
 * Pure interruption / response-id gating for Realtime barge-in.
 * Used by RickyRealtimeClient and focused Node tests.
 */

export type ResponseScopedEventType =
  | "response.created"
  | "response.audio.delta"
  | "response.output_audio.delta"
  | "response.audio.done"
  | "response.output_audio.done"
  | "response.audio_transcript.delta"
  | "response.output_audio_transcript.delta"
  | "response.output_text.delta"
  | "response.done"
  | "response.cancelled"
  | "response.canceled"
  | string;

export function extractResponseId(event: {
  response_id?: unknown;
  responseId?: unknown;
  response?: { id?: unknown } | null;
}): string | null {
  if (typeof event.response_id === "string" && event.response_id) return event.response_id;
  if (typeof event.responseId === "string" && event.responseId) return event.responseId;
  if (event.response && typeof event.response.id === "string" && event.response.id) return event.response.id;
  return null;
}

export function isSupersededResponseId(
  responseId: string | null,
  supersededIds: Iterable<string>,
): boolean {
  if (!responseId) return false;
  const set = supersededIds instanceof Set ? supersededIds : new Set(supersededIds);
  return set.has(responseId);
}

/**
 * Whether a response-scoped event should be applied to live UI/state.
 * - response.created always accepted (establishes the replacement id).
 * - Events for superseded ids are ignored.
 * - When an active id is set, events for a different non-null id are ignored.
 */
export function shouldAcceptResponseScopedEvent(args: {
  eventType: string;
  responseId: string | null;
  activeResponseId: string | null;
  supersededIds: Iterable<string>;
}): boolean {
  const { eventType, responseId, activeResponseId, supersededIds } = args;
  if (eventType === "response.created") return true;
  if (isSupersededResponseId(responseId, supersededIds)) return false;
  if (activeResponseId && responseId && responseId !== activeResponseId) return false;
  return true;
}

export function planBargeIn(args: {
  activeResponseId: string | null;
  responseAudioStarted: boolean;
  responseInFlight: boolean;
}): {
  shouldInvalidate: boolean;
  supersededId: string | null;
  clearAssistantText: boolean;
  clearAudioStarted: boolean;
  clearInFlight: boolean;
  flushPlayback: boolean;
} {
  const shouldInvalidate =
    Boolean(args.activeResponseId) || args.responseAudioStarted || args.responseInFlight;
  return {
    shouldInvalidate,
    supersededId: args.activeResponseId,
    clearAssistantText: shouldInvalidate,
    clearAudioStarted: shouldInvalidate,
    clearInFlight: shouldInvalidate,
    flushPlayback: shouldInvalidate,
  };
}

export function canClientCreateResponse(responseInFlight: boolean): boolean {
  return !responseInFlight;
}

export function afterResponseCreated(responseId: string | null): {
  activeResponseId: string | null;
  responseInFlight: boolean;
} {
  return {
    activeResponseId: responseId,
    responseInFlight: true,
  };
}

export function afterActiveResponseFinished(args: {
  responseId: string | null;
  activeResponseId: string | null;
}): {
  clearActive: boolean;
  clearInFlight: boolean;
} {
  if (!args.responseId || args.responseId === args.activeResponseId) {
    return { clearActive: true, clearInFlight: true };
  }
  return { clearActive: false, clearInFlight: false };
}
