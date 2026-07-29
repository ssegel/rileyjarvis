"use strict";

/**
 * Testable single-instance helpers for Electron main.
 */

function createSingleInstanceController(options = {}) {
  const requestLock =
    typeof options.requestSingleInstanceLock === "function"
      ? options.requestSingleInstanceLock
      : () => true;
  const quit =
    typeof options.quit === "function"
      ? options.quit
      : () => {};
  const getMainWindow =
    typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;

  const gotLock = requestLock();
  if (!gotLock) {
    quit();
    return { gotLock: false, focusExisting: () => false };
  }

  function focusExisting() {
    const win = getMainWindow();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
      return false;
    }
    try {
      if (typeof win.isMinimized === "function" && win.isMinimized()) {
        win.restore();
      }
      if (typeof win.show === "function") win.show();
      if (typeof win.focus === "function") win.focus();
      return true;
    } catch {
      return false;
    }
  }

  return { gotLock: true, focusExisting };
}

module.exports = {
  createSingleInstanceController,
};
