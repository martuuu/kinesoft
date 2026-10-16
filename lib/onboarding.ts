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
 *      PL-1a: nace INDIVIDUAL en prueba de 14 días y pregunta «¿Atendés
 *      pacientes?» (`ownerClinical`, default sí): un Titular que no atiende
 *      nace sin Practitioner ni agenda (`bootstrapTenant`, PL-1c).
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
import { initialSubscriptionFor } from "@/lib/platform-provisioning-schemas";
import { signupMode } from "@/lib/env";
import { signupAssistedMessage } from "@/lib/onboarding-logic";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getAccessSnapshot, getActor } from "@/lib/session";
// PL-A (plan §20.5.9): los datos de onboarding dejaron de auditarse (ruido); queda el link de invitación (acceso).
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ensurePrimaryLocation } from "@/lib/agenda-defaults";
import { lockTenantLocations } from "@/lib/location-lock";
import { LocationInput } from "@/lib/locations-schemas";
import { bootstrapTenant, OpenOnboardingExistsError } from "@/lib/tenant-bootstrap";
import { getSessionUser, isPortalPatientIdentity, loadMemberships } from "@/lib/onboarding-internal";
import { OnboardingClinicInput, type ActionResult, type OnboardingClinicInputType } from "@/lib/validation";

/** Copy compartido de BO1-A para un usuario deshabilitado (mismo texto que /cuenta-desactivada). */
const USER_DISABLED_ERROR = "Tu cuenta está desactivada. Si creés que es un error, escribinos a soporte.";
const TWO_FACTOR_PENDING_ERROR = "Primero terminá de verificar tu acceso.";

/**
 * PL-Z (a2#6): ¿la sesión tiene la 2FA del usuario pendiente? Estas dos actions no pasan por `getActor` (la persona
 * todavía no tiene consultorio), que es donde se corta la 2FA en el resto de la app: sin esto, con solo la contraseña
 * se podía crear un consultorio o abrir una invitación salteando el segundo paso del dueño de la cuenta. Misma foto
 * del request que la sesión (cacheada: cero queries extra si ya se leyó).
 */
async function twoFactorPending(): Promise<boolean> {
  const s = await getAccessSnapshot();
  return s?.twoFactor?.state === "required";
}

/**
 * BO1-A: `UserProfile.disabledAt` (M7) corta también el alta y la apertura de invitaciones. Sin esto, un usuario
 * deshabilitado en la plataforma podía crearse un consultorio nuevo (o entrar a uno por invitación) y volver a
 * tener Actor por la puerta de atrás. Canal service: todavía no hay Actor; el filtro es la sesión verificada.
 */
async function isUserDisabled(userId: string): Promise<boolean> {
  const p = await prismaService.userProfile.findUnique({ where: { id: userId }, select: { disabledAt: true } });
  return !!p?.disabledAt;
}


/**
 * PL-1a (C-PL12): «¿Atendés pacientes?». Se valida aparte de `OnboardingClinicInput` (lib/validation.ts no es de
 * esta sesión): ausente = true, que es lo que pasaba antes (el Titular siempre era profesional). Solo pesa en la
 * CREACIÓN: re-entrar al paso no cambia si el Titular atiende (eso es Equipo, con su propio flujo).
 */
const OwnerClinicalInput = z.boolean({ invalid_type_error: "Respuesta inválida." }).optional().default(true);

