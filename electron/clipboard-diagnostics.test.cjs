const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const { writeTextToClipboard } = require("./clipboard-write.cjs");
const { sanitizeDiagnosticText } = require("./realtime-errors.cjs");

function buildSanitizedReport(overrides = {}) {
  const header = {
    generatedAt: "2026-07-24T00:00:00.000Z",
    appVersion: "1.0.0",
    lastErrorCode: overrides.lastErrorCode || "network.offline",
    eventCount: 1,
    includedEvents: 1,
  };
  const event = {
    ts: "2026-07-24T00:00:00.000Z",
    level: "error",
    event: "connect.fail",
    connectionId: "conn-1",
    errorCode: "network.offline",
    message: sanitizeDiagnosticText(
      overrides.message || "Network connection looks down.",
      240,
    ),
  };
  return ["Jarvis Realtime Diagnostics", JSON.stringify(header, null, 2), "", "Events:", JSON.stringify(event)].join(
    "\n",
  );
}

test("successful native clipboard copy returns ok", () => {
  const writes = [];
  const result = writeTextToClipboard(
    {
      writeText(text) {
        writes.push(text);
      },
    },
    "Jarvis Realtime Diagnostics\n{}",
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /Jarvis Realtime Diagnostics/);
});

test("clipboard failure returns false with sanitized error", () => {
  const result = writeTextToClipboard(
    {
      writeText() {
        throw new Error("boom <html>sk-secret-key-value</html>");
      },
    },
    "report",
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not copy diagnostics.");
  assert.doesNotMatch(result.error, /boom|html|sk-secret/i);
});

test("non-string clipboard input fails safely", () => {
  const writes = [];
  const result = writeTextToClipboard(
    {
      writeText(text) {
        writes.push(text);
      },
    },
    { evil: true },
  );
  assert.equal(result.ok, false);
  assert.equal(writes.length, 0);
  assert.equal(result.error, "Could not copy diagnostics.");
});

test("oversized clipboard payload fails without writing", () => {
  const { MAX_CLIPBOARD_CHARS } = require("./clipboard-write.cjs");
  const writes = [];
  const result = writeTextToClipboard(
    {
      writeText(text) {
        writes.push(text);
      },
    },
    "x".repeat(MAX_CLIPBOARD_CHARS + 1),
  );
  assert.equal(result.ok, false);
  assert.equal(writes.length, 0);
  assert.equal(result.error, "Could not copy diagnostics.");
});

test("copied text is the sanitized diagnostic report", () => {
  const writes = [];
  const report = buildSanitizedReport({
    message: "Authorization: Bearer sk-abc1234567890xyz <html><body>nope</body></html>",
  });
  const result = writeTextToClipboard(
    {
      writeText(text) {
        writes.push(text);
      },
    },
    report,
  );
  assert.equal(result.ok, true);
  assert.equal(writes[0], report);
  assert.match(writes[0], /Jarvis Realtime Diagnostics/);
  assert.match(writes[0], /network\.offline/);
  assert.doesNotMatch(writes[0], /sk-abc1234567890xyz/);
  assert.doesNotMatch(writes[0], /<html/i);
  assert.doesNotMatch(writes[0], /<body/i);
});

test("wiring uses narrow clipboard IPC without exposing Electron", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const viteEnv = fs.readFileSync(path.join(root, "src/vite-env.d.ts"), "utf8");

  assert.match(main, /clipboard:write-text/);
  assert.match(main, /clipboard-write\.cjs/);
  assert.match(main, /Do not log or forward clipboard contents/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.doesNotMatch(main, /clipboard:write-text[\s\S]{0,200}console\.(log|error|debug).*text/);
  assert.match(preload, /copyTextToClipboard/);
  assert.match(preload, /clipboard:write-text/);
  assert.doesNotMatch(preload, /require\("electron"\)\.clipboard|clipboard\.writeText/);
  assert.match(app, /window\.ricky\.copyTextToClipboard/);
  assert.match(app, /result\?\.ok === true/);
  assert.doesNotMatch(app, /navigator\.clipboard/);
  assert.match(viteEnv, /copyTextToClipboard/);
});
