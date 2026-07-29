const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, nativeImage, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");
const { createDesktopControl } = require("./platform/index.cjs");
const { createMemoryStore } = require("./memory.cjs");
const { createSingleInstanceController } = require("./single-instance.cjs");
const {
  sanitizeRendererLoadFailure,
  isBoundsOnScreen,
  evaluateJarvisUiReadiness,
} = require("./window-launch.cjs");
const { sanitizeDiagnosticText } = require("./realtime-errors.cjs");
const { prepareTextRunPayload } = require("./text-run-request.cjs");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "ricky-db.json");
const desktopControl = createDesktopControl({ dataDir, screen, shell, desktopCapturer });
const memoryStore = createMemoryStore({ rootDir: path.join(dataDir, "memory") });
let currentMode = "display";
let mainWindow = null;
let normalWindowBounds = null;
let dbWriteQueue = Promise.resolve();

const singleInstance = createSingleInstanceController({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  getMainWindow: () => mainWindow,
});
if (!singleInstance.gotLock) {
  // Second instance: focus is handled by the first process; print then quit.
  console.info("Jarvis is already running");
} else {
  app.on("second-instance", () => {
    singleInstance.focusExisting();
  });
}

function getBuildInfo() {
  let version = "1.0.0";
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) version = pkg.version.trim();
  } catch {
    // ignore
  }
  let gitSha = null;
  let branch = null;
  try {
    gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    gitSha = null;
  }
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    branch = null;
  }
  return { version, gitSha, branch };
}

const RESTART_POLICY_NOTE = "Pending confirmations do not survive restart.";

const JARVIS_INSTRUCTIONS = `# Role and Objective
You are Jarvis, Sarah's personal desktop AI operator. You speak through realtime voice and can use local computer tools when authorized.

# Personality and Tone
Concise, calm, useful. Use a confident man's voice. Talk like a smart operator, not a chatbot.

# Personal Memory
- Durable personal instructions, preferences, profile facts, daily working context, and memory entries live in local files under data/memory/.
- Temporary conversation history is session-only and is not persisted as durable memory.
- Use memory_view, memory_remember, memory_correct, memory_update_daily, memory_priorities, working_context_items, memory_active_projects, memory_day_briefing, memory_set_preference, memory_set_instructions, and memory_clear to manage personal context.
- Use memory_priorities for every daily-priority lifecycle request: list, add, insert, edit, complete, reopen, remove, reorder, replace, clear completed, carry, restore backup, and preview.
- Use working_context_items for every commitment, follow-up, and unresolved-item lifecycle request: list, add, insert, edit, complete, reopen, remove, reorder, replace, clear completed, defer, clear defer, set/clear due date, convert, promote to priority, restore backup, and preview.
- Use memory_active_projects for every active-project lifecycle request: list, add, insert, edit, remove, reorder, replace, restore backup, and preview.
- Use memory_day_briefing for executive day briefings and archived-day listing. Operations: brief, list_archives. Compose content only from persisted memory — never invent, infer, reorder creatively, or add work items.
- For "brief me", "daily briefing", "what does my day look like", call memory_day_briefing with operation "brief" (today).
- For "brief me on yesterday", use targetDate "yesterday".
- For "brief me on July 25, 2026" / an ISO date, pass targetDate "YYYY-MM-DD".
- For "list archives" / "what days are archived", use operation "list_archives".
- Never invent briefing bullets; never brief tomorrow or future dates; never dump raw daily JSON for this purpose.
- Do not use lifecycle tools when Sarah only asked for a briefing or a list of archives.
- Day-briefing examples:
  - Brief today: {"operation":"brief"} or {"operation":"brief","targetDate":"today"}
  - Brief yesterday: {"operation":"brief","targetDate":"yesterday"}
  - Brief archived day: {"operation":"brief","targetDate":"2026-07-25"}
  - List archives: {"operation":"list_archives"}
- Show the briefing artifact; give a short spoken/text lead from the tool message. Do not re-list every bullet in speech. Do not invent items missing from the artifact. On failure, report the tool error once; do not retry identical args.
- Never say that full details are in the artifact panel (or similar) unless this turn's tool result included a substantive artifact that was delivered for display. If memory_day_briefing failed or returned no artifact, do not claim the panel shows the briefing.
- Never ask Sarah for internal IDs. Resolve by ordinal, exact wording, distinctive phrase, person/project/due qualifier, or the recently changed item.
- When Sarah says "that one", "that", or "the recent one", map it to the most recently touched compatible item in that domain (daily priority, active project, or working-context item for the relevant scope). Call the matching tool with reference {"by":"recent"} (plain string "recent" is also accepted). Do not ask which item she meant while a valid recent reference exists for that domain. If the tool returns NOT_FOUND for recent, then ask one concise clarification.
- Example — User: "Complete that one." → memory_priorities {"operation":"complete","reference":{"by":"recent"}}
- Example — User: "Remove that one." → memory_priorities {"operation":"remove","reference":{"by":"recent"}} (preview, then confirm with the same previewToken)
- Never invent or expand Sarah's reference wording to force a unique match. Pass the phrase she actually supplied (or its shared meaningful tokens). If several open items share that phrase, the tool returns AMBIGUOUS_MATCH — ask one concise clarification and do not write. Do not pick one candidate by guessing a narrower phrase.
- Never use memory_update_daily.priorities for add, edit, complete, reopen, remove, reorder, replace, clear, carry, or restore.
- Never use memory_update_daily.commitments, followUps, or unresolved — use working_context_items instead.
- Never use memory_update_daily.activeProjects — use memory_active_projects instead.
- On AMBIGUOUS_MATCH, ask one concise clarification and do not write.
- Never claim a working-context, priority, or active-project mutation succeeded unless the tool result has ok:true for that write.
- complete targets an open priority (status open, blocked, or active). reopen targets a completed priority (status done).
- For working_context_items: complete prefers open/blocked; reopen prefers done. Default open lists exclude future-deferred items.
- For add, insert, edit, complete, reopen, simple reorder, defer, clear_defer, set_due_date, clear_due_date, and single promote_to_priority: call working_context_items once and execute immediately.
- Working-context examples:
  - Add commitment with due date: {"operation":"add","scope":"commitments","item":{"text":"Send Greg the website draft","due":"2026-07-25"}}
  - Complete follow-up: {"operation":"complete","scope":"follow_ups","reference":{"by":"text","value":"Cecilia"}}
  - Reopen unresolved item: {"operation":"reopen","scope":"unresolved_items","reference":{"by":"text","value":"scanner"}}
  - Defer commitment: {"operation":"defer","scope":"commitments","reference":{"by":"text","value":"Greg"},"deferredUntil":"2026-07-28"}
  - Convert unresolved to commitment: preview then confirm {"operation":"convert","scope":"unresolved_items","destinationScope":"commitments","reference":{"by":"text","value":"email access"}}
  - Promote follow-up to priority: {"operation":"promote_to_priority","scope":"follow_ups","reference":{"by":"text","value":"website"}}
  - Remove with confirmation: preview remove, then confirmed=true with previewToken
  - List overdue commitments: {"operation":"list","scope":"commitments","filter":"overdue"}
- For remove, replace, clear_completed, convert, restore_backup, and bulk promote only: present the preview, wait for explicit confirmation, then call again with confirmed=true and the matching previewToken.
- After every successful working-context write, briefly confirm and report the resulting ordered list for that scope.
- For add, insert, edit, and simple reorder on active projects: call memory_active_projects once and execute immediately. Do not ask Sarah to confirm these operations.
- Active-project array order is project order; "first project" means ordinal 1 / index 0. Pass Sarah's project name phrase as supplied.
- Active-project examples:
  - Add: {"operation":"add","items":[{"name":"Jarvis desktop assistant"}]}
  - Insert first: {"operation":"insert","atPosition":1,"item":{"name":"Estate planning"}}
  - Edit note: {"operation":"edit","reference":{"by":"text","value":"Jarvis"},"item":{"note":"Phase 15"}}
  - Reorder: {"operation":"reorder","reference":{"by":"text","value":"Website"},"atPosition":1}
  - Remove/replace/restore: present preview, then confirmed=true with previewToken
- For remove, replace, and restore_backup on active projects only: present the preview, wait for explicit confirmation, then call again with confirmed=true and the matching previewToken.
- After every successful active-project write, briefly confirm and report the resulting ordered list.
- For add, insert, edit, complete, reopen, and simple reorder on priorities: call memory_priorities once and execute immediately. Do not preview these operations and do not ask Sarah to confirm them.
- For insert: call memory_priorities in one tool call with operation "insert", the item text, and the exact 1-based atPosition. Priority N means atPosition N (array index N-1). Never ask Sarah to confirm an ordinary insertion.
- For reorder (move one item within today's list): call once with operation "reorder", a text reference, and the 1-based atPosition. Example: move call Cecilia to priority one → {"operation":"reorder","reference":{"by":"text","value":"call Cecilia"},"atPosition":1}. Equivalent reference shapes such as {"text":"call Cecilia"} or item {"text":"call Cecilia"} are also accepted.
- On NOT_FOUND, report the failure once or ask one concise clarification. Do not retry identical or near-identical tool calls (same operation, same normalized reference, same destination/material arguments, same error) in the same turn.
- Carry across dates (copy vs move — follow wording exactly):
  - "carry", "carry forward", "carry into tomorrow", or "copy" means COPY. Omit move or send move:false. Never send move:true when Sarah only says carry/copy/carry forward.
  - "copy" preserves the source priority on today and adds it to the target date.
  - Only explicit words such as "move", "transfer", or "remove from today and put tomorrow" may set move:true (remove from today and add to the target date).
  - Example COPY — User: "Carry Call Cecilia into tomorrow." → {"operation":"carry","reference":{"by":"text","value":"Call Cecilia"},"targetDate":"tomorrow","move":false}
  - Example MOVE — User: "Move Call Cecilia to tomorrow." → {"operation":"carry","reference":{"by":"text","value":"Call Cecilia"},"targetDate":"tomorrow","move":true}
  - Present the preview wording exactly (copy keeps today unchanged; move removes from today), then confirm with the matching previewToken. Never call a copy operation a move.
- To show tomorrow's (or another date's) daily priorities, call memory_priorities list with targetDate "tomorrow" or YYYY-MM-DD. Example: {"operation":"list","targetDate":"tomorrow"}. Never answer a tomorrow/future list request from today's priorities or from injected today context.
- For remove, replace, clear completed, carry, and restore backup only: present the preview, wait for explicit confirmation, then call again with confirmed=true and the matching previewToken.
- After every successful priority write, briefly confirm and report the resulting ordered list.
- Require confirmed=true before memory_clear and before full replacement of instructions.
- Never invent commitments. Prefer explicit user confirmation before irreversible actions.
- Do not put secret memory values into ordinary responses; use confirmed memory_view when Sarah asks to see secrets.
- When inferred information conflicts with stored facts, report the conflict and ask how to resolve it instead of overwriting.
- Priority selection for broad questions such as "What is my first priority?", "What is my priority?", "What should I work on?", and "What is most important today?": use open daily priorities first, then open commitments explicitly due now, then open follow-ups, then open unresolved items, then active projects.
- If one or more daily priorities are open, answer from that daily-priority list first and preserve their stored order.
- If there are no open daily priorities, say exactly: "You currently have no open daily priorities." Then you may optionally name the highest relevant open item from another category with a clear category label (for example: "Your next open follow-up is..."). Never present a follow-up, unresolved item, commitment, or active project as a daily priority.

# Modes
- Display mode is the default. Use the app and artifact panel to show things. Do not control the computer.
- Computer use mode allows desktop control tools. Only use computer tools after the user asks for computer use or asks you to control the computer.

# Tool Behavior
- Use read-only tools when the user's intent is clear.
- When Sarah says "show me the menu", "show me what I can do", or asks what Jarvis can do, call show_menu immediately.
- For web search, notes, charts, records, image generation, personal memory, and artifact display, act directly when the request is clear.
- For thumbnail creation/editing, always use the thumbnail board tools, never generic image_generate and never artifact_show with imageLoading. Generate exactly one 16:9 image per request. Never generate multiple unless Sarah separately asks again. Every generate/edit request gets a permanent database number that never changes, like #18 then #19 then #20. Do not renumber visible grid positions. Show paginated 3x3 pages of the permanent numbers. Do not show a standalone fullscreen loading animation for thumbnails. Use Sarah's wording literally: do not invent elaborate extra concepts, fake text, or extra thumbnail ideas. For edits, use the exact existing numbered/selected image as input and make only the requested change.
- The thumbnail board persists across sessions. If Sarah references thumbnail #N, trust that permanent number and call the matching thumbnail tool. Do not say you cannot see old thumbnails. Use thumbnail_grid to refresh state or change pages if needed.
- When a thumbnail finishes generating or editing, do not announce it verbally. The UI updates silently.
- For sending messages, deleting data, buying things, account changes, sharing private information, or anything irreversible, summarize the action and ask for explicit confirmation before calling the modifying tool.
- If a tool requires a confirmed field, set confirmed to true only after the user clearly confirms.
- Typing text and pressing Enter/Return in computer use mode are allowed without extra approval when Sarah asks you to type or send a prompt. Ask first before clicking controls or taking actions that delete, purchase, change settings, or expose private information.
- Explain what you are doing in one short sentence before longer tool work. Do not over-explain.

# Artifacts
Use artifacts for menus, web results, graphics, notes, database tables, code snippets, personal memory views, and task progress. If the user asks to show, hide, or fullscreen the artifacts panel, call the artifact tool.
For Mermaid charts, keep syntax simple: start with flowchart TD, avoid markdown fences, avoid parentheses in node labels, and use short alphanumeric node IDs.

# Audio
Let the user interrupt. If audio is unclear, ask one short clarifying question instead of guessing.`;

