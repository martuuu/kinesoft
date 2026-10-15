import { z } from "zod";
import { REALTIME_DRIVERS } from "@/lib/realtime-constants";
import { ACCESS_ENFORCEMENTS, type AccessEnforcement } from "@/lib/tenant-access";
import { PLATFORM_MFA_ENFORCEMENTS, type PlatformMfaEnforcement } from "@/lib/platform-mfa-logic";

// IAM-0b: `.env.example` trae estas variables vacías (`EMAIL_TRANSPORT=""`).
// Un string vacío cuenta como "no seteada", no como un valor inválido: si no,
// copiar el example rompería el arranque en local.
const emptyAsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DIRECT_URL: z.string().url().optional(),
  // Service channel (BYPASSRLS) for surfaces without an Actor. Optional:
  // when unset, lib/db.ts falls back to DIRECT_URL (the owner connection).
  DATABASE_URL_SERVICE: z.string().url().optional(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Sala de Espera en tiempo real (SV, §18.2). `off` (default) = la app es
  // idéntica a SR: ni publica ni abre sockets. `local` = bus en memoria + SSE,
  // solo para dev (en Vercel cada lambda tiene su propio bus: no entregaría
  // nada entre usuarios). `supabase` = Broadcast privado.
  REALTIME_DRIVER: z.enum(REALTIME_DRIVERS).default("off"),
  // Secreto HS256 con el que firmamos el token del canal (SV-D6/D15). SERVER-ONLY:
  // nunca `NEXT_PUBLIC_` (el guard (d) de SV lo verifica). Con él se puede firmar
  // un token `authenticated` del proyecto: es tan sensible como la service key.
  SUPABASE_JWT_SECRET: z.string().optional(),
  // `kid` opcional del header (SV-D15): con una clave HS256 del sistema nuevo de
  // JWT signing keys de Supabase hay que nombrarla; con el secreto legacy, no.
  SUPABASE_JWT_KID: z.string().optional(),

  MP_ACCESS_TOKEN: z.string().optional(),
  MP_PUBLIC_KEY: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SENTRY_DSN: z.string().optional(),

  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Mail transaccional (IAM-0b, C-IAM1). La app manda todos los mails; Supabase
  // solo emite tokens. Todo opcional: `lib/email/transport.ts` decide por dónde
  // sale cada mail leyendo `process.env` en cada envío (no este objeto, que se
  // congela al importar y los tests no podrían cambiarlo); acá se validan la
  // forma y el aviso de Production.
  //   RESEND_API_KEY  SERVER-ONLY (nunca NEXT_PUBLIC_). Sin ella, en Production
  //                   los mails van a log (no salen) y se avisa al boot.
  //   EMAIL_FROM      `KineSoft <no-reply@mail.dominio>`. Fuera de Production
  //                   hay default; en Production sin él tampoco sale nada.
  //   EMAIL_TRANSPORT resend|mailpit|log. Solo pesa fuera de Production (dev:
  //                   mailpit o el opt-in de resend); Production lo ignora.
  //   EMAIL_REPLY_TO  default del Reply-To cuando el emisor no pasa uno.
  //   MAILPIT_URL     API HTTP de Mailpit (default http://localhost:8025).
  RESEND_API_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),
  EMAIL_FROM: z.preprocess(emptyAsUndefined, z.string().optional()),
  EMAIL_TRANSPORT: z.preprocess(emptyAsUndefined, z.enum(["resend", "mailpit", "log"]).optional()),
  EMAIL_REPLY_TO: z.preprocess(emptyAsUndefined, z.string().optional()),
  MAILPIT_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),

  // BO1-A (C-BO1, plan §19.5): despliegue del bloqueo por acceso del consultorio.
  //   off     = nada se corta (interruptor de emergencia).
  //   banner  = DEFAULT: la banda avisa (prueba, gracia, solo lectura) y solo se respeta la suspensión/baja
  //             explícita desde /plataforma. Prod es demo y hay consultorios en TRIALING vencido: no se los
  //             bloquea hasta que Martin lo decida.
  //   enforce = solo lectura real (transacciones read-only) y superficies públicas cerradas.
  // Los cortes leen `tenantAccessEnforcement()` (process.env en cada llamada), no este objeto congelado.
  TENANT_ACCESS_ENFORCEMENT: z.preprocess(
    emptyAsUndefined,
    z.enum(ACCESS_ENFORCEMENTS as unknown as [AccessEnforcement, ...AccessEnforcement[]]).default("banner")
  ),

  // BO4 (BO-D6, plan §19.5): verificación en dos pasos (TOTP de Supabase) para superadmins.
  //   off     = DEFAULT: Plataforma no la exige (las pantallas /plataforma-mfa igual funcionan para enrolarse).
  //             «Entrar como soporte» sigue permitido y el registro deja `mfa:false`.
  //   enforce = AAL2 para todo /plataforma y cada action de admin; re-verificación (10 min) en las de riesgo high.
  // Default off porque prenderlo antes de que el superadmin tenga un factor lo deja afuera de Plataforma (puede
  // configurarlo igual desde /plataforma-mfa/configurar, pero el orden es: enrolarse con off → probar → enforce).
  // Lo leen `platformMfaEnforcement()` (process.env en cada llamada) y `next.config.mjs` no: la CSP no depende de él.
  PLATFORM_MFA_ENFORCEMENT: z.preprocess(
    emptyAsUndefined,
    z
      .enum(PLATFORM_MFA_ENFORCEMENTS as unknown as [PlatformMfaEnforcement, ...PlatformMfaEnforcement[]])
      .default("off")
  ),

  // BO3-E: secreto de los cron de Vercel (Authorization: Bearer). Opcional hasta BO5-A, que lo usa en el handler;
  // hoy solo lo lee `/plataforma/sistema` para mostrar presencia (nunca el valor).
  CRON_SECRET: z.preprocess(emptyAsUndefined, z.string().optional()),

  // BO5-B: modo mantenimiento (`lib/maintenance.ts`). Se prende con `on` + redeploy. El middleware NO lee este
  // objeto (importar `lib/env.ts` en el edge validaría todo el entorno en cada cold start): lee
  // `process.env.MAINTENANCE_MODE` con `maintenanceMode()`, que trata cualquier otro valor como `off`. Acá se valida
  // la forma (mayúsculas y espacios se toleran, igual que en el middleware), así un typo como `true` frena el
  // build del deploy en vez de dejar la app abierta creyendo que está en mantenimiento.
  //   MAINTENANCE_MESSAGE  línea opcional que ve CUALQUIERA en /mantenimiento: dato público, nada interno. Sin
  //                        tope acá a propósito: `maintenanceMessage()` la corta a 280 al mostrarla, y un mensaje
  //                        largo no puede frenar el deploy que justamente prende el mantenimiento.
  MAINTENANCE_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "on"]).default("off")
  ),
  MAINTENANCE_MESSAGE: z.preprocess(emptyAsUndefined, z.string().optional()),

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

