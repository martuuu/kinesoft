"use server";

/**
 * Stepper de alta del consultorio (A3c-S-signup) — `/onboarding`.
 *
 * El paso 1 fue la cuenta (signup + email verificado). Acá:
 *   2. `saveOnboardingClinic` — crea Tenant + Practitioner + OWNER +
 *      "Particular" en UNA transacción (`lib/tenant-bootstrap.ts`, la misma
 *      lógica que usa `scripts/create-tenant.ts`). Re-ejecutarlo EDITA el
 *      consultorio en alta: nunca duplica tenant, membresía ni Particular.
 *      EV0: elige el tipo de consultorio (`vertical`, default KINESIOLOGY);
 *      al re-entrar la cambia por el escritor único (C-EV5) mientras el alta
 *      siga abierta. El turnero nace apagado (EV-D2).
 *   3. Sede — `saveOnboardingLocation` (B5.5 ONB): confirma/edita la sede
 *      principal que dejó el bootstrap (la crea si falta).
 *   4-8. Horario, tu horario, servicios (+ práctica del catálogo), obras
 *      sociales (+ prestadora del catálogo) y equipo reusan las actions de
 *      siempre (`setBusinessHours`, `savePractitionerWeek`, `createService`,
 *      `createInsurer`/`addInsurerFromCatalog`, `createInvitation`): el OWNER
 *      ya tiene Actor desde el paso 2.
 *   9. `completeOnboarding` — marca `Tenant.onboardingCompletedAt`.
 *
 * El paso actual no se guarda: se deriva del estado (`deriveResumeStep`).
 */
import { randomBytes } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ensurePrimaryLocation } from "@/lib/agenda-defaults";
import { lockTenantLocations } from "@/lib/location-lock";
import { LocationInput } from "@/lib/locations-schemas";
import { bootstrapTenant, PractitionerElsewhereError } from "@/lib/tenant-bootstrap";
import { getSessionUser, isPortalPatientIdentity, loadMemberships } from "@/lib/onboarding-internal";
import { OnboardingClinicInput, type ActionResult, type OnboardingClinicInputType } from "@/lib/validation";

const INVITE_TTL_MS = 7 * 86_400_000;

