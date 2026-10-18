import "server-only";
/**
 * HF-3 (plan §22.4, D-HF7) · pausa temporal de la 2FA del superadmin · lado servidor.
 *
 * Lee `SUPERADMIN_2FA_BYPASS` y `PLATFORM_MFA_ENFORCEMENT` de `process.env` en CADA llamada (como
 * `platformMfaEnforcement()`): Martin la carga o la borra en Vercel y el redeploy la toma; los tests la cambian en
 * caliente. No pasa por el objeto congelado de `lib/env.ts` a propósito (ese archivo no es de esta sesión, y la
 * variable es opcional: vacía = nada).
 *
 * La decisión es pura (`twoFactorBypassDecision`, lib/two-factor-bypass-logic.ts). Acá solo se suma:
 *  - el camino rápido: sin la variable, cero trabajo (esto corre en la foto de acceso de CADA request de cada usuario);
 *  - el aviso: una variable mal formada o con la fecha a más de 30 días se ignora con `logger.warn`, una vez por valor
 *    y proceso (si no, cada request del superadmin repetiría la línea). Nunca se loguea el valor.
 *
 * Dónde actúa (y dónde NO):
 *  - `lib/session.ts` (foto de acceso): el estado de la 2FA queda `satisfied` → el login no pide código;
 *  - `requireStepUp` (lib/two-factor-step-up.ts): sale antes y lo loguea (`2fa.stepup_bypassed`);
 *  - `support.start` deja `twoFactorBypass: true` en el registro;
 *  - NO en `resolveTwoFactorSession` ni en `assertStepUp` (lib/two-factor.ts): cambiar o apagar la 2FA sigue pidiendo
 *    el código. Riesgo aceptado por Martin: mientras dure, con la contraseña sola se opera Plataforma entera.
 */
import { logger } from "@/lib/logger";
import { platformMfaEnforcement } from "@/lib/env";
import {
  twoFactorBypassDecision,
  type TwoFactorBypassDecision,
  type TwoFactorBypassUser,
} from "@/lib/two-factor-bypass-logic";

const warned = new Set<string>();

export function twoFactorBypassFor(user: TwoFactorBypassUser | null, now: Date = new Date()): TwoFactorBypassDecision {
  const raw = process.env.SUPERADMIN_2FA_BYPASS;
  if (!raw || !raw.trim()) return { active: false, reason: "unset" };
  const d = twoFactorBypassDecision({ raw, enforcement: platformMfaEnforcement(), user, now });
  if (!d.active && (d.reason === "malformed" || d.reason === "too_far")) {
    const key = `${d.reason}|${raw}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn("2fa.bypass_ignored", {
        reason: d.reason,
        hint: d.reason === "malformed" ? "formato: <userId>@AAAA-MM-DD, separados por coma" : "la pausa no puede pasar los 30 días",
      });
    }
  }
  return d;
}

/** Atajo para los que solo necesitan el sí/no (step-up, registro de soporte). */
export function isTwoFactorBypassed(user: TwoFactorBypassUser | null, now?: Date): boolean {
  return twoFactorBypassFor(user, now).active;
}
