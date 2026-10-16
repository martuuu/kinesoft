"use server";

/**
 * ES4 S24d · «Mis datos» del portal: el paciente pide cambiar su contacto o su obra social y puede cerrar la sesión
 * en todos sus dispositivos. Solo funciones async (archivo `"use server"`); la lógica de escritura y la lectura del
 * perfil viven en `lib/portal-profile-internal.ts` (`server-only`), los tipos en `lib/portal-profile-types.ts`.
 *
 * `requestPortalProfileChange`, en orden:
 *   1. `requirePortalPatient(slug)`: ficha VINCULADA por (tenantId, userId), sin staff ni archivadas;
 *   2. `surfacesOpen`: un consultorio suspendido no recibe escrituras sin Actor (nadie del equipo las atendería);
 *   3. zod del contrato `PortalPendingChanges` (`.strict()`, topes, ≤ 4 KB, al menos un campo);
 *   4. rate-limit 3/h por (cuenta, consultorio): es una escritura que notifica al equipo; tres pedidos por hora
 *      alcanzan para corregir un error de tipeo y frenan que un loop llene la campana del consultorio;
 *   5. pedido PENDING (INSERT o UPDATE con CAS) — NUNCA la ficha;
 *   6. aviso al profesional asignado, a OWNER/ADMIN (ES4-D9) y a quien opera la agenda de todos (`agenda.operateAll`,
 *      la Secretaria que lo aprueba; ES4-Z b7) con los NOMBRES de los campos, sin valores.
 * Logs `portal.profile.*` con slug y campos: nunca valores ni el email.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { upsertPendingChangeRequest } from "@/lib/portal-profile-internal";
import { PortalPendingChanges, type PortalPendingChangesT } from "@/lib/portal-pending-changes";
import {
  PORTAL_PROFILE_FIELD_LABELS,
  type PortalProfileFormState,
  type PortalSignOutState,
} from "@/lib/portal-profile-types";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { clearActiveTenantCookie } from "@/lib/tenant-choice";
import { clearTwoFactorCookies } from "@/lib/two-factor-cookie";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";

const Slug = z.string().trim().min(1).max(100);

const NO_REF = "No encontramos tu ficha en este consultorio. Volvé a Mis consultorios y probá de nuevo.";

/** Mensaje por campo (voseo, sin jerga): el error de zod crudo no le sirve al paciente. */
const FIELD_ERRORS: Record<string, string> = {
  phone: "Revisá el teléfono: tiene que tener entre 6 y 30 caracteres.",
  email: "Revisá el email: no parece válido.",
  emergencyContact: "Para el contacto de emergencia necesitamos nombre y un teléfono (entre 6 y 30 caracteres).",
  coverage: "Para la obra social necesitamos al menos su nombre.",
};

function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : "";
    if (FIELD_ERRORS[key] && !out[key]) out[key] = [FIELD_ERRORS[key]];
  }
  return out;
}

export async function requestPortalProfileChange(input: {
  tenantSlug: string;
  changes: unknown;
}): Promise<ActionResult<{ fields: string[] }>> {
  const slug = Slug.safeParse(input.tenantSlug);
  // ES4-Z (b): «Sin acceso.» no decía qué hacer.
  if (!slug.success) return { ok: false, error: NO_REF };
  const ref = await requirePortalPatient(slug.data);
  if (!ref) return { ok: false, error: NO_REF };
  if (!ref.surfacesOpen) {
    return {
      ok: false,
      error: "Tu consultorio no está recibiendo pedidos por acá por ahora. Escribiles directamente.",
    };
  }

  const parsed = PortalPendingChanges.safeParse(input.changes);
  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error);
    const first = Object.values(fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? "Completá al menos un dato para cambiar.", fieldErrors };
  }

  const rl = await rateLimit(`portal-profile:${ref.userId}:${ref.tenantId}`, { limit: 3, windowMs: 3_600_000 });
  if (!rl.ok) {
    logger.warn("portal.profile.refused", { tenantSlug: ref.tenant.slug, reason: "rate_limited" });
    return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };
  }

  const r = await upsertPendingChangeRequest(ref, parsed.data);
  if (!r.ok) {
    logger.warn("portal.profile.refused", { tenantSlug: ref.tenant.slug, reason: r.reason });
    return {
      ok: false,
      error:
        r.reason === "invalid"
          ? "Ya tenés un pedido abierto con muchos cambios. Esperá a que el consultorio lo revise o escribiles directamente."
          : "No pudimos guardar tu pedido. Probá de nuevo en un momento.",
    };
  }

  const patientName = `${ref.patient.firstName} ${ref.patient.lastName}`.trim();
  const labels = r.fields.map((f) => PORTAL_PROFILE_FIELD_LABELS[f] ?? f).join(", ");
  // ES4-D9: sin valores (son datos personales y la campana los replicaría); el equipo los ve en la ficha (S24r).
  await notifyTenantOwners({
    tenantId: ref.tenantId,
    kind: "SYSTEM",
    title: `${patientName} pidió actualizar sus datos`,
    body: `Desde el portal: ${labels}. Revisalo en su ficha para aprobarlo.`,
    link: `/pacientes/${ref.patientId}`,
    alsoPractitionerId: ref.patient.assignedPractitionerId ?? undefined,
    alsoAgendaOperators: true,
  });
  logger.info("portal.profile.requested", { tenantSlug: ref.tenant.slug, mode: r.mode, fields: r.fields });
  revalidatePath("/portal/me");
  return { ok: true, data: { fields: r.fields } };
}

