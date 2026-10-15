/**
 * BO3-E · lógica pura de `/plataforma/sistema`: qué servicios externos están configurados en ESTE deploy.
 *
 * Regla (plan §19.5, «Sistema muestra presencia, nunca valores»): de cada secreto se dice si está o falta, jamás el
 * valor ni un pedazo (ni los primeros caracteres, ni el largo: un prefijo de token ya ayuda a un atacante y el largo
 * distingue claves de test y de prod). Los únicos VALORES que salen son enums que la app valida (`REALTIME_DRIVER`,
 * `TENANT_ACCESS_ENFORCEMENT`, `VERCEL_ENV`), y aun así se re-validan acá contra su lista: un valor fuera de la lista
 * (alguien pegó un secreto en la variable equivocada) se muestra como «inválido», no tal cual.
 * `NEXT_PUBLIC_APP_URL` es pública, pero tampoco sale: solo si apunta a localhost (el bug de env-sin-fail-fast).
 *
 * El builder recibe un objeto de entrada explícito (no lee `process.env`) para que el unit test pueda pasarle valores
 * marcados y probar que ninguno aparece en el DTO.
 */
import { REALTIME_DRIVERS } from "@/lib/realtime-constants";
import { ACCESS_ENFORCEMENTS } from "@/lib/tenant-access";

export type SystemCheckState = "ok" | "missing" | "warn" | "value";

export type SystemCheck = {
  key: string;
  label: string;
  state: SystemCheckState;
  /** Solo para enums validados (driver, modo, entorno) y datos no secretos (conteos, nombre de migración). */
  value: string | null;
  /** Qué implica, en una línea. */
  detail: string;
};

export type SystemGroup = { id: string; title: string; checks: SystemCheck[] };

export type PlatformSystemStatus = {
  generatedAt: string;
  groups: SystemGroup[];
};

/** Entrada del builder: las variables tal como las tiene `lib/env.ts` (+ CRON_SECRET, que todavía no está ahí). */
export type SystemConfigInput = {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  SENTRY_DSN?: string;
  MP_ACCESS_TOKEN?: string;
  MP_PUBLIC_KEY?: string;
  MP_WEBHOOK_SECRET?: string;
  REALTIME_DRIVER?: string;
  TENANT_ACCESS_ENFORCEMENT?: string;
  CRON_SECRET?: string;
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_ENV?: string;
};

export type MigrationsInfo = { available: true; applied: number; last: string | null } | { available: false };
export type HealthInfo = { up: boolean; ms: number };

const present = (v: string | undefined) => typeof v === "string" && v.trim() !== "";

/** Un nombre de migración de Prisma: `<timestamp>_<snake>`. Otra cosa no se muestra. */
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]{1,80}$/;

function presence(key: string, label: string, v: string | undefined, missingDetail: string, okDetail: string): SystemCheck {
  return present(v)
    ? { key, label, state: "ok", value: null, detail: okDetail }
    : { key, label, state: "missing", value: null, detail: missingDetail };
}

function enumValue(v: string | undefined, allowed: readonly string[], fallback: string): string {
  const t = (v ?? "").trim();
  if (!t) return fallback;
  return allowed.includes(t) ? t : "inválido";
}