const toolSpecs = [
  {
    type: "function",
    name: "set_mode",
    description: "Switch Jarvis between display mode and computer use mode.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["display", "computer"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "artifact_show",
    description: "Show structured content in the artifact panel. Use for notes, menus, web results, charts, code, task progress, and visual content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["text", "markdown", "code", "table", "notes", "mermaid", "image", "imageLoading", "thumbnailBoard", "progress"] },
        content: { type: "string" },
        language: { type: "string" },
        fullscreen: { type: "boolean" },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "show_menu",
    description: "Show Jarvis's capability menu in the artifact panel. Call this when the user asks 'show me the menu', 'show me what I can do', or asks what Jarvis can do.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web with Exa. Use for current facts, links, research, and source gathering. Results are shown as a clean Markdown research brief in the artifact panel.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "image_generate",
    description: "Generate a standalone image with GPT Image and show it in the artifact panel. Do not use for YouTube thumbnails, thumbnail edits, or the thumbnail board; use thumbnail_generate or thumbnail_edit instead.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_reference_add",
    description: "Add a local image file as a reference image for making thumbnails of Sarah. Use when Sarah gives a file path to a photo of herself.",
    parameters: {
      type: "object",
      properties: {
        imagePath: { type: "string" },
        label: { type: "string" },
      },
      required: ["imagePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_generate",
    description: "Generate exactly one 16:9 YouTube thumbnail into Jarvis's persistent paginated thumbnail board. Uses Sarah reference images if available. Assigns a new permanent number that never changes. Never generate multiple at once.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_edit",
    description: "Edit one existing thumbnail by permanent thumbnail number, or edit the currently selected thumbnail if number is omitted. Use this whenever Sarah says 'edit number 20' or 'edit this'. The edited result gets a new permanent number.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        number: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_select",
    description: "Select a permanent numbered thumbnail and show it fullscreen. Use when Sarah says 'pull up number 20', 'show number 20', 'open number 20', or 'select number 20'.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", minimum: 1 },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_grid",
    description: "Show one paginated 3x3 page of the persistent thumbnail board and return compact board state. Use to refresh state, change pages, or when Sarah asks what thumbnails exist.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mermaid_render",
    description: "Render a Mermaid chart in the artifact panel. Provide only Mermaid code, no markdown fences. Prefer flowchart TD with quoted labels.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        diagram: { type: "string" },
      },
      required: ["title", "diagram"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "note_add",
    description: "Add a note to Jarvis's fun local notes list.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_view",
    description: "View personal memory scopes: instructions, preferences, profile, daily, entries, or all. Set confirmed=true to include secret values.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["instructions", "preferences", "profile", "daily", "entries", "all"] },
        confirmed: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_remember",
    description: "Store a durable memory entry or profile fact with sensitivity and source.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["entry", "profile"] },
        text: { type: "string" },
        value: { type: "string" },
        key: { type: "string" },
        kind: { type: "string", enum: ["fact", "preference", "project", "person", "rule", "other"] },
        tags: { type: "array", items: { type: "string" } },
        sensitivity: { type: "string", enum: ["normal", "sensitive", "secret"] },
        source: { type: "string", enum: ["user", "assistant", "import"] },
        confidence: { type: "string", enum: ["stated", "inferred"] },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_correct",
    description: "Correct a stored memory entry or profile fact. Preserves history through supersedes.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        key: { type: "string" },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        sensitivity: { type: "string", enum: ["normal", "sensitive", "secret"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_update_daily",
    description:
      "Update today's summary only. Do not pass priorities (use memory_priorities), commitments/followUps/unresolved (use working_context_items), or activeProjects (use memory_active_projects).",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_active_projects",
    description:
      "Manage active projects with deterministic reference resolution. Operations: list, add, insert, edit, remove, reorder, replace, restore_backup, preview. Projects use name and note only (no status/due). Never ask for UUIDs. Pass Sarah's reference phrase as supplied — do not invent a narrower phrase to force a unique match. Execute add/insert/edit/reorder directly. Require preview then confirmed=true+previewToken for remove/replace/restore_backup. On NOT_FOUND/AMBIGUOUS_MATCH do not retry identical arguments; on AMBIGUOUS_MATCH ask one clarification and do not write. Only report success when ok:true.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "add",
            "insert",
            "edit",
            "remove",
            "reorder",
            "replace",
            "restore_backup",
            "preview",
          ],
        },
        confirmed: { type: "boolean" },
        previewToken: { type: "string" },
        expectedUpdatedAt: { type: "string" },
        previewOperation: { type: "string" },
        reference: {
          description:
            'Project reference. Prefer {"by":"text","value":"Website"}. Also accepts ordinal, id, recent, name, phrase, or a plain string.',
          anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
        },
        item: { type: "object", additionalProperties: true },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
        order: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
        },
        atPosition: { type: "number" },
        backupId: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_day_briefing",
    description:
      "Compose a deterministic executive day briefing from persisted memory, or list archived daily dates. Operations: brief, list_archives. For brief, targetDate may be omitted/today, yesterday, or YYYY-MM-DD for an archive. Tomorrow and future dates are unsupported. Read-only: never invent work items; never edit archives or daily arrays. Only report success when ok:true.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["brief", "list_archives"],
        },
        targetDate: {
          type: "string",
          description:
            'For brief only: omit or "today" for live today; "yesterday" for previous calendar date archive; or YYYY-MM-DD archive/today date. Ignored for list_archives.',
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "working_context_items",
    description:
      "Manage commitments, follow-ups, and unresolved items with deterministic reference resolution. Required scope: commitments | follow_ups | unresolved_items. Operations: list, add, insert, edit, complete, reopen, remove, reorder, replace, clear_completed, defer, clear_defer, set_due_date, clear_due_date, convert, promote_to_priority, restore_backup, preview. Never ask for UUIDs. Pass Sarah's reference phrase as supplied — do not invent a narrower phrase to force a unique match. Execute add/insert/edit/complete/reopen/reorder/defer/clear_defer/set_due_date/clear_due_date/single promote directly. Require preview then confirmed=true+previewToken for remove/replace/clear_completed/convert/restore_backup/bulk promote. Convert is a same-ID move. Promote creates a linked daily priority and keeps the source. On NOT_FOUND/AMBIGUOUS_MATCH do not retry identical arguments; on AMBIGUOUS_MATCH ask one clarification and do not write. Only report success when ok:true.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "add",
            "insert",
            "edit",
            "complete",
            "reopen",
            "remove",
            "reorder",
            "replace",
            "clear_completed",
            "defer",
            "clear_defer",
            "set_due_date",
            "clear_due_date",
            "convert",
            "promote_to_priority",
            "restore_backup",
            "preview",
          ],
        },
        scope: {
          type: "string",
          enum: ["commitments", "follow_ups", "unresolved_items"],
        },
        confirmed: { type: "boolean" },
        previewToken: { type: "string" },
        expectedUpdatedAt: { type: "string" },
        reference: {
          description:
            'Item reference. Prefer {"by":"text","value":"Cecilia"}. Also accepts ordinal, id, recent, person, project, due, or a plain string.',
          anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
        },
        item: { type: "object", additionalProperties: true },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
        order: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
        },
        atPosition: { type: "number" },
        destinationScope: {
          type: "string",
          enum: ["commitments", "follow_ups", "unresolved_items"],
        },
        dueDate: { type: "string", description: 'YYYY-MM-DD, "today", or "tomorrow".' },
        deferredUntil: { type: "string", description: 'YYYY-MM-DD, "today", or "tomorrow".' },
        filter: {
          type: "string",
          enum: [
            "open",
            "done",
            "all",
            "overdue",
            "due_today",
            "due_tomorrow",
            "due_this_week",
            "no_due_date",
            "deferred",
          ],
        },
        relatedPerson: { type: "string" },
        relatedProject: { type: "string" },
        priorityPosition: { type: "number" },
        allowDuplicates: { type: "boolean" },
        backupId: { type: "string" },
        listScope: {
          type: "string",
          enum: [
            "open",
            "done",
            "all",
            "overdue",
            "due_today",
            "due_tomorrow",
            "due_this_week",
            "no_due_date",
            "deferred",
          ],
        },
        previewOperation: { type: "string" },
      },
      required: ["operation", "scope"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_priorities",
    description:
      "Manage today's daily priorities with deterministic reference resolution. Operations: list, add, insert, edit, complete, reopen, remove, reorder, replace, clear_completed, carry, restore_backup, preview. complete targets an open priority; reopen targets a completed priority. Carry language: \"carry\"/\"carry forward\"/\"carry into tomorrow\"/\"copy\" = COPY (omit move or move:false; never move:true for carry-only wording). Only explicit \"move\"/\"transfer\"/\"remove from today and put tomorrow\" = move:true. COPY example: User \"Carry Call Cecilia into tomorrow.\" → {\"operation\":\"carry\",\"reference\":{\"by\":\"text\",\"value\":\"Call Cecilia\"},\"targetDate\":\"tomorrow\",\"move\":false}. MOVE example: User \"Move Call Cecilia to tomorrow.\" → {\"operation\":\"carry\",\"reference\":{\"by\":\"text\",\"value\":\"Call Cecilia\"},\"targetDate\":\"tomorrow\",\"move\":true}. List tomorrow with {\"operation\":\"list\",\"targetDate\":\"tomorrow\"} — never answer tomorrow from today's list. Execute add/insert/edit/complete/reopen/reorder directly in one call (insert requires exact 1-based atPosition). Reorder example: {\"operation\":\"reorder\",\"reference\":{\"by\":\"text\",\"value\":\"call Cecilia\"},\"atPosition\":1}. Only remove/replace/clear_completed/carry/restore_backup require preview then confirmed=true with previewToken. On NOT_FOUND, do not retry identical or near-identical arguments. Never ask the user for UUIDs.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "add",
            "insert",
            "edit",
            "complete",
            "reopen",
            "remove",
            "reorder",
            "replace",
            "clear_completed",
            "carry",
            "restore_backup",
            "preview",
          ],
        },
        confirmed: { type: "boolean" },
        expectedUpdatedAt: { type: "string" },
        items: { type: "array", items: { type: "object", additionalProperties: true } },
        item: { type: "object", additionalProperties: true },
        reference: {
          description:
            'Priority reference. Prefer {"by":"text","value":"call Cecilia"}. Also accepts {"by":"recent"} or plain string "recent" for "that one"/"that"/"the recent one", {"text":"call Cecilia"}, ordinal, id, or a plain string.',
          anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
        },
        atPosition: { type: "number" },
        order: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
        },
        targetDate: {
          type: "string",
          description:
            'For carry and list. "tomorrow" or YYYY-MM-DD. On list, reads that date\'s future file (not today). Omit on list to show today.',
        },
        backupId: { type: "string" },
        previewToken: { type: "string" },
        previewOperation: { type: "string" },
        listScope: { type: "string", enum: ["open", "done", "all"] },
        allowDuplicates: { type: "boolean" },
        move: {
          type: "boolean",
          description:
            "For carry only. Omitted or false: copy to the target date and preserve today. true: remove from today and add to the target date. Never set true for ordinary carry wording.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_set_preference",
    description: "Update personal preferences and hard interaction rules.",
    parameters: {
      type: "object",
      properties: {
        addressAs: { type: "string" },
        defaultMode: { type: "string", enum: ["display", "computer"] },
        confirmBefore: { type: "array", items: { type: "string" } },
        hardRules: { type: "array", items: { type: "string" } },
        hardRule: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_set_instructions",
    description: "Append to or replace personal operating instructions. Full replacement requires confirmed=true.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["append", "replace"] },
        content: { type: "string" },
        text: { type: "string" },
        section: { type: "string" },
        confirmed: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "memory_clear",
    description: "Clear a memory scope. Always requires confirmed=true. Scopes: daily, entries, preferences, instructions, all.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["daily", "entries", "preferences", "instructions", "all"] },
        confirmed: { type: "boolean" },
      },
      required: ["scope"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_create",
    description: "Create a local database record.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["collection", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_search",
    description: "Search local database records by collection and query.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        query: { type: "string" },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_update",
    description: "Update a local database record. Ask for confirmation first if the change is sensitive or destructive.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_delete",
    description: "Delete a local database record. Always ask the user for explicit confirmation first, then call with confirmed true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["id", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_open_app",
    description: "Open a macOS app by name. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        appName: { type: "string" },
      },
      required: ["appName"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_type_text",
    description: "Type text into the active app. Requires computer mode. Do not ask for extra confirmation just to type.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_press_key",
    description: "Press a keyboard key in the active app. Requires computer mode. Use enter/return after typing when the user asks to send a prompt.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", enum: ["enter", "return", "tab", "escape", "delete", "space", "up", "down", "left", "right"] },
        repeat: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_click",
    description: "Click screen coordinates. Requires computer mode. Ask for confirmation before clicking buttons that send, delete, buy, submit, or change settings.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_scroll",
    description: "Scroll the active app. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "screen_snapshot",
    description: "Capture the current screen and return the local screenshot path. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ui_inspect",
    description: "Inspect the frontmost application name, window, and visible UI summary using platform accessibility APIs when available. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

async function ensureData() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(defaultDb(), null, 2));
  }
}

