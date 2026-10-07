/**
 * Deep-links de Planes (P3-C, ES3 · contrato C10 de `.docs/PLANES.md` §4).
 *
 * Rutas (literal de C10):
 *   - `/pacientes/<id>?tab=planes&programa=<programId>`        → la card de ese plan
 *   - `/pacientes/<id>?tab=planes&nuevo=1&turno=<bookingId>`   → editor, "crear desde el turno"
 *   - `/pacientes/<id>?tab=planes&nuevo=1&prefill=<base64url>` → editor prellenado (`PlanEditorPrefill`)
 *   - `/diagnostico?patientId=&bookingId=`                      → puerta Diagnóstico
 *
 * Reglas:
 *   - Se ARMAN y se PARSEAN **solo acá** (nadie concatena `?tab=planes…` a mano;
 *     `lib/plans.ts` lo hacía en la notificación y queda igual al formato de acá).
 *   - El `prefill` va con zod y un tope de 2 kB (el string base64url). Un
 *     prefill roto, viejo o enorme NO rompe la pantalla: se ignora y el editor
 *     abre vacío (`prefillInvalid: true` para que la UI pueda avisar).
 *   - La pestaña es `'planes'`, con el alias `'plan'` (links viejos y la unión
 *     `Tab` de antes de ES3).
 *   - El prefill NO lleva texto libre (título, notas): la URL queda en el
 *     historial, en logs y en el `Referer`. Lleva ids, fechas, horario y
 *     precio; el título lo propone el editor (D6) y las notas y la autorización
 *     de la OS (su código es texto libre; fuera desde P3.Z) se cargan en el editor.
 *
 * Puro (sin `server-only`): lo usan la página del perfil (server), el shell
 * del perfil, el modal de agenda ("Crealo como plan…") y el drawer.
 */
import { z } from "zod";
import { DISCIPLINES, PLAN_MAX_DURATION, PLAN_MAX_SESSIONS, PLAN_MIN_DURATION } from "@/lib/plans-constants";
import { DayKeySchema, PlanPricingSchema, PlanScheduleV1Schema } from "@/lib/plans-schemas";

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Pestaña del perfil (C10). */
export const PLANS_TAB = "planes" as const;
/** Alias de pestañas del perfil → la canónica. */
export const PROFILE_TAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({ plan: PLANS_TAB });
/** Tope del `prefill` (string base64url, C10). */
export const PLAN_PREFILL_MAX_CHARS = 2048;

/** Nombres de los params (una sola fuente; el shell los limpia después de abrir). */
export const PLAN_DEEPLINK_PARAMS = {
  tab: "tab",
  program: "programa",
  isNew: "nuevo",
  booking: "turno",
  prefill: "prefill",
  diagnosisPatient: "patientId",
  diagnosisBooking: "bookingId",
} as const;

/**
 * Id que viaja en la URL (cuid). Más estricto que `PlanEntityId`: solo
 * caracteres seguros para URL, así un id nunca necesita escape ni puede
 * inyectar otro param. El server igual lo valida contra el tenant.
 */
const UrlIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// ─── PlanEditorPrefill ───────────────────────────────────────────────────────

/**
 * Borrador parcial del editor que viaja en `?prefill=` (C10). Todo opcional:
 * el editor completa lo que falta con sus defaults. Sin `patientId` (va en la
 * ruta) ni texto libre (ver arriba). Las claves desconocidas se descartan (un
 * link armado por una versión más nueva sigue abriendo).
 *
 * Sin `authorization` (P3.Z): el código de la autorización de la OS es texto
 * libre (≤ 64) y en la URL queda en el historial, los logs y el Referer (C10
 * "sin texto libre", §2.6). La autorización se carga en el editor. Un link
 * viejo que la traiga abre igual: la clave se descarta como cualquier otra
 * desconocida.
 */
export const PlanEditorPrefillSchema = z.object({
  discipline: z.enum(DISCIPLINES).optional(),
  serviceId: UrlIdSchema.optional(),
  practitionerId: UrlIdSchema.optional(),
  /** null = sede principal / sin sede (como `PlanCreateInput.locationId`). */
  locationId: UrlIdSchema.nullable().optional(),
  durationMin: z.number().int().min(PLAN_MIN_DURATION).max(PLAN_MAX_DURATION).optional(),
  startDayKey: DayKeySchema.optional(),
  totalSessions: z.number().int().min(1).max(PLAN_MAX_SESSIONS).optional(),
  schedule: PlanScheduleV1Schema.optional(),
  /** null = "Sin precio · sigue la cobertura". */
  pricing: PlanPricingSchema.optional(),
  templateId: UrlIdSchema.optional(),
  /** Puerta 4 / "Crealo como plan…": el turno de origen. */
  fromBookingId: UrlIdSchema.optional(),
  countBookingAsSession1: z.boolean().optional(),
});

export type PlanEditorPrefill = z.output<typeof PlanEditorPrefillSchema>;

// ─── base64url (UTF-8, sin padding), igual en Node y en el navegador ─────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Prefill → string para `?prefill=`. `null` si no pasa el zod o si excede
 * `PLAN_PREFILL_MAX_CHARS` (el caller cae al link sin prefill o deshabilita
 * el botón; nunca arma un link que el parser después va a tirar).
 */
export function encodePlanPrefill(prefill: PlanEditorPrefill): string | null {
  const parsed = PlanEditorPrefillSchema.safeParse(prefill);
  if (!parsed.success) return null;
  const out = toBase64Url(JSON.stringify(parsed.data));
  return out.length <= PLAN_PREFILL_MAX_CHARS ? out : null;
}

