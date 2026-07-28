"use strict";

const crypto = require("node:crypto");

const USER_MESSAGES = {
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

const NON_RETRYABLE = new Set([
  "config.missing_api_key",
  "config.invalid_api_key",
  "quota.exhausted",
  "mic.permission_denied",
  "mic.unavailable",
]);

const RETRY_AFTER_CAP_MS = 30_000;
/** Text cooldown honors Retry-After up to 60s (Realtime connect remains 30s). */
const TEXT_RETRY_AFTER_CAP_MS = 60_000;
const TEXT_COOLDOWN_FALLBACK_MS = Object.freeze([1000, 2000, 4000, 8000]);
const TEXT_REPEATED_429_FLOOR_MS = 30_000;
const TEXT_REPEATED_429_MESSAGE_AFTER = 3;
const TEXT_AUTO_NETWORK_RETRY_DELAY_MS = 750;
/** Sanity bound when parsing Retry-After before policy caps apply. */
const RETRY_AFTER_PARSE_SANITY_MS = 86_400_000;

function userMessageForCode(code) {
  return USER_MESSAGES[code] || USER_MESSAGES.unknown;
}

function isRetryableCode(code) {
  return !NON_RETRYABLE.has(code);
}

/** Manual Retry allowed after cooldown for these text failure codes. */
function isTextManualRetryAllowed(code) {
  if (!code) return false;
  if (
    code === "quota.exhausted" ||
    code === "config.missing_api_key" ||
    code === "config.invalid_api_key"
  ) {
    return false;
  }
  return isRetryableCode(code);
}

/** Countdown UI is never shown for quota or other non-manual-retry codes. */
function showsTextRetryCountdown(code) {
  return isTextManualRetryAllowed(code);
}

/**
 * Text cooldown policy (§3).
 * @param {number} attemptIndex zero-based fallback index for this cooldown chain
 * @param {number|undefined} retryAfterMs parsed Retry-After (may be uncapped)
 * @param {number} [consecutiveRateLimited=0] consecutive user-facing rate_limited count
 */
function computeTextCooldownMs(attemptIndex, retryAfterMs, consecutiveRateLimited = 0) {
  let computed;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    computed = Math.min(retryAfterMs, TEXT_RETRY_AFTER_CAP_MS);
  } else {
    const idx = Math.min(Math.max(0, Number(attemptIndex) || 0), TEXT_COOLDOWN_FALLBACK_MS.length - 1);
    computed = TEXT_COOLDOWN_FALLBACK_MS[idx];
  }
  if (Number(consecutiveRateLimited) >= TEXT_REPEATED_429_MESSAGE_AFTER) {
    computed = Math.max(computed, TEXT_REPEATED_429_FLOOR_MS);
  }
  return computed;
}

function textCooldownUserMessage(code, cooldownMs, consecutiveRateLimited = 0) {
  const base = userMessageForCode(code);
  if (!showsTextRetryCountdown(code)) {
    return base;
  }
  const seconds = Math.max(1, Math.ceil(Number(cooldownMs || 0) / 1000));
  let message = `${base} You can retry in ${seconds}s.`;
  if (code === "rate_limited" && Number(consecutiveRateLimited) >= TEXT_REPEATED_429_MESSAGE_AFTER) {
    message = `${base} Wait longer / try later. You can retry in ${seconds}s.`;
  }
  return message;
}

function formatRetryAvailableAt(cooldownUntilMs, nowMs = Date.now()) {
  const until = Number(cooldownUntilMs);
  if (!Number.isFinite(until) || until <= nowMs) return null;
  try {
    return new Date(until).toLocaleTimeString();
  } catch {
    return null;
  }
}

function looksLikeHtml(text) {
  const trimmed = String(text || "")
    .trim()
    .slice(0, 200)
    .toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<head") ||
    trimmed.includes("<body")
  );
}

function sanitizeDiagnosticText(raw, maxLength = 160) {
  let text = String(raw || "");
  text = text.replace(/(sk-[a-zA-Z0-9_-]{10,})/g, "[redacted-key]");
  text = text.replace(/(ek_[a-zA-Z0-9_-]{10,})/g, "[redacted-token]");
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted-token]");
  text = text.replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]");
  text = text.replace(/(password["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]");
  text = text.replace(/JARVIS_TOKEN_ERROR:[^\n]*/g, "JARVIS_TOKEN_ERROR:[redacted]");
  if (looksLikeHtml(text)) return "[html-omitted]";
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) return `${text.slice(0, maxLength)}…`;
  return text;
}