async function readDb() {
  await ensureData();
  const raw = await fs.readFile(dbPath, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await ensureData();
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function updateDb(mutator) {
  const operation = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return { db, result };
  });
  dbWriteQueue = operation.catch(() => {});
  return operation;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaultDb() {
  return {
    notes: [],
    records: [],
    thumbnailBoard: {
      references: [],
      images: [],
      nextNumber: 1,
      page: 1,
      pageSize: 9,
      selectedId: null,
      view: "grid",
    },
  };
}

function normalizeDb(db) {
  const next = db && typeof db === "object" ? db : defaultDb();
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.records)) next.records = [];
  if (!next.thumbnailBoard || typeof next.thumbnailBoard !== "object") {
    next.thumbnailBoard = defaultDb().thumbnailBoard;
  }
  if (!Array.isArray(next.thumbnailBoard.references)) next.thumbnailBoard.references = [];
  if (!Array.isArray(next.thumbnailBoard.images)) next.thumbnailBoard.images = [];
  let maxNumber = 0;
  for (const image of [...next.thumbnailBoard.images].reverse()) {
    if (!Number.isInteger(image.number) || image.number < 1) image.number = maxNumber + 1;
    maxNumber = Math.max(maxNumber, image.number);
  }
  if (!Number.isInteger(next.thumbnailBoard.nextNumber) || next.thumbnailBoard.nextNumber <= maxNumber) {
    next.thumbnailBoard.nextNumber = maxNumber + 1;
  }
  if (!Number.isInteger(next.thumbnailBoard.page) || next.thumbnailBoard.page < 1) next.thumbnailBoard.page = 1;
  if (!Number.isInteger(next.thumbnailBoard.pageSize) || next.thumbnailBoard.pageSize < 1) next.thumbnailBoard.pageSize = 9;
  if (typeof next.thumbnailBoard.view !== "string") next.thumbnailBoard.view = "grid";
  if (!("selectedId" in next.thumbnailBoard)) next.thumbnailBoard.selectedId = null;
  return next;
}

