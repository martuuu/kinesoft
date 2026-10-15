import "server-only";
/**
 * Step-up de la 2FA (PL-2a, contrato C-PL6; PL-D11) y la foto de 2FA de la sesión para las actions sensibles.
 *
 * `requireStepUp(actor)` es el contrato que consumen PL-2b (`applyPlanChange`, débito, medio de pago, permisos) y
 * PL-3 (transferir titularidad): se llama DESPUÉS de `getActor`/`requireCapability` y ANTES de escribir.
 *  - Sin ningún método de 2FA → `TwoFactorSetupRequiredError` (digest `KINE_2FA_SETUP_REQUIRED`): «Activá la
 *    verificación en dos pasos para cambiar el plan» (decisión de Martin: obligatoria para plan / medio de pago).
 *  - Con método pero sin `kine_stepup` fresco (< 10 min) de ESTA sesión → `StepUpRequiredError` (digest
 *    `KINE_STEP_UP_REQUIRED`). `useStepUpAction` (components/account/step-up-modal.tsx) lo atrapa, pide el código y
 *    reintenta la action una vez.
 * El `digest` es lo único que sobrevive a Next en prod (oculta el mensaje); `classifyStepUpError` lo lee.
 *
 * Fuente de los métodos: la foto del request (`getAccessSnapshot`, ya leída por `getActor`: cero queries). La
 * cookie se valida contra el `session_id` del JWT de esa misma foto.
 */
import { getAccessSnapshot, ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { getSessionUser, getStrictSessionUser } from "@/lib/session-user";
import { hasFreshStepUp, hasSessionProof } from "@/lib/two-factor-cookie";
import {
  TWO_FACTOR_ERROR_DIGEST,
  hasAnyTwoFactorMethod,
  twoFactorStateOf,
  type TwoFactorMethods,
  type TwoFactorState,
} from "@/lib/two-factor-logic";

export const STEP_UP_REQUIRED_COPY = "Confirmá que sos vos para seguir.";
export const TWO_FACTOR_SETUP_COPY = "Activá la verificación en dos pasos para hacer este cambio.";

export class StepUpRequiredError extends ForbiddenError {
  digest = TWO_FACTOR_ERROR_DIGEST.stepUp;
  constructor() {
    super("step_up_required");
    this.name = "StepUpRequiredError";
    // `classifyStepUpError` mira digest y message: en dev Next pasa el mensaje, en prod el digest.
    this.message = TWO_FACTOR_ERROR_DIGEST.stepUp;
  }
}

export class TwoFactorSetupRequiredError extends ForbiddenError {
  digest = TWO_FACTOR_ERROR_DIGEST.setup;
  constructor() {
    super("two_factor_setup_required");
    this.name = "TwoFactorSetupRequiredError";
    this.message = TWO_FACTOR_ERROR_DIGEST.setup;
  }
}

/** Pura: lo que decide `requireStepUp` (exportada para el unit test). */
export function stepUpDecision(methods: TwoFactorMethods, stepUpFresh: boolean): "ok" | "setup" | "step_up" {
  if (!hasAnyTwoFactorMethod(methods)) return "setup";
  return stepUpFresh ? "ok" : "step_up";
}

/**
 * C-PL6. `actor` = el de `getActor()` (o cualquier `{ userId }` de la sesión: también un superadmin en soporte, que
 * confirma con SU 2FA). Tira; no devuelve nada si pasa.
 */
export async function requireStepUp(actor: { userId: string }): Promise<void> {
  const [s, user] = await Promise.all([getAccessSnapshot(), getSessionUser()]);
  if (!s || !user || s.userId !== actor.userId || user.id !== actor.userId) throw new UnauthenticatedError("no_session");
  const d = stepUpDecision(s.twoFactor.methods, hasFreshStepUp(actor.userId, user.sessionId));
  if (d === "setup") throw new TwoFactorSetupRequiredError();
  if (d === "step_up") throw new StepUpRequiredError();
}

/**
 * La sesión vista por las actions de 2FA (`lib/two-factor.ts`). Verificada CONTRA GoTrue (`getStrictSessionUser`):
 * son flujos de autenticación y una sesión cerrada en otro lado no puede seguir pidiendo códigos. Los métodos
 * salen de la foto del request; el estado se recalcula con el `aal`/`session_id` del token que GoTrue validó.
 *
 * null = sin sesión, sin perfil, sin `session_id` legible (no se puede atar nada a la sesión) o usuario
 * deshabilitado en Plataforma.
 */
export type TwoFactorSession = {
  userId: string;
  sessionId: string;
  aal: "aal1" | "aal2" | null;
  /** Email de la CUENTA (con el que entra); si GoTrue no lo trae, el del perfil. */
  email: string;
  methods: TwoFactorMethods;
  state: TwoFactorState;
  isPlatformAdmin: boolean;
  hasUsableMembership: boolean;
};

export async function resolveTwoFactorSession(): Promise<TwoFactorSession | null> {
  const [strict, s] = await Promise.all([getStrictSessionUser(), getAccessSnapshot()]);
  if (!strict || !s || !s.profile || strict.id !== s.userId) return null;
  if (s.profile.disabledAt) return null;
  if (!strict.sessionId) return null;
  const methods = s.twoFactor.methods;
  const state = twoFactorStateOf(methods, {
    aal: strict.aal,
    sessionId: strict.sessionId,
    sessionProofValid: hasAnyTwoFactorMethod(methods) && hasSessionProof(strict.id, strict.sessionId),
  });
  return {
    userId: strict.id,
    sessionId: strict.sessionId,
    aal: strict.aal,
    email: (strict.email ?? s.profile.email ?? "").trim().toLowerCase(),
    methods,
    state,
    isPlatformAdmin: s.profile.isPlatformAdmin,
    hasUsableMembership: s.usable.length > 0,
  };
}
