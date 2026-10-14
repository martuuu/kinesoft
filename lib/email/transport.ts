/**
 * Por dónde sale un mail (IAM-0b, C-IAM1). PURO: todo entra por parámetro
 * (el env y el mensaje), así la matriz se testea entera sin tocar `process.env`.
 * El envío vive en `index.ts`; Resend en `resend.ts` y Mailpit en `mailpit.ts`.
 *
 * Patrón portado de Traze (`app/lib/email/transport.ts`), con la diferencia de
 * que acá Production se reconoce por `VERCEL_ENV` (como `lib/env.ts`) y no por
 * el host de Supabase: KineSoft no tiene un stack local de Supabase, y un
 * `next start` / `next build` local corre con NODE_ENV=production sin ser prod.
 *
 * La matriz, en orden:
 *  1. Production (`VERCEL_ENV=production`):
 *     - si el html o el texto llevan un link a localhost/127.x/0.0.0.0/::1 →
 *       `blocked`. Un link a localhost no le sirve a nadie y viaja con el token
 *       adentro (en Traze pasó: NEXT_PUBLIC_SITE_URL mal cargada). Gana sobre
 *       todo lo demás, incluso sobre "sin key": tiene que verse como error.
 *     - con `RESEND_API_KEY` y `EMAIL_FROM` → `resend`. `EMAIL_TRANSPORT` se
 *       ignora: nadie apaga los mails de prod con una variable olvidada.
 *     - sin alguna de las dos → `log` (+ aviso al boot en `lib/env.ts`). Sin
 *       EMAIL_FROM, el default `kinesoft.app` no está verificado en Resend y
 *       daría un 403 por mail: mejor no intentar.
 *  2. Preview → `log`, siempre. Los Preview de Vercel corren contra la base de
 *     PROD (memoria del proyecto): un mail desde un Preview le llega a un
 *     paciente real con un link a un deploy efímero.
 *  3. NODE_ENV=test → `mailpit` si se pide, si no `log`. Resend nunca: un test
 *     de integración no puede mandar un mail real aunque `.env.local` traiga
 *     una key.
 *  4. Dev (y `next start` local) → `mailpit` con `EMAIL_TRANSPORT=mailpit`;
 *     `resend` SOLO con `EMAIL_TRANSPORT=resend` explícito + key (lo usa
 *     `scripts/diagnose-email.ts` para que Martin pruebe el dominio antes de
 *     IAM-2), y aun así `blocked` si el mail lleva un link local (el incidente
 *     de Traze: el dev mandaba invitaciones reales con links a localhost
 *     porque la key de prod "se colaba" desde `.env`). Si no, `log`.
 */
import type { EmailTransportName } from "@/lib/email/types";

/** Variables de entorno como entran (`process.env` o un objeto de test). */
export type EnvLike = Record<string, string | undefined>;

/**
 * Por qué un mail NO salió. Es el `reason` de `SendEmailResult` y lo que guarda
 * EmailLog (IAM-1); la UI de IAM-4c lo traduce. Nunca lleva tokens ni direcciones.
 *  - no_api_key           Production sin RESEND_API_KEY (o dev con opt-in sin key). skipped.
 *  - no_from              Production sin EMAIL_FROM. skipped.
 *  - log_only             el entorno no manda a propósito (Preview, dev, test). skipped.
 *  - mailpit_unreachable  Mailpit caído o colgado: cae a log. skipped.
 *  - unsafe_link_host     Production con links a localhost. FALLO (blocked).
 *  - invalid_to           destinatario que no es UN email válido. Fallo.
 *  - rate_limited         Resend 429. Fallo (reintentable).
 *  - provider_error       Resend/Mailpit rechazó (4xx/5xx). Fallo.
 *  - timeout              Resend no contestó en 5 s. Fallo.
 *  - network_error        el fetch falló (DNS, conexión). Fallo.
 *  - internal_error       algo nuestro tiró adentro de sendEmail. Fallo.
 */
export type EmailNotSentReason =
  | "no_api_key"
  | "no_from"
  | "log_only"
  | "mailpit_unreachable"
  | "unsafe_link_host"
  | "invalid_to"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "network_error"
  | "internal_error";