async function clearStartupLoadingThumbnails() {
  const db = await readDb();
  const before = db.thumbnailBoard.images.length;
  db.thumbnailBoard.images = db.thumbnailBoard.images.filter((image) => image.status !== "loading");
  if (db.thumbnailBoard.images.length !== before) {
    db.thumbnailBoard.selectedId = null;
    db.thumbnailBoard.view = "grid";
    await writeDb(db);
  }
}

function requireComputerMode() {
  if (currentMode !== "computer") {
    return {
      ok: false,
      needsMode: "computer",
      message: "Computer control is disabled. Ask Jarvis to switch to computer use mode first.",
    };
  }
  return null;
}

function requiresConfirmation(args) {
  return args.confirmed !== true && (args.risk === "may_send_or_modify" || args.risk === "private_or_sensitive");
}

async function createWindow() {
  await ensureData();
  await memoryStore.ensureMemory();
  await clearStartupLoadingThumbnails();

  let loadFailed = false;
  let readyEmitted = false;
  let mainFrameLoaded = false;

  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: "Jarvis",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    icon: nativeImage.createEmpty(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  const tryEmitJarvisLaunchReady = () => {
    if (readyEmitted || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const displays = screen.getAllDisplays().map((display) => ({ bounds: display.bounds }));
    const readiness = evaluateJarvisUiReadiness({
      loadFailed,
      destroyed: win.isDestroyed(),
      loaded: mainFrameLoaded,
      shown: win.isVisible(),
      minimized: typeof win.isMinimized === "function" ? win.isMinimized() : false,
      visible: win.isVisible(),
      boundsOnScreen: isBoundsOnScreen(bounds, displays),
    });
    if (!readiness.ready) return;
    readyEmitted = true;
    console.info("[jarvis-launch] ready", JSON.stringify(getBuildInfo()));
  };

  const showJarvisWindowIfReady = () => {
    if (loadFailed || win.isDestroyed()) return;
    if (!mainFrameLoaded) return;
    if (typeof win.isMinimized === "function" && win.isMinimized()) {
      win.restore();
    }
    const bounds = win.getBounds();
    const displays = screen.getAllDisplays().map((display) => ({ bounds: display.bounds }));
    if (!isBoundsOnScreen(bounds, displays)) {
      win.center();
    }
    win.show();
    win.focus();
    tryEmitJarvisLaunchReady();
  };

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    loadFailed = true;
    const detail = sanitizeRendererLoadFailure(
      { errorCode, errorDescription, validatedURL },
      sanitizeDiagnosticText,
    );
    console.error("[jarvis-launch] renderer-load-failed", JSON.stringify(detail));
  });

  win.webContents.on("did-finish-load", () => {
    if (loadFailed || win.isDestroyed()) return;
    mainFrameLoaded = true;
    showJarvisWindowIfReady();
  });

  win.once("ready-to-show", () => {
    showJarvisWindowIfReady();
  });

  try {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      await win.loadURL(devUrl);
    } else {
      await win.loadFile(path.join(process.cwd(), "dist", "index.html"));
    }
  } catch (error) {
    loadFailed = true;
    const detail = sanitizeRendererLoadFailure(
      {
        errorCode: null,
        errorDescription: error && error.message ? String(error.message) : "renderer_load_failed",
        validatedURL: null,
      },
      sanitizeDiagnosticText,
    );
    console.error("[jarvis-launch] renderer-load-failed", JSON.stringify(detail));
  }
}

