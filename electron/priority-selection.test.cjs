const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  planBroadPriorityAnswer,
  formatDailyWorkingContext,
  NO_OPEN_DAILY_PRIORITIES_LINE,
  NO_OPEN_DAILY_PRIORITIES_REPLY,
  PRIORITY_SELECTION_PRECEDENCE,
} = require("./memory.cjs");

const root = path.join(__dirname, "..");

const BROAD_PRIORITY_PROMPTS = [
  "What is my first priority?",
  "What is my priority?",
  "What should I work on?",
  "What is most important today?",
];

test("What should I work on? and What is most important today? use the same precedence", () => {
  const daily = {
    date: "2026-07-24",
    priorities: [{ text: "Done item", status: "done" }],
    commitments: [],
    followUps: [{ text: "Follow this next", status: "open" }],
    unresolved: [{ text: "Unresolved later", status: "open" }],
    activeProjects: [{ name: "Jarvis" }],
  };
  for (const prompt of BROAD_PRIORITY_PROMPTS) {
    const planned = planBroadPriorityAnswer(daily, daily.date);
    assert.equal(planned.category, "follow_ups", prompt);
    assert.equal(planned.mustSayNoOpenDailyPriorities, true, prompt);
    assert.equal(planned.categoryLabel, "follow-up", prompt);
  }
  assert.deepEqual(PRIORITY_SELECTION_PRECEDENCE, [
    "open daily priorities",
    "open commitments explicitly due now",
    "open follow-ups",
    "open unresolved items",
    "active projects",
  ]);
});

test("text and Realtime instructions both contain the same priority-selection rule", () => {
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const session = fs.readFileSync(path.join(root, "electron", "session-instructions.cjs"), "utf8");
  assert.match(main, /const JARVIS_INSTRUCTIONS/);
  assert.match(main, /buildSharedSessionInstructions/);
  assert.match(main, /Priority selection for broad questions/);
  assert.match(main, /What should I work on\?/);
  assert.match(main, /What is most important today\?/);
  assert.match(main, /You currently have no open daily priorities\./);
  assert.match(main, /Your next open follow-up is/);
  assert.match(main, /Never present a follow-up, unresolved item, commitment, or active project as a daily priority/);
  // Shared path used by text and Realtime.
  assert.match(session, /buildSessionInstructions/);
  assert.match(main, /buildInstructions:\s*buildSharedSessionInstructions/);
  assert.match(main, /buildSharedSessionInstructions\(\)/);
  assert.equal(NO_OPEN_DAILY_PRIORITIES_REPLY, "You currently have no open daily priorities.");
  assert.equal(NO_OPEN_DAILY_PRIORITIES_LINE, "Open daily priorities: none.");
});

test("personal-context block separates daily categories and empty priorities line", () => {
  const formatted = formatDailyWorkingContext(
    {
      date: "2026-07-24",
      summary: "",
      priorities: [{ text: "A", status: "done" }],
      commitments: [{ text: "Pay invoice", status: "open", due: "2026-07-24" }],
      followUps: [{ text: "Call back", status: "open" }],
      unresolved: [{ text: "Pick stack", status: "open" }],
      activeProjects: [{ name: "Jarvis", note: "desktop" }],
    },
    "2026-07-24",
  );
  assert.match(formatted.text, /Open daily priorities: none\./);
  assert.match(formatted.text, /Commitments due now:\n- Pay invoice \(due 2026-07-24\)/);
  assert.match(formatted.text, /Follow-ups:\n- Call back/);
  assert.match(formatted.text, /Unresolved items:\n- Pick stack/);
  assert.match(formatted.text, /Active projects:\n- Jarvis: desktop/);
  assert.ok(formatted.text.indexOf("Open daily priorities: none.") < formatted.text.indexOf("Commitments due now:"));
  assert.ok(formatted.text.indexOf("Commitments due now:") < formatted.text.indexOf("Follow-ups:"));
  assert.ok(formatted.text.indexOf("Follow-ups:") < formatted.text.indexOf("Unresolved items:"));
  assert.ok(formatted.text.indexOf("Unresolved items:") < formatted.text.indexOf("Active projects:"));
});
