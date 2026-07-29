"use strict";

/**
 * Build the main-process text:run payload.
 * Renderer must never supply previewToken; main injects it only for explicit resume.
 *
 * @param {object|null|undefined} request
 * @param {() => object|null} getPendingInternal
 */
function prepareTextRunPayload(request, getPendingInternal) {
  const payload = request && typeof request === "object" ? { ...request } : {};
  const resume = payload.resumePendingConfirmation === true;
  delete payload.resumePendingConfirmation;
  // Never trust renderer-supplied confirmation payloads (may contain tokens).
  delete payload.pendingConfirmation;

  if (!resume) {
    return payload;
  }

  const internal =
    typeof getPendingInternal === "function" ? getPendingInternal() : null;
  if (internal && internal.previewToken) {
    payload.pendingConfirmation = {
      toolName: internal.toolName,
      operation: internal.operation,
      scope: internal.scope ?? null,
      previewToken: internal.previewToken,
      expiresAt: internal.expiresAt,
      redactedSummary: internal.redactedSummary,
      dailyUpdatedAt: internal.dailyUpdatedAt,
    };
  }
  return payload;
}

/**
 * Empty-check without mutating the composer/submit string.
 * @param {unknown} text
 * @returns {{ empty: boolean, text: string }}
 */
function resolveExactComposerText(text) {
  const exact = text == null ? "" : String(text);
  return { empty: !exact.trim(), text: exact };
}

module.exports = {
  prepareTextRunPayload,
  resolveExactComposerText,
};