function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mode === "computer") {
    const currentBounds = mainWindow.getBounds();
    if (currentBounds.width > 400 && currentBounds.height > 400) {
      normalWindowBounds = currentBounds;
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getDisplayMatching(currentBounds);
    const { workArea } = targetDisplay;
    const miniSize = 190;
    const margin = 18;
    mainWindow.setMinimumSize(150, 150);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, "floating");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setBounds({
      x: workArea.x + margin,
      y: workArea.y + workArea.height - miniSize - margin,
      width: miniSize,
      height: miniSize,
    });
    return;
  }

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(420, 520);
  if (normalWindowBounds) {
    mainWindow.setBounds(normalWindowBounds);
  } else {
    mainWindow.setBounds({ width: 1120, height: 760 });
    mainWindow.center();
  }
}

ipcMain.handle("tools:list", () => toolSpecs);

ipcMain.handle("clipboard:write-text", (_event, text) => {
  const { writeTextToClipboard } = require("./clipboard-write.cjs");
  // Native write only. Do not log or forward clipboard contents.
  return writeTextToClipboard(clipboard, text);
});

const { buildSessionInstructions } = require("./session-instructions.cjs");
const { createTextSessionController } = require("./text-session.cjs");
const realtimeErrors = require("./realtime-errors.cjs");

async function buildSharedSessionInstructions() {
  // Shared by Realtime mint and text turns. Do not log the injected memory block.
  return buildSessionInstructions({
    jarvisInstructions: `${JARVIS_INSTRUCTIONS}`,
    memoryStore,
    readDb,
    buildThumbnailBoardInstructions,
  });
}

const textSession = createTextSessionController({
  getApiKey: () => process.env.OPENAI_API_KEY,
  getTextModel: () => process.env.OPENAI_TEXT_MODEL || "gpt-4.1",
  buildInstructions: buildSharedSessionInstructions,
  getToolSpecs: () => toolSpecs,
  executeTool: (toolCall) => executeTrustedTool(toolCall),
  classifyHttpFailure: realtimeErrors.classifyHttpFailure,
  createTokenError: realtimeErrors.createTokenError,
  sanitizeDiagnosticText: realtimeErrors.sanitizeDiagnosticText,
});

ipcMain.handle("text:run", async (_event, request) => {
  const payload = prepareTextRunPayload(request, () =>
    typeof memoryStore.getPendingConfirmationInternal === "function"
      ? memoryStore.getPendingConfirmationInternal()
      : null,
  );
  return textSession.runTextTurn(payload);
});
ipcMain.handle("text:cancel", async (_event, clientTurnId) => textSession.cancelTextTurn(clientTurnId));

ipcMain.handle("app:get-build-info", () => getBuildInfo());

ipcMain.handle("continuity:get", () => {
  const pending =
    typeof memoryStore.getPendingConfirmation === "function" ? memoryStore.getPendingConfirmation() : null;
  const recentSnapshot =
    typeof memoryStore.getRecentContinuitySnapshot === "function"
      ? memoryStore.getRecentContinuitySnapshot()
      : {
          recent: {
            priorityId: null,
            activeProjectId: null,
            workingContext: { commitments: null, follow_ups: null, unresolved_items: null },
          },
        };
  return {
    recent: recentSnapshot.recent,
    pendingConfirmation: pending,
    buildInfo: getBuildInfo(),
    restartPolicyNote: RESTART_POLICY_NOTE,
  };
});

ipcMain.handle("continuity:dismiss-pending", () => {
  if (typeof memoryStore.dismissPendingConfirmation === "function") {
    memoryStore.dismissPendingConfirmation();
  }
  return { ok: true };
});

app.on("before-quit", () => {
  try {
    if (textSession && typeof textSession.cancelAllActiveTurns === "function") {
      textSession.cancelAllActiveTurns();
    }
  } catch {
    // ignore
  }
});

ipcMain.handle("realtime:create-token", async () => {
  const {
    missingApiKeyError,
    classifyHttpFailure,
    createTokenError,
    badTokenResponseError,
  } = realtimeErrors;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw missingApiKeyError();
  }
  const instructions = await buildSharedSessionInstructions();

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("riley-local-ricky").digest("hex"),
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime-2",
          instructions,
          output_modalities: ["audio"],
          reasoning: { effort: "low" },
          tool_choice: "auto",
          tools: toolSpecs,
          audio: {
            input: {
              turn_detection: {
                type: "semantic_vad",
                eagerness: "medium",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              voice: "cedar",
            },
          },
          tracing: {
            workflow_name: "Jarvis Desktop Companion",
          },
        },
      }),
    });
  } catch (error) {
    throw createTokenError({
      code: "network.offline",
      userMessage: "Network connection looks down.",
      retryable: true,
      bodyHash: undefined,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    const classified = classifyHttpFailure({
      httpStatus: response.status,
      bodyText: text,
      retryAfterHeader: response.headers.get("retry-after"),
    });
    console.error(
      "[jarvis-realtime] token mint failed",
      JSON.stringify({
        code: classified.code,
        httpStatus: classified.httpStatus,
        bodyHash: classified.bodyHash,
      }),
    );
    throw createTokenError(classified);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw badTokenResponseError("non-json token response");
  }

  const value = data.value || data.client_secret?.value;
  if (!value) {
    throw badTokenResponseError("missing client secret value");
  }
  return { value, expiresAt: data.expires_at || data.client_secret?.expires_at || null };
});

ipcMain.handle("tools:execute", async (_event, toolCall) => executeTrustedTool(toolCall));

