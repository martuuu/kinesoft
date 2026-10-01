"use server";

/**
 * Authentication server actions.
 *
 *   - `signUpPractitioner` — signup con email VERIFICADO (A3c-S-signup).
 *     Solo crea la identidad en Supabase (`auth.signUp`, que manda el mail de
 *     confirmación). **No crea ningún tenant**: el consultorio se da de alta
 *     en `/onboarding` después de verificar. Con `inviteToken` es el signup
 *     de unión a un consultorio existente.
 *
 *   - `sendPasswordReset` — fire-and-forget `resetPasswordForEmail`.
 *     The same email arrives whether the address exists or not so we
 *     don't leak account presence; UI shows "if your email exists you'll
 *     get a link" regardless of result.
 *
 *   - `updatePasswordWithRecoverySession` — /reset. Con la cookie firmada
 *     `ks_recovery` (la deja `/auth/confirm` tras un link de recovery) cambia
 *     la clave sin pedir la actual; sin ella, exige la contraseña actual.
 *
 * H5 (auditoría 23-sep): el signup anterior creaba el usuario con el admin
 * client y `email_confirm: true` (auto-confirmado) y armaba el tenant en el
 * acto: cualquiera podía crear consultorios con un email ajeno, sin probar
 * que era suyo, y quemar ese email para el dueño real. Eso se eliminó.
 */
