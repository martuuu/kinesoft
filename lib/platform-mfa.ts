import "server-only";
/**
 * Nombres de BO4 del puerto MFA (PL-2a lo generalizó a `lib/mfa-port.ts`, para cualquier usuario).
 *
 * Se conserva como re-export para no tocar en la misma ola a los consumidores de Plataforma
 * (`lib/platform-actor.ts`, `lib/platform-mfa-actions.ts`, `app/plataforma-mfa/**`) ni a sus tests: el símbolo es el
 * MISMO (un fake inyectado con `__setPlatformMfaForTests` también lo ven las actions de `lib/two-factor.ts`).
 * Código nuevo: `mfaPort()` / `__setMfaPortForTests` / `readMfaAssurance` de `lib/mfa-port.ts`.
 */
export {
  qrDataUri,
  mfaPort as platformMfa,
  __setMfaPortForTests as __setPlatformMfaForTests,
  readMfaAssurance as readPlatformAssurance,
} from "@/lib/mfa-port";
export type { MfaFactorLite, MfaResult, TotpEnrollment, MfaPort as PlatformMfaPort } from "@/lib/mfa-port";