async function executeTrustedTool(toolCall) {
  const name = String(toolCall?.name || "");
  const args = asObject(toolCall?.arguments);

  try {
    if (name === "set_mode") {
      currentMode = args.mode === "computer" ? "computer" : "display";
      setWindowMode(currentMode);
      return {
        ok: true,
        mode: currentMode,
        artifact: {
          title: "Jarvis Mode",
          kind: "progress",
          content: `Mode switched to ${currentMode === "computer" ? "computer use" : "display"} mode.`,
        },
      };
    }

    if (name === "artifact_show") {
      return { ok: true, artifact: args };
    }

    if (name === "show_menu") {
      return {
        ok: true,
        artifact: {
          title: "Jarvis Menu",
          kind: "markdown",
          content: buildMenuMarkdown(),
        },
      };
    }

    if (name === "web_search") {
      return await webSearch(args);
    }

    if (name === "image_generate") {
      return await generateImage(args);
    }

    if (name === "thumbnail_loading_prepare") {
      return await thumbnailLoadingPrepare(args);
    }

    if (name === "thumbnail_reference_add") {
      return await thumbnailReferenceAdd(args);
    }

    if (name === "thumbnail_generate") {
      return await thumbnailGenerate(args);
    }

    if (name === "thumbnail_edit") {
      return await thumbnailEdit(args);
    }

    if (name === "thumbnail_select") {
      return await thumbnailSelect(args);
    }

    if (name === "thumbnail_grid") {
      const { db } = await updateDb(async (currentDb) => {
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = pageForArgs(args);
      });
      return { ok: true, board: thumbnailBoardSummary(db), artifact: await thumbnailBoardArtifact(db, "grid") };
    }

    if (name === "mermaid_render") {
      const diagram = normalizeMermaidDiagram(String(args.diagram || ""), String(args.title || "Mermaid chart"));
      return {
        ok: true,
        artifact: {
          title: String(args.title || "Mermaid chart"),
          kind: "mermaid",
          content: diagram,
        },
      };
    }

    if (name === "note_add") {
      const db = await readDb();
      const note = {
        id: crypto.randomUUID(),
        text: String(args.text || ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        createdAt: new Date().toISOString(),
      };
      db.notes.unshift(note);
      await writeDb(db);
      return {
        ok: true,
        note,
        artifact: {
          title: "Fun Notes",
          kind: "notes",
          content: JSON.stringify(db.notes.slice(0, 20), null, 2),
        },
      };
    }

    if (name === "memory_view") {
      return await memoryStore.memoryView(args);
    }
    if (name === "memory_remember") {
      return await memoryStore.memoryRemember(args);
    }
    if (name === "memory_correct") {
      return await memoryStore.memoryCorrect(args);
    }
    if (name === "memory_update_daily") {
      return await memoryStore.memoryUpdateDaily(args);
    }
    if (name === "memory_priorities") {
      return await memoryStore.memoryPriorities(args);
    }
    if (name === "memory_active_projects") {
      return await memoryStore.memoryActiveProjects(args);
    }
    if (name === "memory_day_briefing") {
      return await memoryStore.memoryDayBriefing(args);
    }
    if (name === "working_context_items") {
      return await memoryStore.workingContextItems(args);
    }
    if (name === "memory_set_preference") {
      return await memoryStore.memorySetPreference(args);
    }
    if (name === "memory_set_instructions") {
      return await memoryStore.memorySetInstructions(args);
    }
    if (name === "memory_clear") {
      return await memoryStore.memoryClear(args);
    }

    if (name === "records_create") {
      const db = await readDb();
      const record = {
        id: crypto.randomUUID(),
        collection: String(args.collection || "default"),
        title: String(args.title || "Untitled"),
        fields: asObject(args.fields),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.records.unshift(record);
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_search") {
      const db = await readDb();
      const collection = String(args.collection || "default");
      const query = String(args.query || "").toLowerCase();
      const records = db.records.filter((record) => {
        if (record.collection !== collection) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return { ok: true, records, artifact: recordsArtifact(records, collection) };
    }

    if (name === "records_update") {
      const db = await readDb();
      const record = db.records.find((item) => item.id === args.id);
      if (!record) return { ok: false, error: "Record not found." };
      record.title = typeof args.title === "string" ? args.title : record.title;
      record.fields = { ...record.fields, ...asObject(args.fields) };
      record.updatedAt = new Date().toISOString();
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_delete") {
      if (args.confirmed !== true) {
        return { ok: false, requiresConfirmation: true, message: "Explicit confirmation is required before deleting a record." };
      }
      const db = await readDb();
      const before = db.records.length;
      db.records = db.records.filter((record) => record.id !== args.id);
      await writeDb(db);
      return { ok: true, deleted: before !== db.records.length, artifact: recordsArtifact(db.records, "All Records") };
    }

    if (name.startsWith("computer_") || name === "screen_snapshot" || name === "ui_inspect") {
      const blocked = requireComputerMode();
      if (blocked) return blocked;
    }

    if (name === "computer_open_app") {
      return await desktopControl.openApp(args);
    }

    if (name === "computer_type_text") {
      return await desktopControl.typeText(args);
    }

    if (name === "computer_press_key") {
      return await desktopControl.pressKey(args);
    }

    if (name === "computer_click") {
      if (requiresConfirmation(args)) {
        return { ok: false, requiresConfirmation: true, message: "Confirmation required before clicking a risky target." };
      }
      return await desktopControl.click(args);
    }

    if (name === "computer_scroll") {
      return await desktopControl.scroll(args);
    }

    if (name === "screen_snapshot") {
      return await desktopControl.captureScreen(args);
    }

    if (name === "ui_inspect") {
      return await desktopControl.inspectUi(args);
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function webSearch(args) {
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey) {
    return {
      ok: false,
      missingEnv: "EXA_API_KEY",
      message: "EXA_API_KEY is not set. Add it to .env.local to enable Jarvis's web search tool.",
    };
  }

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaKey,
    },
    body: JSON.stringify({
      query: String(args.query || ""),
      type: "auto",
      numResults: Math.max(1, Math.min(10, Number(args.numResults || 5))),
      contents: { text: { maxCharacters: 900 } },
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `Exa search failed: ${response.status} ${await response.text()}` };
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    ok: true,
    results,
    artifact: {
      title: `Web Search: ${args.query}`,
      kind: "markdown",
      content: formatSearchMarkdown(String(args.query || ""), results),
    },
  };
}

function formatSearchMarkdown(query, results) {
  const cleanQuery = query.trim() || "Search";
  if (results.length === 0) {
    return `# ${cleanQuery}\n\nNo strong web results came back for this search. Try a narrower query or ask Jarvis to search a specific site.`;
  }

  const sections = results.slice(0, 8).map((result, index) => {
    const title = cleanMarkdownText(result.title || result.url || `Result ${index + 1}`);
    const url = String(result.url || "");
    const source = cleanMarkdownText(result.author || hostname(url) || "Source");
    const text = cleanMarkdownText(result.text || result.summary || "").slice(0, 700);
    const published = result.publishedDate ? `\n- Published: ${cleanMarkdownText(result.publishedDate)}` : "";
    const link = url ? `[Open source](${url})` : "Source link unavailable";

    return `### ${index + 1}. ${title}\n\n${text || "No snippet was returned for this result."}\n\n- Source: ${source}${published}\n- ${link}`;
  });

  return [`# ${cleanQuery}`, `Jarvis found ${results.length} source${results.length === 1 ? "" : "s"}.`, ...sections].join(
    "\n\n",
  );
}

function cleanMarkdownText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildMenuMarkdown() {
  return `# Jarvis Menu

Here is what you can ask me to do.

## Voice and Conversation

- Talk naturally with Jarvis in realtime.
- Interrupt mid-response and ask follow-ups.
- Ask unrelated questions while tools keep running.

## Artifacts Panel

- "Show me the menu."
- "Show the artifacts panel."
- "Make that fullscreen."
- Show clean research briefs, notes, code snippets, charts, task progress, images, and records.

## Web and Research

- "Search the web for ..."
- "Look up the latest on ..."
- Results render as a clean Markdown brief with source links.

## Visuals

- Generate images with GPT Image.
- Create Mermaid charts with automatic fallback if the syntax breaks.
- Draft diagrams, code snippets, structured notes, and visual explanations.

## Notes and Records

- Add notes to Jarvis's local note grid.
- Create, search, update, and confirm-delete local database records.

## Personal Memory

- View durable instructions, preferences, profile facts, daily context, and memory entries.
- Remember facts, correct stored items, and update today's summary, projects, commitments, and follow-ups.
- Manage daily priorities with natural language: list, add, insert, edit, complete, reopen, remove, reorder, replace, clear completed, carry to another day, and restore a backup.
- Manage active projects with natural language: list, add, insert, edit name/note, remove, reorder, replace, and restore a backup.
- Ask for a deterministic day briefing (today, yesterday, or an archived YYYY-MM-DD) or list archived daily dates — read-only; never invents work items.
- complete targets an open priority; reopen targets a completed priority.
- Carry/carry forward/copy into tomorrow keeps today's item (move:false). Only explicit move/transfer removes it from today (move:true).
- Show tomorrow's priorities with list targetDate tomorrow — do not reuse today's list.
- Ordinary add, insert, edit, complete, reopen, and reorder run immediately without confirmation.
- Ordinary active-project add, insert, edit, and reorder run immediately without confirmation.
- Removing, replacing, clearing completed priorities, carrying across dates, or restoring a backup requires an explicit confirmation after preview.
- Removing, replacing, or restoring active projects requires an explicit confirmation after preview.
- Clearing memory or fully replacing instructions requires explicit confirmation.
- Conversation transcript stays temporary for the current session only.

## Computer Use Mode

- "Switch to computer use mode."
- Open apps, click, type, press Enter/Return, scroll, inspect the UI, and take screen snapshots.
- Jarvis asks before risky actions like sending, deleting, buying, changing settings, or sharing private info.

## Good Starter Prompts

- "Show me the menu."
- "Brief me on today."
- "List my daily archives."
- "Search the web for the latest AI video tools."
- "Create a chart of my workflow."
- "Add a note: follow up on the sponsor."
- "Switch to computer use mode and open Notes."`;
}

async function generateImage(args) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return imageErrorArtifact("OPENAI_API_KEY is missing in .env.local.");
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: String(args.prompt || ""),
      size: String(args.size || "1024x1024"),
      quality: "medium",
    }),
  });

  if (!response.ok) {
    return imageErrorArtifact(`Image generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  const url = data.data?.[0]?.url;
  if (b64) {
    await fs.mkdir(dataDir, { recursive: true });
    const imagePath = path.join(dataDir, `ricky-image-${Date.now()}.png`);
    await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
    return {
      ok: true,
      path: imagePath,
      artifact: {
        title: "Generated Image",
        kind: "image",
        content: `data:image/png;base64,${b64}`,
      },
    };
  }
  if (url) {
    return { ok: true, url, artifact: { title: "Generated Image", kind: "image", content: url } };
  }
  return imageErrorArtifact("Image response did not include image data.");
}

function imageErrorArtifact(error) {
  return {
    ok: false,
    error,
    artifact: {
      title: "Image Generation Failed",
      kind: "markdown",
      content: `# Image generation failed\n\n${cleanMarkdownText(error)}\n\nTry a shorter prompt, a different size, or check model access for \`gpt-image-2\`.`,
    },
  };
}

