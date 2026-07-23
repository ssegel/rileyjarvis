# RileyJarvis

RileyJarvis is a local Electron desktop AI companion with realtime voice, a visual artifact panel, image generation, web search, notes, and opt-in macOS computer control.

It is built with Electron, React, Vite, TypeScript, and the OpenAI Realtime API.

## Features

- Realtime speech-to-speech conversation with OpenAI Realtime.
- Animated companion face with listening, thinking, speaking, and working states.
- Artifact panel for markdown, menus, notes, Mermaid diagrams, generated images, records, and progress.
- YouTube thumbnail board with persistent numbered generations and image edits.
- Optional Exa-powered web search.
- Local notes, records, and personal memory stored at runtime under `data/`.
- Optional computer-use mode for opening apps, clicking, typing, scrolling, screenshots, and UI inspection on macOS and Windows 11.

## Requirements

- macOS or Windows 11
- Node.js 20+
- npm
- An OpenAI API key with Realtime and image generation access
- Optional: an Exa API key for web search

Computer-use mode works on macOS and Windows 11. Voice, artifacts, notes, records, personal memory, image, and web-search features are available on both.

## Quick Start

### macOS

```bash
git clone https://github.com/rileybrown/rileyjarvis.git
cd rileyjarvis
npm install
cp .env.example .env.local
npm run dev
```

### Windows PowerShell

```powershell
git clone https://github.com/rileybrown/rileyjarvis.git
Set-Location rileyjarvis
npm install
Copy-Item .env.example .env.local
npm run dev
```

In Command Prompt, use `cd rileyjarvis` and `copy .env.example .env.local` instead.

Edit `.env.local` before starting voice features:

```bash
OPENAI_API_KEY=your_openai_api_key_here
EXA_API_KEY=your_exa_api_key_here
```

`OPENAI_API_KEY` is required. `EXA_API_KEY` is optional; web search will show a setup message when it is missing.

## macOS Permissions

RileyJarvis runs locally. Depending on the features you use, macOS may ask for:

- Microphone permission for voice conversation.
- Accessibility permission for computer-control tools.
- Screen Recording permission for screenshots and screen inspection.

Computer-control tools are blocked until the app is in computer-use mode.

## Development

```bash
npm run dev
```

This starts Vite on `127.0.0.1:5173` and launches Electron.

Other useful commands:

```bash
npm run typecheck
npm run build
npm start
```

## Runtime Data

The app creates a local `data/` directory for notes, records, generated images, thumbnail-board state, and personal memory. That directory is intentionally ignored by Git.

### Personal memory (`data/memory/`)

| Path | Purpose |
|---|---|
| `instructions.md` | Durable personal operating instructions |
| `preferences.json` | Preferences and hard interaction rules |
| `profile.json` | Profile facts with provenance and sensitivity |
| `daily.json` | Today’s priorities, projects, commitments, follow-ups, unresolved items |
| `entries.json` | Durable memory entries |
| `archive/daily-YYYY-MM-DD.json` | Archived daily context after date rollover |
| `backups/{timestamp}-*.json` | Timestamped snapshots before destructive changes (last 10 retained) |

**Durability boundaries**

- Durable: instructions, preferences, profile, entries, and daily working context.
- Temporary: realtime conversation transcript stays in the current session only and is not written to memory files.
- Open/blocked daily items carry forward when the calendar date changes; done items do not.

**Privacy and sensitivity**

- Sensitivity levels: `normal`, `sensitive`, `secret`.
- `secret` values are excluded from automatic Realtime prompt injection.
- `sensitive` values appear in injected context only as redacted labels.
- Raw sensitive/secret content is available only through an explicit confirmed `memory_view`.
- Memory tool acknowledgements stay concise; secret payloads are not logged.

**Backup and OneDrive**

- Clearing memory or fully replacing instructions creates a backup snapshot first.
- Because `data/` is gitignored but may still sync if the project folder lives under OneDrive, treat memory files as local personal data and exclude or pause sync if needed.

**Memory commands**

- `memory_view` — view instructions, preferences, profile, daily, entries, or all
- `memory_remember` — store an entry or profile fact
- `memory_correct` — supersede a stored item while preserving history
- `memory_update_daily` — update today’s working context
- `memory_set_preference` — update preferences/hard rules
- `memory_set_instructions` — append or replace instructions (`confirmed=true` required for full replace)
- `memory_clear` — clear `daily`, `entries`, `preferences`, `instructions`, or `all` (`confirmed=true` required)

Do not commit:

- `.env.local`
- Anything under `data/`
- `dist/`
- `node_modules/`

## Security Notes

- API keys are loaded only from local environment files.
- `.env.local` and all `.env.*` files are ignored except `.env.example`.
- Generated images and local database files are ignored.
- Risky computer-control actions should require explicit confirmation.
- Typing and pressing Enter in computer-use mode are intentionally allowed without extra confirmation because they are core voice-control actions.

Before publishing a fork, run:

```bash
npm run typecheck
npm run build
git status --short
```

Then verify that no local secrets or runtime data are staged.

## License

MIT