/** Texto del form: recortado; vacío = «no lo cambio». */
function text(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

const FORM_KEYS = ["phone", "email", "ecName", "ecRelation", "ecPhone", "insurerName", "planName", "memberId"] as const;

/**
 * Del form a la forma del contrato. Un grupo (contacto de emergencia, obra social) entra si el paciente completó
 * cualquiera de sus campos: si falta el obligatorio, lo dice zod con el mensaje del grupo.
 */
function changesFromForm(fd: FormData): PortalPendingChangesT {
  const c: PortalPendingChangesT = {};
  const phone = text(fd, "phone");
  if (phone) c.phone = phone;
  const email = text(fd, "email");
  if (email) c.email = email.toLowerCase();
  const [ecName, ecRelation, ecPhone] = [text(fd, "ecName"), text(fd, "ecRelation"), text(fd, "ecPhone")];
  if (ecName || ecRelation || ecPhone) c.emergencyContact = { name: ecName, relation: ecRelation || null, phone: ecPhone };
  const [insurerName, planName, memberId] = [text(fd, "insurerName"), text(fd, "planName"), text(fd, "memberId")];
  if (insurerName || planName || memberId) {
    c.coverage = { insurerName, planName: planName || null, memberId: memberId || null };
  }
  return c;
}

/** Action del form «Pedir un cambio» con la forma de `useFormState` (anda sin JS). */
export async function submitPortalProfileChange(
  _prev: PortalProfileFormState,
  fd: FormData
): Promise<PortalProfileFormState> {
  const slug = text(fd, "slug");
  const r = await requestPortalProfileChange({ tenantSlug: slug, changes: changesFromForm(fd) });
  if (r.ok) return { status: "sent", slug, fields: r.data.fields, at: Date.now() };
  const values: Record<string, string> = {};
  for (const k of FORM_KEYS) values[k] = text(fd, k).slice(0, 200);
  return { status: "error", slug, error: r.error, values, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}) };
}

/**
 * «Cerrar sesión en todos lados»: revoca TODOS los refresh tokens de la cuenta en GoTrue (`scope: "global"`), no solo
 * el de este navegador; para un celular perdido o una PC compartida. supabase-js no tira: el `{ error }` se chequea y
 * se muestra (sin eso, una falla de red dejaba al paciente creyendo que cerró las otras sesiones). Si sale bien,
 * borra las cookies propias como `/api/auth/sign-out` y vuelve al portal.
 */
export async function signOutPortalEverywhere(_prev: PortalSignOutState, _fd: FormData): Promise<PortalSignOutState> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) {
    logger.warn("portal.signout_global.failed", { error: error.name, status: error.status ?? null });
    return {
      status: "error",
      error: "No pudimos cerrar tus otras sesiones. Revisá tu conexión y probá de nuevo.",
    };
  }
  clearActiveTenantCookie();
  clearTwoFactorCookies();
  logger.info("portal.signout_global.done", {});
  redirect("/portal");
}
