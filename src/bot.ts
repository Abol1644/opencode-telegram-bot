import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { chunkMessage, escapeHtml } from "./telegram/chunker.js";
import {
  getSessionId,
  newSessionId,
  setSessionId,
  listSessions,
  runOpenCode,
  abortRun,
  isRunning,
  getActiveRun,
  getAllActiveRuns,
  killAllRuns,
} from "./opencode/runner.js";

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(config.BOT_TOKEN);

// Auth guard — must be before all handlers
bot.use(authMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  "🤖 <b>OpenCode Telegram Bot</b>",
  "",
  "Available commands:",
  "• /start — Show this help",
  "• /help — Show this help",
  "• /status — Bot & OpenCode diagnostics",
  "• /new [title] — Create a new session",
  "• /run &lt;prompt&gt; — Run a prompt in the active session",
  "• /abort — Abort the current run",
  "• /sessions — List known sessions",
  "",
  "💡 Any plain text message is treated as <code>/run &lt;text&gt;</code>.",
  "",
  `Bot: ${escapeHtml(config.BOT_USERNAME)}`,
].join("\n");

const startTime = Date.now();

async function getOpenCodeVersion(): Promise<string> {
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<string>((resolve) => {
      const isWin = process.platform === "win32";
      const child = spawn("opencode", ["--version"], {
        shell: isWin,
        windowsHide: true,
      });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", () => resolve(out.trim().split("\n").pop()?.trim() ?? "unknown"));
      child.on("error", () => resolve("not found"));
      setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve("timeout");
      }, 3000);
    });
  } catch {
    return "unknown";
  }
}

async function sendChunkedHtml(ctx: { reply: (t: string, o?: unknown) => Promise<unknown> }, text: string): Promise<void> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("can't parse") || msg.toLowerCase().includes("parse entities")) {
        await ctx.reply(chunk);
      } else {
        throw err;
      }
    }
  }
}