/** Paso 2: alta (o edición, si ya existe) del consultorio del usuario. */
export async function saveOnboardingClinic(
  raw: OnboardingClinicInputType
): Promise<ActionResult<{ tenantId: string; created: boolean }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Tu sesión expiró. Iniciá sesión de nuevo." };
  // Sin verificar no hay tenant: el signup ya no auto-confirma (H5), y una
  // sesión sin email confirmado (proyecto mal configurado, identidad vieja)
  // tampoco pasa de acá.
  if (!user.emailVerified) {
    return { ok: false, error: "Confirmá tu email antes de crear el consultorio. Revisá tu bandeja de entrada." };
  }

  const parsed = OnboardingClinicInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Revisá los datos del consultorio.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;
  const contact = {
    name: d.name,
    phone: d.phone || null,
    whatsapp: d.whatsapp || null,
    publicEmail: d.publicEmail || null,
  };

  const rl = await rateLimit(`onboarding:clinic:${user.id}`, { limit: 10, windowMs: 600_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const memberships = await loadMemberships(user.id);
  const inProgress = memberships.find((m) => m.role === "OWNER" && !m.tenant.onboardingCompletedAt);

  // Idempotencia: re-entrar al paso 2 edita el consultorio en alta.
  if (inProgress) {
    const tenantId = inProgress.tenantId;
    // EV0 (EV-D5): la vertical se puede corregir mientras el alta siga
    // abierta, y SOLO por el escritor único (C-EV5, source `onboarding`), que
    // re-chequea `onboardingCompletedAt IS NULL` con la fila bloqueada: si un
    // `completeOnboarding` en otra pestaña cerró el alta entre `loadMemberships`
    // y acá, devuelve `onboarding-closed` y no se escribe nada (ni contacto).
    // `homeTenantId = tenantId` es legítimo: la membresía OWNER sale de la
    // sesión verificada, no de un input.
    const entitlements = await runWithRls(tenantId, async (tx) => {
      const r = d.vertical
        ? await applyTenantEntitlementsInTx(tx, {
            tenantId,
            source: "onboarding",
            patch: { vertical: d.vertical },
            actor: { userId: user.id, homeTenantId: tenantId },
          })
        : null;
      if (r && !r.ok) return r;
      await tx.tenant.update({ where: { id: tenantId }, data: contact });
      return r;
    });
    if (entitlements && !entitlements.ok) {
      return {
        ok: false,
        error:
          entitlements.reason === "onboarding-closed"
            ? "El alta del consultorio ya se completó. Entrá desde el panel."
            : "No pudimos guardar el consultorio. Probá de nuevo.",
      };
    }
    if (entitlements && entitlements.changed.length > 0) {
      // Después del commit: el set de módulos cambió (nav, catálogo, dashboard).
      for (const tag of tenantEntitlementTags(tenantId)) revalidateTag(tag);
      revalidatePath("/", "layout");
    }
    await audit({
      tenantId: inProgress.tenantId,
      actorId: user.id,
      action: "tenant.update",
      entity: "Tenant",
      entityId: inProgress.tenantId,
      payload: { source: "onboarding" },
    });
    return { ok: true, data: { tenantId: inProgress.tenantId, created: false } };
  }
  if (memberships.length > 0) {
    return { ok: false, error: "Tu cuenta ya pertenece a un consultorio. Entrá desde el panel." };
  }

  // Staff ≠ paciente (misma regla que acceptInvite). Acá la identidad ya está
  // verificada, así que se puede decir el motivo sin filtrar nada ajeno.
  if (await isPortalPatientIdentity(user)) {
    return {
      ok: false,
      error: "Esta cuenta se usa en el portal de pacientes. Para crear un consultorio, registrate con otro email.",
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Doble click / dos pestañas: si el otro pedido ya creó el consultorio,
      // se devuelve ese (mismo resultado que re-entrar al paso).
      const mine = await ownedTenantId(user.id);
      if (mine) return { ok: true, data: { tenantId: mine, created: false } };
    }
    try {
      const r = await prismaService.$transaction((tx) =>
        bootstrapTenant(tx, {
          userId: user.id,
          email: user.email,
          fullName: user.fullName,
          clinicName: contact.name,
          phone: contact.phone,
          whatsapp: contact.whatsapp,
          publicEmail: contact.publicEmail,
          vertical: d.vertical,
          onboardingCompleted: false,
          source: "onboarding",
        })
      );
      logger.info("onboarding.tenant_created", { tenantId: r.tenantId, slug: r.slug });
      return { ok: true, data: { tenantId: r.tenantId, created: true } };
    } catch (e) {
      if (e instanceof PractitionerElsewhereError) {
        // El practitioner puede ser el que acaba de crear un pedido paralelo
        // de este mismo usuario: eso no es "otro consultorio".
        const mine = await ownedTenantId(user.id);
        if (mine) return { ok: true, data: { tenantId: mine, created: false } };
        return {
          ok: false,
          error: "Tu cuenta ya figura como profesional de otro consultorio. Escribinos a soporte para crear uno nuevo.",
        };
      }
      // P2002: slug tomado por otra alta simultánea (→ otro slug), o el
      // UserProfile/Practitioner que insertó un pedido paralelo del mismo
      // usuario (→ el chequeo del principio del loop devuelve ese tenant).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      logger.error("onboarding.tenant_create_failed", { error: e instanceof Error ? e.message : String(e) });
      return { ok: false, error: "No pudimos crear el consultorio. Probá de nuevo." };
    }
  }
  return { ok: false, error: "No pudimos crear el consultorio. Probá de nuevo." };
}

async function ownedTenantId(userId: string): Promise<string | null> {
  const m = (await loadMemberships(userId)).find((x) => x.role === "OWNER");
  return m?.tenantId ?? null;
}

/** OWNER del tenant activo con el alta sin terminar. */
async function requireOnboardingOwner() {
  const actor = await getActor();
  const row = await runWithRls(actor.tenantId, async (tx) => {
    const [m, t] = await Promise.all([
      tx.membership.findUnique({
        where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
        select: { role: true },
      }),
      tx.tenant.findUnique({ where: { id: actor.tenantId }, select: { onboardingCompletedAt: true } }),
    ]);
    return { role: m?.role ?? null, completedAt: t?.onboardingCompletedAt ?? null };
  });
  if (row.role !== "OWNER") throw new Error("Solo el dueño del consultorio completa el alta.");
  return { actor, completedAt: row.completedAt };
}

/**
 * Paso "Sede" (B5.5 ONB): datos de la sede principal. En el alta la
 * dirección es obligatoria (es lo que marca el paso como hecho para el
 * retome, `deriveResumeStep`); en Configuración → Sedes sigue opcional.
 *
 * Idempotente: siempre escribe sobre LA principal. El bootstrap ya la crea
 * ("Principal", ids del backfill); si falta (alta abierta antes de B2.3) se
 * crea acá con `ensurePrimaryLocation`, el mismo helper del alta, así no hay
 * dos caminos que produzcan sedes distintas (AUDIT §5.26). Lock exclusivo de
 * sedes como `createLocation`: crear/cambiar la principal no se intercala
 * con un archivado ni con otra alta.
 */
const OnboardingLocationInput = LocationInput.pick({ name: true, city: true, province: true, phone: true }).extend({
  address: z.string().trim().min(1, "Poné la dirección.").max(160, "Máximo 160 caracteres"),
});

export async function saveOnboardingLocation(
  raw: z.input<typeof OnboardingLocationInput>
): Promise<ActionResult<{ locationId: string }>> {
  const { actor } = await requireOnboardingOwner();
  const parsed = OnboardingLocationInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Revisá los datos de la sede.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  // Como `updateLocation`: un campo omitido no se toca ("" sí lo borra; el
  // transform de `optText` convierte undefined en null y lo pisaría).
  const data = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k in raw)) as Prisma.LocationUpdateManyMutationInput;
  try {
    const locationId = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const id = await ensurePrimaryLocation(tx, actor.tenantId);
      // updateMany con tenantId: la barrera explícita también en la escritura
      // (BYPASSRLS en prod).
      await tx.location.updateMany({ where: { id, tenantId: actor.tenantId }, data });
      return id;
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "location.update",
      entity: "Location",
      entityId: locationId,
      payload: { fields: Object.keys(data), source: "onboarding" },
    });
    revalidatePath("/configuracion");
    revalidatePath("/agenda");
    return { ok: true, data: { locationId } };
  } catch (e) {
    logger.error("onboarding.location_failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la sede. Probá de nuevo." };
  }
}

