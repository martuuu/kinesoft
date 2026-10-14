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
 * Política por acción (`PLATFORM_ACTION_POLICY`): nivel de riesgo + rate limit por superadmin. MFA (TOTP) queda
 * para BO4: `PLATFORM_MFA_ENFORCED` es el flag que esa ola prende; hoy el riesgo `high` solo se registra.
 */
import { getAccessSnapshot, ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export type PlatformActor = { userId: string; email: string; homeTenantId: string | null };

export type PlatformRisk = "low" | "medium" | "high";
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
  "user.access_link": { risk: "medium", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "user.disable": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "user.superadmin.update": { risk: "high", rateLimit: { limit: 5, windowMs: 10 * MIN } },
  "repair.run": { risk: "medium", rateLimit: { limit: 30, windowMs: 10 * MIN } },
  "support.start": { risk: "high", rateLimit: { limit: 10, windowMs: 10 * MIN } },
  "audit.read": { risk: "low", rateLimit: { limit: 300, windowMs: MIN } },
} as const satisfies Record<string, PlatformActionPolicy>;

/** C-BO2: `string` en el contrato; en la práctica, las claves de la política (las demás se rechazan). */
export type PlatformActionKey = keyof typeof PLATFORM_ACTION_POLICY | (string & {});

/**
 * BO4 (BO-D6): TOTP obligatorio para superadmins y re-verificación en las acciones `high`. Hasta entonces, false.
 * TODO(BO4): con true, `requirePlatformAdmin` exige AAL2 (`supabase.auth.mfa`) y, para `high`, una verificación
 * reciente.
 */
export const PLATFORM_MFA_ENFORCED = false;

export function platformActionPolicy(action: string): PlatformActionPolicy | null {
  return Object.prototype.hasOwnProperty.call(PLATFORM_ACTION_POLICY, action)
    ? (PLATFORM_ACTION_POLICY as Record<string, PlatformActionPolicy>)[action]
    : null;
}

/** El superadmin se pasó del rate limit de la acción. El mensaje se puede mostrar tal cual. */
export class PlatformRateLimitedError extends ForbiddenError {
  constructor(public retryAfterMs: number) {
    super(rateLimitedMessage(retryAfterMs));
    this.name = "PlatformRateLimitedError";
  }
}

/**
 * C-BO2. Sin sesión → `UnauthenticatedError`. Sin `isPlatformAdmin`, o con `UserProfile.disabledAt` →
 * `ForbiddenError("platform_admin_required")`. Con `action`: una clave fuera de la política es un error de
 * programación y falla cerrado (`ForbiddenError("unknown_platform_action")`); si no, aplica su rate limit.
 *
 * `homeTenantId` = el consultorio al que entraría con esta sesión (null si no tiene ninguno usable): referencia
 * para el registro de plataforma, nunca un permiso.
 */
export async function requirePlatformAdmin(action?: PlatformActionKey): Promise<PlatformActor> {
  const s = await getAccessSnapshot();
  if (!s || !s.profile) throw new UnauthenticatedError("no_session");
  if (!s.profile.isPlatformAdmin || s.profile.disabledAt) throw new ForbiddenError("platform_admin_required");

  if (action !== undefined) {
    const policy = platformActionPolicy(action);
    if (!policy) throw new ForbiddenError("unknown_platform_action");
    const rl = await rateLimit(`platform:${action}:${s.userId}`, policy.rateLimit);
    if (!rl.ok) {
      logger.warn("platform.rate_limited", { action, userId: s.userId });
      throw new PlatformRateLimitedError(rl.retryAfterMs);
    }
  }

  return {
    userId: s.userId,
    email: s.profile.email,
    homeTenantId: s.state.kind === "ok" ? s.state.tenantId : null,
  };
}
