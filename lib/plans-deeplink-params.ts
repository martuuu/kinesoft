/**
 * Deep-links de Planes (C10): las partes sin zod, para el cliente. PF1-Z (D-PF5) las separó de
 * `lib/plans-deeplink.ts` (que las re-exporta: misma API) porque el perfil del paciente solo necesita esto y al
 * importarlo de allá cargaba zod entero (~13 kB gz) en el JS inicial de /pacientes/[id]. Movido tal cual.
 */

/** Pestaña del perfil (C10). */
export const PLANS_TAB = "planes" as const;
/** Alias de pestañas del perfil → la canónica. */
export const PROFILE_TAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({ plan: PLANS_TAB });
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
/** Pestaña del perfil normalizada (`'plan'` → `'planes'`); `null` sin `?tab=`. */
export function normalizeProfileTab(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return PROFILE_TAB_ALIASES[raw] ?? raw;
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
