/**
 * Lógica pura del signup verificado y del stepper de alta (A3c-S-signup).
 *
 * Sin Prisma, sin `next/*`, sin Supabase: la importan el layout de la app, la
 * página de `/onboarding`, `lib/tenant-bootstrap.ts` (que también usa el
 * script `create-tenant`) y los unit tests (tests/unit/onboarding-logic.test.ts).
 */
// Solo tipo (se borra al compilar) y relativo: `tenant-bootstrap` lo importa desde un script de tsx.
import type { AccessState } from "./access-logic";

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
  "c", "configuracion", "dashboard", "diagnostico", "elegir-consultorio", "forgot", "invite",
  "login", "logout", "onboarding", "pacientes", "plataforma", "portal",
  "reportes", "reset", "seguimiento", "signup", "sin-acceso", "terapia-manual", "www",
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
  /** Se pudo armar un Actor (membresía usable). También true con el actor demo (sin sesión). */
  hasActor: boolean;
  /**
   * IAM-3a: estado de acceso de la sesión (`resolveAccessState` sobre TODAS sus membresías). null = no hay foto
   * (sin sesión, o actor demo).
   */
  access: AccessState | null;
  /** IAM-3a (decisión 6): 2+ consultorios usables y la cookie `kine_tenant` no apunta a uno → preguntar. */
  needsChoice: boolean;
  /** Rol del actor en el tenant activo (null si no hay actor). */
  role: string | null;
  /** `Tenant.onboardingCompletedAt != null` del tenant activo. */
  onboardingCompleted: boolean;
  /** Path pedido, para volver después del login / la elección (ya pasado por safeNext o null). */
  nextPath: string | null;
};

/** Destinos del gate. Todos viven FUERA del grupo `(app)`: ninguno vuelve a pasar por este layout. */
export const APP_GATE_DESTINATIONS = ["/login", "/onboarding", "/sin-acceso", "/elegir-consultorio"] as const;

