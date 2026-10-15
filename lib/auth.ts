"use server";

/**
 * Authentication server actions.
 *
 * Principio del bloque IAM (ADR, plan §19.4, sesión IAM-2c): **la app manda todos los mails; Supabase solo
 * emite tokens.** Acá no se usan el `signUp` ni el reset por mail de supabase-js: el token sale de
 * `admin.generateLink` (puerto `lib/identity/auth-admin.ts`, que no manda nada) y el mail, con link a
 * NUESTRO `/auth/confirm`, por `lib/email`. Así la Site URL y las plantillas de Supabase dejan de importar
 * (el link `localhost:3000/#access_token=…` del QA del 14-oct, §19.1 #3) y cada caso manda el mail que
 * corresponde (§19.1 #4: el signup sobre un email con cuenta no mandaba NADA y la pantalla decía «te
 * mandamos un email»).
 *
 *   - `signUpPractitioner` — signup con email VERIFICADO (A3c-S-signup). Crea la cuenta SIN confirmar con la
 *     contraseña y manda la verificación. **No crea ningún tenant**: el consultorio se da de alta en
 *     `/onboarding` después de verificar (H5). Con invitación no hace nada: la UI va a `/invite/<token>`.
 *   - `sendPasswordReset` — link de recovery propio a `/reset`.
 *   - `resendVerification` — re-emite la verificación de una cuenta sin confirmar (C-IAM6).
 *   - `updatePasswordWithRecoverySession` — /reset. Con la cookie firmada
 *     `ks_recovery` (la deja `/auth/confirm` tras un link de recovery) cambia
 *     la clave sin pedir la actual; sin ella, exige la contraseña actual.
 *
 * Sin oráculo de cuentas: signup, forgot y reenviar responden LO MISMO exista o no la cuenta (lo que
 * cambia es qué mail llega, o ninguno). Los únicos errores visibles son los de formato, el rate limit
 * (que aplica igual exista o no) y una falla del servicio de cuentas (que tampoco depende de la cuenta).
 *
 * H5 (auditoría 23-sep): el signup anterior creaba el usuario con el admin
 * client y `email_confirm: true` (auto-confirmado) y armaba el tenant en el
 * acto: cualquiera podía crear consultorios con un email ajeno, sin probar
 * que era suyo, y quemar ese email para el dueño real. Eso se eliminó (y sigue
 * eliminado: `generateLink(signup)` crea la cuenta SIN confirmar).
 */
