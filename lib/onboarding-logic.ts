/**
 * Lógica pura del signup verificado y del stepper de alta (A3c-S-signup).
 *
 * Sin Prisma, sin `next/*`, sin Supabase: la importan el layout de la app, la
 * página de `/onboarding`, `lib/tenant-bootstrap.ts` (que también usa el
 * script `create-tenant`) y los unit tests (tests/unit/onboarding-logic.test.ts).
 */

// ──────────────────────────────────────────────────────────────────────
// Slug del consultorio
// ──────────────────────────────────────────────────────────────────────

/** 3-40 chars, minúsculas/números/guiones, sin guión al inicio ni al final. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Paths de primer nivel de la app: un tenant con ese slug chocaría con el
 * router (`/c/<slug>` es lo público, pero el subdominio `<slug>.kinesoft.app`
 * y los links viejos usan el slug pelado). Antes estaba duplicada en
 * `lib/auth.ts` y en `scripts/create-tenant.ts`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "app", "auth", "agenda", "biblioteca", "booking",
  "c", "configuracion", "dashboard", "diagnostico", "forgot", "invite",
  "login", "logout", "onboarding", "pacientes", "plataforma", "portal",
  "reportes", "reset", "seguimiento", "signup", "terapia-manual", "www",
]);

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/**
 * "Centro Kinésico Movare" → "centro-kinesico-movare". Nunca devuelve algo
 * inválido: si el nombre no deja nada usable (emojis, "!!") o cae en un slug
 * reservado, cae a "consultorio".
 */
export function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  if (s.length < 3 || RESERVED_SLUGS.has(s)) s = s.length >= 3 ? `${s}-kine` : "consultorio";
  return s;
}

/**
 * Primer slug libre para `base`: `base`, `base-2`, `base-3`… `taken` son los
 * slugs que ya existen con ese prefijo (una sola query `startsWith`). El
 * índice único de la DB sigue siendo la verdad: ante una carrera, el caller
 * reintenta (ver `lib/tenant-bootstrap.ts`).
 */
export function pickFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const cand = `${base.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(cand)) return cand;
  }
  // Inalcanzable en la práctica (10k consultorios con el mismo nombre).
  return `${base.slice(0, 31)}-${Date.now().toString(36)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Guard del layout de la app (`app/(app)/layout.tsx`)
// ──────────────────────────────────────────────────────────────────────

export type AppGateInput = {
  /** Hay sesión de Supabase (getUser devolvió usuario). */
  hasSession: boolean;
  /** Se pudo armar un Actor (membresía aceptada + practitioner). */
  hasActor: boolean;
  /** Rol del actor en el tenant activo (null si no hay actor). */
  role: string | null;
  /** `Tenant.onboardingCompletedAt != null` del tenant activo. */
  onboardingCompleted: boolean;
  /** Path pedido, para volver después del login (ya pasado por safeNext o null). */
  nextPath: string | null;
};

/**
 * Adónde manda el layout de la app. `null` = renderizar la app.
 *
 * - Sin sesión → `/login?next=<path>` (handoff de A3b-S-auth: antes se perdía
 *   el destino y el usuario caía siempre en /dashboard).
 * - Sesión verificada sin membresía → `/onboarding`. Antes iba a `/login`, que
 *   lo mandaba de vuelta a /dashboard: loop para toda cuenta nueva y para un
 *   invitado que todavía no aceptó. `/onboarding` resuelve las dos cosas: si
 *   hay una invitación pendiente para su email la ofrece primero; si no, arranca
 *   el alta del consultorio.
 * - OWNER de un tenant con el alta sin terminar → `/onboarding`. Los demás
 *   roles NO: un profesional invitado mientras el dueño todavía configura no
 *   tiene nada que hacer en el stepper (y no podría: es OWNER-only).
 */
export function decideAppGate(i: AppGateInput): string | null {
  if (!i.hasActor) {
    if (!i.hasSession) {
      return i.nextPath && i.nextPath !== "/dashboard"
        ? `/login?next=${encodeURIComponent(i.nextPath)}`
        : "/login";
    }
    return "/onboarding";
  }
  if (!i.onboardingCompleted && i.role === "OWNER") return "/onboarding";
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Pasos del stepper
// ──────────────────────────────────────────────────────────────────────

/**
 * El paso 1 fue la cuenta (signup + verificación); el stepper arranca en el 2.
 * B-pre suma sedes, horarios por profesional, prácticas y coberturas de
 * catálogo: se agregan acá y en `components/onboarding/`.
 */
export const ONBOARDING_STEPS = [
  { n: 1, key: "account", label: "Tu cuenta" },
  { n: 2, key: "clinic", label: "Consultorio" },
  { n: 3, key: "hours", label: "Horario" },
  { n: 4, key: "services", label: "Servicios" },
  { n: 5, key: "insurers", label: "Obras sociales" },
  { n: 6, key: "team", label: "Equipo" },
  { n: 7, key: "done", label: "Listo" },
] as const;

export type OnboardingStepNumber = 2 | 3 | 4 | 5 | 6 | 7;
export const FIRST_STEP: OnboardingStepNumber = 2;
export const LAST_STEP: OnboardingStepNumber = 7;

export type OnboardingProgress = {
  hasTenant: boolean;
  servicesCount: number;
  /** Obras sociales además de "Particular". */
  insurersCount: number;
  invitationsCount: number;
};

/**
 * Paso en el que se retoma el alta, derivado del estado (sin columna "paso
 * actual": lo que ya se cargó ES el progreso). Horario y servicios van juntos
 * porque el horario tiene default (8-19) y no deja rastro propio: si todavía
 * no hay servicios, se retoma en el horario para que lo vea.
 */
export function deriveResumeStep(p: OnboardingProgress): OnboardingStepNumber {
  if (!p.hasTenant) return 2;
  if (p.servicesCount === 0) return 3;
  if (p.insurersCount === 0 && p.invitationsCount === 0) return 5;
  if (p.invitationsCount === 0) return 6;
  return 7;
}

/**
 * Paso a mostrar dado el `?step=` de la URL. Sin tenant solo existe el 2 (los
 * demás escriben sobre el tenant). Sin servicios no se pasa del 4: la agenda
 * y el turnero necesitan al menos uno.
 */
export function resolveStep(requested: string | null | undefined, p: OnboardingProgress): OnboardingStepNumber {
  const resume = deriveResumeStep(p);
  const n = Number(requested);
  if (!requested || !Number.isInteger(n) || n < FIRST_STEP || n > LAST_STEP) return resume;
  if (!p.hasTenant) return 2;
  if (p.servicesCount === 0 && n > 4) return 4;
  return n as OnboardingStepNumber;
}