/** Paso 9: cierra el alta. Idempotente (no pisa la fecha de un alta ya cerrada). */
export async function completeOnboarding(): Promise<ActionResult> {
  const { actor, completedAt } = await requireOnboardingOwner();
  if (completedAt) return { ok: true, data: undefined };
  const services = await runWithRls(actor.tenantId, (tx) =>
    tx.service.count({ where: { tenantId: actor.tenantId } })
  );
  if (services === 0) {
    return { ok: false, error: "Cargá al menos un servicio: la agenda y el turnero lo necesitan." };
  }
  await runWithRls(actor.tenantId, (tx) =>
    tx.tenant.updateMany({
      where: { id: actor.tenantId, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: new Date() },
    })
  );
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "tenant.onboarding.complete",
    entity: "Tenant",
    entityId: actor.tenantId,
  });
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

/**
 * Sesión verificada sin consultorio y con una invitación pendiente para su
 * email: la lleva a aceptarla. La invitación guarda solo el HASH del token,
 * así que el link del mail no se puede reconstruir: se rota el token (el link
 * viejo deja de valer) y se devuelve la URL nueva. Es seguro porque quien lo
 * pide es el dueño verificado del email invitado — el mismo que podría abrir
 * el mail.
 */
export async function openPendingInvitation(invitationId: string): Promise<ActionResult<{ url: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Tu sesión expiró. Iniciá sesión de nuevo." };
  if (!user.emailVerified) return { ok: false, error: "Confirmá tu email primero." };
  if (typeof invitationId !== "string" || !invitationId) return { ok: false, error: "Invitación inválida." };

  const rl = await rateLimit(`onboarding:invite:${user.id}`, { limit: 10, windowMs: 600_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  // Canal service: el usuario todavía no es miembro del tenant de la
  // invitación. El filtro por email de la sesión es la barrera.
  const inv = await prismaService.invitation.findFirst({
    where: {
      id: invitationId,
      email: { equals: user.email, mode: "insensitive" },
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, tenantId: true },
  });
  if (!inv) return { ok: false, error: "La invitación ya no está disponible." };

  const rawToken = randomBytes(24).toString("base64url");
  await prismaService.invitation.update({
    where: { id: inv.id },
    data: { token: hashInviteToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  await audit({
    tenantId: inv.tenantId,
    actorId: user.id,
    action: "invitation.reissue_self",
    entity: "Invitation",
    entityId: inv.id,
  });
  return { ok: true, data: { url: `/invite/${rawToken}` } };
}
