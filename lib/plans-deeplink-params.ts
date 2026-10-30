/**
 * Deep-links de Planes (C10): las partes sin zod, para el cliente. PF1-Z (D-PF5) las separó de
 * `lib/plans-deeplink.ts` (que las re-exporta: misma API) porque el perfil del paciente solo necesita esto y al
 * importarlo de allá cargaba zod entero (~13 kB gz) en el JS inicial de /pacientes/[id]. Movido tal cual.
 */

/** Pestaña del perfil (C10). */
export const PLANS_TAB = "planes" as const;
/** Pestaña de la historia clínica (clave histórica `evoluciones`, EV2-3a; FC-3d la hace primera e inicial). */
export const HC_TAB = "evoluciones" as const;
/**
 * Alias de pestañas del perfil → la canónica. FC-3d (§24.7): `?tab=hc` abre la historia clínica. La clave sigue
 * siendo `evoluciones` (los links de `clinicalNoteDeepLink` ya emitidos y `profileNoteBookingId` la usan). `evol` era
 * la curva EVA, que se sacó del perfil en CF (§28): un `?tab=evol` viejo cae en la pestaña por defecto.
 */
export const PROFILE_TAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({ plan: PLANS_TAB, hc: HC_TAB });
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

/**
 * FC-3d (§24.7 «La URL se sincroniza con `replaceState`»): URL con la pestaña que se acaba de elegir, para que un
 * refresh, «atrás/adelante» o un link copiado vuelvan a la misma pestaña (antes el refresh siempre caía a Resumen).
 * La pestaña inicial del viewer (`defaultTab`: la HC con `clinical.read`, Resumen sin él) no escribe `?tab=`: la
 * URL limpia ya abre ahí. Saca `turno` al cambiar de pestaña: ese param es una intención de la HC (deep link de la
 * ficha) y, con otra pestaña en la URL, un refresh no la tiene que revivir. El resto de los params queda.
 */
export function profileTabHref(href: string, tab: string, defaultTab: string): string {
  const url = new URL(href, "http://x");
  if (tab === defaultTab) url.searchParams.delete(PLAN_DEEPLINK_PARAMS.tab);
  else url.searchParams.set(PLAN_DEEPLINK_PARAMS.tab, tab);
  if (tab !== HC_TAB) url.searchParams.delete(PLAN_DEEPLINK_PARAMS.booking);
  const qs = url.searchParams.toString();
  const path = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
  return /^https?:\/\//.test(href) ? `${url.origin}${path}` : path;
}
