"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

/**
 * Pure helpers for daily launch scripts (also covered by automated tests).
 */
const {
  checkLaunchPrerequisites,
  parseEnvLocalHasOpenAiKey,
} = require("../electron/session-continuity.cjs");

function resolveRepoRoot(scriptDir) {
  return path.resolve(scriptDir, "..");
}

function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      execFileSync("which", [command], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function normalizePathForCompare(value) {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return "";
  try {
    return path.resolve(raw).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  } catch {
    return raw.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }
}

function pathsEqual(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/**
 * Resolve an executable safe for Start-Process / CreateProcess.
 * On Windows, never return npm.ps1 — prefer npm.cmd beside it or from PATH candidates.
 *
 * @param {string[]} candidates Absolute paths from Get-Command / where / discovery
 * @param {{ platform?: string, exists?: (p: string) => boolean }} [options]
 */
function resolveNpmStartExecutable(candidates, options = {}) {
  const platform = options.platform || process.platform;
  const exists = typeof options.exists === "function" ? options.exists : (p) => fs.existsSync(p);
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (platform === "win32") {
    for (const candidate of list) {
      if (/\.ps1$/i.test(candidate)) continue;
      if (/\.cmd$/i.test(candidate) && exists(candidate)) {
        return { ok: true, path: candidate, source: "candidate.cmd" };
      }
    }
    for (const candidate of list) {
      if (!/\.ps1$/i.test(candidate)) continue;
      const sibling = path.join(path.dirname(candidate), "npm.cmd");
      if (exists(sibling)) {
        return { ok: true, path: sibling, source: "sibling.cmd" };
      }
    }
    for (const candidate of list) {
      if (/\.ps1$/i.test(candidate)) continue;
      if (exists(candidate)) {
        return { ok: true, path: candidate, source: "candidate.other" };
      }
    }
    return {
      ok: false,
      path: null,
      message: "npm was not found.",
    };
  }

  for (const candidate of list) {
    if (exists(candidate)) {
      return { ok: true, path: candidate, source: "posix" };
    }
  }
  return {
    ok: false,
    path: null,
    message: "npm was not found.",
  };
}

/**
 * Resolve the packaged Electron binary under node_modules for an explicit app-path launch.
 */
function resolveElectronExecutable(repoRoot, options = {}) {
  const platform = options.platform || process.platform;
  const exists = typeof options.exists === "function" ? options.exists : (p) => fs.existsSync(p);
  const root = path.resolve(String(repoRoot || ""));
  if (!root) {
    return {
      ok: false,
      path: null,
      message: "Launch script could not find the Jarvis project root.",
    };
  }

  const exeName = platform === "win32" ? "electron.exe" : "electron";
  const exePath = path.join(root, "node_modules", "electron", "dist", exeName);
  if (exists(exePath)) {
    return { ok: true, path: exePath, source: "dist" };
  }
  return {
    ok: false,
    path: null,
    message: "Electron executable was not found. Run npm install in the Jarvis folder.",
  };
}

function buildElectronStartArgs(repoRoot) {
  return [path.resolve(String(repoRoot || ""))];
}

/**
 * Quote one Windows CreateProcess / ProcessStartInfo.Arguments token.
 * Always wraps in double quotes so paths with spaces stay one argument
 * (PowerShell Start-Process -ArgumentList @($path) splits on spaces otherwise).
 */
function quoteWindowsProcessArgument(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Argument list for Windows daily launch (exactly one app-path token, pre-quoted).
 * Intended for ProcessStartInfo.Arguments or a single Start-Process -ArgumentList string.
 */
function buildWindowsStartProcessArgumentList(repoRoot) {
  const absolute = path.resolve(String(repoRoot || ""));
  return [quoteWindowsProcessArgument(absolute)];
}

/**
 * Join the Windows start-process argument list into ProcessStartInfo.Arguments.
 * Does not build an unquoted command string for the executable.
 */
function buildWindowsProcessStartInfoArguments(repoRoot) {
  return buildWindowsStartProcessArgumentList(repoRoot).join(" ");
}

/**
 * Decode a Start-Process / ProcessStartInfo argument list back to argv values.
 * Proves spaced paths remain a single application argument.
 */
function decodeWindowsStartProcessArgumentList(argumentList) {
  const list = Array.isArray(argumentList) ? argumentList : [];
  return list.map((item) => {
    const s = String(item ?? "");
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"');
    }
    return s;
  });
}

/**
 * True when an unquoted spaced path would truncate at the first space
 * (the failure mode that produced C:\Users\Sarah).
 */
function wouldTruncateSpacedPathIfUnquoted(repoRoot) {
  const absolute = path.resolve(String(repoRoot || ""));
  if (!/\s/.test(absolute)) return false;
  const firstToken = absolute.split(/\s+/)[0];
  return firstToken !== absolute && /\\Users\\Sarah$/i.test(firstToken);
}

/**
 * Parse argv-looking tokens after the Electron executable in a Windows/POSIX command line.
 * Prefer electron.exe so node_modules\electron\ is not mistaken for the binary.
 */
function extractArgsAfterElectronExecutable(commandLine) {
  const cmd = String(commandLine || "");
  const win = cmd.match(/electron\.exe["']?\s*(.*)$/i);
  if (win) return String(win[1] || "").trim();
  const posix = cmd.match(/(?:^|[/\\])electron["']?\s+(.*)$/i);
  if (posix) return String(posix[1] || "").trim();
  return "";
}

function tokenizeCommandLineArgs(argsText) {
  const text = String(argsText || "");
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    args.push(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
  }
  return args;
}

function isDefaultElectronAppCommandLine(commandLine) {
  const cmd = String(commandLine || "");
  if (/default_app\.asar/i.test(cmd)) return true;
  if (!/electron(\.exe)?/i.test(cmd)) return false;
  const rest = extractArgsAfterElectronExecutable(cmd);
  if (!rest) return true;
  // Child processes always have --type=; bare mains have empty rest (handled above).
  if (/^--type=/i.test(rest)) {
    return /default_app\.asar/i.test(cmd);
  }
  return false;
}

/**
 * True only when the command line identifies this repository as the Electron app
 * (absolute app argument, --app-path=<repo>, or main.cjs under the repo).
 * Bare electron.exe / default_app.asar never count — even when the exe lives under the repo.
 */
function isJarvisProcessCommandLine(commandLine, repoRoot) {
  const cmd = String(commandLine || "");
  if (!cmd.trim()) return false;
  if (/default_app\.asar/i.test(cmd)) return false;

  const root = path.resolve(String(repoRoot || ""));
  if (!root) return false;
  const rootNorm = normalizePathForCompare(root);
  const rootFwd = root.replace(/\\/g, "/");
  const rootFwdNorm = rootFwd.toLowerCase();

  if (/electron[/\\]main\.cjs/i.test(cmd)) {
    const mainPathMatch = cmd.match(/([^\s"']+electron[/\\]main\.cjs)/i);
    if (mainPathMatch) {
      const mainPath = normalizePathForCompare(mainPathMatch[1]);
      if (mainPath.startsWith(rootNorm + "\\") || mainPath.startsWith(rootNorm + "/")) {
        return true;
      }
    }
    // Quoted absolute main under repo
    if (cmd.toLowerCase().includes(rootNorm + "\\electron\\main.cjs")) return true;
    if (cmd.toLowerCase().includes(rootFwdNorm + "/electron/main.cjs")) return true;
  }

  const appPathMatch = cmd.match(/--app-path=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  if (appPathMatch) {
    const appPath = appPathMatch[1] || appPathMatch[2] || appPathMatch[3] || "";
    if (/default_app/i.test(appPath)) return false;
    return pathsEqual(appPath, root);
  }

  if (!/electron(\.exe)?/i.test(cmd)) return false;

  const rest = extractArgsAfterElectronExecutable(cmd);
  if (!rest || /^--type=/i.test(rest)) return false;

  const args = tokenizeCommandLineArgs(rest);
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    if (pathsEqual(arg, root)) return true;
    if (/electron[/\\]main\.cjs/i.test(arg) && normalizePathForCompare(arg).startsWith(rootNorm)) {
      return true;
    }
  }

  // Quoted absolute repo as a discrete argument (handles nested quoting in WMI dumps).
  if (cmd.includes(`"${root}"`) || cmd.includes(`'${root}'`)) return true;
  if (cmd.includes(`"${rootFwd}"`) || cmd.includes(`'${rootFwd}'`)) return true;

  return false;
}

/**
 * Decide whether `[jarvis-launch] ready` may be printed.
 * Never ready merely because some Electron process exists.
 */
function evaluateJarvisLaunchReadiness(options = {}) {
  const repoRoot = options.repoRoot;
  const appPath = options.appPath;
  const commandLines = Array.isArray(options.commandLines) ? options.commandLines : [];

  if (appPath != null && String(appPath).trim()) {
    if (/default_app\.asar/i.test(String(appPath))) {
      return {
        ready: false,
        reason: "default_app_path",
        message: "Jarvis did not start as the expected application (Electron default app is not Jarvis).",
      };
    }
    if (repoRoot && !pathsEqual(appPath, repoRoot)) {
      return {
        ready: false,
        reason: "app_path_mismatch",
        message: "Jarvis did not start as the expected application (Electron default app is not Jarvis).",
      };
    }
    return {
      ready: true,
      reason: "app_path",
      message: "[jarvis-launch] ready",
    };
  }

  const jarvisLine = commandLines.find((line) => isJarvisProcessCommandLine(line, repoRoot));
  if (jarvisLine) {
    return {
      ready: true,
      reason: "process_command_line",
      message: "[jarvis-launch] ready",
    };
  }

  const hasElectron = commandLines.some((line) => /electron(\.exe)?/i.test(String(line || "")));
  if (hasElectron) {
    return {
      ready: false,
      reason: "electron_without_jarvis_identity",
      message: "Jarvis did not start as the expected application (Electron default app is not Jarvis).",
    };
  }

  return {
    ready: false,
    reason: "jarvis_identity_not_confirmed",
    message: "Jarvis did not start as the expected application (Electron default app is not Jarvis).",
  };
}

function isJarvisApplicationPath(appPath, repoRoot) {
  const readiness = evaluateJarvisLaunchReadiness({ appPath, repoRoot });
  return readiness.ready === true;
}

/**
 * Interpret a child process exit for the daily launcher.
 * A still-running long-lived Electron child is success until it exits.
 */
function interpretLaunchChildExit(exitCode, options = {}) {
  const alreadyRunning = options.alreadyRunning === true;
  if (exitCode == null) {
    return { ok: true, action: "still_running_or_unknown", exitCode: 0 };
  }
  const code = Number(exitCode);
  if (!Number.isFinite(code)) {
    return { ok: false, action: "invalid_exit", exitCode: 1, message: "Jarvis exited with an error (code 1)." };
  }
  if (code === 0) {
    return {
      ok: true,
      action: alreadyRunning ? "already_running_focused" : "clean_exit",
      exitCode: 0,
    };
  }
  return {
    ok: false,
    action: "nonzero_exit",
    exitCode: code,
    message: `Jarvis exited with an error (code ${code}).`,
  };
}

function shouldSetViteDevServerUrl() {
  // Daily launcher must never set VITE_DEV_SERVER_URL.
  return false;
}

function inspectLaunchEnvironment(repoRoot, options = {}) {
  const forceRebuild = options.forceRebuild === true;
  const exists = typeof options.exists === "function" ? options.exists : (p) => fs.existsSync(p);
  const platform = options.platform || process.platform;
  const distHtml = path.join(repoRoot, "dist", "index.html");
  const envLocalPath = path.join(repoRoot, ".env.local");
  let envContents = "";
  let envPresent = false;
  try {
    envContents = fs.readFileSync(envLocalPath, "utf8");
    envPresent = true;
  } catch {
    envPresent = false;
  }
  const distPresent = exists(distHtml);
  const electronResolved = resolveElectronExecutable(repoRoot, { platform, exists });
  return {
    nodeAvailable: options.nodeAvailable != null ? options.nodeAvailable : commandExists("node"),
    npmAvailable: options.npmAvailable != null ? options.npmAvailable : commandExists("npm"),
    packageJsonPresent: exists(path.join(repoRoot, "package.json")),
    electronInstalled: exists(path.join(repoRoot, "node_modules", "electron")),
    electronExecutablePresent: electronResolved.ok,
    electronExecutablePath: electronResolved.path,
    envLocalPresent: envPresent,
    openAiKeyPresent: envPresent ? parseEnvLocalHasOpenAiKey(envContents) : false,
    distPresent,
    willRebuild: forceRebuild || !distPresent,
    forceRebuild,
    repoRoot,
  };
}

function buildLaunchPlan(env, options = {}) {
  const checks = checkLaunchPrerequisites(env);
  const platform = options.platform || process.platform;
  const exists = options.exists;
  const npmCandidates = Array.isArray(options.npmCandidates) ? options.npmCandidates : [];
  const npmResolved = resolveNpmStartExecutable(npmCandidates, {
    platform,
    exists,
  });
  const electronResolved = resolveElectronExecutable(env.repoRoot, { platform, exists });
  const absoluteRepoRoot = path.resolve(String(env.repoRoot || ""));
  const startArgs = buildElectronStartArgs(absoluteRepoRoot);
  const startProcessArgumentList = buildWindowsStartProcessArgumentList(absoluteRepoRoot);
  const decodedStartArgs = decodeWindowsStartProcessArgumentList(startProcessArgumentList);

  const failures = [...checks.failures];
  if (!electronResolved.ok) {
    failures.push({
      code: "electron_exe_missing",
      message: electronResolved.message,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    shouldBuild: env.willRebuild === true,
    startCommand: electronResolved.ok ? electronResolved.path : null,
    startArgs,
    startProcessArgumentList,
    startProcessArguments: buildWindowsProcessStartInfoArguments(absoluteRepoRoot),
    absoluteAppPath: absoluteRepoRoot,
    electronExecutable: electronResolved,
    npmExecutable: npmResolved,
    setViteDevServerUrl: shouldSetViteDevServerUrl(),
    banner: "Starting Jarvis (built UI)…",
    workingDirectory: absoluteRepoRoot,
    // Guarantees for regression assertions
    usesExplicitAppPath: true,
    avoidsNpmStartDot: true,
    rejectsDefaultApp: !startArgs.some((a) => /default_app/i.test(String(a))),
    appArgumentCount: decodedStartArgs.length,
    decodedAppArguments: decodedStartArgs,
  };
}

module.exports = {
  resolveRepoRoot,
  commandExists,
  resolveNpmStartExecutable,
  resolveElectronExecutable,
  buildElectronStartArgs,
  quoteWindowsProcessArgument,
  buildWindowsStartProcessArgumentList,
  buildWindowsProcessStartInfoArguments,
  decodeWindowsStartProcessArgumentList,
  wouldTruncateSpacedPathIfUnquoted,
  extractArgsAfterElectronExecutable,
  tokenizeCommandLineArgs,
  isDefaultElectronAppCommandLine,
  isJarvisProcessCommandLine,
  evaluateJarvisLaunchReadiness,
  isJarvisApplicationPath,
  interpretLaunchChildExit,
  shouldSetViteDevServerUrl,
  inspectLaunchEnvironment,
  buildLaunchPlan,
  checkLaunchPrerequisites,
  parseEnvLocalHasOpenAiKey,
  normalizePathForCompare,
  pathsEqual,
  spawn,
};
