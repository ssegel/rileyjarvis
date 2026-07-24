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

function userMessageForCode(code) {
  return USER_MESSAGES[code] || USER_MESSAGES.unknown;
}

function isRetryableCode(code) {
  return !NON_RETRYABLE.has(code);
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

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return undefined;
  const trimmed = String(headerValue).trim();
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
  const retryAfterMs = parseRetryAfterMs(options.retryAfterHeader);
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
  userMessageForCode,
  isRetryableCode,
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
