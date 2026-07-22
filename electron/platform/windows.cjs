const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const helperPath = path.resolve(__dirname, "windows-input.ps1");
const maxTextLength = 32_768;
const maxCoordinate = 1_000_000;
const maxHelperOutput = 1_048_576;

const supportedCapabilities = new Set(["openApp", "typeText", "pressKey", "click", "scroll"]);
const capabilityNames = [...supportedCapabilities, "captureScreen", "inspectUi"];

const keyVirtualKeys = Object.freeze({
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  delete: 0x08,
  space: 0x20,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
});

const applicationAliases = Object.freeze({
  notepad: { type: "path", relativePath: ["System32", "notepad.exe"] },
  "notepad.exe": { type: "path", relativePath: ["System32", "notepad.exe"] },
  paint: { type: "path", relativePath: ["System32", "mspaint.exe"] },
  mspaint: { type: "path", relativePath: ["System32", "mspaint.exe"] },
  "file explorer": { type: "path", relativePath: ["explorer.exe"] },
  explorer: { type: "path", relativePath: ["explorer.exe"] },
  calculator: { type: "appId", value: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  calc: { type: "appId", value: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  settings: { type: "uri", value: "ms-settings:" },
});

function unsupported(capability) {
  return {
    ok: false,
    platform: "win32",
    phase: 3,
    unsupportedCapability: capability,
    error: `Desktop control capability "${capability}" is not implemented on Windows in Phase 3.`,
  };
}

function invalidInput(code, error) {
  return { ok: false, platform: "win32", code, error };
}

function createWindowsDesktopControl(options = {}) {
  const inputRunner = options.inputRunner || runPowerShellInput;
  const shellApi = options.shell;
  const screenApi = options.screen;
  const fsApi = options.fs || fs;
  const launchProcess = options.launchProcess || defaultLaunchProcess;
  const windowsDirectory = path.win32.resolve(options.windowsDirectory || process.env.SystemRoot || "C:\\Windows");

  return {
    platform: "win32",
    capabilities: () => Object.fromEntries(capabilityNames.map((name) => [name, supportedCapabilities.has(name)])),

    async openApp(args) {
      const requestedName = typeof args.appName === "string" ? args.appName.trim() : "";
      if (!requestedName || requestedName.length > 4096 || requestedName.includes("\0")) {
        return invalidInput("INVALID_APP_NAME", "Application name must be a non-empty string of at most 4096 characters.");
      }

      const alias = applicationAliases[requestedName.toLowerCase()];
      if (alias) {
        const result = await openAlias(alias, { fsApi, launchProcess, shellApi, windowsDirectory });
        if (!result.ok) return result;
        return { ok: true, message: `Opened ${args.appName}.` };
      }

      const resolved = await validateExecutablePath(requestedName, fsApi);
      if (!resolved.ok) return resolved;
      const opened = await openExecutable(resolved.path, shellApi);
      if (!opened.ok) return opened;
      return { ok: true, message: `Opened ${args.appName}.` };
    },

    async typeText(args) {
      if (typeof args.text !== "string" || args.text.length > maxTextLength || args.text.includes("\0")) {
        return invalidInput("INVALID_TEXT", `Text must be a string without null characters and at most ${maxTextLength} UTF-16 code units.`);
      }
      await inputRunner("typeText", { text: args.text });
      return { ok: true, message: "Typed text into the active app." };
    },

    async pressKey(args) {
      const key = String(args.key || "").toLowerCase();
      const virtualKey = keyVirtualKeys[key];
      if (!virtualKey) {
        return { ok: false, error: `Unsupported key: ${args.key}` };
      }
      const repeatResult = boundedInteger(args.repeat, 1, 20, 1, "repeat");
      if (!repeatResult.ok) return repeatResult;
      await inputRunner("pressKey", { key, virtualKey, repeat: repeatResult.value });
      return { ok: true, message: `Pressed ${args.key}.` };
    },

    async click(args) {
      const xResult = boundedNumber(args.x, -maxCoordinate, maxCoordinate, "x");
      if (!xResult.ok) return xResult;
      const yResult = boundedNumber(args.y, -maxCoordinate, maxCoordinate, "y");
      if (!yResult.ok) return yResult;
      if (!screenApi || typeof screenApi.dipToScreenPoint !== "function") {
        return invalidInput("SCREEN_API_UNAVAILABLE", "Windows screen coordinate conversion is unavailable.");
      }
      const point = screenApi.dipToScreenPoint({ x: Math.round(xResult.value), y: Math.round(yResult.value) });
      const nativeX = boundedNumber(point?.x, -maxCoordinate, maxCoordinate, "converted x");
      if (!nativeX.ok) return nativeX;
      const nativeY = boundedNumber(point?.y, -maxCoordinate, maxCoordinate, "converted y");
      if (!nativeY.ok) return nativeY;
      await inputRunner("click", { x: Math.round(nativeX.value), y: Math.round(nativeY.value) });
      return { ok: true, message: `Clicked ${args.x}, ${args.y}.` };
    },

    async scroll(args) {
      const direction = String(args.direction || "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) {
        return invalidInput("INVALID_DIRECTION", `Unsupported scroll direction: ${args.direction}`);
      }
      const amountResult = boundedInteger(args.amount, 1, 20, 4, "amount");
      if (!amountResult.ok) return amountResult;
      const sign = direction === "up" || direction === "right" ? 1 : -1;
      await inputRunner("scroll", {
        direction,
        amount: amountResult.value,
        horizontal: direction === "left" || direction === "right",
        delta: sign * 120 * amountResult.value,
      });
      return { ok: true, message: `Scrolled ${direction}.` };
    },

    captureScreen: async () => unsupported("captureScreen"),
    inspectUi: async () => unsupported("inspectUi"),
  };
}

async function openAlias(alias, dependencies) {
  if (alias.type === "path") {
    const executablePath = path.win32.join(dependencies.windowsDirectory, ...alias.relativePath);
    const resolved = await validateExecutablePath(executablePath, dependencies.fsApi);
    if (!resolved.ok) return resolved;
    return await openExecutable(resolved.path, dependencies.shellApi);
  }

  const explorerPath = path.win32.join(dependencies.windowsDirectory, "explorer.exe");
  const resolvedExplorer = await validateExecutablePath(explorerPath, dependencies.fsApi);
  if (!resolvedExplorer.ok) return resolvedExplorer;
  const launchArgument = alias.type === "appId" ? `shell:AppsFolder\\${alias.value}` : alias.value;
  await dependencies.launchProcess(resolvedExplorer.path, [launchArgument]);
  return { ok: true };
}

async function validateExecutablePath(candidate, fsApi) {
  if (!path.win32.isAbsolute(candidate)) {
    return invalidInput("UNKNOWN_APP", "Application names must match a supported alias or be an absolute .exe path.");
  }
  if (path.win32.extname(candidate).toLowerCase() !== ".exe") {
    return invalidInput("INVALID_EXECUTABLE", "Application paths must target a .exe file.");
  }

  try {
    const absolutePath = path.win32.normalize(candidate);
    const realPath = await fsApi.realpath(absolutePath);
    if (!path.win32.isAbsolute(realPath) || path.win32.extname(realPath).toLowerCase() !== ".exe") {
      return invalidInput("INVALID_EXECUTABLE", "Resolved application target must be an absolute .exe file.");
    }
    const stats = await fsApi.stat(realPath);
    if (!stats.isFile()) {
      return invalidInput("INVALID_EXECUTABLE", "Application path must identify a file, not a directory.");
    }
    return { ok: true, path: realPath };
  } catch {
    return invalidInput("EXECUTABLE_NOT_FOUND", "Application executable does not exist or cannot be accessed.");
  }
}

async function openExecutable(executablePath, shellApi) {
  if (!shellApi || typeof shellApi.openPath !== "function") {
    return invalidInput("SHELL_API_UNAVAILABLE", "Electron application launching is unavailable.");
  }
  const error = await shellApi.openPath(executablePath);
  return error ? invalidInput("APP_LAUNCH_FAILED", error) : { ok: true };
}

function boundedNumber(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    return invalidInput("INVALID_NUMBER", `${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return { ok: true, value: number };
}

function boundedInteger(value, minimum, maximum, defaultValue, label) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: defaultValue };
  }
  const result = boundedNumber(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, label);
  if (!result.ok) return result;
  return { ok: true, value: Math.max(minimum, Math.min(maximum, Math.trunc(result.value))) };
}

async function defaultLaunchProcess(executablePath, args) {
  await execFileAsync(executablePath, args, { windowsHide: true });
}

function runPowerShellInput(operation, payload, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const systemRoot = path.win32.resolve(options.systemRoot || process.env.SystemRoot || "C:\\Windows");
  const powershellPath = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scriptPath = path.resolve(options.helperPath || helperPath);
  if (scriptPath !== helperPath) {
    return Promise.reject(new Error("Alternate Windows input helper paths are not allowed."));
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on("error", fail);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxHelperOutput) fail(new Error("Windows input helper produced excessive output."));
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > maxHelperOutput) fail(new Error("Windows input helper produced excessive diagnostics."));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(stderr.trim() || `Windows input helper exited with code ${code}.`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result || result.ok !== true) throw new Error("Windows input helper did not report success.");
        settled = true;
        resolve(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify({ operation, payload }));
  });
}

module.exports = {
  applicationAliases,
  createWindowsDesktopControl,
  helperPath,
  keyVirtualKeys,
  runPowerShellInput,
};