/** Paso 2: alta (o edición, si ya existe) del consultorio del usuario. */
export async function saveOnboardingClinic(
  raw: OnboardingClinicInputType & { ownerClinical?: boolean }
): Promise<ActionResult<{ tenantId: string; created: boolean }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Tu sesión expiró. Iniciá sesión de nuevo." };
  // Sin verificar no hay tenant: el signup ya no auto-confirma (H5), y una
  // sesión sin email confirmado (proyecto mal configurado, identidad vieja)
  // tampoco pasa de acá.
  if (!user.emailVerified) {
    return { ok: false, error: "Confirmá tu email antes de crear el consultorio. Revisá tu bandeja de entrada." };
  }
  if (await isUserDisabled(user.id)) return { ok: false, error: USER_DISABLED_ERROR };
  if (await twoFactorPending()) return { ok: false, error: TWO_FACTOR_PENDING_ERROR };

  const { ownerClinical: rawOwnerClinical, ...clinicRaw } = raw ?? ({} as typeof raw);
  const parsed = OnboardingClinicInput.safeParse(clinicRaw);
  const ownerClinicalParsed = OwnerClinicalInput.safeParse(rawOwnerClinical);
  if (!parsed.success || !ownerClinicalParsed.success) {
    return {
      ok: false,
      error: "Revisá los datos del consultorio.",
      fieldErrors: {
        ...(parsed.success ? {} : parsed.error.flatten().fieldErrors),
        ...(ownerClinicalParsed.success ? {} : { ownerClinical: ownerClinicalParsed.error.issues.map((i) => i.message) }),
      },
    };
  }
  const d = parsed.data;
  const ownerClinical = ownerClinicalParsed.data;
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
    return { ok: true, data: { tenantId: inProgress.tenantId, created: false } };
  }
  // IAM-1: se mantiene. Desde M6 la base ya permite que un miembro de A sea
  // profesional de un consultorio propio B, pero el stepper sigue siendo para
  // cuentas SIN consultorio: crear el propio desde una cuenta que ya es
  // miembro es un flujo de producto aparte (IAM-D4, «desde el selector»,
  // IAM-3b). Lo fija onboarding.test.ts («quien ya es miembro de otro
  // consultorio no crea uno nuevo desde el stepper»).
  if (memberships.length > 0) {
    return { ok: false, error: "Tu cuenta ya pertenece a un consultorio. Entrá desde el panel." };
  }
  // BO-Z (BO-D11): con SIGNUP_MODE=assisted los consultorios nuevos los da de alta Plataforma. Va DESPUÉS del
  // re-entrar (un consultorio creado desde Plataforma con el alta abierta sigue su stepper) y del «ya sos miembro»:
  // solo corta la CREACIÓN de un consultorio nuevo.
  if (signupMode() === "assisted") return { ok: false, error: signupAssistedMessage() };

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
      const r = await prismaService.$transaction(async (tx) => {
        // PL-1a: `ownerClinical` (C-PL5, opción de `bootstrapTenant` de PL-1c): false = Titular sin Practitioner.
        const created = await bootstrapTenant(tx, {
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
          ownerClinical,
        });
        // PL-1a (§20.5.8, PL-D10): el alta web nace INDIVIDUAL en prueba (14 días por default; hasta el fin del día AR; mismo
        // cálculo que el alta desde Plataforma). Por el escritor único y en la MISMA tx: o nace con la prueba, o no
        // nace. Antes (BO-D1) nacía en prueba PRO. `saasPlan` ya es INDIVIDUAL por default de la columna: va igual en
        // el patch para que el contrato sea explícito (y el escritor espeja `plan` = FREE si hiciera falta).
        // VX2.1: los días salen de `SaasPlanConfig.trialDays` (lo que promete el signup, que lee el catálogo); sin
        // fila cae a `PLAN_DEFAULTS` (undefined). Antes usaba siempre el default y, si Plataforma cambiaba la prueba,
        // la pantalla y el consultorio decían cosas distintas.
        // VX-Z (decisión 24, default para Martin): un Titular que NO atiende (`ownerClinical=false`) en Individual
        // (1 lugar) ocupa el único lugar sin agenda y no puede invitar a nadie que atienda: consultorio sin salida.
        // Esa alta nace en prueba CONSULTORIO, con los días de SU fila del catálogo (o el default del plan).
        const trialPlan = ownerClinical ? "INDIVIDUAL" : "CONSULTORIO";
        const catalog = await tx.saasPlanConfig.findUnique({ where: { plan: trialPlan }, select: { trialDays: true } });
        const sub = initialSubscriptionFor(trialPlan, catalog?.trialDays, new Date());
        const ent = await applyTenantEntitlementsInTx(tx, {
          tenantId: created.tenantId,
          source: "onboarding",
          initial: true,
          patch: { saasPlan: trialPlan, subscriptionStatus: sub.subscriptionStatus, trialEndsAt: sub.trialEndsAt },
          actor: { userId: user.id, homeTenantId: created.tenantId },
        });
        if (!ent.ok) throw new Error(`[onboarding] entitlements: ${ent.reason}`);
        return created;
      });
      logger.info("onboarding.tenant_created", { tenantId: r.tenantId, slug: r.slug });
      return { ok: true, data: { tenantId: r.tenantId, created: true } };
    } catch (e) {
      // IAM-1: el pedido paralelo del mismo usuario (doble click, dos
      // pestañas) creó el consultorio mientras este esperaba el lock por
      // usuario de `bootstrapTenant`: mismo resultado que re-entrar al paso.
      // Antes de M6 esto lo resolvía el P2002 del único global de
      // Practitioner.userId; ese único ya no existe (un usuario puede ser
      // profesional en varios consultorios). Un removido de otro consultorio
      // (Practitioner viejo, sin membresías) ya NO cae en «escribinos a
      // soporte»: crea el suyo.
      if (e instanceof OpenOnboardingExistsError) {
        return { ok: true, data: { tenantId: e.tenantId, created: false } };
      }
      // P2002: slug tomado por otra alta simultánea (→ otro slug), o el
      // UserProfile que insertó un pedido paralelo del mismo usuario (→ el
      // chequeo del principio del loop devuelve ese tenant).
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
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

/**
 * Sesión verificada sin consultorio y con una invitación pendiente para su
 * email: la lleva a aceptarla por id. Es seguro porque quien lo pide es el
 * dueño verificado del email invitado (filtro escapado + `sameEmail`) — el
 * mismo que podría abrir el mail.
 *
 * IAM-2a: NO rota el token. La invitación guarda solo el HASH, así que el link
 * del mail no se puede reconstruir; antes se pisaba `Invitation.token` con uno
 * nuevo y el link del mail que el invitado todavía tenía daba 404 (hallazgo
 * del 14-oct, cuentas muertas: si se iba de esta pantalla y volvía al mail, ya
 * no podía entrar). Ahora el link de esta pantalla es un token ADICIONAL: su
 * hash se agrega a `priorTokens` (`push` atómico) y el vigente queda igual,
 * igual que un «Reenviar» (C-IAM5). Tampoco extiende la vigencia: el invitado
 * acepta ahora o le piden que se la reenvíen. «Generar link nuevo» del
 * consultorio lo anula junto con los demás.
 */
export async function openPendingInvitation(invitationId: string): Promise<ActionResult<{ url: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Tu sesión expiró. Iniciá sesión de nuevo." };
  if (!user.emailVerified) return { ok: false, error: "Confirmá tu email primero." };
  if (await isUserDisabled(user.id)) return { ok: false, error: USER_DISABLED_ERROR };
  if (await twoFactorPending()) return { ok: false, error: TWO_FACTOR_PENDING_ERROR };
  if (typeof invitationId !== "string" || !invitationId || invitationId.length > 64) {
    return { ok: false, error: "Invitación inválida." };
  }

  const rl = await rateLimit(`onboarding:invite:${user.id}`, { limit: 10, windowMs: 600_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  // Canal service: el usuario todavía no es miembro del tenant de la
  // invitación. El filtro por email de la sesión es la barrera.
  const now = new Date();
  const inv = await prismaService.invitation.findFirst({
    where: {
      id: invitationId,
      // IAM-0a: escapado. Pelado en el ILIKE, `jpere_@hotmail.com` reabría la
      // invitación de `jperez@hotmail.com`. + post-filtro exacto antes de escribir.
      email: emailEqualsFilter(user.email),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, tenantId: true, email: true },
  });
  if (!inv || !sameEmail(inv.email, user.email)) return { ok: false, error: "La invitación ya no está disponible." };

  const rawToken = randomBytes(24).toString("base64url");
  // Re-chequea el estado en el mismo UPDATE: si se anuló o aceptó entre la
  // lectura y acá, no se agrega un link vivo a una invitación muerta.
  // PL-A (acceso): un link vivo más a la invitación → audit en la misma tx que el `push` (canal service: el
  // usuario todavía no es miembro). Si la invitación cambió en el medio, no se escribe ninguno de los dos.
  const added = await prismaService.$transaction(async (tx) => {
    const upd = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { priorTokens: { push: hashInviteToken(rawToken) } },
    });
    if (upd.count !== 1) return false;
    await auditInTx(tx, {
      tenantId: inv.tenantId,
      actorId: user.id,
      action: "invitation.open_self",
      entity: "Invitation",
      entityId: inv.id,
    });
    return true;
  });
  if (!added) return { ok: false, error: "La invitación ya no está disponible." };
  return { ok: true, data: { url: `/invite/${rawToken}` } };
}