import { cookies, headers } from "next/headers";
// Lecturas pre-sesión (el chequeo staff ≠ paciente): todavía no hay Actor ni
// GUC posible → canal service. See lib/db.ts.
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { hashKeyPart, rateLimit, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { emailEqualsFilter } from "@/lib/email-match";
import { RECOVERY_COOKIE, verifyRecoveryCookie } from "@/lib/recovery-cookie";
import { authAdmin, type AuthUserLite } from "@/lib/identity/auth-admin";
import { issueAccessLink } from "@/lib/identity/access-link";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (cada emisor de mails lo importa: ver lib/email/log.ts).
import "@/lib/email/log";
import { accountExistsEmail, emailVerificationEmail, passwordResetEmail } from "@/lib/email/templates";
import type { EmailKind, RenderedEmail } from "@/lib/email/types";
import { logger } from "@/lib/logger";
import { env, signupMode } from "@/lib/env";
import { signupAssistedMessage } from "@/lib/onboarding-logic";
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
const ACCOUNTS_DOWN = "No pudimos crear la cuenta. Probá de nuevo en unos minutos.";

/** Destino al confirmar el alta: el stepper del consultorio (exige email verificado). */
const SIGNUP_NEXT = "/onboarding";

function appUrl(path: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
}

/** Baneada (suspendida a mano en Auth): no se le manda nada, igual que si no existiera. */
function isBanned(u: AuthUserLite): boolean {
  return !!u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now();
}

/**
 * Staff ≠ paciente (AUDIT §5.22, misma regla que acceptInvite): un email que ya usa el portal de pacientes
 * no se registra como profesional. Quien pregunta todavía NO probó ser dueño del email, así que no se le
 * dice por qué: misma respuesta que un alta normal y no se manda nada. El mensaje explícito lo da el paso
 * 2 de /onboarding, con la identidad ya verificada.
 */
async function isPortalPatientEmail(email: string): Promise<boolean> {
  const row = await prisma.patient.findFirst({
    // IAM-0a: escapado. Pelado en el ILIKE, `ana_@x.com` "era" la paciente con
    // portal `anax@x.com` y su alta se descartaba en silencio.
    where: { email: emailEqualsFilter(email), userId: { not: null } },
    select: { id: true },
  });
  return !!row;
}

/** Manda el mail y solo loguea si no salió: la respuesta al navegador no cambia (sin oráculo). */
async function sendAuthEmail(kind: EmailKind, to: string, mail: RenderedEmail): Promise<void> {
  const r = await sendEmail({ ...mail, kind, to });
  if (!r.ok) logger.warn("auth.email_not_sent", { kind, transport: r.transport, reason: r.reason });
}

/**
 * Re-emite la verificación de una cuenta SIN confirmar (signup repetido o «reenviar»). `generateLink(signup)`
 * sobre una cuenta sin confirmar re-emite sin contraseña [S6]: la clave NO se toca. A propósito: el pedido no
 * está autenticado, y pisar la clave de una cuenta pendiente dejaría que un tercero fije la contraseña de una
 * cuenta que después confirma su dueño (pre-account takeover).
 */
async function sendVerification(email: string): Promise<void> {
  const link = await issueAccessLink({ email, kind: "signup", next: SIGNUP_NEXT });
  if (!link.ok) {
    logger.warn("auth.verification.link_failed", { code: link.code });
    return;
  }
  await sendAuthEmail("email_verification", email, emailVerificationEmail({ url: link.url }));
}

export async function signUpPractitioner(
  raw: SignupInputType
): Promise<ActionResult<{ email: string; joining: boolean; message: string; redirectTo?: string }>> {
  // Unión por invitación (IAM-2c): la activación es de `/invite/<token>` (IAM-2b: nombre + contraseña →
  // cuenta confirmada + membresía en una tx). Acá no se crea nada ni se manda nada: la UI convierte esto
  // en un redirect. Antes el signup de unión llamaba a signUp sobre el usuario que ya había creado
  // `inviteUserByEmail` → no salía ningún mail y la persona quedaba colgada (§19.1 #4).
  // Se resuelve ANTES de validar el resto del form: con invitación esos campos no importan.
  const rawInvite = typeof raw?.inviteToken === "string" ? raw.inviteToken.trim() : "";
  if (rawInvite && rawInvite.length <= 200) {
    return {
      ok: true,
      data: { email: "", joining: true, message: "", redirectTo: `/invite/${encodeURIComponent(rawInvite)}` },
    };
  }

  // BO-Z (BO-D11): con SIGNUP_MODE=assisted /signup no crea cuentas para un consultorio nuevo (la pantalla ya no
  // ofrece el form; esto cierra la action, que es un endpoint público). La unión por invitación ya salió arriba.
  if (signupMode() === "assisted") return { ok: false, error: signupAssistedMessage() };

  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  const email = data.email;

  // 3 por IP cada 10 min (A3a) + 3 por hora por email: el signup manda un mail,
  // y rotando IPs se podía bombardear el buzón de un tercero.
  const limited = await rateLimitAll([
    { key: `signup:${clientIp(headers())}`, limit: 3, windowMs: 600_000 },
    { key: `signup:email:${hashKeyPart(email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }

  const ok = { ok: true as const, data: { email, joining: false, message: SIGNUP_SENT } };

  if (await isPortalPatientEmail(email)) {
    logger.info("signup.rejected_patient_identity", {});
    return ok;
  }

  const port = authAdmin();
  const found = await port.findUserByEmail(email);
  if (!found.ok) {
    // Falla del servicio (o sin service key): no depende de si la cuenta existe, no es oráculo.
    logger.error("signup.lookup_failed", { code: found.code });
    return { ok: false, error: ACCOUNTS_DOWN };
  }
  const existing = found.data;

  if (existing) {
    if (isBanned(existing)) {
      logger.info("signup.existing_banned", {});
    } else if (existing.emailConfirmedAt) {
      await sendAccountExists(email);
    } else {
      await sendVerification(email);
    }
    return ok;
  }

  // Email sin cuenta: `generateLink(signup)` la CREA sin confirmar, con la contraseña elegida, y devuelve
  // el token de verificación (no manda nada). La cuenta no sirve hasta confirmar el email.
  const link = await issueAccessLink({ email, kind: "signup", next: SIGNUP_NEXT, password: data.password });
  if (!link.ok) {
    if (link.code === "email_exists") {
      // Carrera: otra pestaña o persona la creó entre el lookup y acá. Se trata como existente.
      await sendAccountExists(email);
      return ok;
    }
    if (link.code === "weak_password") {
      // La política de contraseñas del proyecto puede ser más estricta que `NewPassword`. Solo se llega
      // acá con un email SIN cuenta, pero la alternativa (decir «te mandamos un email» sin mandarlo) es
      // justo el bug que cierra esta sesión; el oráculo que abre es angosto (requiere una clave que pase
      // nuestro zod y no la de Supabase) y lo frena el rate limit.
      return {
        ok: false,
        error: "La contraseña no cumple los requisitos. Probá con una más larga.",
        fieldErrors: { password: ["Contraseña débil"] },
      };
    }
    if (link.code === "rate_limited") {
      return { ok: false, error: "Hay demasiados pedidos en este momento. Probá de nuevo en unos minutos." };
    }
    return { ok: false, error: ACCOUNTS_DOWN };
  }
  // El nombre va a `user_metadata.full_name` (lo lee `/auth/confirm` al crear el UserProfile).
  // `generateLink` no lo recibe; es best-effort: sin nombre el onboarding lo pide igual.
  if (link.userId) {
    const named = await port.updateUserById(link.userId, { fullName: data.fullName });
    if (!named.ok) logger.warn("signup.set_name_failed", { code: named.code });
  }
  await sendAuthEmail("email_verification", email, emailVerificationEmail({ url: link.url }));
  return ok;
}

/**
 * «Ya tenés una cuenta»: a quien intenta registrarse con un email con cuenta confirmada le llega un mail con
 * «Ingresar» y «Recuperar contraseña» (un link de recovery listo, que habilita /reset sin la clave actual).
 * Solo lo recibe el dueño del buzón. Si el recovery falla, el botón lleva a /forgot.
 */
async function sendAccountExists(email: string): Promise<void> {
  const recovery = await issueAccessLink({ email, kind: "recovery", next: "/reset" });
  const resetUrl = recovery.ok ? recovery.url : appUrl("/forgot");
  await sendAuthEmail("account_exists", email, accountExistsEmail({ loginUrl: appUrl("/login"), resetUrl }));
}

// ──────────────────────────────────────────────────────────────────────
// Password recovery
// ──────────────────────────────────────────────────────────────────────

const EmailOnlyInput = z.object({
  email: z.string().trim().toLowerCase().email("Email inválido").max(120),
});

export async function sendPasswordReset(
  raw: z.input<typeof EmailOnlyInput>
): Promise<ActionResult> {
  const parsed = EmailOnlyInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Email inválido",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const email = parsed.data.email;

  // A3a-S-rl: por IP y además por hash del email (3/h): sin esto, rotando
  // IPs se podía bombardear el buzón de una persona con mails de reset. El
  // límite aplica exista o no la cuenta, así que no filtra enumeración.
  const limited = await rateLimitAll([
    { key: `forgot:ip:${clientIp(headers())}`, limit: 5, windowMs: 600_000 },
    { key: `forgot:email:${hashKeyPart(email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }

  // IAM-2c: token de recovery con `generateLink` + mail propio. El link va a NUESTRO `/auth/confirm`
  // (`verifyOtp` con token_hash, no el code de PKCE: ese solo se canjea en el MISMO browser que pidió el
  // mail, y la gente abre el mail en el celular), que deja la cookie firmada `ks_recovery` para cambiar la
  // clave sin la actual en /reset. Sin cuenta, GoTrue devuelve not_found [S3] y no crea a nadie: no se
  // manda nada. Ninguna rama cambia la respuesta: nunca revelar si el email está registrado.
  const link = await issueAccessLink({ email, kind: "recovery", next: "/reset" });
  if (link.ok) {
    await sendAuthEmail("password_reset", email, passwordResetEmail({ url: link.url }));
  } else if (link.code !== "not_found") {
    logger.warn("auth.forgot.failed", { code: link.code });
  }
  return { ok: true, data: undefined };
}

// ──────────────────────────────────────────────────────────────────────
// Reenviar verificación (C-IAM6)
// ──────────────────────────────────────────────────────────────────────

/**
 * «No me llegó el mail»: re-emite la verificación de una cuenta SIN confirmar. Respuesta genérica (misma
 * con cuenta confirmada, sin cuenta o con email de paciente, que no reciben nada). Campo `email` del form.
 * Rate limit por IP y por hash del email: aplica exista o no la cuenta, así que tampoco filtra.
 */
export async function resendVerification(formData: FormData): Promise<ActionResult> {
  const parsed = EmailOnlyInput.safeParse({ email: String(formData.get("email") ?? "") });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Email inválido",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const email = parsed.data.email;

  const limited = await rateLimitAll([
    { key: `verify-resend:ip:${clientIp(headers())}`, limit: 5, windowMs: 600_000 },
    { key: `verify-resend:email:${hashKeyPart(email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) {
    return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };
  }

  // Staff ≠ paciente: la verificación lleva a /onboarding (armar un consultorio). Una cuenta pendiente de
  // un paciente (p. ej. la que crea un magic link del portal [S4]) no recibe ese mail.
  if (await isPortalPatientEmail(email)) return { ok: true, data: undefined };

  const found = await authAdmin().findUserByEmail(email);
  if (!found.ok) {
    logger.warn("auth.verify_resend.lookup_failed", { code: found.code });
  } else if (found.data && !found.data.emailConfirmedAt && !isBanned(found.data)) {
    await sendVerification(email);
  }
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
  // IAM-3a: el usuario sale del único `getVerifiedSessionUser` (un `auth.getUser()` por request, nunca tira).
  const user = await getVerifiedSessionUser();
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
