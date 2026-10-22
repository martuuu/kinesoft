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
 * HF-1a (H-RT1, plan §22.4) · ÚNICA excepción, el secreto de firma de realtime (`SUPABASE_JWT_SECRET`): se muestran su
 * LARGO, si tenía espacios o saltos al borde (sí/no) y una HUELLA (sha256 con prefijo propio → 8 hex,
 * `realtimeSecretFingerprint`). La agenda nunca entraba en vivo porque Vercel tenía el secreto con un `\n` final, y sin
 * estos tres datos no había forma de verlo desde la app. Por qué no rompe la regla de arriba: la huella no es un
 * pedazo del valor ni sirve para adivinarlo (32 bits de un hash, el espacio a recorrer es el del secreto), y el largo
 * de un secreto HS256 no distingue test de prod (todos los de Supabase miden lo mismo); el `\n` sí se nota (+1). El
 * builder recibe esos datos ya calculados (`RealtimeSecretInfo`), nunca el secreto. El `kid` sale tal cual solo con
 * forma de UUID (no es secreto: viaja en el header de cada token), y de la anon key solo el TIPO.
 *
 * El builder recibe un objeto de entrada explícito (no lee `process.env`) para que el unit test pueda pasarle valores
 * marcados y probar que ninguno aparece en el DTO.
 */
import { REALTIME_DRIVERS } from "@/lib/realtime-constants";
import { ACCESS_ENFORCEMENTS } from "@/lib/tenant-access";
import type { RealtimeSecretInfo } from "@/lib/realtime-token-internal";
import { formatArDateTime } from "@/lib/mp-receipt";

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

/** Lo que arma `buildSystemStatus` (la configuración de este deploy). */
export type SystemConfigStatus = {
  generatedAt: string;
  groups: SystemGroup[];
};

/**
 * OPS-1a · una fila de la tarjeta «Últimos mails que no salieron». Solo lo que sirve para diagnosticar sin datos de
 * nadie: cuándo, qué tipo de mail, por qué (el `reason` de EmailLog, re-validado) y el DOMINIO del destinatario (para
 * ver si fallan solo los de un proveedor). Nunca el usuario de la dirección (ni enmascarado), ni el cuerpo (EmailLog
 * no lo guarda), ni el link.
 */
export type RecentEmailFailure = {
  at: string;
  kind: string;
  status: string;
  reason: string;
  /** El motivo en castellano (`emailFailureLabel`). */
  label: string;
  recipientDomain: string | null;
};

export type EmailFailuresInfo = { available: true; items: RecentEmailFailure[] } | { available: false };

export type PlatformSystemStatus = SystemConfigStatus & { emailFailures: EmailFailuresInfo };

/** Fila de EmailLog tal como la lee `platform-system-read.ts` (el `select` exacto). */
export type EmailFailureRow = {
  createdAt: Date;
  kind: string;
  status: string;
  transport: string;
  reason: string | null;
  toMasked: string;
};

/** Techo de la tarjeta: los últimos 10 alcanzan para ver un patrón; el historial completo está en EmailLog. */
export const EMAIL_FAILURES_LIMIT = 10;

/**
 * Qué filas de EmailLog cuentan como «no salió»: `failed` y `blocked` siempre; `skipped` solo por config faltante
 * (`no_api_key`, `no_from`), que en Production significa que nadie recibe sus mails. `log_only` (Preview, dev) y
 * `mailpit_unreachable` son el entorno decidiendo no mandar: llenarían la tarjeta de ruido.
 */
export const EMAIL_FAILURE_SKIP_REASONS = ["no_api_key", "no_from"] as const;