async function thumbnailReferenceAdd(args) {
  const imagePath = path.resolve(String(args.imagePath || "").replace(/^file:\/\//, ""));
  try {
    await fs.access(imagePath);
  } catch {
    return imageErrorArtifact(`Reference image not found: ${imagePath}`);
  }

  const db = await readDb();
  const reference = {
    id: crypto.randomUUID(),
    path: imagePath,
    label: String(args.label || path.basename(imagePath)),
    createdAt: new Date().toISOString(),
  };
  db.thumbnailBoard.references.unshift(reference);
  await writeDb(db);
  return {
    ok: true,
    reference,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "grid"),
    message: `Added ${reference.label} as a thumbnail reference image.`,
  };
}

async function thumbnailLoadingPrepare(args) {
  const runId = crypto.randomUUID();
  const count = 1;
  const mode = args.mode === "edit" ? "edited" : "generated";
  let target = null;
  const { db } = await updateDb(async (currentDb) => {
    target = mode === "edited" ? thumbnailByNumberOrSelected(currentDb, args.number, args.targetId) : null;
    const placeholders = Array.from({ length: count }, (_unused, index) => ({
      id: crypto.randomUUID(),
      number: currentDb.thumbnailBoard.nextNumber++,
      runId,
      status: "loading",
      type: mode,
      prompt: String(args.prompt || ""),
      size: "1536x1024",
      parentId: target?.id || null,
      createdAt: new Date().toISOString(),
      loadingLabel: count > 1 ? `Generating ${index + 1}/${count}` : mode === "edited" ? "Editing" : "Generating",
    }));

    currentDb.thumbnailBoard.images.unshift(...placeholders);
    if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
      currentDb.thumbnailBoard.selectedId = null;
      currentDb.thumbnailBoard.view = "grid";
      currentDb.thumbnailBoard.page = 1;
    }
  });
  const view = db.thumbnailBoard.view === "selected" && db.thumbnailBoard.selectedId ? "selected" : "grid";
  return {
    ok: true,
    runId,
    targetId: target?.id || null,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, view),
  };
}

async function thumbnailGenerate(args) {
  try {
    const db = await readDb();
    const prompt = thumbnailPrompt(String(args.prompt || ""), db.thumbnailBoard.references.length > 0);
    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 4);

    const generated = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt,
          size,
          inputPaths: referencePaths,
        });
        return thumbnailRecord(image, args.prompt, "generated", size);
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, generated);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: generated.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailEdit(args) {
  try {
    const db = await readDb();
    const target = thumbnailByNumberOrSelected(db, args.number, args.targetId);
    if (!target) {
      return imageErrorArtifact("No thumbnail is selected. Say a number, like 'edit number two', or generate a thumbnail first.");
    }

    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 3);
    const inputPaths = [target.path, ...referencePaths].filter(Boolean);
    const editPrompt = editThumbnailPrompt(String(args.prompt || ""), target.prompt || "");

    const edited = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt: editPrompt,
          size,
          inputPaths,
        });
        return {
          ...thumbnailRecord(image, args.prompt, "edited", size),
          parentId: target.id,
        };
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, edited);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: edited.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailSelect(args) {
  const db = await readDb();
  const number = Number(args.number || 0);
  const selected = db.thumbnailBoard.images.find((image) => image.number === number);
  if (!selected) {
    return imageErrorArtifact(`Thumbnail number ${number} does not exist yet.`);
  }
  if (selected.status === "loading") {
    return imageErrorArtifact(`Thumbnail number ${number} is still generating.`);
  }
  db.thumbnailBoard.selectedId = selected.id;
  db.thumbnailBoard.view = "selected";
  await writeDb(db);
  return {
    ok: true,
    selected,
    selectedNumber: number,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "selected"),
    message: `Selected thumbnail ${number}.`,
  };
}

