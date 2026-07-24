const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

const USER_VISIBLE_FILES = [
  "index.html",
  "src/App.tsx",
  "src/components/RickyFace.tsx",
  "src/components/ArtifactPanel.tsx",
  "src/lib/realtime.ts",
  "electron/main.cjs",
  "electron/preload.cjs",
  "src/vite-env.d.ts",
];

/** Compatibility / historical paths intentionally retaining ricky identifiers. */
const INTENTIONAL_COMPAT = [
  { file: "electron/main.cjs", pattern: /ricky-db\.json/, reason: "persisted database filename" },
  { file: "electron/main.cjs", pattern: /ricky-image-/, reason: "image storage filename prefix" },
  { file: "electron/main.cjs", pattern: /riley-local-ricky/, reason: "OpenAI Safety-Identifier seed" },
  { file: "electron/platform/windows-input.ps1", pattern: /RickyWindowsInput/, reason: "non-UI PowerShell helper class" },
  { file: "electron/platform/windows-ui.ps1", pattern: /RickyWindowsUiInspect/, reason: "non-UI PowerShell helper class" },
  { file: "docs/realtime-voice-stabilization-audit.md", pattern: /Ricky/, reason: "historical audit documentation" },
  { file: "docs/phase-9-diagnostics-recovery-audit.md", pattern: /Ricky/, reason: "historical audit documentation" },
];

test("visible connection text says Jarvis is live", () => {
  const realtime = fs.readFileSync(path.join(root, "src/lib/realtime.ts"), "utf8");
  assert.match(realtime, /Jarvis is live\. Start talking naturally\./);
  assert.doesNotMatch(realtime, /Ricky is live/);
});

test("user-visible menus, status, placeholders, and ARIA labels contain no Ricky", () => {
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const face = fs.readFileSync(path.join(root, "src/components/RickyFace.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src/components/ArtifactPanel.tsx"), "utf8");
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

  assert.match(app, /Jarvis is ready\. Connect voice/);
  assert.match(app, /aria-label="Jarvis computer use mini mode"/);
  assert.match(app, /Return to full Jarvis window/);
  assert.match(app, /entry\.role === "ricky" \? "Jarvis"/);
  assert.match(face, /Jarvis mood:/);
  assert.match(indexHtml, /<title>Jarvis<\/title>/);
  assert.match(main, /workflow_name:\s*"Jarvis Desktop Companion"/);
  assert.match(main, /title:\s*"Jarvis"/);
  assert.match(panel, /Ask Jarvis/);
  assert.match(app, /Type to Jarvis/);

  for (const file of USER_VISIBLE_FILES) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    // Strip TypeScript/JS identifiers that intentionally retain Ricky* symbol names.
    const withoutSymbols = text
      .replace(/\bRicky[A-Za-z0-9_]*/g, "")
      .replace(/\brole:\s*"ricky"/g, "")
      .replace(/entry\.role === "ricky"/g, "")
      .replace(/\.entry-ricky\b/g, "")
      .replace(/ricky-db\.json/g, "")
      .replace(/ricky-image-/g, "")
      .replace(/riley-local-ricky/g, "");
    assert.doesNotMatch(
      withoutSymbols,
      /\bRicky\b/,
      `${file} still contains user-visible Ricky after symbol stripping`,
    );
  }
});

test("renderer bridge uses approved Jarvis-facing name", () => {
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const viteEnv = fs.readFileSync(path.join(root, "src/vite-env.d.ts"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const realtime = fs.readFileSync(path.join(root, "src/lib/realtime.ts"), "utf8");

  assert.match(preload, /exposeInMainWorld\("jarvis"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\("ricky"/);
  assert.match(viteEnv, /\bjarvis:\s*\{/);
  assert.doesNotMatch(viteEnv, /\bricky:\s*\{/);
  assert.match(app, /window\.jarvis\./);
  assert.doesNotMatch(app, /window\.ricky\./);
  assert.match(realtime, /window\.jarvis\./);
  assert.doesNotMatch(realtime, /window\.ricky\./);
});

test("instructions constant renamed and workflow branding updated", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  assert.match(main, /const JARVIS_INSTRUCTIONS/);
  assert.doesNotMatch(main, /const RICKY_INSTRUCTIONS/);
  assert.match(main, /\$\{JARVIS_INSTRUCTIONS\}/);
  assert.match(main, /You are Jarvis/);
});

test("compatibility identifiers intentionally retained and excluded from user-visible output", () => {
  for (const item of INTENTIONAL_COMPAT) {
    const text = fs.readFileSync(path.join(root, item.file), "utf8");
    assert.match(text, item.pattern, `missing intentional compat marker: ${item.reason}`);
  }

  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const face = fs.readFileSync(path.join(root, "src/components/RickyFace.tsx"), "utf8");
  const realtime = fs.readFileSync(path.join(root, "src/lib/realtime.ts"), "utf8");
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

  // Compatibility seeds must not leak into UI copy.
  assert.doesNotMatch(app, /ricky-db\.json|riley-local-ricky|Ricky Desktop Companion/);
  assert.doesNotMatch(face, /ricky-db\.json|riley-local-ricky/);
  assert.doesNotMatch(realtime, /Ricky is live|Ricky is generating|Ricky Desktop Companion/);
  assert.doesNotMatch(indexHtml, /\bRicky\b/);
});

test("existing negative branding assertions still hold", () => {
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src/components/ArtifactPanel.tsx"), "utf8");
  assert.doesNotMatch(app, /Type to Ricky/);
  assert.doesNotMatch(panel, /Ask Ricky/);
});
