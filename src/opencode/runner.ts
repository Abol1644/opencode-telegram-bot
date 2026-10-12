import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import kill from "tree-kill";

// ---------------------------------------------------------------------------
// Session management — in-memory per chatId
// ---------------------------------------------------------------------------

const sessionByChat = new Map<number, string>();
const DEFAULT_SESSION_PREFIX = "tg-";

export function getSessionId(chatId: number): string {
  let sid = sessionByChat.get(chatId);
  if (!sid) {
    sid = `${DEFAULT_SESSION_PREFIX}${chatId}-${randomUUID().slice(0, 8)}`;
    sessionByChat.set(chatId, sid);
  }
  return sid;
}

export function setSessionId(chatId: number, sessionId: string): void {
  sessionByChat.set(chatId, sessionId);
}

export function newSessionId(chatId: number, title?: string): string {
  // Use title slug + uuid to keep sessions distinguishable; opencode will create
  // the session on first --session use if it doesn't exist.
  const slug = title
    ? title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 24)
    : "";
  const sid = slug
    ? `${DEFAULT_SESSION_PREFIX}${chatId}-${slug}-${randomUUID().slice(0, 6)}`
    : `${DEFAULT_SESSION_PREFIX}${chatId}-${randomUUID().slice(0, 8)}`;
  sessionByChat.set(chatId, sid);
  return sid;
}

export function listSessions(): Array<{ chatId: number; sessionId: string }> {
  return [...sessionByChat.entries()].map(([chatId, sessionId]) => ({ chatId, sessionId }));
}

// ---------------------------------------------------------------------------
// Running process tracking
// ---------------------------------------------------------------------------

type ActiveRun = {
  process: ChildProcess;
  prompt: string;
  startedAt: number;
};

const activeRuns = new Map<number, ActiveRun>();

export function isRunning(chatId: number): boolean {
  const entry = activeRuns.get(chatId);
  if (!entry) return false;
  // Process may have exited but map not yet cleaned
  return entry.process.exitCode === null && entry.process.signalCode === null;
}

export function getActiveRun(chatId: number): ActiveRun | undefined {
  return activeRuns.get(chatId);
}

export function getAllActiveRuns(): Map<number, ActiveRun> {
  return activeRuns;
}

// ---------------------------------------------------------------------------
// Opencode spawn — Windows-safe
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: "text"; delta?: string; text?: string; content?: string }
  | { type: "tool_use"; tool?: string; name?: string; input?: unknown }
  | { type: "error"; error?: string; message?: string }
  | { type: "done"; sessionId?: string }
  | Record<string, unknown>;

export type RunCallbacks = {
  onEvent?: (event: RunEvent, raw: string) => void;
  onTextDelta?: (delta: string) => void;
  onError?: (message: string) => void;
  onClose?: (code: number | null, signal: string | null) => void;
};

/**
 * Resolve the executable to spawn on Windows.
 * - `opencode.cmd` shim is installed by npm on Windows (C:\...\npm\opencode.cmd)
 * - Direct `opencode` relies on shell PATHEXT resolution, so we use shell:true
 * - Fallback to `npx opencode` if needed is handled by caller.
 */
function resolveOpenCodeCommand(): { command: string; shell: boolean } {
  if (process.platform === "win32") {
    // Using shell:true lets PATHEXT resolve opencode.cmd / .ps1 correctly and
    // also handles spaces in paths. This is the safest cross-install method.
    return { command: "opencode", shell: true };
  }
  return { command: "opencode", shell: false };
}

export type RunOptions = {
  prompt: string;
  sessionId?: string;
  model?: string;
  agent?: string;
};

/**
 * Spawn `opencode run --format json [--session <id>] <prompt>` and stream NDJSON.
 * Returns the ChildProcess. Caller should track it via activeRuns.
 */
