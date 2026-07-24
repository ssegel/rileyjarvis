"use strict";

/** Soft upper bound so IPC cannot push unbounded blobs to the system clipboard. */
const MAX_CLIPBOARD_CHARS = 200_000;

/**
 * Narrow clipboard write helper for main-process IPC.
 * Writes plain text only; does not read, log, or transmit clipboard contents.
 * Content sanitization is the caller's responsibility (diagnostic report builder).
 */
function writeTextToClipboard(clipboardApi, text) {
  if (typeof text !== "string") {
    return { ok: false, error: "Could not copy diagnostics." };
  }
  if (text.length > MAX_CLIPBOARD_CHARS) {
    return { ok: false, error: "Could not copy diagnostics." };
  }
  if (!clipboardApi || typeof clipboardApi.writeText !== "function") {
    return { ok: false, error: "Could not copy diagnostics." };
  }
  try {
    clipboardApi.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not copy diagnostics." };
  }
}

module.exports = {
  writeTextToClipboard,
  MAX_CLIPBOARD_CHARS,
};
