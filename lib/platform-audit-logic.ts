/**
 * BO3-E · lógica pura del visor de auditoría de Plataforma (`/plataforma/auditoria`). Sin I/O: la usan
 * `lib/platform-audit-read.ts` (server) y la página; tiene su unit test.
 *
 * Por qué el payload sale como CLAVES y no como valores: `PlatformAuditEvent.payload` es JSON libre que escribe cada
 * call site. Hoy son ids, enums y contadores, pero ya hay textos (`label` de un tag, `email` de una invitación,
 * `name`/`previousName` del catálogo) y nada impide que mañana alguien audite un motivo o un dato de paciente. El
 * visor cruza consultorios: si mostrara valores, sería el lugar por donde un dato sensible sale de su consultorio.
 * Por eso la regla es al revés de un log común: se muestran las claves (qué cambió) y solo los VALORES de una lista
 * cerrada de claves que por construcción son enums, booleanos o contadores. Una clave nueva arranca oculta.
 */

export const PLATFORM_AUDIT_PAGE_SIZE = 50;

/** Claves cuyo valor es un enum/código corto (plan, estado, rol, tipo…): se muestran si pasan `ENUMISH`. */
const ENUM_VALUE_KEYS = new Set([
  "plan",
  "status",
  "subscriptionStatus",
  "role",
  "vertical",
  "kind",
  "type",
  "scope",
  "purpose",
  "emailStatus",
  "transport",
  "endedReason",
  "source",
  "via",
]);

/** Claves de contadores (enteros). */
const COUNTER_KEYS = new Set([
  "count",
  "durationMin",
  "futureBookings",
  "revokedInvitations",
  "revokedPriorLinks",
  "aliasesAdded",
  "reasonLength",
  "schedules",
  "services",
  "payers",
]);

/** Claves de banderas (booleanos). */
const BOOLEAN_KEYS = new Set(["linkShown", "self", "reasonGiven", "publicBookingEnabled"]);

/**
 * `changed` es la lista de NOMBRES de campos tocados (`["email"]`, `["slug"]`): no son valores. Se muestra si cada
 * ítem es un identificador.
 */
const FIELD_LIST_KEYS = new Set(["changed"]);

/** Contenedores de un nivel cuyas claves internas se listan con el mismo criterio (`before.plan`, `after.status`). */
const NESTED_KEYS = new Set(["before", "after"]);

/**
 * Interno del escritor (`platform.actorHomeTenantId`, `platformEventId`): no dice nada de la acción y repetirlo en
 * cada fila es ruido. `supportSessionId` lo estampa `audit()`; en el registro global no debería aparecer.
 */
const HIDDEN_KEYS = new Set(["platform"]);

/** Un enum/código: letras, dígitos, `_`, `.`, `-`, `:`; corto. Un mail o un texto libre no pasa (`@`, espacios). */
const ENUMISH = /^[A-Za-z0-9_.:-]{1,40}$/;
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export type PlatformAuditPayloadEntry = {
  /** Clave (con prefijo `before.` / `after.` si viene de un contenedor). */
  key: string;
  /** Valor visible, o null = la clave existe pero el valor no se muestra. */
  value: string | null;
};

/** Fila del visor. Lista cerrada de campos: NUNCA el payload crudo, la IP ni el user agent. */
export type PlatformAuditRow = {
  id: string;
  /** ISO. */
  createdAt: string;
  action: string;
  actorEmail: string | null;
  tenant: { id: string; name: string } | null;
  targetUserId: string | null;
  payload: PlatformAuditPayloadEntry[];
};

export type PlatformAuditPage = { rows: PlatformAuditRow[]; nextCursor: string | null };

export type PlatformAuditFilters = {
  action?: string;
  tenantId?: string;
  actorEmail?: string;
  targetUserId?: string;
  /** Día AR "YYYY-MM-DD", inclusive. */
  from?: string;
  /** Día AR "YYYY-MM-DD", inclusive. */
  to?: string;
  cursor?: string;
};

