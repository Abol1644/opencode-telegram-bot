import type { Context, NextFunction } from "grammy";
import { config } from "../config.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  if (userId !== config.ADMIN_ID) {
    // Polite denial — do not leak admin ID or token. Silent drop would also be valid,
    // but prompt asks for a polite denial message.
    try {
      await ctx.reply("⛔ Unauthorized — this bot is private and only responds to its admin.");
    } catch {
      // Ignore send failures for unauthorized users (e.g. blocked).
    }
    return;
  }

  await next();
}
