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

function inspectLaunchEnvironment(repoRoot, options = {}) {
  const forceRebuild = options.forceRebuild === true;
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
  const distPresent = fs.existsSync(distHtml);
  return {
    nodeAvailable: commandExists("node"),
    npmAvailable: commandExists("npm"),
    packageJsonPresent: fs.existsSync(path.join(repoRoot, "package.json")),
    electronInstalled: fs.existsSync(path.join(repoRoot, "node_modules", "electron")),
    envLocalPresent: envPresent,
    openAiKeyPresent: envPresent ? parseEnvLocalHasOpenAiKey(envContents) : false,
    distPresent,
    willRebuild: forceRebuild || !distPresent,
    forceRebuild,
    repoRoot,
  };
}

function buildLaunchPlan(env) {
  const checks = checkLaunchPrerequisites(env);
  return {
    ...checks,
    shouldBuild: env.willRebuild === true,
    startCommand: "npm",
    startArgs: ["start"],
    banner: "Starting Jarvis (built UI)…",
  };
}

module.exports = {
  resolveRepoRoot,
  commandExists,
  inspectLaunchEnvironment,
  buildLaunchPlan,
  checkLaunchPrerequisites,
  parseEnvLocalHasOpenAiKey,
  spawn,
};
