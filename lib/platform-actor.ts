import "server-only";
/**
 * Actor de plataforma (BO1-A, contrato C-BO2, plan §19.5).
 *
 * El bug que lo motiva (§19.1): el superadmin necesitaba un consultorio «casa» con `Practitioner` para llegar a
 * /plataforma, porque `requireSuperAdmin` pasaba por `getActor` → `buildActor`. Un superadmin sin consultorio (o
 * con el suyo suspendido) quedaba afuera del panel desde el que se arreglan justamente esos casos.
 *
 * `requirePlatformAdmin` NO pasa por `buildActor`: mira solo la sesión verificada y el perfil (la misma foto del
 * request, `getAccessSnapshot`, cero queries si el layout ya la leyó). Es la ÚNICA barrera de los módulos
 * `lib/platform-*` (escriben por el canal service, BYPASSRLS): cada export la llama (invariante del gate de BO).
 *
 * Política por acción (`PLATFORM_ACTION_POLICY`): nivel de riesgo + rate limit por superadmin.
 *
 * BO4 (BO-D6): verificación en dos pasos. Con `PLATFORM_MFA_ENFORCEMENT=enforce` (lib/env.ts) toda llamada exige una
 * sesión AAL2 (TOTP de Supabase, `lib/platform-mfa.ts`) y las acciones `high`, además, un código reciente
 * (`lib/platform-reauth.ts`). La decisión es pura (`decidePlatformMfa`, lib/platform-mfa-logic.ts). Con `off`
 * (default) no se consulta a GoTrue, salvo en `support.start`, que lee el nivel para dejar `mfa` en el registro; las
 * acciones `high` piden igual el step-up de la 2FA por usuario (PL-Z, `requireStepUp`).
 */
import { getAccessSnapshot, ForbiddenError, UnauthenticatedError, type AccessSnapshot } from "@/lib/session";
import { getStrictSessionUser } from "@/lib/session-user";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { platformMfaEnforcement } from "@/lib/env";
import { readPlatformAssurance } from "@/lib/platform-mfa";
import { hasFreshPlatformReauth } from "@/lib/platform-reauth";
import { requireStepUp } from "@/lib/two-factor-step-up";
import {
  PLATFORM_ERROR_DIGEST,
  PLATFORM_MFA_COPY,
  decidePlatformMfa,
  type PlatformRisk,
} from "@/lib/platform-mfa-logic";

export type { PlatformRisk };

/**
 * `mfa`: la sesión pasó por TOTP (AAL2). Solo es información cuando se consultó: con `enforce` siempre es true (si no,
 * no se llega acá); con `off` es la lectura real en `support.start` y false en el resto (no se consulta).
 */
export type PlatformActor = { userId: string; email: string; homeTenantId: string | null; mfa: boolean };

export type PlatformActionPolicy = { risk: PlatformRisk; rateLimit: { limit: number; windowMs: number } };

const MIN = 60_000;

/**
 * Acciones de Plataforma. Las claves las consumen las sesiones de BO1-B/BO2/BO3 (una nueva se agrega acá con su
 * riesgo, en la misma tanda que el export que la usa). Riesgo:
 *  - low: lecturas y escrituras del catálogo global (sin datos de un consultorio);
 *  - medium: cambios reversibles sobre un consultorio o su equipo;
 *  - high: lo que corta acceso, mueve identidad o da poder (BO4 les exige re-verificación TOTP).
 * El rate limit es por superadmin y acción: frena un script o una sesión robada, no el uso normal.
 */
