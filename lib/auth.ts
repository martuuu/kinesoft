"use server";

/**
 * Authentication server actions — Sprint 16 (C).
 *
 *   - `signUpPractitioner` — self-serve owner signup. Creates a Supabase
 *     auth user via the admin API, then provisions the tenant +
 *     practitioner + OWNER membership in a single Prisma transaction.
 *
 *   - `sendPasswordReset` — fire-and-forget `resetPasswordForEmail`.
 *     The same email arrives whether the address exists or not so we
 *     don't leak account presence; UI shows "if your email exists you'll
 *     get a link" regardless of result.
 *
 *   - `updatePasswordWithRecoverySession` — called from /reset after the
 *     user clicks the recovery email link and Supabase has set a session
 *     cookie with the `recovery` token.
 *
 * Auth + tenancy invariants enforced here:
 *   - Slug uniqueness is checked twice: pre-flight + DB constraint.
 *   - Email duplicates across Supabase identities are surfaced cleanly
 *     (don't leak whether the email already exists for security; we
 *     return a generic "no se pudo crear la cuenta" on dupe).
 *   - On any Prisma failure after the Supabase user was created we
 *     **delete the orphan auth user** so the email can be retried.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { headers } from "next/headers";
import type { ActionResult } from "@/lib/validation";

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const SignupInput = z.object({
  clinicName: z.string().trim().min(2, "Nombre del consultorio requerido").max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Mínimo 3 caracteres")
    .max(40)
    .regex(
      slugRe,
      "Solo minúsculas, números y guiones. No empieza ni termina con guión."
    ),
  email: z.string().trim().toLowerCase().email("Email inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres").max(72),
  fullName: z.string().trim().min(2, "Nombre completo requerido").max(80),
  licenseNumber: z
    .string()
    .trim()
    .max(40)
    .optional()
    .or(z.literal("")),
});

const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "agenda",
  "biblioteca",
  "booking",
  "c",
  "configuracion",
  "dashboard",
  "diagnostico",
  "forgot",
  "invite",
  "login",
  "logout",
  "pacientes",
  "portal",
  "reportes",
  "reset",
  "seguimiento",
  "signup",
  "terapia-manual",
  "www",
]);

export async function signUpPractitioner(
  raw: z.input<typeof SignupInput>
): Promise<ActionResult<{ redirect: string }>> {
  const parsed = SignupInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;

  // Rate limit by IP — 3 signups per 10 minutes per IP. Prevents
  // tenant-flood + Supabase user enumeration.
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const limited = await rateLimit(`signup:${ip}`, { limit: 3, windowMs: 600_000 });
  if (!limited.ok) {
    return {
      ok: false,
      error: "Demasiados intentos. Probá de nuevo en unos minutos.",
    };
  }

  if (RESERVED_SLUGS.has(data.slug)) {
    return {
      ok: false,
      error: "Ese identificador está reservado. Probá con otro.",
      fieldErrors: { slug: ["Reservado"] },
    };
  }

  // Pre-flight slug check so the friendly error fires before we hit the
  // admin API. (DB unique constraint is still authoritative.)
  const existing = await prisma.tenant.findUnique({
    where: { slug: data.slug },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      error: "Ya existe un consultorio con ese identificador.",
      fieldErrors: { slug: ["Ya está en uso"] },
    };
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      error:
        "Configuración del servidor incompleta. Pedile al administrador que configure SUPABASE_SERVICE_ROLE_KEY.",
    };
  }

  // Step 1: create the Supabase auth user. We auto-confirm the email
  // since the user is doing the signup interactively and we trust the
  // session flow downstream.
  const { data: userData, error: createErr } = await admin.auth.admin.createUser({
    email: data.email,
    password: data.password,
    email_confirm: true,
    user_metadata: { full_name: data.fullName },
  });
  if (createErr || !userData.user) {
    logger.warn("signup.supabase_create_failed", { error: createErr?.message });
    // Don't leak whether the email is already registered — return a
    // generic error.
    return { ok: false, error: "No pudimos crear la cuenta. Probá con otro email." };
  }
  const userId = userData.user.id;

  // Step 2: provision the tenant + user profile + practitioner +
  // membership inside ONE transaction. If any step fails, delete the
  // orphan Supabase user so the email can be retried.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.userProfile.create({
        data: {
          id: userId,
          email: data.email,
          fullName: data.fullName,
        },
      });
      const tenant = await tx.tenant.create({
        data: {
          slug: data.slug,
          name: data.clinicName,
        },
      });
      const practitioner = await tx.practitioner.create({
        data: {
          tenantId: tenant.id,
          userId,
          licenseNumber: data.licenseNumber || null,
        },
      });
      await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId,
          role: "OWNER",
          acceptedAt: new Date(),
        },
      });
      await audit({
        tenantId: tenant.id,
        actorId: userId,
        action: "tenant.create",
        entity: "Tenant",
        entityId: tenant.id,
        payload: { slug: tenant.slug, practitionerId: practitioner.id },
      });
    });
  } catch (e) {
    logger.error("signup.prisma_failed", {
      error: e instanceof Error ? e.message : String(e),
      userId,
    });
    // Clean up the orphan auth user so the email can be reused.
    await admin.auth.admin.deleteUser(userId).catch((cleanupErr) => {
      logger.error("signup.cleanup_failed", {
        userId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    });
    return {
      ok: false,
      error: "No pudimos completar el registro. Intentá de nuevo.",
    };
  }

  // Step 3: sign the user in via the server client so the cookie is
  // set for the redirect to /dashboard. The Supabase server client
  // reads/writes cookies on the incoming request.
  const supabase = getSupabaseServerClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: data.email,
    password: data.password,
  });
  if (signInErr) {
    // Account is provisioned but auto-login failed — send to /login
    // with the email pre-filled so the user just types the password.
    logger.warn("signup.auto_signin_failed", { error: signInErr.message });
    return {
      ok: true,
      data: { redirect: `/login?email=${encodeURIComponent(data.email)}` },
    };
  }

  return { ok: true, data: { redirect: "/dashboard" } };
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

  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const limited = await rateLimit(`forgot:${ip}`, { limit: 5, windowMs: 600_000 });
  if (!limited.ok) {
    return {
      ok: false,
      error: "Demasiados intentos. Probá de nuevo en unos minutos.",
    };
  }

  // We use the server (anon-key) client here, NOT the admin client.
  // resetPasswordForEmail is intentionally noisy: it always responds
  // success regardless of whether the email exists — perfect for our
  // "no enumeration" stance.
  //
  // The email link points at `/auth/callback?next=/reset` because the
  // callback exchanges the recovery code for a server-side session
  // cookie. Going straight to `/reset` would leave the user without a
  // session (the recovery token lives in the URL hash, client-only).
  const supabase = getSupabaseServerClient();
  const redirectTo = `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/reset`;
  await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo });
  // Always return ok — never reveal whether the email is registered.
  return { ok: true, data: undefined };
}

const ResetInput = z.object({
  password: z.string().min(8, "Mínimo 8 caracteres").max(72),
});

/**
 * Called from /reset after the user follows the recovery email link.
 * Supabase has set a `recovery`-typed session cookie via the callback;
 * `updateUser({ password })` consumes it.
 */
export async function updatePasswordWithRecoverySession(
  raw: z.input<typeof ResetInput>
): Promise<ActionResult> {
  const parsed = ResetInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Contraseña inválida",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const limited = await rateLimit(`reset:${ip}`, { limit: 5, windowMs: 600_000 });
  if (!limited.ok) {
    return { ok: false, error: "Demasiados intentos. Esperá unos minutos." };
  }
  const supabase = getSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return {
      ok: false,
      error: "El link expiró o ya fue usado. Volvé a pedir el reset.",
    };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { ok: false, error: "No pudimos actualizar la contraseña. Probá de nuevo." };
  }
  return { ok: true, data: undefined };
}
