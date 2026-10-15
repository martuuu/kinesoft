/**
 * Mails de la cuenta del usuario (PL-2a, C-PL6): código de verificación en dos pasos, aviso de cambios en la 2FA y
 * aviso de código de recuperación usado. PURAS (sin red, sin env, sin `server-only`), como `templates.ts`.
 *
 * Usan `compose` de `templates.ts` (exportado en la integración de PL-2), con el mismo layout que el resto. El mail
 * del código va SIN botón (`ctas: []`): no hay nada que clickear y un link que «verifica» con un clic sería
 * phishing-friendly.
 *
 * Seguridad del código (contrato de PL-2a, test en `tests/integration/two-factor.test.ts`):
 *  - el código va SOLO en el cuerpo (html y texto), nunca en el asunto ni en el preheader: el asunto se ve en la
 *    notificación del teléfono bloqueado y en los listados del proveedor;
 *  - `sendEmail` no guarda cuerpo ni asunto en `EmailLog` (solo kind, hash del destinatario y host del primer link) y
 *    este mail no tiene links: `linkHost` queda null.
 *
 * Copy en voseo, sin emojis, sin nombrar al proveedor.
 */
import { EMAIL_COLORS as C, EMAIL_MONO as MONO, compose, escapeHtml, formatExpiryAR, para } from "@/lib/email/templates";
import type { RenderedEmail } from "@/lib/email/types";

const NOT_YOU =
  "Si no fuiste vos, cambiá tu contraseña ya y avisale al titular de tu consultorio: alguien puede tener tu contraseña.";

export type TwoFactorCodePurpose = "login" | "step_up" | "enroll_email";

const PURPOSE_COPY: Record<TwoFactorCodePurpose, { subject: string; lead: string }> = {
  login: { subject: "Tu código para entrar a KineSoft", lead: "Usá este código para terminar de entrar a KineSoft." },
  step_up: {
    subject: "Tu código para confirmar un cambio en KineSoft",
    lead: "Usá este código para confirmar el cambio que estás haciendo en KineSoft.",
  },
  enroll_email: {
    subject: "Tu código para activar la verificación por email",
    lead: "Usá este código para activar la verificación en dos pasos por email en tu cuenta de KineSoft.",
  },
};

/**
 * Código de 6 números. El código va SOLO en el cuerpo (ver cabecera). `minutes` = vida del código (10).
 * Se muestra partido «123 456» (se lee mejor y el campo de la app acepta el espacio).
 */
export function twoFactorCodeEmail(p: { code: string; purpose: TwoFactorCodePurpose; minutes: number }): RenderedEmail {
  const copy = PURPOSE_COPY[p.purpose];
  const digits = p.code.replace(/\D/g, "").slice(0, 6);
  const shown = `${digits.slice(0, 3)} ${digits.slice(3)}`;
  const validity = `Vence en ${p.minutes} minutos y sirve una sola vez.`;
  const footer = [
    "Te llegó este mail porque alguien pidió un código de verificación con tu cuenta.",
    "Nadie de KineSoft te va a pedir este código: no se lo pases a nadie.",
    NOT_YOU,
  ];
  const codeBlock = `<p style="margin:8px 0 20px;padding:16px 20px;background-color:${C.panel};border:1px solid ${C.line};border-radius:10px;font-family:${MONO};font-size:32px;line-height:40px;font-weight:700;letter-spacing:0.2em;color:${C.ink};text-align:center;">${escapeHtml(shown)}</p>`;
  return compose({
    subject: copy.subject,
    preheader: validity,
    context: null,
    title: "Tu código de verificación",
    paragraphs: [copy.lead, `Código: ${shown}`, validity],
    bodyBlocksHtml: [para(escapeHtml(copy.lead)), codeBlock, para(escapeHtml(validity))],
    ctas: [],
    footer,
  });
}

export type TwoFactorChange =
  | "totp_enabled"
  | "totp_disabled"
  | "email_enabled"
  | "email_disabled"
  | "recovery_regenerated"
  | "reset_by_platform";

const CHANGE_COPY: Record<TwoFactorChange, { subject: string; lead: string }> = {
  totp_enabled: {
    subject: "Activaste la app de autenticación en KineSoft",
    lead: "Se activó la verificación en dos pasos con app de autenticación en tu cuenta.",
  },
  totp_disabled: {
    subject: "Desactivaste la app de autenticación en KineSoft",
    lead: "Se desactivó la verificación en dos pasos con app de autenticación en tu cuenta.",
  },
  email_enabled: {
    subject: "Activaste la verificación por email en KineSoft",
    lead: "Se activó la verificación en dos pasos con código por email en tu cuenta.",
  },
  email_disabled: {
    subject: "Desactivaste la verificación por email en KineSoft",
    lead: "Se desactivó la verificación en dos pasos con código por email en tu cuenta.",
  },
  recovery_regenerated: {
    subject: "Generaste códigos de recuperación nuevos en KineSoft",
    lead: "Se generaron códigos de recuperación nuevos para tu cuenta. Los anteriores ya no sirven.",
  },
  reset_by_platform: {
    subject: "El equipo de KineSoft restableció tu verificación en dos pasos",
    lead: "A pedido, el equipo de KineSoft desactivó la verificación en dos pasos de tu cuenta y borró tus códigos de recuperación. Para volver a activarla, entrá a Seguridad de la cuenta.",
  },
};

/** Aviso de cambio en la 2FA (lo recibe el dueño de la cuenta; si no fue él, es la alarma). */
export function twoFactorChangedEmail(p: { change: TwoFactorChange; at: Date; securityUrl: string }): RenderedEmail {
  const copy = CHANGE_COPY[p.change];
  const when = `Fecha: ${formatExpiryAR(p.at)} (hora de Argentina).`;
  const footer = ["Te llegó este mail porque cambió la seguridad de tu cuenta de KineSoft.", NOT_YOU];
  return compose({
    subject: copy.subject,
    preheader: copy.lead,
    context: null,
    title: "Cambió la seguridad de tu cuenta",
    paragraphs: [copy.lead, when],
    ctas: [{ label: "Ver la seguridad de mi cuenta", url: p.securityUrl }],
    footer,
  });
}

/** Aviso: se usó un código de recuperación (un uso; quedan `remaining`). */
export function recoveryCodeUsedEmail(p: { remaining: number; at: Date; securityUrl: string }): RenderedEmail {
  const lead = "Se usó uno de tus códigos de recuperación para entrar a tu cuenta de KineSoft.";
  const left =
    p.remaining > 0
      ? `${p.remaining === 1 ? "Te queda 1 código" : `Te quedan ${p.remaining} códigos`}. Si te quedan pocos, generá códigos nuevos.`
      : "No te quedan códigos de recuperación: generá códigos nuevos desde Seguridad de la cuenta.";
  const when = `Fecha: ${formatExpiryAR(p.at)} (hora de Argentina).`;
  const footer = ["Te llegó este mail porque se usó un código de recuperación de tu cuenta.", NOT_YOU];
  return compose({
    subject: "Se usó un código de recuperación de tu cuenta de KineSoft",
    preheader: lead,
    context: null,
    title: "Se usó un código de recuperación",
    paragraphs: [lead, left, when],
    ctas: [{ label: "Ver la seguridad de mi cuenta", url: p.securityUrl }],
    footer,
  });
}