export const PLATFORM_ACTION_POLICY = {
  "platform.read": { risk: "low", rateLimit: { limit: 600, windowMs: MIN } },
  "catalog.write": { risk: "low", rateLimit: { limit: 120, windowMs: MIN } },
  // BO2-F: fusionar prestadoras/prácticas y promover planes repuntan FKs de filas de TODOS los consultorios
  // (Insurer.payerId, Service.practiceId, Coverage.payerPlanId) y no tienen «deshacer»: no es una edición más
  // del catálogo. Medium y un cupo chico; el curado normal sigue en `catalog.write`.
  "catalog.merge": { risk: "medium", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "tenant.create": { risk: "medium", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  "tenant.entitlements.update": { risk: "medium", rateLimit: { limit: 60, windowMs: 10 * MIN } },
  "tenant.profile.update": { risk: "medium", rateLimit: { limit: 60, windowMs: 10 * MIN } },
  "tenant.status.update": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "tenant.slug.update": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  // BO2-D: forzar el fin del alta. Medio: no corta acceso ni mueve identidad, pero saltea los pasos del titular.
  "tenant.onboarding.complete": { risk: "medium", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  "tenant.export.request": { risk: "high", rateLimit: { limit: 5, windowMs: 10 * MIN } },
  "team.manage": { risk: "medium", rateLimit: { limit: 60, windowMs: 10 * MIN } },
  // BO2-B: invitar / reenviar mandan un mail en nombre del consultorio (además del límite por destinatario de los
  // núcleos); suspender y quitar cortan el acceso de una persona (high, como deshabilitar un usuario).
  "team.invite": { risk: "medium", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "team.access.revoke": { risk: "high", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  "team.transfer_owner": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  // PL-3b: «¿Atiende?» del Titular y permisos delegados («Configuración» / «Planes y pagos») hechos por el superadmin
  // en lugar del Titular: cambian quién administra el consultorio o ve la plata, que en Configuración pide step-up.
  "team.grants": { risk: "high", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  // BO-Z (B2): high. Emite un link de recuperación de la cuenta de OTRA persona (con el mail caído, y si la cuenta no
  // se activó nunca, el superadmin lo ve): con MFA en enforce pide el código reciente, como deshabilitar.
  "user.access_link": { risk: "high", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "user.disable": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "user.superadmin.update": { risk: "high", rateLimit: { limit: 5, windowMs: 10 * MIN } },
  "repair.run": { risk: "medium", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "support.start": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "audit.read": { risk: "low", rateLimit: { limit: 300, windowMs: MIN } },
  // BO4: el segundo paso propio. Las usa `requirePlatformAdmin(<clave>, { mfaStep: true })` (sin AAL2: es como se llega).
  // `mfa.verify` cubre el código del login, el de confirmar el enrolamiento y el de re-verificar: un solo cupo para
  // adivinar 6 dígitos (GoTrue tiene el suyo además). `mfa.enroll` frena regenerar QRs en loop.
  "mfa.enroll": { risk: "low", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "mfa.verify": { risk: "low", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  // PL-1d (plan §20.5.6/§20.5.7): claves de los cobros, la bandeja de mensajes, el reset de 2FA y el cambio de plan.
  // Las consumen PL-2a/2c/2d y PL-3c. Plata (imputar, anular, condonar, precio), cambiar el plan (deshabilita usuarios)
  // y resetear la 2FA de otra persona son `high`: no tienen «deshacer» limpio. Responder un hilo manda un mail en
  // nombre de Plataforma (medium); leer cuentas y bandeja, low.
  "billing.read": { risk: "low", rateLimit: { limit: 300, windowMs: MIN } },
  "billing.write": { risk: "high", rateLimit: { limit: 60, windowMs: 10 * MIN } },
  "billing.price": { risk: "high", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  "inbox.read": { risk: "low", rateLimit: { limit: 300, windowMs: MIN } },
  "inbox.reply": { risk: "medium", rateLimit: { limit: 60, windowMs: 10 * MIN } },
  "user.two_factor.reset": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "tenant.plan.change": { risk: "high", rateLimit: { limit: 20, windowMs: 10 * MIN } },
  // DIR-2c (C-DIR8): moderar el directorio público (ocultar/mostrar consultorio o perfil, verificar matrícula).
  // Medium: es reversible y no corta acceso a la app (el turnero sigue andando); solo cambia qué se ve en /profesionales.
  "directory.moderate": { risk: "medium", rateLimit: { limit: 60, windowMs: 10 * MIN } },
} as const satisfies Record<string, PlatformActionPolicy>;

/** C-BO2: `string` en el contrato; en la práctica, las claves de la política (las demás se rechazan). */
export type PlatformActionKey = keyof typeof PLATFORM_ACTION_POLICY | (string & {});

export function platformActionPolicy(action: string): PlatformActionPolicy | null {
  return Object.prototype.hasOwnProperty.call(PLATFORM_ACTION_POLICY, action)
    ? (PLATFORM_ACTION_POLICY as Record<string, PlatformActionPolicy>)[action]
    : null;
}

/**
 * El superadmin se pasó del rate limit de la acción. El mensaje se puede mostrar tal cual en dev; en prod Next lo
 * tapa y la UI lo reconstruye del `digest` (`classifyPlatformActionError`), con el mismo copy uniforme.
 */
export class PlatformRateLimitedError extends ForbiddenError {
  digest: string;
  constructor(public retryAfterMs: number) {
    super(rateLimitedMessage(retryAfterMs));
    this.name = "PlatformRateLimitedError";
    this.digest = `${PLATFORM_ERROR_DIGEST.rateLimited}:${Math.max(1, Math.ceil(retryAfterMs / 1000))}`;
  }
}

/**
 * BO4: falta el segundo paso en esta sesión. `step`: `setup` (no tiene factor), `verify` (tiene factor y la sesión es
 * AAL1) o `unavailable` (no se pudo leer el nivel: falla cerrado). `reason` = `mfa_<step>_required` /
 * `mfa_unavailable`; el layout de `(platform)` redirige a `/plataforma-mfa/*` antes de su `notFound()` genérico.
 */
export class PlatformMfaRequiredError extends ForbiddenError {
  digest: string;
  constructor(public step: "setup" | "verify" | "unavailable") {
    super(step === "unavailable" ? "mfa_unavailable" : `mfa_${step}_required`);
    this.name = "PlatformMfaRequiredError";
    this.message = PLATFORM_MFA_COPY[step];
    this.digest =
      step === "setup"
        ? PLATFORM_ERROR_DIGEST.mfaSetup
        : step === "verify"
          ? PLATFORM_ERROR_DIGEST.mfaVerify
          : PLATFORM_ERROR_DIGEST.mfaUnavailable;
  }
}

/**
 * BO4: acción `high` sin código reciente. Error tipado (`reason = "reauth_required"`, digest `KINE_PLATFORM_REAUTH`):
 * `usePlatformAction` (components/plataforma/reauth-modal.tsx) lo atrapa, pide el código y reintenta.
 */
export class PlatformReauthRequiredError extends ForbiddenError {
  digest = PLATFORM_ERROR_DIGEST.reauth;
  constructor() {
    super("reauth_required");
    this.name = "PlatformReauthRequiredError";
    this.message = PLATFORM_MFA_COPY.reauth;
  }
}

/** Sesión + perfil + política + rate limit: lo común a las dos puertas. */
async function admitPlatformAdmin(
  action: PlatformActionKey | undefined
): Promise<{ s: AccessSnapshot & { profile: NonNullable<AccessSnapshot["profile"]> }; policy: PlatformActionPolicy | null }> {
  // PF-0b: Plataforma verifica también contra GoTrue (revocación inmediata), no solo el JWT local del actor.
  const [s, strict] = await Promise.all([getAccessSnapshot(), getStrictSessionUser()]);
  if (!s || !s.profile) throw new UnauthenticatedError("no_session");
  if (!strict || strict.id !== s.userId) throw new UnauthenticatedError("no_session");
  if (!s.profile.isPlatformAdmin || s.profile.disabledAt) throw new ForbiddenError("platform_admin_required");
  // PL-2a (C-PL6): la 2FA por usuario también corta Plataforma, con la misma foto (cero queries). Antes que el rate
  // limit y que `{ mfaStep: true }`: con solo la contraseña, las pantallas de /plataforma-mfa servirían para sumar un
  // TOTP propio y llegar a AAL2 salteando el código por email del dueño. El layout de `(platform)` la manda a
  // `/verificar-acceso?next=` (handoff de PL-2a).
  if (s.twoFactor?.state === "required") throw new UnauthenticatedError("two_factor");

  let policy: PlatformActionPolicy | null = null;
  if (action !== undefined) {
    policy = platformActionPolicy(action);
    if (!policy) throw new ForbiddenError("unknown_platform_action");
    // Antes que el MFA: el cupo también frena martillar GoTrue (y adivinar códigos) con una sesión robada.
    const rl = await rateLimit(`platform:${action}:${s.userId}`, policy.rateLimit);
    if (!rl.ok) {
      logger.warn("platform.rate_limited", { action, userId: s.userId });
      throw new PlatformRateLimitedError(rl.retryAfterMs);
    }
  }
  return { s: s as AccessSnapshot & { profile: NonNullable<AccessSnapshot["profile"]> }, policy };
}

function actorOf(s: AccessSnapshot & { profile: NonNullable<AccessSnapshot["profile"]> }, mfa: boolean): PlatformActor {
  return {
    userId: s.userId,
    email: s.profile.email,
    homeTenantId: s.state.kind === "ok" ? s.state.tenantId : null,
    mfa,
  };
}

/** Claves que puede usar el segundo paso propio (`{ mfaStep: true }`). Sin acción = las pantallas de /plataforma-mfa. */
const MFA_STEP_ACTIONS = new Set<string | undefined>([undefined, "mfa.enroll", "mfa.verify"]);

/**
 * C-BO2. Sin sesión → `UnauthenticatedError`. Con la 2FA del usuario pendiente (PL-2a) → `UnauthenticatedError("two_factor")`.
 * Sin `isPlatformAdmin`, o con `UserProfile.disabledAt` →
 * `ForbiddenError("platform_admin_required")`. Con `action`: una clave fuera de la política es un error de
 * programación y falla cerrado (`ForbiddenError("unknown_platform_action")`); si no, aplica su rate limit
 * (`PlatformRateLimitedError`, «Demasiados intentos. Probá de nuevo en N s.»).
 *
 * PL-Z: sin `enforce`, riesgo `high` → `requireStepUp` de la 2FA por usuario (`StepUpRequiredError` /
 * `TwoFactorSetupRequiredError`, por digest).
 *
 * BO4, con `PLATFORM_MFA_ENFORCEMENT=enforce`: sin AAL2 → `PlatformMfaRequiredError` (setup/verify/unavailable); con
 * riesgo `high` y sin re-verificación de los últimos 10 min → `PlatformReauthRequiredError`. Sin `action` (layout,
 * lecturas sin clave) no hay riesgo: alcanza con AAL2.
 *
 * `{ mfaStep: true }`: SOLO para el segundo paso propio (`lib/platform-mfa-actions.ts`, `app/plataforma-mfa/**`):
 * todo lo anterior (sesión, superadmin, no deshabilitado, rate limit) pero SIN exigir AAL2, que es justamente cómo se
 * llega a AAL2. Solo vale con `mfa.enroll`, `mfa.verify` o sin acción; con cualquier otra clave falla cerrado
 * (`ForbiddenError("mfa_step_misuse")`): una acción de admin no puede saltearse el MFA pasándolo. Es un parámetro y no
 * otra función para que el guard estático (tests/unit/platform-admin-guard.test.ts) siga viendo `requirePlatformAdmin(`
 * en cada export.
 *
 * `homeTenantId` = el consultorio al que entraría con esta sesión (null si no tiene ninguno usable): referencia
 * para el registro de plataforma, nunca un permiso.
 */
export async function requirePlatformAdmin(
  action?: PlatformActionKey,
  opts?: { mfaStep: true }
): Promise<PlatformActor> {
  if (opts?.mfaStep && !MFA_STEP_ACTIONS.has(action)) throw new ForbiddenError("mfa_step_misuse");
  const { s, policy } = await admitPlatformAdmin(action);
  if (opts?.mfaStep) return actorOf(s, false);

  const enforcement = platformMfaEnforcement();
  // PL-Z (a2#4, decisión del orquestador): sin `enforce` (el default en prod hoy), las acciones `high` (suspender,
  // deshabilitar, dar superadmin, resetear 2FA ajena, plata) no pedían NINGÚN segundo factor: una sesión de
  // superadmin robada las hacía todas. Mientras el TOTP de Plataforma no se prenda, piden el step-up de la 2FA por
  // usuario (C-PL6, 10 min), el mismo de cambiar el plan: `usePlatformAction` muestra el modal de step-up y
  // reintenta. Sin 2FA por usuario → `TwoFactorSetupRequiredError` («Activá la verificación…»). Con `enforce` manda
  // la re-verificación TOTP de BO4 (abajo) y esto no corre: nunca se piden los dos.
  if (enforcement !== "enforce" && policy?.risk === "high") await requireStepUp({ userId: s.userId });
  // Con off solo se consulta para el registro de soporte («el soporte no se despliega sin BO4»: con off queda
  // permitido para desarrollo, pero la fila dice que no hubo segundo paso).
  if (enforcement !== "enforce" && action !== "support.start") return actorOf(s, false);

  const assurance = await readPlatformAssurance();
  const risk = policy?.risk ?? null;
  // La cookie solo se mira cuando decide algo (enforce + high): el layout corre en server components sin action.
  const reauthFresh = enforcement === "enforce" && risk === "high" ? hasFreshPlatformReauth(s.userId) : false;
  const d = decidePlatformMfa({ enforcement, assurance, risk, reauthFresh });
  switch (d.kind) {
    case "ok":
      return actorOf(s, d.mfa);
    case "setup_required":
      throw new PlatformMfaRequiredError("setup");
    case "verify_required":
      throw new PlatformMfaRequiredError("verify");
    case "unavailable":
      throw new PlatformMfaRequiredError("unavailable");
    case "reauth_required":
      logger.info("platform.reauth_required", { action, userId: s.userId });
      throw new PlatformReauthRequiredError();
  }
}
