/**
 * Tipos de las actions de 2FA (`lib/two-factor.ts`, "use server": solo exporta funciones async). Puro: lo importan
 * las pantallas de `/verificar-acceso`, `/cuenta/seguridad` y el modal de step-up.
 */
import type { TwoFactorMethods } from "@/lib/two-factor-logic";

/** Para qué se pide el código por email. `enroll_email` = activar el método (se confirma con `enableEmailMethod`). */
export type EmailCodePurpose = "login" | "step_up" | "enroll_email";

export type EmailCodeSent = { sentTo: string; expiresInS: number };

/**
 * Enrolamiento TOTP. `existing: true` = la persona ya tenía un factor verificado en Supabase sin el flag prendido
 * (p. ej. el superadmin enrolado en BO4): no hay QR nuevo, alcanza con un código de la app que ya tiene.
 */
export type TotpEnrollmentView = { factorId: string; qrCode: string | null; secret: string | null; existing: boolean };

/** Códigos de recuperación en claro: se muestran UNA vez. null = ya tenía códigos sin usar (no se regeneran). */
export type RecoveryCodesResult = { recoveryCodes: string[] | null };

export type DisableMethodResult = {
  changed: boolean;
  /** Se borró el factor por el canal admin (sesión sin AAL2): GoTrue cerró las sesiones; hay que volver a entrar. */
  signedOut: boolean;
};

export type StepUpOptions = { methods: TwoFactorMethods; emailMasked: string; recoveryCodesLeft: number };
