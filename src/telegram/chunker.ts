/**
 * Telegram message limits:
 *  - 4096 characters per message (for text). We use 3900 as safe limit to leave headroom
 *    for wrappers / headers.
 */

export const TELEGRAM_LIMIT = 4096;
export const SAFE_CHUNK_SIZE = 3900;

/**
 * Escape HTML entities. Used when parse_mode = "HTML" fails we fallback to plain text,
 * but this also serves as safe escape for HTML mode.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape MarkdownV2 special characters if you ever switch to MarkdownV2.
 * Kept here for reference; default bot uses HTML.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Split a long string into chunks of <= SAFE_CHUNK_SIZE.
 * - Prefers splitting on double newline, then single newline, then space.
 * - Tries not to break inside fenced code blocks (``` ... ```).
 * - Never breaks a single line longer than limit mid-word unless unavoidable.
 */
export function chunkMessage(text: string, limit: number = SAFE_CHUNK_SIZE): string[] {
  if (!text) return [""];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = -1;

    // Track whether we are "inside" a code fence up to the cut point.
    // Count occurrences of ``` before the limit; odd => inside block.
    const fenceCount = (remaining.slice(0, limit).match(/```/g) ?? []).length;
    const insideCodeBlock = fenceCount % 2 === 1;

    if (!insideCodeBlock) {
      // Prefer paragraph boundary, then line, then word
      const doubleNl = remaining.lastIndexOf("\n\n", limit);
      if (doubleNl > limit * 0.3) {
        splitAt = doubleNl + 2;
      } else {
        const singleNl = remaining.lastIndexOf("\n", limit);
        if (singleNl > limit * 0.3) {
          splitAt = singleNl + 1;
        } else {
          const lastSpace = remaining.lastIndexOf(" ", limit);
          if (lastSpace > limit * 0.3) {
            splitAt = lastSpace + 1;
          }
        }
      }
    } else {
      // Inside code block — try to split *before* the block or after closing fence if nearby
      const fenceBefore = remaining.lastIndexOf("```", limit);
      // If fence is close enough to limit, split right before it to keep block intact
      if (fenceBefore > limit * 0.5) {
        splitAt = fenceBefore;
      } else {
        // Otherwise fall back to newline/space but still try to avoid mid-block mid-line
        const nl = remaining.lastIndexOf("\n", limit);
        if (nl > limit * 0.4) splitAt = nl + 1;
      }
    }

    if (splitAt === -1 || splitAt <= 0) {
      // Forced hard cut — unavoidable
      splitAt = limit;
    }

    const chunk = remaining.slice(0, splitAt);
    chunks.push(chunk);
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Wrap each chunk with optional HTML code fence handling and attempt to send.
 * Falls back to plain text if Telegram rejects HTML parsing.
 */
export async function sendChunked(
  sendHtml: (text: string) => Promise<unknown>,
  sendPlain: (text: string) => Promise<unknown>,
  text: string,
  limit: number = SAFE_CHUNK_SIZE,
): Promise<void> {
  const chunks = chunkMessage(text, limit);
  for (const chunk of chunks) {
    // Try HTML first
    try {
      await sendHtml(chunk);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Telegram parse errors contain "can't parse entities"
      if (msg.toLowerCase().includes("can't parse") || msg.toLowerCase().includes("parse entities")) {
        await sendPlain(chunk);
      } else {
        throw err;
      }
    }
  }
}

export type SendChunkedOptions = {
  parseMode?: "HTML" | undefined;
  limit?: number;
};