/**
 * Parse Retry-After. Optional capMs defaults to Realtime 30s for backward compatibility.
 * Pass null/undefined explicitly via options for uncapped (sanity-bounded) parse used by classification.
 */
function parseRetryAfterMs(headerValue, capMs = RETRY_AFTER_CAP_MS) {
  if (!headerValue) return undefined;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return undefined;
  let ms;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    ms = Math.round(asSeconds * 1000);
  } else {
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
      ms = Math.max(0, asDate - Date.now());
    } else {
      return undefined;
    }
  }
  ms = Math.min(ms, RETRY_AFTER_PARSE_SANITY_MS);
  if (capMs == null || !Number.isFinite(capMs)) return ms;
  return Math.min(ms, capMs);
}

function bodyHash(bodyText) {
  return crypto.createHash("sha256").update(String(bodyText || "")).digest("hex").slice(0, 12);
}

function bodyLooksNonJson(bodyText) {
  const trimmed = String(bodyText || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}

function buildError(code, options = {}) {
  return {
    code,
    userMessage: sanitizeDiagnosticText(options.userMessage || userMessageForCode(code), 200),
    retryable: isRetryableCode(code),
    httpStatus: options.httpStatus,
    retryAfterMs: options.retryAfterMs,
    bodyHash: options.bodyHash,
  };
}

function classifyHttpFailure(options) {
  const httpStatus = Number(options.httpStatus);
  const bodyText = String(options.bodyText || "");
  const lower = bodyText.toLowerCase();
  // Store uncapped (sanity-bounded) Retry-After; Realtime/text policies apply their own caps.
  const retryAfterMs = parseRetryAfterMs(options.retryAfterHeader, null);
  const hash = bodyHash(bodyText);

  if (httpStatus === 401 || httpStatus === 403) {
    return buildError("config.invalid_api_key", { httpStatus, bodyHash: hash });
  }

  if (httpStatus === 429) {
    if (
      lower.includes("insufficient_quota") ||
      lower.includes("quota") ||
      lower.includes("billing") ||
      lower.includes("exceeded your current quota")
    ) {
      return buildError("quota.exhausted", { httpStatus, bodyHash: hash });
    }
    return buildError("rate_limited", { httpStatus, retryAfterMs, bodyHash: hash });
  }

  if ([500, 502, 503, 504].includes(httpStatus)) {
    return buildError("server.unavailable", { httpStatus, retryAfterMs, bodyHash: hash });
  }

  if (looksLikeHtml(bodyText) || bodyLooksNonJson(bodyText)) {
    return buildError("api.bad_response", { httpStatus, retryAfterMs, bodyHash: hash });
  }

  return buildError("unknown", { httpStatus, retryAfterMs, bodyHash: hash });
}

function encodeTokenErrorPayload(classified) {
  return `JARVIS_TOKEN_ERROR:${JSON.stringify({
    code: classified.code,
    message: classified.userMessage,
    httpStatus: classified.httpStatus,
    retryAfterMs: classified.retryAfterMs,
    bodyHash: classified.bodyHash,
  })}`;
}

function createTokenError(classified) {
  const error = new Error(encodeTokenErrorPayload(classified));
  error.code = classified.code;
  error.httpStatus = classified.httpStatus;
  error.retryAfterMs = classified.retryAfterMs;
  return error;
}

function missingApiKeyError() {
  return createTokenError(buildError("config.missing_api_key"));
}

function badTokenResponseError(reason) {
  return createTokenError(
    buildError("api.bad_response", {
      userMessage: userMessageForCode("api.bad_response"),
      bodyHash: bodyHash(reason || ""),
    }),
  );
}

module.exports = {
  USER_MESSAGES,
  RETRY_AFTER_CAP_MS,
  TEXT_RETRY_AFTER_CAP_MS,
  TEXT_COOLDOWN_FALLBACK_MS,
  TEXT_REPEATED_429_FLOOR_MS,
  TEXT_REPEATED_429_MESSAGE_AFTER,
  TEXT_AUTO_NETWORK_RETRY_DELAY_MS,
  userMessageForCode,
  isRetryableCode,
  isTextManualRetryAllowed,
  showsTextRetryCountdown,
  computeTextCooldownMs,
  textCooldownUserMessage,
  formatRetryAvailableAt,
  looksLikeHtml,
  sanitizeDiagnosticText,
  parseRetryAfterMs,
  bodyHash,
  classifyHttpFailure,
  buildError,
  encodeTokenErrorPayload,
  createTokenError,
  missingApiKeyError,
  badTokenResponseError,
};
