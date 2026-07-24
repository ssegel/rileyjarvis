export type RealtimeErrorCode =
  | "config.missing_api_key"
  | "config.invalid_api_key"
  | "quota.exhausted"
  | "rate_limited"
  | "server.unavailable"
  | "api.bad_response"
  | "mic.permission_denied"
  | "mic.unavailable"
  | "webrtc.connect_failed"
  | "webrtc.disconnected"
  | "network.offline"
  | "session.error"
  | "unknown";

export type ClassifiedRealtimeError = {
  code: RealtimeErrorCode;
  userMessage: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
};

export type SanitizedTokenErrorPayload = {
  code: RealtimeErrorCode;
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  bodyHash?: string;
};

const USER_MESSAGES: Record<RealtimeErrorCode, string> = {
  "config.missing_api_key": "Add your OpenAI API key in `.env.local`, then try again.",
  "config.invalid_api_key": "OpenAI rejected the API key. Check `.env.local`.",
  "quota.exhausted": "OpenAI quota is exhausted. Check billing/limits.",
  rate_limited: "OpenAI is rate-limiting requests. Wait, then retry.",
  "server.unavailable": "OpenAI is temporarily unavailable.",
  "api.bad_response": "OpenAI returned an unreadable response.",
  "mic.permission_denied": "Microphone access was denied. Allow mic, then retry.",
  "mic.unavailable": "No microphone was found.",
  "webrtc.connect_failed": "Could not start the voice connection.",
  "webrtc.disconnected": "Voice connection dropped.",
  "network.offline": "Network connection looks down.",
  "session.error": "Jarvis hit a session error.",
  unknown: "Something went wrong connecting Jarvis.",
};

const NON_RETRYABLE = new Set<RealtimeErrorCode>([
  "config.missing_api_key",
  "config.invalid_api_key",
  "quota.exhausted",
  "mic.permission_denied",
  "mic.unavailable",
]);

export const MAX_CONNECT_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;
export const RETRY_AFTER_CAP_MS = 30_000;
export const RETRY_JITTER_MS = 250;

export function userMessageForCode(code: RealtimeErrorCode): string {
  return USER_MESSAGES[code];
}

export function isRetryableCode(code: RealtimeErrorCode): boolean {
  return !NON_RETRYABLE.has(code);
}

export function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim().slice(0, 200).toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<head") ||
    trimmed.includes("<body")
  );
}

