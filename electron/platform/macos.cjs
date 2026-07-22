const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");

const execFileAsync = promisify(execFile);

function keyCodeForKey(key) {
  const keyCodes = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    delete: 51,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
  };
  return keyCodes[String(key || "").toLowerCase()] || null;
}

function appleScriptString(value) {
  return JSON.stringify(String(value)).replace(/\\\\/g, "\\");
}

function createMacosDesktopControl({ dataDir }) {
  return {
    platform: "darwin",
    capabilities: () => ({
      openApp: true,
      typeText: true,
      pressKey: true,
      click: true,
      scroll: true,
      captureScreen: true,
      inspectUi: true,
    }),

    async openApp(args) {
      await execFileAsync("open", ["-a", String(args.appName || "")]);
      return { ok: true, message: `Opened ${args.appName}.` };
    },

    async typeText(args) {
      await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke ${appleScriptString(args.text || "")}`]);
      return { ok: true, message: "Typed text into the active app." };
    },

    async pressKey(args) {
      const keyCode = keyCodeForKey(args.key);
      if (!keyCode) {
        return { ok: false, error: `Unsupported key: ${args.key}` };
      }
      const repeat = Math.max(1, Math.min(20, Number(args.repeat || 1)));
      await execFileAsync("osascript", ["-e", `tell application "System Events" to repeat ${repeat} times\nkey code ${keyCode}\nend repeat`]);
      return { ok: true, message: `Pressed ${args.key}.` };
    },

    async click(args) {
      await execFileAsync("osascript", ["-e", `tell application "System Events" to click at {${Number(args.x)}, ${Number(args.y)}}`]);
      return { ok: true, message: `Clicked ${args.x}, ${args.y}.` };
    },

    async scroll(args) {
      const direction = String(args.direction || "down");
      const amount = Math.max(1, Math.min(20, Number(args.amount || 4)));
      const keyByDirection = { up: 126, down: 125, left: 123, right: 124 };
      const keyCode = keyByDirection[direction] || 125;
      await execFileAsync("osascript", ["-e", `tell application "System Events" to repeat ${amount} times\nkey code ${keyCode}\nend repeat`]);
      return { ok: true, message: `Scrolled ${direction}.` };
    },

    async captureScreen() {
      await fs.mkdir(dataDir, { recursive: true });
      const screenshotPath = path.join(dataDir, `screenshot-${Date.now()}.png`);
      await execFileAsync("screencapture", ["-x", screenshotPath]);
      return {
        ok: true,
        path: screenshotPath,
        artifact: {
          title: "Screen Snapshot",
          kind: "image",
          content: screenshotPath,
        },
      };
    },

    async inspectUi() {
      const script = `tell application "System Events"
set frontApp to first application process whose frontmost is true
set appName to name of frontApp
set windowName to ""
try
  set windowName to name of front window of frontApp
end try
set roleSummary to ""
try
  set roleSummary to value of attribute "AXRoleDescription" of front window of frontApp
end try
return "App: " & appName & linefeed & "Window: " & windowName & linefeed & "Role: " & roleSummary
end tell`;
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      return {
        ok: true,
        summary: stdout.trim(),
        artifact: {
          title: "UI Inspect",
          kind: "text",
          content: stdout.trim(),
        },
      };
    },
  };
}

module.exports = {
  createMacosDesktopControl,
};
