import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DIRECT_URL: z.string().url().optional(),
  // Service channel (BYPASSRLS) for surfaces without an Actor. Optional:
  // when unset, lib/db.ts falls back to DIRECT_URL (the owner connection).
  DATABASE_URL_SERVICE: z.string().url().optional(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  MP_ACCESS_TOKEN: z.string().optional(),
  MP_PUBLIC_KEY: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SENTRY_DSN: z.string().optional(),

  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Set by Vercel: "production" | "preview" | "development". Unset locally/CI.
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
});

/**
 * Fail-fast for the Production environment only (AUDIT 2026-09-23,
 * env-sin-fail-fast). Everything above is optional so local/CI builds work
 * with placeholders — which also meant a Production deploy missing
 * NEXT_PUBLIC_APP_URL shipped green and every invitation, password reset and
 * the Mercado Pago notification_url pointed at localhost:3000, and a missing
 * service key silently turned patient-file uploads into byte-less stubs.
 *
 * Keyed on VERCEL_ENV, NOT NODE_ENV: `next build` sets NODE_ENV=production in
 * CI too, and CI must keep building with placeholders.
 */
const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** Still owner-pending (bucket C): logged loudly in prod, not fatal yet. */
const RECOMMENDED_IN_PRODUCTION = [
  "DATABASE_URL_SERVICE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
] as const;

const productionSchema = schema.superRefine((e, ctx) => {
  if (e.VERCEL_ENV !== "production") return;
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!e[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "obligatoria en Production" });
  }
  if (/localhost|127\.0\.0\.1/.test(e.NEXT_PUBLIC_APP_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_APP_URL"],
      message: "no puede apuntar a localhost en Production (links de invitación/reset y webhook de MP)",
    });
  }
  // Without the secret the webhook answers 503 to every payment (AUDIT §5.4).
  if (e.MP_ACCESS_TOKEN && !e.MP_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MP_WEBHOOK_SECRET"],
      message: "obligatoria si MP_ACCESS_TOKEN está seteada",
    });
  }
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const r = productionSchema.safeParse(raw);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`[env] configuración inválida — ${detail}`);
  }
  if (r.data.VERCEL_ENV === "production" && typeof window === "undefined") {
    const missing = RECOMMENDED_IN_PRODUCTION.filter((k) => !r.data[k]);
    if (missing.length) {
      console.error(`[env] Production sin: ${missing.join(", ")} (tareas del dueño, ver .docs/EXTERNAL-CONFIG.md)`);
    }
  }
  return r.data;
}

export const env = parseEnv({
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  DATABASE_URL_SERVICE: process.env.DATABASE_URL_SERVICE,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SENTRY_DSN: process.env.SENTRY_DSN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
});

export const isProd = env.NODE_ENV === "production";