import { cookies, headers } from "next/headers";
// Lecturas pre-sesión (la invitación por token, el chequeo staff ≠ paciente):
// todavía no hay Actor ni GUC posible → canal service. See lib/db.ts.
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { hashKeyPart, rateLimit, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { RECOVERY_COOKIE, verifyRecoveryCookie } from "@/lib/recovery-cookie";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { z } from "zod";
import {
  ResetPasswordInput,
  SignupInput,
  type ActionResult,
  type ResetPasswordInputType,
  type SignupInputType,
} from "@/lib/validation";

/** Mismo mensaje exista o no la cuenta: el signup no es un oráculo de emails. */
const SIGNUP_SENT = "Te mandamos un email para confirmar tu cuenta.";

export async function signUpPractitioner(
  raw: SignupInputType
): Promise<ActionResult<{ email: string; joining: boolean; message: string }>> {
  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;

  // Unión por invitación: el email lo fija la invitación (el del form se
  // ignora: si no, cualquiera con el link se registraría con SU email y la
  // invitación no le serviría a nadie).
  let email = data.email;
  let next = "/onboarding";
  const inviteToken = data.inviteToken || null;
  if (inviteToken) {
    const invite = await prisma.invitation.findUnique({
      where: { token: hashInviteToken(inviteToken) },
      select: { email: true, acceptedAt: true, expiresAt: true },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      return { ok: false, error: "La invitación no es válida o venció. Pedile al consultorio una nueva." };
    }
    email = invite.email.toLowerCase();
    next = `/invite/${encodeURIComponent(inviteToken)}`;
  }

  // 3 por IP cada 10 min (A3a) + 3 por hora por email: signUp manda un mail,
  // y rotando IPs se podía bombardear el buzón de un tercero.
  const limited = await rateLimitAll([
    { key: `signup:${clientIp(headers())}`, limit: 3, windowMs: 600_000 },
    { key: `signup:email:${hashKeyPart(email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }

  const ok = { ok: true as const, data: { email, joining: !!inviteToken, message: SIGNUP_SENT } };

  // Staff ≠ paciente (misma regla que acceptInvite): un email que ya usa el
  // portal de pacientes no se registra como profesional. Acá quien pregunta
  // todavía NO probó ser dueño del email, así que no se le dice por qué: misma
  // respuesta que un alta normal y no se manda nada (Supabase tampoco manda
  // mail a una identidad existente). El mensaje explícito lo da el paso 2 de
  // /onboarding, con la identidad ya verificada.
  const asPatient = await prisma.patient.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, userId: { not: null } },
    select: { id: true },
  });
  if (asPatient) {
    logger.info("signup.rejected_patient_identity", {});
    return ok;
  }

  const supabase = getSupabaseServerClient();
  // `emailRedirectTo` es el DESTINO FINAL (llega a la plantilla como
  // `{{ .RedirectTo }}`, que la plantilla pone en `next` de /auth/confirm).
  // Si fuera `/auth/confirm?next=…`, /auth/confirm redirigía a sí mismo sin
  // token_hash → "link inválido" con la cuenta ya verificada
  // (bug `signup-confirm-doble-salto`, cierre de A3c).
  const emailRedirectTo = `${env.NEXT_PUBLIC_APP_URL}${next}`;
  const { data: signUpData, error } = await supabase.auth.signUp({
    email,
    password: data.password,
    options: { emailRedirectTo, data: { full_name: data.fullName } },
  });
  if (error) {
    // 429 del propio Supabase (límite de mails del proyecto) → se dice; el
    // resto (password débil para la política del proyecto, etc.) → genérico.
    logger.warn("signup.supabase_failed", { status: error.status, message: error.message });
    if (error.status === 429) {
      return { ok: false, error: "Hay demasiados pedidos en este momento. Probá de nuevo en unos minutos." };
    }
    if (/password/i.test(error.message)) {
      return { ok: false, error: "La contraseña no cumple los requisitos. Probá con una más larga.", fieldErrors: { password: ["Contraseña débil"] } };
    }
    return { ok: false, error: "No pudimos crear la cuenta. Probá de nuevo en unos minutos." };
  }
  // Con "Confirm email" ON, signUp NO devuelve sesión. Si la devuelve, el
  // proyecto tiene la confirmación apagada: la cuenta queda sin verificar y
  // eso es un error de configuración (ver EXTERNAL-CONFIG). Se loguea fuerte;
  // igual no se crea tenant acá (lo hace /onboarding, que exige email
  // verificado).
  if (signUpData?.session) {
    logger.error("signup.confirm_email_disabled", {});
  }
  return ok;
}

// ──────────────────────────────────────────────────────────────────────
// Password recovery
// ──────────────────────────────────────────────────────────────────────

const ForgotInput = z.object({
  email: z.string().trim().toLowerCase().email("Email inválido"),
});

export async function sendPasswordReset(
  raw: z.input<typeof ForgotInput>
): Promise<ActionResult> {
  const parsed = ForgotInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Email inválido",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  // A3a-S-rl: por IP y además por hash del email (3/h): sin esto, rotando
  // IPs se podía bombardear el buzón de una persona con mails de reset. El
  // límite aplica exista o no la cuenta, así que no filtra enumeración.
  const limited = await rateLimitAll([
    { key: `forgot:ip:${clientIp(headers())}`, limit: 5, windowMs: 600_000 },
    { key: `forgot:email:${hashKeyPart(parsed.data.email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }

  // We use the server (anon-key) client here, NOT the admin client.
  // resetPasswordForEmail is intentionally noisy: it always responds
  // success regardless of whether the email exists — perfect for our
  // "no enumeration" stance.
  //
  // A3c: el destino es `/auth/confirm` (verifyOtp con token_hash), no el
  // `/auth/callback` de PKCE: el code de PKCE solo se canjea en el MISMO
  // browser que pidió el mail, y la gente abre el mail en el celular.
  // `/auth/confirm` además deja la cookie firmada `ks_recovery` que habilita
  // /reset sin la clave actual. El link real lo arma la plantilla "Reset
  // password" de Supabase (tarea del dueño, EXTERNAL-CONFIG):
  //   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset
  // Este `redirectTo` es el `{{ .RedirectTo }}` y tiene que estar en las
  // Redirect URLs del proyecto.
  const supabase = getSupabaseServerClient();
  // Destino final (misma regla que el signup): la plantilla de reset fija next=/reset.
  const redirectTo = `${env.NEXT_PUBLIC_APP_URL}/reset`;
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo });
  if (error) {
    // Se loguea (SMTP caído, redirect no permitido) pero la respuesta es la
    // misma: nunca revelar si el email está registrado.
    logger.warn("auth.forgot.failed", { status: error.status, message: error.message });
  }
  // Always return ok — never reveal whether the email is registered.
  return { ok: true, data: undefined };
}

/**
 * /reset (A3c-S-signup). Dos modos:
 *   - **recovery**: la cookie firmada `ks_recovery` de ESTE usuario (la deja
 *     `/auth/confirm` tras verificar el link del mail) → acepta la clave nueva
 *     sin la actual, y la cookie se borra: es de un solo uso.
 *   - **cambio común**: sin cookie, se exige la contraseña actual.
 *
 * Por qué: antes bastaba CUALQUIER sesión para cambiar la clave. Una sesión
 * robada (una notebook compartida del consultorio, un token filtrado) se
 * convertía en toma de cuenta permanente: cambiaba la clave y dejaba afuera al
 * dueño.
 */
export async function updatePasswordWithRecoverySession(
  raw: ResetPasswordInputType
): Promise<ActionResult> {
  const parsed = ResetPasswordInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Contraseña inválida",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const limited = await rateLimit(`reset:${clientIp(headers())}`, { limit: 5, windowMs: 600_000 });
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }
  const supabase = getSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user?.email) {
    return {
      ok: false,
      error: "El link expiró o ya fue usado. Volvé a pedir el reset.",
    };
  }

  const jar = cookies();
  const viaRecovery = verifyRecoveryCookie(jar.get(RECOVERY_COOKIE)?.value, user.id);
  if (!viaRecovery) {
    const current = parsed.data.currentPassword ?? "";
    if (!current) {
      return {
        ok: false,
        error: "Ingresá tu contraseña actual. Si no la recordás, pedí un link desde “Olvidé mi contraseña”.",
        fieldErrors: { currentPassword: ["Requerida"] },
      };
    }
    // Además del límite por IP, por usuario: sin esto la contraseña actual se
    // podía adivinar desde una sesión robada rotando IPs.
    const perUser = await rateLimit(`reset:user:${user.id}`, { limit: 5, windowMs: 600_000 });
    if (!perUser.ok) return { ok: false, error: rateLimitedMessage(perUser.retryAfterMs) };
    const { error: pwErr } = await supabase.auth.signInWithPassword({ email: user.email, password: current });
    if (pwErr) {
      return {
        ok: false,
        error: "La contraseña actual no es correcta.",
        fieldErrors: { currentPassword: ["Incorrecta"] },
      };
    }
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    logger.warn("auth.reset.update_failed", { status: error.status, message: error.message });
    return { ok: false, error: "No pudimos actualizar la contraseña. Probá de nuevo." };
  }
  // Un solo uso. Se borra recién tras el cambio exitoso: si Supabase falló,
  // el usuario reintenta dentro de los 15 min sin pedir otro mail.
  if (viaRecovery) jar.delete(RECOVERY_COOKIE);
  return { ok: true, data: undefined };
}