// Throttled edit helper for streaming
function createStreamingSender(ctx: { reply: (t: string, o?: unknown) => Promise<unknown>; api: { editMessageText: (c: string | number, m: number, t: string, o?: unknown) => Promise<unknown> } }, chatId: number) {
  let messageId: number | null = null;
  let lastEdit = 0;
  let pendingText = "";
  const EDIT_INTERVAL_MS = 1200;

  return {
    async init(initialText: string) {
      const msg = (await ctx.reply(initialText, { parse_mode: "HTML" })) as { message_id?: number };
      messageId = msg?.message_id ?? null;
      pendingText = initialText;
      lastEdit = Date.now();
      return messageId;
    },
    async append(delta: string) {
      pendingText += delta;
      const now = Date.now();
      if (now - lastEdit < EDIT_INTERVAL_MS) return;
      if (messageId === null) return;
      // Avoid editing with >3900 chars — Telegram will reject; we flush instead
      const display = pendingText.length > 3900 ? pendingText.slice(-3900) : pendingText;
      try {
        await ctx.api.editMessageText(chatId, messageId, display, { parse_mode: "HTML" });
        lastEdit = now;
      } catch {
        // Editing can fail if message not modified or too frequent — ignore
      }
    },
    async finalize(finalText: string) {
      pendingText = finalText;
      if (messageId === null) {
        await sendChunkedHtml(ctx, finalText);
        return;
      }
      // If final text is huge, send as new chunked messages after the streaming one
      if (finalText.length <= 3900) {
        try {
          await ctx.api.editMessageText(chatId, messageId, finalText, { parse_mode: "HTML" });
          return;
        } catch {
          // fallback to chunked send
        }
      }
      // Fallback: edit first chunk, then send rest as new messages
      const chunks = chunkMessage(finalText);
      try {
        await ctx.api.editMessageText(chatId, messageId, chunks[0] ?? finalText.slice(0, 3900), {
          parse_mode: "HTML",
        });
      } catch {
        await ctx.reply(chunks[0] ?? finalText.slice(0, 3900), { parse_mode: "HTML" }).catch(async () => {
          await ctx.reply(chunks[0] ?? finalText.slice(0, 3900));
        });
      }
      for (let i = 1; i < chunks.length; i++) {
        try {
          await ctx.reply(chunks[i]!, { parse_mode: "HTML" });
        } catch {
          await ctx.reply(chunks[i]!);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command("start", async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
});

bot.command("status", async (ctx) => {
  const chatId = ctx.chat?.id;
  const sessionId = chatId ? getSessionId(chatId) : "—";
  const running = chatId ? isRunning(chatId) : false;
  const active = chatId ? getActiveRun(chatId) : undefined;
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const uptime =
    uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
        ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
        : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  const ocVersion = await getOpenCodeVersion();

  const lines = [
    "📊 <b>Status</b>",
    `• Uptime: ${escapeHtml(uptime)}`,
    `• Node: ${escapeHtml(process.version)}`,
    `• Platform: ${escapeHtml(process.platform)} ${escapeHtml(process.arch)}`,
    `• OpenCode: ${escapeHtml(ocVersion)}`,
    `• Active session: <code>${escapeHtml(sessionId)}</code>`,
    `• Running: ${running ? `⏳ yes — <code>${escapeHtml(active?.prompt.slice(0, 80) ?? "")}</code>` : "idle"}`,
    `• Sessions tracked: ${listSessions().length}`,
    `• Active jobs total: ${getAllActiveRuns().size}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const title = ctx.match?.toString().trim() ?? "";
  const sid = newSessionId(chatId, title || undefined);
  if (isRunning(chatId)) {
    await ctx.reply(
      `🆕 New session created: <code>${escapeHtml(sid)}</code>\n⚠️ A run is still in progress — it will continue on the previous session. Use /abort to stop it.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  await ctx.reply(`🆕 New session: <code>${escapeHtml(sid)}</code>\nSend <code>/run &lt;prompt&gt;</code> or just type a message.`, {
    parse_mode: "HTML",
  });
});

bot.command("sessions", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const activeId = getSessionId(chatId);
  const all = listSessions();
  if (all.length === 0) {
    await ctx.reply(`No sessions yet. Active would be: <code>${escapeHtml(activeId)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }
  const lines = ["📋 <b>Sessions</b>", ""];
  for (const s of all) {
    const marker = s.sessionId === activeId && s.chatId === chatId ? " ← active" : "";
    const running = isRunning(s.chatId) ? " ⏳ running" : "";
    lines.push(`• chat <code>${s.chatId}</code>: <code>${escapeHtml(s.sessionId)}</code>${marker}${running}`);
  }
  // Also allow switching via /new or direct session id
  lines.push("", `Your active: <code>${escapeHtml(activeId)}</code>`, "Use /new [title] to create a new one.");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("abort", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!isRunning(chatId)) {
    await ctx.reply("No active run to abort.");
    return;
  }
  const ok = await abortRun(chatId);
  await ctx.reply(ok ? "🛑 Aborted." : "⚠️ Nothing to abort or abort failed.");
});

async function handleRun(ctx: { chat?: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown>; api: { editMessageText: (c: string | number, m: number, t: string, o?: unknown) => Promise<unknown>; sendChatAction: (c: number, a: string) => Promise<unknown> } }, rawPrompt: string) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const prompt = rawPrompt.trim();
  if (!prompt) {
    await ctx.reply("Usage: /run &lt;prompt&gt;\nExample: <code>/run fix the build error in src/bot.ts</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  if (isRunning(chatId)) {
    const active = getActiveRun(chatId);
    await ctx.reply(
      `⏳ A run is already in progress:\n<code>${escapeHtml(active?.prompt.slice(0, 300) ?? "")}</code>\nUse /abort to cancel it.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const sessionId = getSessionId(chatId);

  // Show typing indicator
  try {
    await ctx.api.sendChatAction(chatId, "typing");
  } catch {}

  const streamer = createStreamingSender(ctx as never, chatId);
  let fullOutput = "";
  let hasError = false;
  let errorText = "";

  await streamer.init(`⏳ <b>Running</b> on <code>${escapeHtml(sessionId)}</code>…\n<code>${escapeHtml(prompt.slice(0, 500))}</code>`);

  // Periodic typing keepalive
  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    await new Promise<void>((resolve, reject) => {
      try {
        runOpenCode(
          chatId,
          { prompt, sessionId },
          {
            onTextDelta: (delta) => {
              fullOutput += delta;
              // Throttled edit
              void streamer.append(delta);
            },
            onError: (msg) => {
              hasError = true;
              errorText += (errorText ? "\n" : "") + msg;
            },
            onClose: (code, signal) => {
              clearInterval(typingInterval);
              if (code !== 0 && code !== null && hasError) {
                // Will be handled in finalize
              }
              if (signal) {
                fullOutput += `\n\n[terminated: ${signal}]`;
              }
              resolve();
            },
          },
        );
      } catch (err) {
        clearInterval(typingInterval);
        reject(err);
      }
    });

    let finalText: string;
    if (fullOutput.trim()) {
      finalText = hasError ? `${fullOutput}\n\n⚠️ ${escapeHtml(errorText.slice(0, 1000))}` : fullOutput;
    } else if (hasError) {
      finalText = `⚠️ Error:\n${escapeHtml(errorText.slice(0, 3500))}`;
    } else {
      finalText = "✅ Done — no output.";
    }

    // If output is very long, truncate streaming finalization will chunk it
    await streamer.finalize(finalText);
  } catch (err) {
    clearInterval(typingInterval);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to start run: ${escapeHtml(msg).slice(0, 3500)}`, { parse_mode: "HTML" }).catch(async () => {
      await ctx.reply(`Failed to start run: ${msg.slice(0, 3500)}`);
    });
  } finally {
    clearInterval(typingInterval);
  }
}

bot.command("run", async (ctx) => {
  const prompt = ctx.match?.toString() ?? "";
  await handleRun(ctx as never, prompt);
});

// Plain text -> /run sugar (ignore commands already handled)
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    // Unknown command — let grammY handle or show help
    const known = ["start", "help", "status", "new", "run", "abort", "sessions"];
    const cmd = text.slice(1).split(/[\s@]+/)[0]?.toLowerCase() ?? "";
    if (!known.includes(cmd)) {
      await ctx.reply(`Unknown command /${escapeHtml(cmd)}. Try /help.`, { parse_mode: "HTML" });
    }
    return;
  }
  await handleRun(ctx as never, text);
  await next();
});

// Fallback for unknown commands that slipped through
bot.on("message", async (_ctx, next) => {
  await next();
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

bot.catch((err) => {
  const e = err.error;
  const msg = e instanceof Error ? e.message : String(e);
  // Never log token
  console.error(`[bot] Unhandled error: ${msg.slice(0, 500)}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let runnerHandle: ReturnType<typeof run> | null = null;

function shutdown(signal: string) {
  console.log(`[bot] Received ${signal}, shutting down…`);
  try {
    killAllRuns();
  } catch {}
  if (runnerHandle) {
    try {
      runnerHandle.stop();
    } catch {}
  }
  // Give a moment for kills to propagate
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[bot] Starting ${config.BOT_USERNAME} (admin: ${config.ADMIN_ID})…`);
  // Validate opencode availability (non-fatal)
  const ocVersion = await getOpenCodeVersion();
  console.log(`[bot] OpenCode version: ${ocVersion}`);
  runnerHandle = run(bot);
  console.log("[bot] Runner started — polling Telegram.");
}

main().catch((err) => {
  console.error("[bot] Failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