async function createThumbnailImage({ prompt, size, inputPaths }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env.local.");
  }

  if (inputPaths.length > 0) {
    return await editImageWithInputs({ apiKey, prompt, size, inputPaths });
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "medium",
    }),
  });

  if (!response.ok) {
    throw new Error(`Thumbnail generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function editImageWithInputs({ apiKey, prompt, size, inputPaths }) {
  const buildForm = async (imageFieldName) => {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "medium");
    for (const inputPath of inputPaths.slice(0, 10)) {
      const buffer = await fs.readFile(inputPath);
      form.append(imageFieldName, new Blob([buffer], { type: mimeForPath(inputPath) }), path.basename(inputPath));
    }
    return form;
  };

  let response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: await buildForm("image[]"),
  });

  if (!response.ok) {
    const firstError = await response.text();
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: await buildForm("image"),
    });
    if (!response.ok) {
      throw new Error(`Thumbnail edit failed: ${response.status} ${await response.text() || firstError}`);
    }
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function saveImageResponse(data, prefix) {
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image response did not include image data.");
  }
  await fs.mkdir(dataDir, { recursive: true });
  const imagePath = path.join(dataDir, `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
  await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
  return { path: imagePath, dataUrl: `data:image/png;base64,${b64}` };
}

function thumbnailRecord(image, prompt, type, size) {
  return {
    id: crypto.randomUUID(),
    type,
    path: image.path,
    prompt: String(prompt || ""),
    size,
    createdAt: new Date().toISOString(),
  };
}

function thumbnailPrompt(prompt, hasReferences) {
  return [
    hasReferences ? "Use the provided reference image(s) of Sarah as the identity reference." : "",
    "Create one 16:9 YouTube thumbnail.",
    "Follow this request literally. Do not add extra concepts, fake UI, extra text, watermarks, or unrelated elements.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function editThumbnailPrompt(prompt, originalPrompt) {
  return [
    "Edit the provided thumbnail image.",
    "Make only this change. Preserve everything else unless the request says otherwise.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function thumbnailByNumberOrSelected(db, number, targetId) {
  const candidate = targetId
    ? db.thumbnailBoard.images.find((image) => image.id === targetId) || null
    : number
      ? db.thumbnailBoard.images.find((image) => image.number === Number(number)) || null
      : db.thumbnailBoard.selectedId
        ? db.thumbnailBoard.images.find((image) => image.id === db.thumbnailBoard.selectedId) || null
        : null;
  if (candidate?.status === "loading") return null;
  return candidate;
}

function replaceLoadingThumbnails(db, runId, records) {
  if (!runId) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  const placeholders = db.thumbnailBoard.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.runId === runId && image.status === "loading");

  if (placeholders.length === 0) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  for (const [recordIndex, placeholder] of placeholders.entries()) {
    const replacement = records[recordIndex];
    if (replacement) db.thumbnailBoard.images[placeholder.index] = { ...replacement, number: placeholder.image.number };
  }

  if (records.length > placeholders.length) {
    db.thumbnailBoard.images.unshift(...records.slice(placeholders.length).map((record) => assignThumbnailNumber(db, record)));
  }
}

async function removeLoadingThumbnailRun(runId) {
  await updateDb(async (db) => {
    db.thumbnailBoard.images = db.thumbnailBoard.images.filter(
      (image) => !(image.runId === runId && image.status === "loading"),
    );
    db.thumbnailBoard.view = "grid";
    if (db.thumbnailBoard.selectedId && !db.thumbnailBoard.images.some((image) => image.id === db.thumbnailBoard.selectedId)) {
      db.thumbnailBoard.selectedId = null;
    }
  });
}

function thumbnailNumber(db, id) {
  return db.thumbnailBoard.images.find((image) => image.id === id)?.number || null;
}

function assignThumbnailNumber(db, image) {
  if (Number.isInteger(image.number) && image.number > 0) return image;
  return { ...image, number: db.thumbnailBoard.nextNumber++ };
}

function pageForArgs(args) {
  const page = Number(args?.page || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function sortedThumbnailImages(db) {
  return [...db.thumbnailBoard.images].sort((a, b) => (b.number || 0) - (a.number || 0));
}

function paginatedThumbnailImages(db, page = db.thumbnailBoard.page || 1) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const start = (page - 1) * pageSize;
  return sortedThumbnailImages(db).slice(start, start + pageSize);
}

function thumbnailPageMeta(db) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const totalImages = db.thumbnailBoard.images.length;
  return {
    page: db.thumbnailBoard.page || 1,
    pageSize,
    totalImages,
    totalPages: Math.max(1, Math.ceil(totalImages / pageSize)),
    nextNumber: db.thumbnailBoard.nextNumber,
  };
}

function thumbnailBoardSummary(db) {
  const board = db.thumbnailBoard;
  const selectedNumber = board.selectedId ? thumbnailNumber(db, board.selectedId) : null;
  const page = thumbnailPageMeta(db);
  return {
    view: board.view,
    selectedNumber,
    references: board.references.length,
    page,
    images: paginatedThumbnailImages(db, page.page).map((image) => ({
      number: image.number,
      id: image.id,
      status: image.status === "loading" ? "loading" : "ready",
      type: image.type || "thumbnail",
      prompt: image.prompt || "",
    })),
  };
}

function buildThumbnailBoardInstructions(db) {
  const summary = thumbnailBoardSummary(db);
  const imageLines = summary.images.length
    ? summary.images
        .map((image) => `- #${image.number}: ${image.status}${image.status === "ready" ? `, ${image.type}` : ""}${image.prompt ? `, prompt: ${image.prompt.slice(0, 120)}` : ""}`)
        .join("\n")
    : "- No generated thumbnails yet.";

  return `# Current Thumbnail Board State
Reference images loaded: ${summary.references}
Current view: ${summary.view}
Selected thumbnail number: ${summary.selectedNumber || "none"}
Current page: ${summary.page.page}/${summary.page.totalPages}
Total thumbnails: ${summary.page.totalImages}
Next new thumbnail number: ${summary.page.nextNumber}
Visible permanent thumbnail numbers:
${imageLines}

When Sarah says "pull up number N", "select N", or "show N", call thumbnail_select with that permanent number. When Sarah says "edit this", use thumbnail_edit with no number if a selected thumbnail number exists. When Sarah says "edit number N", call thumbnail_edit with that permanent number. When she asks for older thumbnails or another page, call thumbnail_grid with the requested page. Do not claim you cannot see prior thumbnails; this board state is persistent and paginated.`;
}

async function thumbnailBoardArtifact(db, view) {
  const board = db.thumbnailBoard;
  const selected = board.images.find((image) => image.id === board.selectedId) || null;
  const page = thumbnailPageMeta(db);
  const visibleImages = view === "selected" && selected ? [selected] : paginatedThumbnailImages(db, page.page);
  const images = await Promise.all(
    visibleImages.map(async (image) => {
      const src = image.path ? await imageDataUrl(image.path) : null;
      return {
        ...image,
        number: image.number,
        src,
        selected: selected?.id === image.id,
      };
    }),
  );

  return {
    title: view === "selected" && selected ? `Thumbnail ${thumbnailNumber(db, selected.id)}` : "Thumbnail Board",
    kind: "thumbnailBoard",
    fullscreen: view === "selected",
    content: JSON.stringify({
      view,
      selectedId: board.selectedId,
      references: board.references,
      page,
      images,
    }),
  };
}

async function imageDataUrl(imagePath) {
  const buffer = await fs.readFile(imagePath);
  return `data:${mimeForPath(imagePath)};base64,${buffer.toString("base64")}`;
}

function mimeForPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function recordsArtifact(records, collection) {
  return {
    title: `Records: ${collection}`,
    kind: "table",
    content: JSON.stringify(records, null, 2),
  };
}

function normalizeMermaidDiagram(diagram, title) {
  const stripped = diagram
    .replace(/```mermaid/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!stripped) {
    return fallbackMermaidDiagram(title);
  }

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/\s+-->\s+/g, " --> ")
        .replace(/\s+---\s+/g, " --- "),
    );

  const hasDiagramHeader = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/i.test(
    lines[0] || "",
  );

  return hasDiagramHeader ? lines.join("\n") : `flowchart TD\n${lines.join("\n")}`;
}

function fallbackMermaidDiagram(title) {
  const safeTitle = String(title || "Chart").replace(/["<>]/g, "");
  return `flowchart TD\n  A["${safeTitle}"] --> B["Chart request received"]\n  B --> C["Jarvis will show a safe fallback if syntax fails"]`;
}

function isJarvisApplicationPath(appPath) {
  const resolvedApp = path.resolve(String(appPath || ""));
  if (!resolvedApp || /default_app\.asar/i.test(resolvedApp)) return false;
  try {
    return resolvedApp === path.resolve(process.cwd());
  } catch {
    return false;
  }
}

if (singleInstance.gotLock) {
  app.whenReady().then(() => {
    const appPath = typeof app.getAppPath === "function" ? app.getAppPath() : "";
    // Never treat Electron's default_app as Jarvis; require the repository app path.
    if (!isJarvisApplicationPath(appPath)) {
      console.error(
        "[jarvis-launch] refused non-Jarvis app path",
        JSON.stringify({ appPath, cwd: process.cwd() }),
      );
      app.quit();
      return;
    }
    // Ready is emitted from createWindow only after load + visible on-screen show.
    void createWindow().catch((error) => {
      const detail = sanitizeRendererLoadFailure(
        {
          errorCode: null,
          errorDescription: error && error.message ? String(error.message) : "window_create_failed",
          validatedURL: null,
        },
        sanitizeDiagnosticText,
      );
      console.error("[jarvis-launch] window-create-failed", JSON.stringify(detail));
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}