export function runOpenCode(
  chatId: number,
  options: RunOptions,
  callbacks: RunCallbacks = {},
): ChildProcess {
  if (isRunning(chatId)) {
    throw new Error("A run is already in progress for this chat. Use /abort first.");
  }

  const sessionId = options.sessionId ?? getSessionId(chatId);
  // Ensure session map is up to date
  setSessionId(chatId, sessionId);

  const args: string[] = ["run", "--format", "json"];
  if (sessionId) args.push("--session", sessionId);
  if (options.model) args.push("--model", options.model);
  if (options.agent) args.push("--agent", options.agent);
  // Prompt is passed as positional args; use -- to avoid flag confusion but opencode
  // treats remaining positionals as message. Safer to push prompt as last arg.
  args.push(options.prompt);

  const { command, shell } = resolveOpenCodeCommand();

  const child = spawn(command, args, {
    shell,
    windowsHide: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeRuns.set(chatId, { process: child, prompt: options.prompt, startedAt: Date.now() });

  const cleanup = () => {
    activeRuns.delete(chatId);
  };

  // stdout is NDJSON — read line by line
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    let buffer = "";

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: RunEvent | null = null;
      let raw = trimmed;

      try {
        event = JSON.parse(trimmed) as RunEvent;
        raw = trimmed;
      } catch {
        // Not JSON — treat as plain text delta (some opencode versions emit plain lines)
        buffer += line + "\n";
        if (callbacks.onTextDelta) callbacks.onTextDelta(line + "\n");
        return;
      }

      if (callbacks.onEvent) callbacks.onEvent(event, raw);

      // Normalize text deltas — opencode json format varies across versions
      const delta =
        (typeof (event as Record<string, unknown>).delta === "string" &&
          (event as Record<string, unknown>).delta as string) ||
        (typeof (event as Record<string, unknown>).text === "string" &&
          (event as Record<string, unknown>).text as string) ||
        (typeof (event as Record<string, unknown>).content === "string" &&
          (event as Record<string, unknown>).content as string) ||
        "";

      if (delta) {
        buffer += delta;
        if (callbacks.onTextDelta) callbacks.onTextDelta(delta);
      }

      // Surface tool_use as text for streaming feedback
      if ((event as Record<string, unknown>).type === "tool_use" || (event as Record<string, unknown>).tool) {
        const toolName =
          ((event as Record<string, unknown>).tool as string) ??
          ((event as Record<string, unknown>).name as string) ??
          "tool";
        const toolLine = `\n🛠️ tool: ${toolName}\n`;
        if (callbacks.onTextDelta) callbacks.onTextDelta(toolLine);
      }

      const errMsg =
        (typeof (event as Record<string, unknown>).error === "string" &&
          (event as Record<string, unknown>).error as string) ||
        (typeof (event as Record<string, unknown>).message === "string" &&
          (event as Record<string, unknown>).message as string &&
          (event as Record<string, unknown>).type === "error" &&
          ((event as Record<string, unknown>).message as string)) ||
        "";

      if (errMsg && callbacks.onError) callbacks.onError(errMsg);
    });

    rl.on("close", () => {
      // readline closed — stdout ended
    });
  }

  if (child.stderr) {
    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => {
      // If stderr has content and process failed, surface it
      if (stderrBuf.trim() && code !== 0) {
        if (callbacks.onError) callbacks.onError(stderrBuf.trim().slice(0, 4000));
      }
      callbacks.onClose?.(code, signal);
    });
  } else {
    child.on("close", (code, signal) => callbacks.onClose?.(code, signal));
  }

  child.on("error", (err) => {
    if (callbacks.onError) callbacks.onError(err.message);
    cleanup();
  });

  child.on("close", () => {
    cleanup();
  });

  child.on("exit", () => {
    cleanup();
  });

  return child;
}

/**
 * Abort a running opencode execution for a chat using tree-kill (Windows-safe).
 * Returns true if a process was found and kill was attempted.
 */
export function abortRun(chatId: number): Promise<boolean> {
  const entry = activeRuns.get(chatId);
  if (!entry || !entry.process.pid) return Promise.resolve(false);

  const pid = entry.process.pid;

  return new Promise((resolve) => {
    kill(pid, "SIGKILL", (err) => {
      if (err) {
        // Fallback: try SIGTERM
        kill(pid, "SIGTERM", () => {
          activeRuns.delete(chatId);
          resolve(true);
        });
        return;
      }
      activeRuns.delete(chatId);
      resolve(true);
    });
  });
}

export function killAllRuns(): void {
  for (const [chatId, entry] of activeRuns.entries()) {
    if (entry.process.pid) {
      try {
        kill(entry.process.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    activeRuns.delete(chatId);
  }
}