/** `reason` de EmailLog: `provider_error` o `provider_error:validation_error:403` (`emailLogReason`). Otra cosa no sale. */
const EMAIL_REASON = /^([a-z_]{1,32})(?::([a-z_]{1,48}):(\d{3}))?$/;
const EMAIL_KIND = /^[a-z_]{1,48}$/;
const EMAIL_STATUS = ["failed", "blocked", "skipped"];
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** El motivo, en una línea, con la causa más probable. Pensado para Martin mirando por qué Resend rechaza. */
export function emailFailureLabel(reason: string): string {
  const m = EMAIL_REASON.exec(reason);
  if (!m) return "Motivo no reconocido.";
  const [, base, name, statusRaw] = m;
  const status = statusRaw ? Number(statusRaw) : null;
  if (base === "provider_error" || base === "rate_limited") {
    if (status === 429 || base === "rate_limited") return "Resend frenó por límite de envíos (429). Se reintenta solo con el próximo envío.";
    if (status === 401) return "Resend rechazó la clave (401): API key inválida o revocada.";
    if (status === 403)
      return name === "validation_error"
        ? "Resend rechazó (403): el dominio del remitente no es el verificado, la key es de otro dominio o la cuenta está en modo prueba."
        : "Resend rechazó (403): dominio sin verificar o key restringida a otro dominio.";
    if (status === 422) return "Resend rechazó el remitente o el destinatario (422): EMAIL_FROM mal pegado o de un dominio no autorizado.";
    if (status !== null && status >= 500) return `Resend falló de su lado (${status}). Suele ser pasajero.`;
    return status !== null ? `El proveedor rechazó el envío (${status}).` : "El proveedor rechazó el envío.";
  }
  switch (base) {
    case "no_api_key":
      return "No salió: falta la clave de Resend (RESEND_API_KEY).";
    case "no_from":
      return "No salió: falta el remitente (EMAIL_FROM).";
    case "unsafe_link_host":
      return "Bloqueado: el mail llevaba un link a localhost (revisá NEXT_PUBLIC_APP_URL).";
    case "invalid_to":
      return "El destinatario no es una dirección válida.";
    case "timeout":
      return "Resend no contestó en 5 s.";
    case "network_error":
      return "No se pudo conectar con Resend (red o DNS).";
    case "internal_error":
      return "Error interno al armar o mandar el mail.";
    default:
      return "Motivo no reconocido.";
  }
}

/** `j***@gmail.com` → `gmail.com`. null si la máscara no tiene la forma esperada. */
function domainOfMasked(masked: string): string | null {
  const at = masked.lastIndexOf("@");
  if (at < 0) return null;
  const d = masked.slice(at + 1).trim().toLowerCase();
  return DOMAIN.test(d) ? d : null;
}

/**
 * OPS-1a · arma la tarjeta a partir de las filas de EmailLog. Puro (lo prueba el unit con filas marcadas): todo campo
 * se re-valida por forma, porque `reason` y `kind` son TEXT libres en la base y una fila escrita por otro camino podría
 * traer cualquier cosa.
 */
export function buildRecentEmailFailures(rows: EmailFailureRow[]): RecentEmailFailure[] {
  return rows.slice(0, EMAIL_FAILURES_LIMIT).map((r) => {
    const reason = r.reason && EMAIL_REASON.test(r.reason) ? r.reason : "desconocido";
    return {
      at: r.createdAt.toISOString(),
      kind: EMAIL_KIND.test(r.kind) ? r.kind : "desconocido",
      status: EMAIL_STATUS.includes(r.status) ? r.status : "desconocido",
      reason,
      label: emailFailureLabel(reason),
      recipientDomain: domainOfMasked(r.toMasked),
    };
  });
}

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
  /** HF-1a: ya recortado por `lib/env.ts`. Solo se muestra con forma de UUID. */
  SUPABASE_JWT_KID?: string;
  /** HF-1a: pública, pero igual solo sale el tipo (JWT legacy / publishable / secreta pegada por error). */
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  /** HF-1a: lo que se puede decir del secreto de firma sin el valor (`describeRealtimeSecret`). null = no está. */
  realtimeSecret?: RealtimeSecretInfo | null;
  /**
   * TP-2h (C-TP13): grupo «Cobros online (Mercado Pago)». Llega ya descripto (modo efectivo, huellas, estado de las
   * claves del secret box, conteos): el builder nunca recibe un client secret, un secreto de webhook ni una clave.
   */
  mpConnect?: MpConnectSystemInfo | null;
};