export function sanitizeDiagnosticText(raw: string, maxLength = 160): string {
  let text = String(raw || "");
  text = text.replace(/(sk-[a-zA-Z0-9_-]{10,})/g, "[redacted-key]");
  text = text.replace(/(ek_[a-zA-Z0-9_-]{10,})/g, "[redacted-token]");
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted-token]");
  text = text.replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]");
  text = text.replace(/(password["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]");
  text = text.replace(/JARVIS_TOKEN_ERROR:[^\n]*/g, "JARVIS_TOKEN_ERROR:[redacted]");
  if (looksLikeHtml(text)) {
    return "[html-omitted]";
  }
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}…`;
  }
  return text;
}

export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.round(asSeconds * 1000), RETRY_AFTER_CAP_MS);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), RETRY_AFTER_CAP_MS);
  }
  return undefined;
}

export function classifyHttpFailure(options: {
  httpStatus: number;
  bodyText?: string;
  retryAfterHeader?: string | null;
}): ClassifiedRealtimeError {
  const { httpStatus, bodyText = "", retryAfterHeader } = options;
  const lower = bodyText.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);

  if (httpStatus === 401 || httpStatus === 403) {
    return buildError("config.invalid_api_key", { httpStatus });
  }

  if (httpStatus === 429) {
    if (
      lower.includes("insufficient_quota") ||
      lower.includes("quota") ||
      lower.includes("billing") ||
      lower.includes("exceeded your current quota")
    ) {
      return buildError("quota.exhausted", { httpStatus });
    }
    return buildError("rate_limited", { httpStatus, retryAfterMs });
  }

  if ([500, 502, 503, 504].includes(httpStatus)) {
    return buildError("server.unavailable", { httpStatus, retryAfterMs });
  }

  if (looksLikeHtml(bodyText) || bodyLooksNonJson(bodyText)) {
    return buildError("api.bad_response", { httpStatus, retryAfterMs });
  }

  return buildError("unknown", { httpStatus, retryAfterMs });
}

export function classifyThrownValue(error: unknown): ClassifiedRealtimeError {
  const tokenPayload = extractTokenErrorPayload(error);
  if (tokenPayload) {
    return buildError(tokenPayload.code, {
      httpStatus: tokenPayload.httpStatus,
      retryAfterMs: tokenPayload.retryAfterMs,
      userMessage: tokenPayload.message,
    });
  }

  if (typeof error === "object" && error && "code" in error) {
    const code = String((error as { code?: string }).code || "");
    if (isRealtimeErrorCode(code)) {
      return buildError(code, {
        httpStatus: numberOrUndefined((error as { httpStatus?: unknown }).httpStatus),
        retryAfterMs: numberOrUndefined((error as { retryAfterMs?: unknown }).retryAfterMs),
      });
    }
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();

  if (name === "NotAllowedError" || lower.includes("permission denied") || lower.includes("notallowederror")) {
    return buildError("mic.permission_denied");
  }
  if (name === "NotFoundError" || lower.includes("requested device not found") || lower.includes("notfounderror")) {
    return buildError("mic.unavailable");
  }

  if (
    lower.includes("openai_api_key is missing") ||
    lower.includes("missing api key") ||
    lower.includes("config.missing_api_key")
  ) {
    return buildError("config.missing_api_key");
  }

  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("network request failed")) {
    return buildError("network.offline");
  }

  if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) {
    return buildError("network.offline");
  }

  if (lower.includes("webrtc") || lower.includes("sdp") || lower.includes("peerconnection")) {
    return buildError("webrtc.connect_failed");
  }

  if (lower.includes("data channel") || lower.includes("connection dropped") || lower.includes("ice failed")) {
    return buildError("webrtc.disconnected");
  }

  const statusMatch = message.match(/\b(401|403|429|500|502|503|504)\b/);
  if (statusMatch) {
    return classifyHttpFailure({ httpStatus: Number(statusMatch[1]), bodyText: message });
  }

  if (looksLikeHtml(message) || lower.includes("unexpected token") || lower.includes("is not valid json")) {
    return buildError("api.bad_response");
  }

  return buildError("unknown");
}

export function classifySessionError(message?: string): ClassifiedRealtimeError {
  const text = message || "";
  const lower = text.toLowerCase();
  if (lower.includes("insufficient_quota") || (lower.includes("quota") && lower.includes("exceed"))) {
    return buildError("quota.exhausted");
  }
  if (lower.includes("rate_limit") || lower.includes("rate limit")) {
    return buildError("rate_limited");
  }
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("invalid_api_key")) {
    return buildError("config.invalid_api_key");
  }
  return buildError("session.error");
}

export function computeRetryDelayMs(attemptIndex: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const base = RETRY_BACKOFF_MS[Math.min(attemptIndex, RETRY_BACKOFF_MS.length - 1)] ?? 4000;
  const jitter = Math.floor(Math.random() * (RETRY_JITTER_MS + 1));
  return base + jitter;
}

export function buildError(
  code: RealtimeErrorCode,
  options: {
    httpStatus?: number;
    retryAfterMs?: number;
    userMessage?: string;
  } = {},
): ClassifiedRealtimeError {
  return {
    code,
    userMessage: sanitizeDiagnosticText(options.userMessage || userMessageForCode(code), 200),
    retryable: isRetryableCode(code),
    httpStatus: options.httpStatus,
    retryAfterMs: options.retryAfterMs,
  };
}

export function encodeTokenErrorPayload(payload: SanitizedTokenErrorPayload): string {
  return `JARVIS_TOKEN_ERROR:${JSON.stringify(payload)}`;
}

export function extractTokenErrorPayload(error: unknown): SanitizedTokenErrorPayload | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const prefix = "JARVIS_TOKEN_ERROR:";
  if (!message.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as SanitizedTokenErrorPayload;
    if (!parsed || !isRealtimeErrorCode(parsed.code) || typeof parsed.message !== "string") return null;
    return {
      code: parsed.code,
      message: sanitizeDiagnosticText(parsed.message, 200),
      httpStatus: numberOrUndefined(parsed.httpStatus),
      retryAfterMs: numberOrUndefined(parsed.retryAfterMs),
      bodyHash: typeof parsed.bodyHash === "string" ? parsed.bodyHash : undefined,
    };
  } catch {
    return null;
  }
}

export function isRealtimeErrorCode(value: string): value is RealtimeErrorCode {
  return value in USER_MESSAGES;
}

function bodyLooksNonJson(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