/**
 * IAM-0b · §19.9: sin estas dos, Production no manda NINGÚN mail (invitaciones,
 * reset, portal): `lib/email/transport.ts` cae a log. Es un aviso y no un error
 * porque hoy el dominio de envío todavía no está cargado y un deploy no puede
 * caerse por eso; pasan a REQUIRED_IN_PRODUCTION cuando Martin cargue el
 * dominio en Resend (antes de IAM-2).
 */
const EMAIL_RECOMMENDED_IN_PRODUCTION = ["RESEND_API_KEY", "EMAIL_FROM"] as const;

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
  // SV-D11: con `supabase` sin secreto/URL/service key el publish falla en cada
  // action (breaker abierto) y nadie mintea tokens: la sala quedaría muda en
  // silencio. Mejor que el deploy no salga.
  // FX1b: también la anon key. `realtimeBootstrap` se la pasa al cliente como
  // `apikey` del socket; sin ella el browser no conecta y la sala cae a polling
  // sin que nada avise. Ya está en REQUIRED_IN_PRODUCTION, pero se repite acá a
  // propósito: si alguien la saca de esa lista (p. ej. al pasar a las claves
  // `sb_publishable_…`), el driver supabase no puede quedar sin ella.
  if (e.REALTIME_DRIVER === "supabase") {
    for (const key of [
      "SUPABASE_JWT_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ] as const) {
      if (!e[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "obligatoria en Production con REALTIME_DRIVER=supabase",
        });
      }
    }
  }
  // SV-D11: el bus `local` vive en la memoria de UN proceso; en Vercel cada
  // lambda tiene el suyo y los eventos no cruzarían entre usuarios.
  if (e.REALTIME_DRIVER === "local") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REALTIME_DRIVER"],
      message: "\"local\" no se permite en Production (usá \"supabase\" u \"off\")",
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
    const missingEmail = EMAIL_RECOMMENDED_IN_PRODUCTION.filter((k) => !r.data[k]?.trim());
    if (missingEmail.length) {
      console.error(
        `[env] Production sin ${missingEmail.join(", ")}: la app NO manda mails (transporte log). Ver plan §19.9.`
      );
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
  REALTIME_DRIVER: process.env.REALTIME_DRIVER,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  SUPABASE_JWT_KID: process.env.SUPABASE_JWT_KID,
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SENTRY_DSN: process.env.SENTRY_DSN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
  MAILPIT_URL: process.env.MAILPIT_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  TENANT_ACCESS_ENFORCEMENT: process.env.TENANT_ACCESS_ENFORCEMENT,
  CRON_SECRET: process.env.CRON_SECRET,
  MAINTENANCE_MODE: process.env.MAINTENANCE_MODE,
  MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE,
  PLATFORM_MFA_ENFORCEMENT: process.env.PLATFORM_MFA_ENFORCEMENT,
});

/**
 * `TENANT_ACCESS_ENFORCEMENT` vigente, leído de `process.env` en cada llamada (como el transporte de mail): los
 * tests de integración lo cambian en caliente y `env` se congela al importar. Un valor inválido cae al default
 * `banner` (el boot ya lo rechazó en `parseEnv`; acá no se tira en medio de un request).
 */
export function tenantAccessEnforcement(): AccessEnforcement {
  const v = process.env.TENANT_ACCESS_ENFORCEMENT?.trim();
  return v === "off" || v === "banner" || v === "enforce" ? v : "banner";
}

/**
 * `PLATFORM_MFA_ENFORCEMENT` vigente (BO4), leído en cada llamada por la misma razón que el de arriba: los tests lo
 * cambian en caliente. Inválido o vacío → `off` (el boot ya rechazó un valor inválido; acá no se tira).
 */
export function platformMfaEnforcement(): PlatformMfaEnforcement {
  return process.env.PLATFORM_MFA_ENFORCEMENT?.trim() === "enforce" ? "enforce" : "off";
}

export const isProd = env.NODE_ENV === "production";