export type EmailTransportDecision = {
  transport: EmailTransportName;
  /** Por qué, en una línea, para logs y el script de diagnóstico. Sin secretos ni direcciones. */
  why: string;
  /** Solo cuando el mail no va a salir (`log` o `blocked`). */
  reason?: EmailNotSentReason;
};

/** Remitente fuera de Production cuando no hay EMAIL_FROM (C-IAM1). En Production no hay default. */
export const DEFAULT_EMAIL_FROM = "KineSoft <no-reply@kinesoft.app>";

/** Sufijo fijo del nombre visible cuando el mail sale en nombre de un consultorio. Nadie lo puede quitar. */
export const FROM_NAME_SUFFIX = " vía KineSoft";

/** Techo del nombre del consultorio en el remitente (se corta con «…»). */
export const FROM_NAME_MAX = 64;

const REQUESTABLE = ["resend", "mailpit", "log"] as const;
type Requested = (typeof REQUESTABLE)[number];

function val(env: EnvLike, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function requested(env: EnvLike): Requested | null {
  const v = val(env, "EMAIL_TRANSPORT")?.toLowerCase();
  return (REQUESTABLE as readonly string[]).includes(v ?? "") ? (v as Requested) : null;
}

export function isProductionEnv(env: EnvLike): boolean {
  return val(env, "VERCEL_ENV") === "production";
}

// ── Hosts ────────────────────────────────────────────────────────────────────

/**
 * ¿El host es la máquina local? localhost (y `*.localhost`, RFC 6761), todo
 * 127.0.0.0/8, 0.0.0.0 y ::1. Un host que solo EMPIEZA con "localhost"
 * (`localhost.example.com`) no lo es.
 */
export function isLocalHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function hostOf(url: string): string | null {
  try {
    // Un href escapado trae `&amp;`: no cambia el host, pero se limpia igual.
    let h = new URL(url.replace(/&amp;/g, "&")).hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    return h || null;
  } catch {
    return null;
  }
}

// Cualquier URL http(s) del contenido, dentro o fuera de un href: el link de
// respaldo ("copiá y pegá") y la parte de texto también llevan el token.
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Primer host LOCAL de cualquier URL http(s) del contenido, o null. */
export function localLinkHostIn(content: string): string | null {
  for (const m of content.matchAll(URL_RE)) {
    const host = hostOf(m[0]);
    if (host && isLocalHost(host)) return host;
  }
  return null;
}

/**
 * Host del PRIMER `href` http(s) del html (el CTA en todas las plantillas), o
 * null. Es el `linkHost` que recibe el sink de EmailLog: alcanza para ver en la
 * base que un mail salió con links a un deploy equivocado, sin guardar el link
 * (que lleva el token).
 */
export function firstLinkHost(html: string): string | null {
  const m = html.match(/\bhref\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/i);
  return m ? hostOf(m[1]) : null;
}

// ── Decisión ─────────────────────────────────────────────────────────────────

export function decideEmailTransport(
  env: EnvLike,
  message: { html?: string; text?: string } = {}
): EmailTransportDecision {
  const content = `${message.html ?? ""}\n${message.text ?? ""}`;
  const req = requested(env);
  const hasKey = !!val(env, "RESEND_API_KEY");

  if (isProductionEnv(env)) {
    const bad = localLinkHostIn(content);
    if (bad) return { transport: "blocked", why: `Production con un link a ${bad}`, reason: "unsafe_link_host" };
    if (!hasKey) return { transport: "log", why: "Production sin RESEND_API_KEY", reason: "no_api_key" };
    if (!val(env, "EMAIL_FROM")) return { transport: "log", why: "Production sin EMAIL_FROM", reason: "no_from" };
    return { transport: "resend", why: "Production" };
  }

  if (val(env, "VERCEL_ENV") === "preview") {
    return { transport: "log", why: "Preview de Vercel (corre contra la base de prod)", reason: "log_only" };
  }

  if (val(env, "NODE_ENV") === "test") {
    return req === "mailpit"
      ? { transport: "mailpit", why: "test + EMAIL_TRANSPORT=mailpit" }
      : { transport: "log", why: "test (nunca Resend)", reason: "log_only" };
  }

  if (req === "mailpit") return { transport: "mailpit", why: "dev + EMAIL_TRANSPORT=mailpit" };
  if (req === "resend") {
    if (!hasKey) return { transport: "log", why: "dev + EMAIL_TRANSPORT=resend sin RESEND_API_KEY", reason: "no_api_key" };
    const bad = localLinkHostIn(content);
    if (bad) return { transport: "blocked", why: `dev + Resend con un link a ${bad}`, reason: "unsafe_link_host" };
    return { transport: "resend", why: "dev + EMAIL_TRANSPORT=resend (opt-in explícito)" };
  }
  return { transport: "log", why: "dev (Mailpit con EMAIL_TRANSPORT=mailpit)", reason: "log_only" };
}

// ── Remitente ────────────────────────────────────────────────────────────────

/** `"KineSoft <a@b>",` → `KineSoft <a@b>`: comillas y comas que se pegan al copiar a Vercel (422 de Resend). */
function cleanAddr(v: string): string {
  return v.trim().replace(/,+\s*$/, "").replace(/^["']+|["']+$/g, "").trim();
}

/** EMAIL_FROM limpio; el default solo fuera de Production; null en Production sin configurar. */
export function resolveBaseFrom(env: EnvLike): string | null {
  const raw = val(env, "EMAIL_FROM");
  if (raw) return cleanAddr(raw);
  return isProductionEnv(env) ? null : DEFAULT_EMAIL_FROM;
}

/** La dirección pelada de `Nombre <casilla>` o `casilla`. */
export function fromAddress(from: string): string {
  const m = from.match(/<\s*([^<>\s]+)\s*>\s*$/);
  return (m ? m[1] : from).trim();
}

/**
 * Nombre visible saneado: sin saltos ni caracteres de control (inyección de
 * cabeceras), sin comillas, `<`, `>` ni barra invertida (romperían el
 * display-name), espacios colapsados y con techo. `""` si no queda nada.
 */
export function sanitizeFromName(raw: string | null | undefined): string {
  const clean = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/["<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= FROM_NAME_MAX) return clean;
  return `${clean.slice(0, FROM_NAME_MAX - 1).trimEnd()}…`;
}

// Specials de RFC 5322 que obligan a un quoted-string en el display-name
// (`Kine S.A., Centro` sin comillas se leería como dos destinatarios).
const RFC_SPECIALS = /[()[\]:;@,.]/;

/**
 * El remitente del envío. Sin `fromName`: EMAIL_FROM tal cual. Con `fromName`
 * (el consultorio): «{nombre} vía KineSoft» con la MISMA casilla. La dirección
 * nunca cambia (SPF/DKIM/DMARC son de KineSoft) y el sufijo lo pone siempre
 * este helper, así ningún emisor puede mandar un mail que se lea como del
 * consultorio solo. Las respuestas van al `replyTo` que pasa quien llama.
 */
export function composeFrom(baseFrom: string, fromName?: string | null): string {
  const name = sanitizeFromName(fromName);
  if (!name) return baseFrom;
  const display = `${name}${FROM_NAME_SUFFIX}`;
  const phrase = RFC_SPECIALS.test(display) ? `"${display}"` : display;
  return `${phrase} <${fromAddress(baseFrom)}>`;
}

// ── Destinatario ─────────────────────────────────────────────────────────────

// Un solo destinatario, sin espacios ni comas (nada de listas), dominio con TLD.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** El email recortado si es UNA dirección válida (≤ 254), o null. No cambia mayúsculas. */
export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || v.length > 254) return null;
  return EMAIL_RE.test(v) ? v : null;
}

/**
 * `juana.perez@gmail.com` → `j***@gmail.com`. Para los logs: alcanza para
 * correlacionar con un reclamo sin dejar la dirección en los logs de Vercel.
 */
export function maskEmail(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at < 1) return "***";
  return `${addr[0]}***@${addr.slice(at + 1)}`;
}