function withNext(path: string, next: string | null): string {
  // /dashboard es el default de todos estos destinos: no hace falta ensuciar la URL.
  return next && next !== "/dashboard" ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/**
 * Adónde manda el layout de la app. `null` = renderizar la app.
 *
 * - Sin sesión → `/login?next=<path>` (handoff de A3b-S-auth: antes se perdía
 *   el destino y el usuario caía siempre en /dashboard).
 * - Sesión sin ninguna membresía → `/onboarding`. Antes iba a `/login`, que
 *   lo mandaba de vuelta a /dashboard: loop para toda cuenta nueva y para un
 *   invitado que todavía no aceptó. `/onboarding` resuelve las dos cosas: si
 *   hay una invitación pendiente para su email la ofrece primero; si no, arranca
 *   el alta del consultorio.
 * - IAM-3a: sesión con membresías pero NINGUNA usable (todas suspendidas, sin
 *   aceptar o sin profesional) → `/sin-acceso`. Antes iba a `/onboarding`, que
 *   veía membresías y decía «done» → /dashboard → acá → … (bucle del 14-oct,
 *   §19.1). `/sin-acceso` está fuera de `(app)` y no redirige solo a la app.
 * - IAM-3a (decisión 6): 2+ consultorios usables sin cookie válida →
 *   `/elegir-consultorio?next=<path>`. Antes que el alta abierta: primero se
 *   elige DÓNDE entrar.
 * - OWNER de un tenant con el alta sin terminar → `/onboarding`. Los demás
 *   roles NO: un profesional invitado mientras el dueño todavía configura no
 *   tiene nada que hacer en el stepper (y no podría: es OWNER-only).
 */
export function decideAppGate(i: AppGateInput): string | null {
  if (!i.hasActor) {
    if (!i.hasSession) return withNext("/login", i.nextPath);
    if (!i.access || i.access.kind === "needs_onboarding") return "/onboarding";
    // `no_access`, o `ok` sin Actor (no debería pasar: `buildActor` arma el Actor desde la misma foto). Las dos van
    // a /sin-acceso, que muestra el motivo y NUNCA rebota solo a la app: si hubiera una carrera, no hay bucle.
    return "/sin-acceso";
  }
  if (i.needsChoice) return withNext("/elegir-consultorio", i.nextPath);
  if (!i.onboardingCompleted && i.role === "OWNER") return "/onboarding";
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Pasos del stepper
// ──────────────────────────────────────────────────────────────────────

/**
 * El paso 1 fue la cuenta (signup + verificación); el stepper arranca en el 2.
 * B5.5 ONB (B-pre) sumó "Sede" y "Tu horario" (la agenda por profesional los
 * necesita) y metió prácticas y coberturas del catálogo dentro de Servicios y
 * Obras sociales. Los componentes usan `STEP.*`, nunca el número pelado: así
 * insertar un paso no obliga a renumerar a mano cada `go(n)`.
 */
export const ONBOARDING_STEPS = [
  { n: 1, key: "account", label: "Tu cuenta" },
  { n: 2, key: "clinic", label: "Consultorio" },
  { n: 3, key: "location", label: "Sede" },
  { n: 4, key: "hours", label: "Horario" },
  { n: 5, key: "myHours", label: "Tu horario" },
  { n: 6, key: "services", label: "Servicios" },
  { n: 7, key: "insurers", label: "Obras sociales" },
  { n: 8, key: "team", label: "Equipo" },
  { n: 9, key: "done", label: "Listo" },
] as const;

export type OnboardingStepKey = Exclude<(typeof ONBOARDING_STEPS)[number]["key"], "account">;
export type OnboardingStepNumber = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Número de cada paso por clave. */
export const STEP = Object.fromEntries(
  ONBOARDING_STEPS.filter((s) => s.key !== "account").map((s) => [s.key, s.n])
) as { readonly [K in OnboardingStepKey]: OnboardingStepNumber };

export const FIRST_STEP: OnboardingStepNumber = STEP.clinic;
export const LAST_STEP: OnboardingStepNumber = STEP.done;

export type OnboardingProgress = {
  hasTenant: boolean;
  /** La sede principal (activa) tiene la dirección cargada. */
  locationReady: boolean;
  /**
   * El OWNER guardó su semana (paso "Tu horario"). La plantilla que deja el
   * alta (lun-sáb con el horario del consultorio) NO cuenta: ver
   * `isCustomSchedule`.
   */
  ownScheduleSaved: boolean;
  servicesCount: number;
  /** Obras sociales además de "Particular". */
  insurersCount: number;
  invitationsCount: number;
};

/**
 * Paso en el que se retoma el alta, derivado del estado (sin columna "paso
 * actual": lo que ya se cargó ES el progreso).
 *
 * Regla: el paso SIGUIENTE a la evidencia más avanzada. Los pasos se recorren
 * en orden, así que el último dato real dice hasta dónde llegó el usuario; se
 * mira de atrás para adelante para que la regla sea monótona (cargar algo
 * nunca hace retroceder el punto de retome). Un alta abierta antes de B-pre
 * que ya tenía servicios retoma en Obras sociales aunque su sede no tenga
 * dirección: Sede y Tu horario quedan a un click en el riel y en el resumen.
 *
 *   sin tenant                 → Consultorio
 *   invitaciones               → Listo
 *   obras sociales             → Equipo
 *   servicios                  → Obras sociales
 *   semana propia guardada     → Servicios
 *   sede con dirección         → Horario (el del consultorio no deja rastro
 *                                propio: tiene default 8-19, así que se
 *                                retoma ahí para que lo vea)
 *   nada más                   → Sede
 */
export function deriveResumeStep(p: OnboardingProgress): OnboardingStepNumber {
  if (!p.hasTenant) return STEP.clinic;
  if (p.invitationsCount > 0) return STEP.done;
  if (p.insurersCount > 0) return STEP.team;
  if (p.servicesCount > 0) return STEP.insurers;
  if (p.ownScheduleSaved) return STEP.services;
  if (p.locationReady) return STEP.hours;
  return STEP.location;
}

/**
 * Paso a mostrar dado el `?step=` de la URL. Sin tenant solo existe
 * Consultorio (los demás escriben sobre el tenant). Sin servicios no se pasa
 * de Servicios: la agenda y el turnero necesitan al menos uno.
 */
export function resolveStep(requested: string | null | undefined, p: OnboardingProgress): OnboardingStepNumber {
  const resume = deriveResumeStep(p);
  const n = Number(requested);
  if (!requested || !Number.isInteger(n) || n < FIRST_STEP || n > LAST_STEP) return resume;
  if (!p.hasTenant) return STEP.clinic;
  if (p.servicesCount === 0 && n > STEP.services) return STEP.services;
  return n as OnboardingStepNumber;
}

/**
 * Último paso al que se puede saltar desde el riel. Con servicios, todos;
 * sin servicios, hasta Servicios (o más, si el retome ya está más adelante,
 * cosa que hoy no pasa: sin servicios el retome es a lo sumo Servicios).
 */
export function maxReachableStep(p: OnboardingProgress): OnboardingStepNumber {
  if (!p.hasTenant) return STEP.clinic;
  if (p.servicesCount > 0) return LAST_STEP;
  return Math.max(STEP.services, deriveResumeStep(p)) as OnboardingStepNumber;
}

/**
 * ¿La semana del profesional es "suya" (guardada a mano) o la plantilla que
 * dejó el alta? La plantilla (`provisionPractitionerAgenda`, mismo criterio
 * que el backfill de `agenda_foundations`) nace con ids DETERMINÍSTICOS por
 * (profesional, dow) y `setBusinessHours` la actualiza en el lugar (mismos
 * ids). `savePractitionerWeek` reemplaza la semana con filas nuevas (cuid):
 * una sola fila con otro id = el usuario guardó. Sin columna nueva ni
 * migración, y guardar la semana tal cual vino también cuenta (confirmó).
 *
 * `defaultIdFor(dow)` = `agendaDefaultIds.schedule(practitionerId, dow)`: se
 * inyecta porque usa `node:crypto` y este módulo lo importa el cliente.
 */
export function isCustomSchedule(
  rows: ReadonlyArray<{ id: string; dow: number }>,
  defaultIdFor: (dow: number) => string
): boolean {
  return rows.some((r) => r.id !== defaultIdFor(r.dow));
}
