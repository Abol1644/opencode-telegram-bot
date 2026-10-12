# OpenCode Telegram Bot

> Manage local [OpenCode](https://opencode.ai) coding-agent sessions remotely from Telegram — securely, from anywhere.

A production-ready Node.js bot that bridges your Telegram admin account to the OpenCode CLI running on a Windows host. Send prompts, stream results, switch sessions, and kill runaway jobs without opening a terminal.

---

## Features

- **Single-admin security guard** — every update passes an `ADMIN_ID` check before reaching any handler.
- **Live streaming NDJSON parsing** — spawns `opencode run --format json`, parses line-delimited events (`text`, `tool_use`, `error`) and streams deltas back to Telegram.
- **4096-char chunking with HTML fallback** — safely splits long output without breaking code fences or words; retries as plain text if Telegram rejects HTML entity parsing.
- **Session management** — per-chat `sessionId` tracking, `/new` / `/sessions` switching, default session auto-creation.
- **Windows process-tree cleanup** — `tree-kill` terminates the entire `opencode.cmd` child tree (`SIGKILL` → `SIGTERM` fallback) to avoid orphaned background processes.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` kills all active runs and stops the grammY runner.

---

## Architecture & Data Flow

```
┌─────────────────────┐
│  Admin Telegram      │
│  Client (phone /     │
│  desktop)            │
└─────────┬───────────┘
          │  message / command
          ▼
┌─────────────────────┐
│  Telegram Bot API    │  (long polling)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  grammY + Runner     │  @grammyjs/runner
│  Bot instance        │  concurrent update handling
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Auth Middleware     │  ctx.from.id === ADMIN_ID ?
│  src/middleware/     │  ├─ yes → next()
│  auth.ts             │  └─ no  → "⛔ Unauthorized"
└─────────┬───────────┘
          │  authorized only
          ▼
┌─────────────────────┐
│  OpenCode CLI Runner │  spawn("opencode", ["run","--format","json","--session",id])
│  src/opencode/       │  shell:true on Windows, ChildProcess
│  runner.ts           │  readline NDJSON → onTextDelta / onError
└─────────┬───────────┘
          │  stdout (NDJSON) / stderr
          ▼
┌─────────────────────┐
│  Telegram Chunker    │  chunkMessage() ≤3900 chars
│  src/telegram/       │  escapeHtml(), throttled editMessageText
│  chunker.ts          │  fallback: plain text on parse failure
└─────────┬───────────┘
          │  sendMessage / editMessageText
          ▼
┌─────────────────────┐
│  Admin Telegram      │
│  Client              │  receives streamed output
└─────────────────────┘

  Abort path:  /abort  →  abortRun(chatId)  →  tree-kill(pid, "SIGKILL")  →  cleanup map
  Shutdown:    SIGINT/SIGTERM  →  killAllRuns()  →  runner.stop()
```

**Key modules:**

| Module | Responsibility |
|--------|---------------|
| `src/config.ts` | `dotenv` + Zod validation for `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_ID` |
| `src/middleware/auth.ts` | Admin guard |
| `src/telegram/chunker.ts` | Chunking, HTML escaping, fallback |
| `src/opencode/runner.ts` | Session map, process map, spawn & streaming, abort |
| `src/bot.ts` | Command handlers, streaming sender, lifecycle |

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | `>= 20` (tested on `24.18.0`) | ESM / `NodeNext` required |
| **pnpm** | `>= 11` (tested on `11.28.5`) | `npm` works but `pnpm` is recommended |
| **OpenCode CLI** | `>= 1.19.0` | `npm i -g opencode-ai` or equivalent |
| **Telegram Bot** | — | Created via [@BotFather](https://t.me/BotFather) |

OpenCode must be authenticated before first use:

```powershell
opencode --version
opencode /connect   # or opencode auth — follow the provider login flow
```

---

## Setup & Configuration

### 1. Clone & Install

```powershell
git clone <your-repo-url> opencode-telegram-bot
cd opencode-telegram-bot
pnpm install
```

### 2. Environment Variables

Copy the example and fill in your values:

```powershell
Copy-Item .env.example .env
```

`.env.example`:

```ini
BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
BOT_USERNAME=@your_bot_username
ADMIN_ID=123456789
```

| Variable | Description | Example |
|----------|-------------|---------|
| `BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather) (`/newbot`) | `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ` |
| `BOT_USERNAME` | Bot username (with or without `@` — normalized automatically) | `@your_bot_username` |
| `ADMIN_ID` | Telegram numeric user ID of the sole admin (get from [@userinfobot](https://t.me/userinfobot)) | `123456789` |

> **Security note:** `.env` is gitignored and **never committed**. The bot only responds to the configured `ADMIN_ID`; all other users receive `⛔ Unauthorized — this bot is private and only responds to its admin.` and the update is dropped. Never share `BOT_TOKEN` or commit it to version control.

Validate config without starting the bot:

```powershell
pnpm exec tsx --eval "import { config } from './src/config.ts'; console.log(config.BOT_USERNAME)"
```

---

## Available Commands & Usage

All commands are admin-only.

| Command | Usage | Description |
|---------|-------|-------------|
| `/start` | `/start` | Show welcome message and command list |
| `/help` | `/help` | Alias for `/start` |
| `/status` | `/status` | Uptime, Node version, platform, OpenCode version, active session ID, running state, tracked sessions |
| `/new` | `/new [title]` | Create a new session for this chat. Optional `title` slugifies into the session ID (e.g., `/new fix-auth`) |
| `/run` | `/run <prompt>` | Execute a prompt in the active session. Streams output back as throttled edits + chunked messages |
| `/abort` | `/abort` | Kill the currently running OpenCode job for this chat (tree-kill `SIGKILL`) |
| `/sessions` | `/sessions` | List all known sessions with `chatId → sessionId`, marks the active one and running state |
| *(implicit)* | `<plain text>` | Any non-command text is treated as `/run <text>` — just type your prompt |

**Examples:**

```
/new refactor-login
/run fix the failing test in src/middleware/auth.test.ts
explain what tree-kill does on Windows
/abort
/status
```

Unknown commands receive: `Unknown command /foo. Try /help.`

---

## Execution & Deployment

### Development

Hot-reload via `tsx watch` (no build step):

```powershell
pnpm dev
# tsx watch src/bot.ts
```

### Production

Compile then run:

```powershell
pnpm build   # tsc → dist/
pnpm start   # node dist/bot.js
```

### Persistent Background Service (Windows)

Use [PM2](https://pm2.keymetrics.io/) to keep the bot alive across reboots and restarts:

```powershell
# One-time: install PM2 globally
npm i -g pm2

# Build first
pnpm build

# Start as a named service
pm2 start dist/bot.js --name opencode-tg

# Save process list and enable startup on boot
pm2 save
pm2 startup   # follow the printed instructions (Windows: pm2-installer or Task Scheduler)

# Useful PM2 commands
pm2 logs opencode-tg      # stream logs
pm2 restart opencode-tg   # restart after config change
pm2 stop opencode-tg      # stop
pm2 delete opencode-tg    # remove
pm2 monit                 # dashboard
```

Alternative on Windows: register via Task Scheduler or run as a Windows Service with [`node-windows`](https://github.com/coreybutler/node-windows).

---

## Windows & Process Management Notes

OpenCode on Windows is installed as `opencode.cmd` (a `cmd` shim) rather than a native `.exe`. The bot accounts for this:

- **Spawn:** `spawn("opencode", args, { shell: true, windowsHide: true })` — `shell:true` lets `PATHEXT` resolve `.cmd`/`.ps1` and handles spaces in `PATH`. Without it, `ENOENT` errors occur on some setups.
- **Termination:** `tree-kill` is used in `abortRun(chatId)` and `killAllRuns()`:

  ```ts
  import kill from "tree-kill";
  kill(pid, "SIGKILL", (err) => {
    if (err) kill(pid, "SIGTERM", () => {});
  });
  ```

  On Windows, a plain `child.kill()` only kills the parent `cmd.exe` shim, leaving the actual `opencode` Node process orphaned. `tree-kill` walks the process tree and terminates all descendants, preventing zombie `opencode` jobs that continue consuming tokens and holding file locks.

- **Graceful shutdown:** `process.on("SIGINT"/"SIGTERM")` calls `killAllRuns()` then `runner.stop()` before exiting.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `⛔ Unauthorized — this bot is private…` | Your Telegram user ID does not match `ADMIN_ID` | Check your ID via [@userinfobot](https://t.me/userinfobot) and update `.env` → restart bot |
| `BOT_TOKEN is required` / `ADMIN_ID must be a positive integer` on startup | `.env` missing or malformed | Ensure `.env` exists next to `package.json`, copy from `.env.example`, no quotes needed, restart |
| `'opencode' is not recognized` / `spawn opencode ENOENT` | OpenCode CLI not in `PATH` for the bot's shell | Reinstall globally: `npm i -g opencode-ai`, verify `opencode --version` and `where opencode` in a **new** terminal, restart bot/PM2 |
| `Bad Request: can't parse entities` then plain text fallback | Telegram rejected HTML parsing (unescaped `<`, `&`, etc.) | Automatic — `chunker.ts` retries as plain text. If you use MarkdownV2, ensure `escapeMarkdownV2` is applied |
| Output truncated / `… (truncated)` | Message exceeded Telegram limits | Use `/sessions` then re-run with a narrower prompt, or check full session via OpenCode TUI locally |
| `A run is already in progress` | One chat = one concurrent run | Use `/abort` to cancel, or wait for completion |
| Bot stops after closing terminal | Not running as a service | Use PM2 (`pm2 start dist/bot.js --name opencode-tg --watch` is not needed — use `pm2 save`) |
| `tree-kill` leaves process running | Rare on Windows with deeply nested children | `pm2 logs` → note PID, `taskkill /PID <pid> /T /F` as manual fallback, then `pm2 restart` |
| `pnpm` store warning `D:\.pnpm-store` | pnpm store is on `D:` not `C:` | Harmless — set `storeDir` in `pnpm-workspace.yaml` if you want to silence it |

**Still stuck?**

1. Check logs: `pm2 logs opencode-tg` or foreground `pnpm dev`.
2. Validate config: `pnpm exec tsx --eval "import {config} from './src/config.ts'; console.log('ok', config.BOT_USERNAME)"`
3. Validate OpenCode: `opencode --version` and `opencode run --format json "hello"` locally.
4. Ensure `.env` is gitignored: `git check-ignore -v .env` should print `.gitignore:1:.env`.

---

## Project Structure

```
opencode-telegram-bot/
├── src/
│   ├── config.ts              # env + Zod validation
│   ├── bot.ts                 # grammY bot, commands, streaming
│   ├── middleware/auth.ts     # admin guard
│   ├── opencode/runner.ts     # session & process manager
│   └── telegram/chunker.ts    # chunking & HTML escaping
├── dist/                      # compiled JS (pnpm build)
├── .env                       # secrets (gitignored)
├── .env.example               # placeholder template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

ISC