/** Lo que el read le pasa al builder del grupo «Cobros online (Mercado Pago)». Nada de esto es un secreto. */
export type MpConnectSystemInfo = {
  /** `mpConnectMode()`: el modo que la app APLICA (fake en Vercel ya cae a off). */
  mode: string;
  /** `mpConnectSignatureMode()`. */
  signature: string;
  clientIdPresent: boolean;
  /** Huella (`mpSecretFingerprint`, 8 hex) o null si no está cargado. */
  clientSecretFingerprint: string | null;
  webhookSecretFingerprint: string | null;
  /** `secretBoxStatus()` (lib/secret-box.ts): kids y huellas de las claves, nunca la clave. */
  secretBox: { configured: boolean; devFallback: boolean; primaryKid: string | null; kids: string[]; fingerprints: Record<string, string> };
  /** `TURNERO_CHECKOUT` crudo: solo se mira si es `platform` (en desuso: se avisa). */
  turneroCheckout?: string;
  /** Conteos de la base; `available: false` si no se pudieron leer (la página no se cae). */
  stats:
    | {
        available: true;
        accounts: { active: number; reauth: number; disconnected: number };
        /** Último cobro que cambió por un webhook (AUTHORIZED/PAID/REFUNDED: solo el webhook los escribe). */
        lastWebhookAt: Date | null;
        /** Último refresh de token exitoso (cron o webhook). */
        lastRefreshAt: Date | null;
      }
    | { available: false };
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

/** Los `kid` de las JWT signing keys de Supabase son UUID. Otra cosa no se muestra (podría ser un secreto mal pegado). */
const KID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un JWT con forma (`eyJ…` y tres partes): la anon key legacy. */
const JWT_SHAPE = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;

function realtimeChecks(input: SystemConfigInput, driver: string): SystemCheck[] {
  const supabase = driver === "supabase";
  const info = input.realtimeSecret ?? null;
  const secret: SystemCheck = !info
    ? {
        key: "SUPABASE_JWT_SECRET",
        label: "Secreto de firma del canal",
        state: supabase ? "missing" : "warn",
        value: null,
        detail: supabase
          ? "Sin secreto no se firma el token del canal: la agenda no entra en vivo."
          : "Sin secreto. Hace falta antes de pasar el tiempo real a supabase.",
      }
    : {
        key: "SUPABASE_JWT_SECRET",
        label: "Secreto de firma del canal",
        state: info.edgeWhitespace ? "warn" : "ok",
        value: `huella ${info.fingerprint}`,
        detail: info.edgeWhitespace
          ? `${info.length} caracteres · espacios o saltos de línea al borde: sí. La app los recorta al firmar, pero volvé a pegarlo limpio en Vercel (sin Enter al final). Compará la huella con la de scripts/realtime-verify.ts.`
          : `${info.length} caracteres · espacios o saltos de línea al borde: no. Compará la huella con la de scripts/realtime-verify.ts: si difieren, firman con secretos distintos.`,
      };

  const kidRaw = (input.SUPABASE_JWT_KID ?? "").trim();
  const kid: SystemCheck = !kidRaw
    ? {
        key: "SUPABASE_JWT_KID",
        label: "kid de la clave",
        state: "value",
        value: "sin kid",
        detail: "Correcto con el secreto legacy. Con una clave HS256 del sistema nuevo de JWT signing keys hace falta su kid.",
      }
    : KID_UUID.test(kidRaw)
      ? {
          key: "SUPABASE_JWT_KID",
          label: "kid de la clave",
          state: "value",
          value: kidRaw.toLowerCase(),
          detail: "Tiene que ser el kid de la clave HS256 con la que se firma (Supabase → JWT Keys). Con el secreto legacy, dejalo vacío.",
        }
      : {
          key: "SUPABASE_JWT_KID",
          label: "kid de la clave",
          state: "warn",
          value: "no es UUID",
          detail: "Los kid de Supabase tienen forma de UUID. No se muestra por si es otro dato pegado acá.",
        };

  const anon = (input.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  const anonCheck: SystemCheck = !anon
    ? {
        key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        label: "Clave pública (anon)",
        state: "missing",
        value: null,
        detail: "Sin clave pública el navegador no puede abrir el socket de tiempo real (ni el login).",
      }
    : anon.startsWith("sb_publishable_")
      ? { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", label: "Clave pública (anon)", state: "value", value: "publishable", detail: "Clave publishable del sistema nuevo de API keys." }
      : anon.startsWith("sb_secret_")
        ? {
            key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
            label: "Clave pública (anon)",
            state: "missing",
            value: "es secreta",
            detail: "Es una clave sb_secret_: viaja en el bundle del navegador. Cambiala por la publishable y rotala en Supabase.",
          }
        : JWT_SHAPE.test(anon)
          ? { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", label: "Clave pública (anon)", state: "value", value: "JWT legacy", detail: "Anon key legacy (JWT)." }
          : {
              key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
              label: "Clave pública (anon)",
              state: "warn",
              value: "no reconocida",
              detail: "No es un JWT ni una clave sb_publishable_: revisá que sea la anon key del proyecto.",
            };

  return [secret, kid, anonCheck];
}

// ── TP-2h · Cobros online (Mercado Pago) ─────────────────────────────────────────────────────────────────────────

const MP_MODES = ["off", "fake", "sandbox", "live"] as const;
const MP_SIGNATURES = ["required", "fetch-only"] as const;
/** Huella de `mpSecretFingerprint` (8 hex). Otra forma no se muestra: podría ser un secreto mal pasado. */
const MP_FINGERPRINT = /^[0-9a-f]{8}$/;
/** kid y huella del secret box (C-TP1: kid `[a-z0-9_-]{1,16}`, huella HMAC truncada a 12 hex). */
const BOX_KID = /^[a-z0-9_-]{1,16}$/;
const BOX_FINGERPRINT = /^[0-9a-f]{12}$/;

function mpSecretCheck(
  key: string,
  label: string,
  fingerprint: string | null,
  needed: boolean,
  missingDetail: string,
  okDetail: string
): SystemCheck {
  if (fingerprint === null) {
    return needed
      ? { key, label, state: "missing", value: null, detail: missingDetail }
      : { key, label, state: "value", value: "sin cargar", detail: "No hace falta con este modo. " + missingDetail };
  }
  return MP_FINGERPRINT.test(fingerprint)
    ? { key, label, state: "ok", value: `huella ${fingerprint}`, detail: okDetail }
    : { key, label, state: "warn", value: "huella inválida", detail: "No se puede mostrar la huella." };
}

function mpConnectChecks(info: MpConnectSystemInfo | null, vercelEnv: string): SystemCheck[] {
  if (!info) {
    return [{ key: "MP_CONNECT_MODE", label: "Modo", state: "warn", value: null, detail: "No se pudo leer la configuración de cobros online." }];
  }
  const mode = enumValue(info.mode, MP_MODES, "off");
  const signature = enumValue(info.signature, MP_SIGNATURES, "required");
  const real = mode === "sandbox" || mode === "live";
  const onVercel = vercelEnv !== "local";
  const checks: SystemCheck[] = [
    {
      key: "MP_CONNECT_MODE",
      label: "Modo",
      state: mode === "inválido" || (mode === "fake" && onVercel) ? "warn" : "value",
      value: mode,
      detail:
        mode === "off"
          ? "Apagado: el turnero reserva sin cobro online y no se generan links de pago."
          : mode === "fake"
            ? "Simulador local: nada toca Mercado Pago real. En Vercel no arranca."
            : mode === "sandbox"
              ? "Sandbox: cuentas y pagos de prueba de Mercado Pago."
              : mode === "live"
                ? "Producción: los pagos entran a la cuenta de cada profesional."
                : "Valor no reconocido.",
    },
    info.clientIdPresent
      ? { key: "MP_OAUTH_CLIENT_ID", label: "Client id de la app", state: "ok", value: null, detail: "Cargado." }
      : real
        ? { key: "MP_OAUTH_CLIENT_ID", label: "Client id de la app", state: "missing", value: null, detail: "Sin client id nadie puede conectar su Mercado Pago." }
        : { key: "MP_OAUTH_CLIENT_ID", label: "Client id de la app", state: "value", value: "sin cargar", detail: "No hace falta con este modo. Cargalo antes de pasar a sandbox o live." },
    mpSecretCheck(
      "MP_OAUTH_CLIENT_SECRET",
      "Client secret de la app",
      info.clientSecretFingerprint,
      real,
      "Sin client secret no se canjea la autorización ni se renuevan los tokens.",
      "Cargado. Compará la huella con la del gestor de contraseñas."
    ),
    mpSecretCheck(
      "MP_CONNECT_WEBHOOK_SECRET",
      "Secreto del webhook (cobros online)",
      info.webhookSecretFingerprint,
      real && signature === "required",
      "Con la firma exigida y sin secreto, el webhook rechaza todos los avisos de pago (401) y Mercado Pago reintenta.",
      "Cargado. Compará la huella con la del secreto de la app en Mercado Pago."
    ),
    {
      key: "MP_CONNECT_WEBHOOK_SIGNATURE",
      label: "Firma del webhook",
      state: signature === "inválido" ? "warn" : "value",
      value: signature,
      detail:
        signature === "fetch-only"
          ? "No se exige la firma: cada aviso se verifica volviendo a pedir el pago con el token de la cuenta."
          : "Se exige la firma y además se vuelve a pedir el pago con el token de la cuenta.",
    },
    secretBoxCheck(info.secretBox, real),
  ];

  const st = info.stats;
  if (!st.available) {
    checks.push({ key: "mp_accounts", label: "Cuentas conectadas", state: "warn", value: null, detail: "No se pudieron leer las cuentas con esta conexión." });
  } else {
    const n = (v: number) => (Number.isInteger(v) && v >= 0 ? v : 0);
    const { active, reauth, disconnected } = st.accounts;
    checks.push(
      {
        key: "mp_accounts",
        label: "Cuentas conectadas",
        state: n(reauth) > 0 ? "warn" : "value",
        value: `${n(active)} activas · ${n(reauth)} a reconectar · ${n(disconnected)} desconectadas`,
        detail:
          n(reauth) > 0
            ? "Hay cuentas que necesitan reconectarse: hasta entonces su turnero reserva sin cobro online."
            : "Cuentas de Mercado Pago de profesionales y consultorios.",
      },
      {
        key: "mp_last_webhook",
        label: "Último webhook aplicado",
        state: "value",
        value: st.lastWebhookAt ? formatArDateTime(st.lastWebhookAt) : "nunca",
        detail: "Último cobro online que cambió por un aviso de Mercado Pago (hora de Argentina).",
      },
      {
        key: "mp_last_refresh",
        label: "Última renovación de tokens",
        state: "value",
        value: st.lastRefreshAt ? formatArDateTime(st.lastRefreshAt) : "nunca",
        detail: "La hace el cron diario con los tokens a menos de 30 días de vencer.",
      }
    );
  }

  if ((info.turneroCheckout ?? "").trim().toLowerCase() === "platform") {
    checks.push({
      key: "TURNERO_CHECKOUT",
      label: "TURNERO_CHECKOUT",
      state: "warn",
      value: "platform",
      detail: "Ya no hace nada: el turnero cobra con la cuenta de cada profesional. Sacala de Vercel.",
    });
  }
  return checks;
}

function secretBoxCheck(box: MpConnectSystemInfo["secretBox"], real: boolean): SystemCheck {
  const kids = box.kids.filter((k) => BOX_KID.test(k));
  const prints = kids
    .map((k) => (BOX_FINGERPRINT.test(box.fingerprints[k] ?? "") ? `${k} ${box.fingerprints[k]}` : `${k} (sin huella)`))
    .join(" · ");
  if (box.configured && kids.length > 0) {
    const primary = box.primaryKid && BOX_KID.test(box.primaryKid) ? box.primaryKid : "?";
    return {
      key: "SECRET_BOX_KEYS",
      label: "Claves de cifrado (SECRET_BOX_KEYS)",
      state: "ok",
      value: `${kids.length} ${kids.length === 1 ? "clave" : "claves"} · sella ${primary}`,
      detail: `Huellas: ${prints}. La primera sella; todas abren.`,
    };
  }
  if (box.devFallback) {
    const dev = BOX_FINGERPRINT.test(box.fingerprints.dev ?? "") ? ` (huella ${box.fingerprints.dev})` : "";
    return {
      key: "SECRET_BOX_KEYS",
      label: "Claves de cifrado (SECRET_BOX_KEYS)",
      state: "warn",
      value: "clave de desarrollo",
      detail: `Sin SECRET_BOX_KEYS: los tokens se sellan con la clave de desarrollo${dev}. Solo sirve fuera de Vercel.`,
    };
  }
  return {
    key: "SECRET_BOX_KEYS",
    label: "Claves de cifrado (SECRET_BOX_KEYS)",
    state: real ? "missing" : "warn",
    value: null,
    detail: "Sin claves (o mal formadas): no se pueden guardar ni abrir los tokens de Mercado Pago.",
  };
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
): SystemConfigStatus {
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
        // TP-2h (§25.10): el token de la plataforma solo sirve al checkout LEGADO (`lib/mercadopago.ts`); el turnero y
        // los links cobran con la cuenta de cada profesional (grupo «Cobros online»). Que falte no es un problema.
        presence(
          "MP_ACCESS_TOKEN",
          "Token de la plataforma (legado)",
          input.MP_ACCESS_TOKEN,
          "Sin token: el checkout legado no cobra. Los cobros online usan la cuenta de cada profesional.",
          "Cargado. Solo lo usa el checkout legado: los cobros online van a la cuenta de cada profesional."
        ),
        presence("MP_PUBLIC_KEY", "Public key", input.MP_PUBLIC_KEY, "Sin public key.", "Cargada."),
        mpToken && !mpSecret
          ? { key: "MP_WEBHOOK_SECRET", label: "Secreto del webhook", state: "missing", value: null, detail: "Con token y sin secreto, el webhook rechaza todos los pagos (503)." }
          : presence("MP_WEBHOOK_SECRET", "Secreto del webhook", input.MP_WEBHOOK_SECRET, "Sin secreto del webhook.", "Cargado."),
      ],
    },
    {
      id: "mp-connect",
      title: "Cobros online (Mercado Pago)",
      checks: mpConnectChecks(input.mpConnect ?? null, vercelEnv),
    },
    {
      id: "runtime",
      title: "Tiempo real y acceso",
      checks: [
        {
          key: "REALTIME_DRIVER",
          label: "Agenda y sala en tiempo real",
          state: realtime === "inválido" ? "warn" : "value",
          value: realtime,
          detail:
            realtime === "supabase"
              ? "Avisos al instante por Supabase Realtime. Probalo con «Probar desde el servidor»."
              : realtime === "local"
                ? "Bus en memoria: solo sirve en desarrollo."
                : realtime === "off"
                  ? "Apagado: sin avisos al instante; la agenda se refresca cada 60 s con la pestaña a la vista."
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
      id: "realtime",
      title: "Tiempo real (Supabase)",
      checks: realtimeChecks(input, realtime),
    },
    {
      id: "cron",
      title: "Tareas programadas",
      checks: [presence("CRON_SECRET", "Secreto de los cron", input.CRON_SECRET, "Sin secreto, los cron no pueden autenticarse.", "Cargado.")],
    },
  ];

  return { generatedAt: now.toISOString(), groups };
}