export function buildSystemStatus(
  input: SystemConfigInput,
  migrations: MigrationsInfo,
  health: HealthInfo,
  now: Date = new Date()
): PlatformSystemStatus {
  const realtime = enumValue(input.REALTIME_DRIVER, REALTIME_DRIVERS, "off");
  const access = enumValue(input.TENANT_ACCESS_ENFORCEMENT, ACCESS_ENFORCEMENTS as readonly string[], "banner");
  const vercelEnv = enumValue(input.VERCEL_ENV, ["production", "preview", "development"], "local");
  const appUrl = (input.NEXT_PUBLIC_APP_URL ?? "").trim();
  const appUrlLocal = !appUrl || /localhost|127\.0\.0\.1/.test(appUrl);

  const mpToken = present(input.MP_ACCESS_TOKEN);
  const mpSecret = present(input.MP_WEBHOOK_SECRET);

  const groups: SystemGroup[] = [
    {
      id: "app",
      title: "Este deploy",
      checks: [
        { key: "VERCEL_ENV", label: "Entorno", state: "value", value: vercelEnv, detail: "Lo setea Vercel; «local» = fuera de Vercel." },
        appUrlLocal
          ? {
              key: "NEXT_PUBLIC_APP_URL",
              label: "URL de la app",
              state: vercelEnv === "production" ? "missing" : "warn",
              value: "localhost",
              detail: "Los links de invitación, reset y el aviso de Mercado Pago apuntan a localhost.",
            }
          : { key: "NEXT_PUBLIC_APP_URL", label: "URL de la app", state: "ok", value: "pública", detail: "Los links de los mails salen con el dominio público." },
        health.up
          ? { key: "health", label: "Base de datos", state: "ok", value: `${health.ms} ms`, detail: "Responde (el mismo chequeo que /api/health)." }
          : { key: "health", label: "Base de datos", state: "missing", value: "caída", detail: "No respondió en 2 s: /api/health está devolviendo 503." },
        migrations.available
          ? {
              key: "migrations",
              label: "Migraciones aplicadas",
              state: "value",
              value: String(migrations.applied),
              detail:
                migrations.last && MIGRATION_NAME.test(migrations.last)
                  ? `Última: ${migrations.last}`
                  : "No se pudo leer el nombre de la última.",
            }
          : { key: "migrations", label: "Migraciones aplicadas", state: "warn", value: null, detail: "No se pudo leer el historial de migraciones con esta conexión." },
      ],
    },
    {
      id: "email",
      title: "Correo (Resend)",
      checks: [
        presence("RESEND_API_KEY", "Clave de Resend", input.RESEND_API_KEY, "Sin clave: en Production los mails no salen (van al log).", "Cargada."),
        presence("EMAIL_FROM", "Remitente", input.EMAIL_FROM, "Sin remitente: en Production los mails no salen.", "Cargado."),
      ],
    },
    {
      id: "ratelimit",
      title: "Límites de uso (Upstash)",
      checks: [
        presence("UPSTASH_REDIS_REST_URL", "URL de Upstash", input.UPSTASH_REDIS_REST_URL, "Sin Upstash, el rate limit es por instancia (en Vercel casi no frena).", "Cargada."),
        presence("UPSTASH_REDIS_REST_TOKEN", "Token de Upstash", input.UPSTASH_REDIS_REST_TOKEN, "Falta el token: el rate limit cae a memoria.", "Cargado."),
      ],
    },
    {
      id: "errors",
      title: "Errores (Sentry)",
      checks: [presence("SENTRY_DSN", "DSN de Sentry", input.SENTRY_DSN, "Los errores solo quedan en el log de Vercel.", "Cargado.")],
    },
    {
      id: "mp",
      title: "Mercado Pago",
      checks: [
        presence("MP_ACCESS_TOKEN", "Access token", input.MP_ACCESS_TOKEN, "Sin token no se pueden generar cobros.", "Cargado."),
        presence("MP_PUBLIC_KEY", "Public key", input.MP_PUBLIC_KEY, "Sin public key.", "Cargada."),
        mpToken && !mpSecret
          ? { key: "MP_WEBHOOK_SECRET", label: "Secreto del webhook", state: "missing", value: null, detail: "Con token y sin secreto, el webhook rechaza todos los pagos (503)." }
          : presence("MP_WEBHOOK_SECRET", "Secreto del webhook", input.MP_WEBHOOK_SECRET, "Sin secreto del webhook.", "Cargado."),
      ],
    },
    {
      id: "runtime",
      title: "Tiempo real y acceso",
      checks: [
        {
          key: "REALTIME_DRIVER",
          label: "Sala de espera en tiempo real",
          state: realtime === "inválido" ? "warn" : "value",
          value: realtime,
          detail:
            realtime === "supabase"
              ? "Avisos al instante por Supabase Realtime."
              : realtime === "local"
                ? "Bus en memoria: solo sirve en desarrollo."
                : realtime === "off"
                  ? "Apagado: la sala se actualiza cada 60 s."
                  : "Valor no reconocido.",
        },
        {
          key: "TENANT_ACCESS_ENFORCEMENT",
          label: "Corte por acceso del consultorio",
          state: access === "inválido" ? "warn" : "value",
          value: access,
          detail:
            access === "enforce"
              ? "Solo lectura real para consultorios vencidos."
              : access === "banner"
                ? "Solo avisa; corta únicamente suspensiones y bajas."
                : access === "off"
                  ? "No corta nada (interruptor de emergencia)."
                  : "Valor no reconocido.",
        },
      ],
    },
    {
      id: "cron",
      title: "Tareas programadas",
      checks: [presence("CRON_SECRET", "Secreto de los cron", input.CRON_SECRET, "Sin secreto, los cron no pueden autenticarse.", "Cargado.")],
    },
  ];

  return { generatedAt: now.toISOString(), groups };
}
