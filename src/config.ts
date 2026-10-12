import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  BOT_USERNAME: z
    .string()
    .min(1, "BOT_USERNAME is required")
    .transform((v) => (v.startsWith("@") ? v : `@${v}`)),
  ADMIN_ID: z.coerce.number().int().positive("ADMIN_ID must be a positive integer"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  console.error(`[config] Invalid environment variables — ${issues}`);
  process.exit(1);
}

export const config = {
  BOT_TOKEN: parsed.data.BOT_TOKEN,
  BOT_USERNAME: parsed.data.BOT_USERNAME,
  ADMIN_ID: parsed.data.ADMIN_ID,
} as const;

export type Config = typeof config;