/** `?prefill=` → prefill validado, o `null` (vacío, > 2 kB, base64 o JSON roto, zod). */
export function decodePlanPrefill(raw: string | null | undefined): PlanEditorPrefill | null {
  if (!raw || raw.length > PLAN_PREFILL_MAX_CHARS) return null;
  const text = fromBase64Url(raw);
  if (text == null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PlanEditorPrefillSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ─── Armar ───────────────────────────────────────────────────────────────────

export type PlanDeepLink =
  /** Tab Planes con la card de ese plan en foco. */
  | { kind: "program"; patientId: string; programId: string }
  /** Editor nuevo: vacío, desde un turno (`fromBookingId`) y/o prellenado. */
  | { kind: "new"; patientId: string; fromBookingId?: string; prefill?: PlanEditorPrefill }
  /** Puerta Diagnóstico (los dos opcionales). */
  | { kind: "diagnosis"; patientId?: string; bookingId?: string };

/**
 * Href del deep-link. `null` si un id no es válido para URL o si el prefill
 * no entra (zod o > 2 kB): la UI deshabilita el botón en vez de navegar a un
 * link roto.
 */
export function planDeepLinkHref(link: PlanDeepLink): string | null {
  const ok = (id: string | undefined) => id === undefined || UrlIdSchema.safeParse(id).success;
  const P = PLAN_DEEPLINK_PARAMS;
  if (link.kind === "diagnosis") {
    if (!ok(link.patientId) || !ok(link.bookingId)) return null;
    const q = new URLSearchParams();
    if (link.patientId) q.set(P.diagnosisPatient, link.patientId);
    if (link.bookingId) q.set(P.diagnosisBooking, link.bookingId);
    const qs = q.toString();
    return qs ? `/diagnostico?${qs}` : "/diagnostico";
  }
  if (!ok(link.patientId)) return null;
  const q = new URLSearchParams({ [P.tab]: PLANS_TAB });
  if (link.kind === "program") {
    if (!ok(link.programId)) return null;
    q.set(P.program, link.programId);
  } else {
    q.set(P.isNew, "1");
    if (link.fromBookingId !== undefined) {
      if (!ok(link.fromBookingId)) return null;
      q.set(P.booking, link.fromBookingId);
    }
    if (link.prefill !== undefined) {
      const encoded = encodePlanPrefill(link.prefill);
      if (encoded == null) return null;
      q.set(P.prefill, encoded);
    }
  }
  return `/pacientes/${link.patientId}?${q.toString()}`;
}

// ─── Parsear ─────────────────────────────────────────────────────────────────

/** `searchParams` de una página (server) o `URLSearchParams` (cliente). */
export type SearchParamsLike = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function param(sp: SearchParamsLike, key: string): string | null {
  if (sp instanceof URLSearchParams) return sp.get(key);
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

function urlId(raw: string | null): string | null {
  return raw != null && UrlIdSchema.safeParse(raw).success ? raw : null;
}

/** Pestaña del perfil normalizada (`'plan'` → `'planes'`); `null` sin `?tab=`. */
export function normalizeProfileTab(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return PROFILE_TAB_ALIASES[raw] ?? raw;
}

export type ProfilePlanIntent =
  | { kind: "none" }
  | { kind: "program"; programId: string }
  | {
      kind: "new";
      fromBookingId: string | null;
      prefill: PlanEditorPrefill | null;
      /** Vino un `?prefill=` y se descartó (roto, viejo o > 2 kB): la UI puede avisar. */
      prefillInvalid: boolean;
    };

/**
 * Params del perfil → pestaña + intención de Planes. La intención solo
 * existe con `tab=planes` (o el alias): un `?programa=` suelto no abre nada.
 * `programa` gana sobre `nuevo` si vienen los dos (abrir lo que existe es lo
 * menos sorpresivo). El shell decide permisos y módulo: esto solo lee la URL.
 */
export function parseProfilePlanParams(sp: SearchParamsLike): { tab: string | null; intent: ProfilePlanIntent } {
  const P = PLAN_DEEPLINK_PARAMS;
  const tab = normalizeProfileTab(param(sp, P.tab));
  if (tab !== PLANS_TAB) return { tab, intent: { kind: "none" } };
  const programId = urlId(param(sp, P.program));
  if (programId) return { tab, intent: { kind: "program", programId } };
  if (param(sp, P.isNew) !== "1") return { tab, intent: { kind: "none" } };
  const rawPrefill = param(sp, P.prefill);
  const prefill = decodePlanPrefill(rawPrefill);
  return {
    tab,
    intent: {
      kind: "new",
      fromBookingId: urlId(param(sp, P.booking)),
      prefill,
      prefillInvalid: rawPrefill != null && rawPrefill !== "" && prefill == null,
    },
  };
}

/** `/diagnostico?patientId=&bookingId=` → ids válidos o `null`. */
export function parseDiagnosisDeepLink(sp: SearchParamsLike): { patientId: string | null; bookingId: string | null } {
  const P = PLAN_DEEPLINK_PARAMS;
  return { patientId: urlId(param(sp, P.diagnosisPatient)), bookingId: urlId(param(sp, P.diagnosisBooking)) };
}

/**
 * URL sin los params de una intención ya consumida (`nuevo`, `turno`,
 * `prefill`, `programa`), para `history.replaceState` después de abrir el
 * editor o la card: un refresh no lo vuelve a disparar (mismo patrón que
 * `/agenda?new=1`). Conserva `tab` y el resto.
 */
export function stripPlanIntentParams(href: string): string {
  const url = new URL(href, "http://x");
  const P = PLAN_DEEPLINK_PARAMS;
  for (const k of [P.program, P.isNew, P.booking, P.prefill]) url.searchParams.delete(k);
  const qs = url.searchParams.toString();
  const path = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
  return /^https?:\/\//.test(href) ? `${url.origin}${path}` : path;
}
