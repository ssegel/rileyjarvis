"use strict";

/**
 * Pure helpers for daily-launch BrowserWindow visibility and readiness.
 */

function sanitizeLoadUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    // Keep protocol + host + pathname only (no query/hash that might carry secrets).
    if (parsed.protocol === "file:") {
      return `file:${parsed.pathname || ""}`.slice(0, 240);
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 240);
  } catch {
    return text.replace(/[?#].*$/, "").slice(0, 240);
  }
}

/**
 * @param {{ errorCode?: number, errorDescription?: string, validatedURL?: string }} details
 * @param {(raw: string, maxLength?: number) => string} sanitizeText
 */
function sanitizeRendererLoadFailure(details = {}, sanitizeText) {
  const sanitize =
    typeof sanitizeText === "function"
      ? sanitizeText
      : (raw, maxLength = 160) => String(raw || "").slice(0, maxLength);
  const code = details.errorCode;
  return {
    errorCode: typeof code === "number" && Number.isFinite(code) ? code : null,
    errorDescription: sanitize(details.errorDescription || "renderer_load_failed", 160),
    url: sanitizeLoadUrl(details.validatedURL),
  };
}

function isBoundsOnScreen(bounds, displays) {
  if (!bounds || typeof bounds !== "object") return false;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (!(width > 0 && height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  const list = Array.isArray(displays) ? displays : [];
  if (list.length === 0) return false;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return list.some((display) => {
    const area = (display && (display.bounds || display.workArea || display)) || null;
    if (!area) return false;
    const ax = Number(area.x);
    const ay = Number(area.y);
    const aw = Number(area.width);
    const ah = Number(area.height);
    if (![ax, ay, aw, ah].every(Number.isFinite) || aw <= 0 || ah <= 0) return false;
    return cx >= ax && cy >= ay && cx < ax + aw && cy < ay + ah;
  });
}

/**
 * Jarvis UI readiness: only after successful load + shown + not minimized + on-screen + visible.
 * Never ready after renderer load failure.
 */
function evaluateJarvisUiReadiness(state = {}) {
  if (state.loadFailed === true) {
    return {
      ready: false,
      reason: "renderer_load_failed",
      message: null,
    };
  }
  if (state.destroyed === true) {
    return { ready: false, reason: "destroyed", message: null };
  }
  if (state.loaded !== true) {
    return { ready: false, reason: "not_loaded", message: null };
  }
  if (state.shown !== true) {
    return { ready: false, reason: "not_shown", message: null };
  }
  if (state.minimized === true) {
    return { ready: false, reason: "minimized", message: null };
  }
  if (state.visible !== true) {
    return { ready: false, reason: "not_visible", message: null };
  }
  if (state.boundsOnScreen !== true) {
    return { ready: false, reason: "off_screen", message: null };
  }
  return {
    ready: true,
    reason: "visible_ui",
    message: "[jarvis-launch] ready",
  };
}

module.exports = {
  sanitizeLoadUrl,
  sanitizeRendererLoadFailure,
  isBoundsOnScreen,
  evaluateJarvisUiReadiness,
};