function visibleValue(key: string, v: unknown): string | null {
  if (ENUM_VALUE_KEYS.has(key)) return typeof v === "string" && ENUMISH.test(v) ? v : null;
  if (COUNTER_KEYS.has(key)) return typeof v === "number" && Number.isInteger(v) ? String(v) : null;
  if (BOOLEAN_KEYS.has(key)) return typeof v === "boolean" ? (v ? "sí" : "no") : null;
  if (FIELD_LIST_KEYS.has(key)) {
    return Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every((x) => typeof x === "string" && IDENT.test(x))
      ? (v as string[]).join(", ")
      : null;
  }
  return null;
}

/** Claves de una clave «segura» como identificador: una clave rara (con espacios, larga) también es dato. */
function safeKey(k: string): string | null {
  return IDENT.test(k) ? k : null;
}

/**
 * Payload JSON → claves (+ valores de la allowlist). Total: cualquier JSON (null, array, escalar) da una lista,
 * nunca tira. Orden: el del objeto.
 */
export function sanitizeAuditPayload(payload: unknown): PlatformAuditPayloadEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const out: PlatformAuditPayloadEntry[] = [];
  for (const [rawKey, v] of Object.entries(payload as Record<string, unknown>)) {
    const k = safeKey(rawKey);
    if (!k || HIDDEN_KEYS.has(k)) continue;
    if (NESTED_KEYS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [rawInner, iv] of Object.entries(v as Record<string, unknown>)) {
        const ik = safeKey(rawInner);
        if (!ik) continue;
        out.push({ key: `${k}.${ik}`, value: visibleValue(ik, iv) });
      }
      continue;
    }
    out.push({ key: k, value: visibleValue(k, v) });
  }
  return out.slice(0, 30);
}

// ── Cursor ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cursor opaco `(createdAt, id)` de la última fila. base64url para que viaje limpio en la URL. */
export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

/** null si está roto (editado a mano): la lista arranca de nuevo en vez de tirar. */
export function decodeAuditCursor(cursor: string | undefined | null): { createdAt: Date; id: string } | null {
  if (!cursor || cursor.length > 200) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { createdAt, id };
}

// ── Fechas (día AR) ──────────────────────────────────────────────────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rango [desde, hasta) en instantes UTC para días AR inclusive. Argentina es UTC-3 todo el año (sin DST desde 2009),
 * así que el día AR arranca a las 03:00 UTC: `new Date("YYYY-MM-DD")` del host sería la medianoche UTC (21:00 AR del
 * día anterior) y correría el filtro 3 h. Un día inválido se ignora.
 */
export function auditDayRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const start = (day: string | undefined) => {
    if (!day || !DAY_KEY.test(day)) return undefined;
    const d = new Date(`${day}T00:00:00-03:00`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const gte = start(from);
  const toStart = start(to);
  return { gte, lt: toStart ? new Date(toStart.getTime() + 24 * 60 * 60 * 1000) : undefined };
}

/** Normaliza los filtros de la URL: trim, largo máximo y formato; lo inválido se descarta (no tira). */
export function normalizeAuditFilters(raw: Record<string, string | undefined>): PlatformAuditFilters {
  const clean = (v: string | undefined, max: number, re?: RegExp) => {
    const t = (v ?? "").trim();
    if (!t || t.length > max) return undefined;
    return re && !re.test(t) ? undefined : t;
  };
  return {
    action: clean(raw.action, 80, /^[a-z0-9_.]+$/i),
    tenantId: clean(raw.tenantId, 64, /^[A-Za-z0-9_-]+$/),
    actorEmail: clean(raw.actorEmail, 254),
    targetUserId: clean(raw.targetUserId, 64, /^[A-Za-z0-9_-]+$/),
    from: clean(raw.from, 10, DAY_KEY),
    to: clean(raw.to, 10, DAY_KEY),
    cursor: clean(raw.cursor, 200),
  };
}

/** Querystring de la página con los filtros (sin el cursor salvo que se pase uno). */
export function auditHref(f: PlatformAuditFilters, cursor?: string | null): string {
  const sp = new URLSearchParams();
  if (f.action) sp.set("action", f.action);
  if (f.tenantId) sp.set("tenantId", f.tenantId);
  if (f.actorEmail) sp.set("actorEmail", f.actorEmail);
  if (f.targetUserId) sp.set("targetUserId", f.targetUserId);
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  if (cursor) sp.set("cursor", cursor);
  const s = sp.toString();
  return s ? `/plataforma/auditoria?${s}` : "/plataforma/auditoria";
}
