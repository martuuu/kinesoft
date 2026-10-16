import "server-only";
/**
 * Zod de las preferencias del tablero, fuera de `lib/preferences-constants.ts` desde PF1-Z (D-PF5).
 *
 * Por qué: `preferences-constants.ts` lo importan componentes cliente del shell, el tablero, la sala y la agenda (tipos,
 * `KPI_OPTIONS`, defaults); con estos schemas adentro, zod entero (~13 kB gz) entraba al JS inicial de esas rutas
 * (`check-bundle-budget.mjs --explain /dashboard`). Los usan solo `lib/dashboard.ts` y `lib/preferences.ts` (server). También van acá la lectura/escritura de las prefs
 * de agenda (`sanitizeAgendaViewPrefs`, `AgendaViewPrefsPatchSchema`, `mergeAgendaViewPrefs`).
 * Semántica sin cambios.
 */
import { z } from "zod";
import {
  AGENDA_MAX_FAVORITES,
  AGENDA_PREF_ID_MAX,
  DEFAULT_AGENDA_VIEW_PREFS,
  type AgendaViewPrefs,
} from "@/lib/preferences-constants";

export const RevenueRangeSchema = z.enum(["week", "month"]);

/** Escritura: patch parcial, estricto (campo desconocido o fuera de dominio → error). */
export const DashboardPrefsPatchSchema = z
  .object({ revenueRange: RevenueRangeSchema })
  .partial()
  .strict();

// ── Agenda (Apariencia, SV, RX): movido tal cual desde `preferences-constants.ts` en PF1-Z. ──
const modeSchema = z.enum(["day", "practitioner", "room"]);
const alertModeSchema = z.enum(["visual", "sound", "off"]);
const salaGroupBySchema = z.enum(["practitioner", "room"]);
const receptionLayoutSchema = z.enum(["board", "list", "flow"]);
const zoomSchema = z.union([z.literal(15), z.literal(30), z.literal(60)]);
const idSchema = z.string().trim().min(1).max(AGENDA_PREF_ID_MAX);

/** Lista de ids → strings válidos, sin duplicados, en orden, con tope. */
function cleanIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const r = idSchema.safeParse(x);
    if (r.success && !out.includes(r.data)) out.push(r.data);
    if (out.length >= AGENDA_MAX_FAVORITES) break;
  }
  return out;
}

/**
 * Lectura: blob no confiable (DB) → `AgendaViewPrefs` válido. Total y por
 * campo. `defaults` permite que el caller ponga su propio default (p. ej. el
 * zoom = `Tenant.agendaSlotMinutes` cuando el usuario nunca eligió uno).
 */
export function sanitizeAgendaViewPrefs(
  raw: unknown,
  defaults: AgendaViewPrefs = DEFAULT_AGENDA_VIEW_PREFS
): AgendaViewPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const schema = z.object({
    mode: modeSchema.catch(defaults.mode),
    zoom: zoomSchema.catch(defaults.zoom),
    density: z.enum(["comfortable", "compact"]).catch(defaults.density),
    favoritePractitionerIds: z.unknown().transform(cleanIds),
    locationId: idSchema.nullable().catch(defaults.locationId),
    // SV: ausente o inválido → default del caller (`.catch` cubre `undefined`).
    arrivalAlert: alertModeSchema.catch(defaults.arrivalAlert),
    callAlert: alertModeSchema.catch(defaults.callAlert),
    salaGroupBy: salaGroupBySchema.catch(defaults.salaGroupBy),
    receptionLayout: receptionLayoutSchema.catch(defaults.receptionLayout),
  });
  const parsed = schema.parse({
    ...o,
    // Campo ausente = default del caller (no `[]`/null forzado).
    favoritePractitionerIds: "favoritePractitionerIds" in o ? o.favoritePractitionerIds : defaults.favoritePractitionerIds,
    locationId: "locationId" in o ? o.locationId : defaults.locationId,
  });
  // `roomId` fuera del schema de arriba: null/ausente/inválido = todas = se omite.
  const room = idSchema.safeParse("roomId" in o ? o.roomId : defaults.roomId);
  return room.success ? { ...parsed, roomId: room.data } : parsed;
}

/** Escritura: patch parcial, estricto (campos desconocidos o fuera de dominio → error). */
export const AgendaViewPrefsPatchSchema = z
  .object({
    mode: modeSchema,
    zoom: zoomSchema,
    density: z.enum(["comfortable", "compact"]),
    favoritePractitionerIds: z
      .array(idSchema)
      .max(AGENDA_MAX_FAVORITES)
      .transform((ids) => Array.from(new Set(ids))),
    locationId: idSchema.nullable(),
    roomId: idSchema.nullable(),
    arrivalAlert: alertModeSchema,
    callAlert: alertModeSchema,
    salaGroupBy: salaGroupBySchema,
    receptionLayout: receptionLayoutSchema,
  })
  .partial()
  .strict();
export type AgendaViewPrefsPatch = z.input<typeof AgendaViewPrefsPatchSchema>;

/** Merge puro de un patch YA validado sobre las prefs actuales. */
export function mergeAgendaViewPrefs(
  current: AgendaViewPrefs,
  patch: z.output<typeof AgendaViewPrefsPatchSchema>
): AgendaViewPrefs {
  const next: Record<string, unknown> = { ...current, ...patch };
  // D2: la sala es de una sede. Un patch que cambia la sede sin traer sala la limpia.
  const locationChanged =
    patch.locationId !== undefined && (patch.locationId ?? null) !== (current.locationId ?? null);
  if (locationChanged && patch.roomId === undefined) delete next.roomId;
  return sanitizeAgendaViewPrefs(next);
}
