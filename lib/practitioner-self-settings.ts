"use server";

/**
 * CF2 (§29, D-CF2-8/9; M21) — ajustes del profesional que se editan desde «Mi agenda» y Profesionales › Horarios
 * (sesión T-S3). Cuatro actions, todas `getActor` → zod → `where: { tenantId }` a mano (en prod la conexión es
 * BYPASSRLS: es la única barrera) → `runWithRls`, con `FOR UPDATE` para que el `from` del audit sea el que se pisó y
 * sin write ni audit si no cambia nada (mismo criterio que `setPractitionerAgendaRules`).
 *
 *   • `setPractitionerPublicLead`: anticipación mínima del turnero de ESE profesional (D-CF2-8; precedencia servicio
 *     del profesional > profesional > consultorio > 60', `effectivePublicMinLead`). La edita el propio profesional o
 *     quien tenga `schedule.configure` (es la agenda del consultorio: Titular, Administrador/a, quien tenga
 *     «Configuración»). Es Configuración → `withSupportWritable` (soporte puede ayudar, como el resto de Horarios).
 *     Action aparte y no una clave más de `setPractitionerAgendaRules`: ese setter manda el form entero y su gate es
 *     solo `schedule.configure` ([CF-A4]); el propio profesional no tiene por qué poder cambiar sus pasos.
 *   • `setOwnLeadContact` / `hidePractitionerLeadContact`: el contacto dentro de la anticipación (D-CF2-9, Ley
 *     25.326). Lo carga y lo PRENDE solo el profesional del actor (nunca un id del input), con consentimiento sellado;
 *     el titular (`tenant.sensitive`) solo lo apaga. Reglas en `lib/practitioner-self-settings-logic.ts`.
 *   • `setOwnBookingNotifications`: mail / push de los turnos online propios (D-CF2-11; nacen apagados).
 *   • CF3 (§30, M22) `setOwnShowPublicPrice`: si el turnero y la sede muestran el precio del profesional (D-CF3-3;
 *     nace prendido = la conducta de antes). Solo el propio: es su precio.
 *   • CF3 `setOwnInsuredContact` / `hidePractitionerInsuredContact`: el WhatsApp del profesional para pacientes con
 *     obra social (D-CF3-5), sobre el MISMO número y consentimiento del contacto de CF2 (vigente =
 *     `LEAD_CONTACT_CONSENT_VERSION`, que PR-P sube a v2 para cubrir los dos usos). Lo prende solo el propio; el titular
 *     (`tenant.sensitive`) solo lo apaga, como `hidePractitionerLeadContact`. El CHECK `Practitioner_insuredContact_check`
 *     de M22 lo respalda en la base; la action valida antes para devolver copy y no un 500.
 *   Las tres revalidan `CLINIC_SITES_TAG` (la sede `/<slug>` cachea precios). El turnero no cachea (`getPublicClinic`).
 *
 * Soporte: el contacto y los avisos son personales del profesional (su número, su casilla, sus dispositivos), no
 * Configuración del consultorio → se rechazan con copy propio y NO van en `SUPPORT_WRITABLE_ACTIONS` (de todos modos el
 * actor de soporte nunca tiene profesional). Todas con `withReadOnlyResult`: consultorio en modo lectura → su copy y no
 * un error redactado.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { bookablePractitionerWhere, isActorPractitioner } from "@/lib/practitioner-scope";
import { withSupportWritable } from "@/lib/support-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { parsePublicMinLead } from "@/lib/agenda-rules-config";
import { CLINIC_SITES_TAG } from "@/lib/cache-tags";
import {
  SELF_SETTINGS_COPY as COPY,
  insuredContactAuditPayload,
  leadContactAuditPayload,
  planHideLeadContact,
  planInsuredContactWrite,
  planLeadContactWrite,
  type InsuredContactState,
  type LeadContactState,
} from "@/lib/practitioner-self-settings-logic";
import type { ActionResult } from "@/lib/validation";

const PractitionerId = z.string().trim().min(1).max(64);

// ─────────────────────────────────────────────────────────────────────────────
// Anticipación del turnero por profesional (D-CF2-8)
// ─────────────────────────────────────────────────────────────────────────────

export async function setPractitionerPublicLead(
  ...args: Parameters<typeof setPractitionerPublicLeadImpl>
): ReturnType<typeof setPractitionerPublicLeadImpl> {
  return withReadOnlyResult(() =>
    withSupportWritable("lib/practitioner-self-settings.ts#setPractitionerPublicLead", () =>
      setPractitionerPublicLeadImpl(...args)
    )
  );
}

async function setPractitionerPublicLeadImpl(
  practitionerId: string,
  minutes: number | string | null
): Promise<ActionResult<{ publicMinLeadMinutes: number | null }>> {
  const actor = await getActor();
  const id = PractitionerId.safeParse(practitionerId);
  if (!id.success) return { ok: false, error: COPY.notFound };
  // El valor se valida con zod solo en la forma (número, texto corto o null); el rango y el copy son los de
  // `parsePublicMinLead`, los mismos del consultorio (un CHECK que rebota en la base sale como 500 sin decir qué corregir).
  const shape = z.union([z.number(), z.string().max(16), z.null()]).safeParse(minutes);
  if (!shape.success) return { ok: false, error: COPY.invalid };
  const parsed = parsePublicMinLead(shape.data);
  if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { publicMinLeadMinutes: [parsed.error] } };
  const to = parsed.value;
  // Sin query para el propio profesional (el id viene en el Actor); las capacidades, una por request.
  if (!isActorPractitioner(actor, id.data)) {
    const caps = await capabilitiesForActor(actor);
    if (!caps.has("schedule.configure")) return { ok: false, error: COPY.leadForbidden };
  }
  const res = await runWithRls(actor.tenantId, async (tx) => {
    // Reservable (T3c-1s): un id ajeno, un suspendido o la fila vieja de la Secretaria = el mismo «no encontrado».
    const found = await tx.practitioner.findFirst({
      where: { id: id.data, ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }) },
      select: { id: true },
    });
    if (!found) return "notFound" as const;
    const [prev] = await tx.$queryRaw<{ publicMinLeadMinutes: number | null }[]>`
      SELECT "publicMinLeadMinutes" FROM "Practitioner"
       WHERE "id" = ${found.id} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (!prev) return "notFound" as const;
    if (prev.publicMinLeadMinutes === to) return "same" as const;
    await tx.practitioner.updateMany({
      where: { id: found.id, tenantId: actor.tenantId },
      data: { publicMinLeadMinutes: to },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.public_lead",
      entity: "Practitioner",
      entityId: found.id,
      payload: { from: prev.publicMinLeadMinutes, to },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") revalidatePath("/configuracion");
  return { ok: true, data: { publicMinLeadMinutes: to } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacto dentro de la anticipación (D-CF2-9)
// ─────────────────────────────────────────────────────────────────────────────

const LeadContactInput = z.object({
  contactWhatsapp: z.string().max(40).nullable(),
  show: z.boolean(),
  acceptConsent: z.boolean().optional(),
});

/**
 * `FOR UPDATE` de las 4 columnas del contacto (M21) + el switch de OS (M22, CF3): el plan del contacto lo necesita
 * para no dejar el switch de OS publicando un número cambiado o borrado (ver `planLeadContactWrite`).
 */
async function lockLeadContact(
  tx: DbClient,
  tenantId: string,
  practitionerId: string
): Promise<InsuredContactState | null> {
  const [row] = await tx.$queryRaw<InsuredContactState[]>`
    SELECT "contactWhatsapp", "showContactInLeadWindow", "contactConsentAt", "contactConsentVersion", "showContactForInsured"
      FROM "Practitioner" WHERE "id" = ${practitionerId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return row ?? null;
}

export async function setOwnLeadContact(
  ...args: Parameters<typeof setOwnLeadContactImpl>
): ReturnType<typeof setOwnLeadContactImpl> {
  return withReadOnlyResult(() => setOwnLeadContactImpl(...args));
}

async function setOwnLeadContactImpl(input: {
  contactWhatsapp: string | null;
  show: boolean;
  acceptConsent?: boolean;
}): Promise<ActionResult<{ contactWhatsapp: string | null; show: boolean }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const practitionerId = actor.practitionerId;
  if (!practitionerId) return { ok: false, error: COPY.ownOnly };
  const parsed = LeadContactInput.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const now = new Date();
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const prev = await lockLeadContact(tx, actor.tenantId, practitionerId);
    if (!prev) return { kind: "notFound" as const };
    const plan = planLeadContactWrite(prev, parsed.data, now);
    if (!plan.ok) return { kind: "invalid" as const, plan };
    if (plan.kind === "same") return { kind: "same" as const, state: prev };
    await tx.practitioner.updateMany({ where: { id: practitionerId, tenantId: actor.tenantId }, data: plan.next });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.lead_contact",
      entity: "Practitioner",
      entityId: practitionerId,
      // Nunca el número completo en el audit: solo los últimos 4 dígitos.
      payload: leadContactAuditPayload(prev, plan.next, plan.consented),
    });
    return { kind: "changed" as const, state: plan.next };
  });
  if (res.kind === "notFound") return { ok: false, error: COPY.notFound };
  if (res.kind === "invalid") {
    return { ok: false, error: res.plan.error, fieldErrors: { [res.plan.field]: [res.plan.error] } };
  }
  if (res.kind === "changed") revalidatePath("/configuracion");
  return { ok: true, data: { contactWhatsapp: res.state.contactWhatsapp, show: res.state.showContactInLeadWindow } };
}

export async function hidePractitionerLeadContact(
  ...args: Parameters<typeof hidePractitionerLeadContactImpl>
): ReturnType<typeof hidePractitionerLeadContactImpl> {
  return withReadOnlyResult(() => hidePractitionerLeadContactImpl(...args));
}

/**
 * El titular (o quien tenga `tenant.sensitive`) puede APAGAR el contacto de un profesional del consultorio, nunca
 * prenderlo ni cambiar el número (D-CF2-9: el consentimiento es del profesional). El propio profesional también puede
 * (apagar lo suyo nunca necesita permiso). Sin filtro de «reservable»: a un suspendido también se le puede apagar.
 */
async function hidePractitionerLeadContactImpl(practitionerId: string): Promise<ActionResult<{ show: false }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const id = PractitionerId.safeParse(practitionerId);
  if (!id.success) return { ok: false, error: COPY.notFound };
  if (!isActorPractitioner(actor, id.data)) {
    const caps = await capabilitiesForActor(actor);
    if (!caps.has("tenant.sensitive")) return { ok: false, error: COPY.hideForbidden };
  }
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const prev = await lockLeadContact(tx, actor.tenantId, id.data);
    if (!prev) return "notFound" as const;
    const plan = planHideLeadContact(prev);
    if (plan.kind === "same") return "same" as const;
    await tx.practitioner.updateMany({
      where: { id: id.data, tenantId: actor.tenantId },
      data: { showContactInLeadWindow: false },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.lead_contact",
      entity: "Practitioner",
      entityId: id.data,
      payload: { ...leadContactAuditPayload(prev, plan.next, false), hiddenBy: isActorPractitioner(actor, id.data) ? "self" : "admin" },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") revalidatePath("/configuracion");
  return { ok: true, data: { show: false } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Avisos de turnos online (D-CF2-11)
// ─────────────────────────────────────────────────────────────────────────────

const BookingNotificationsInput = z.object({ email: z.boolean(), push: z.boolean() }).strict();

export async function setOwnBookingNotifications(
  ...args: Parameters<typeof setOwnBookingNotificationsImpl>
): ReturnType<typeof setOwnBookingNotificationsImpl> {
  return withReadOnlyResult(() => setOwnBookingNotificationsImpl(...args));
}

async function setOwnBookingNotificationsImpl(input: {
  email: boolean;
  push: boolean;
}): Promise<ActionResult<{ email: boolean; push: boolean }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const practitionerId = actor.practitionerId;
  if (!practitionerId) return { ok: false, error: COPY.ownOnly };
  // Booleanos reales: un «"true"» o un ausente tomado como false prendería o apagaría avisos sin que nadie los toque.
  const parsed = BookingNotificationsInput.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const to = parsed.data;
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const [prev] = await tx.$queryRaw<{ notifyBookingEmail: boolean; notifyBookingPush: boolean }[]>`
      SELECT "notifyBookingEmail", "notifyBookingPush" FROM "Practitioner"
       WHERE "id" = ${practitionerId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (!prev) return "notFound" as const;
    const from = { email: prev.notifyBookingEmail, push: prev.notifyBookingPush };
    if (from.email === to.email && from.push === to.push) return "same" as const;
    await tx.practitioner.updateMany({
      where: { id: practitionerId, tenantId: actor.tenantId },
      data: { notifyBookingEmail: to.email, notifyBookingPush: to.push },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.booking_notifications",
      entity: "Practitioner",
      entityId: practitionerId,
      payload: { from, to },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") revalidatePath("/configuracion");
  return { ok: true, data: to };
}

// ─────────────────────────────────────────────────────────────────────────────
// CF3 (§30, M22): precio visible (D-CF3-3) y WhatsApp para pacientes con OS (D-CF3-5)
// ─────────────────────────────────────────────────────────────────────────────

/** Post-commit: «Mi agenda» y la sede (que cachea precios y profesionales). */
function revalidateOwnPublic(): void {
  revalidatePath("/configuracion");
  revalidateTag(CLINIC_SITES_TAG);
}

export async function setOwnShowPublicPrice(
  ...args: Parameters<typeof setOwnShowPublicPriceImpl>
): ReturnType<typeof setOwnShowPublicPriceImpl> {
  return withReadOnlyResult(() => setOwnShowPublicPriceImpl(...args));
}

async function setOwnShowPublicPriceImpl(show: boolean): Promise<ActionResult<{ showPublicPrice: boolean }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const practitionerId = actor.practitionerId;
  if (!practitionerId) return { ok: false, error: COPY.ownOnly };
  // Booleano real: un «"false"» truthy lo dejaría prendido creyendo que se apagó.
  const parsed = z.boolean().safeParse(show);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const to = parsed.data;
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const [prev] = await tx.$queryRaw<{ showPublicPrice: boolean }[]>`
      SELECT "showPublicPrice" FROM "Practitioner"
       WHERE "id" = ${practitionerId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (!prev) return "notFound" as const;
    if (prev.showPublicPrice === to) return "same" as const;
    await tx.practitioner.updateMany({ where: { id: practitionerId, tenantId: actor.tenantId }, data: { showPublicPrice: to } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.public_price",
      entity: "Practitioner",
      entityId: practitionerId,
      payload: { from: prev.showPublicPrice, to },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") revalidateOwnPublic();
  return { ok: true, data: { showPublicPrice: to } };
}

const InsuredContactInput = z.object({ show: z.boolean(), acceptConsent: z.boolean().optional() }).strict();

export async function setOwnInsuredContact(
  ...args: Parameters<typeof setOwnInsuredContactImpl>
): ReturnType<typeof setOwnInsuredContactImpl> {
  return withReadOnlyResult(() => setOwnInsuredContactImpl(...args));
}

async function setOwnInsuredContactImpl(
  show: boolean,
  opts: { acceptConsent?: boolean } = {}
): Promise<ActionResult<{ showContactForInsured: boolean }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const practitionerId = actor.practitionerId;
  if (!practitionerId) return { ok: false, error: COPY.ownOnly };
  const parsed = InsuredContactInput.safeParse({ show, ...(opts ?? {}) });
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const now = new Date();
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const prev = await lockLeadContact(tx, actor.tenantId, practitionerId);
    if (!prev) return { kind: "notFound" as const };
    const plan = planInsuredContactWrite(prev, parsed.data, now);
    if (!plan.ok) return { kind: "invalid" as const, plan };
    if (plan.kind === "same") return { kind: "same" as const, state: prev };
    await tx.practitioner.updateMany({
      where: { id: practitionerId, tenantId: actor.tenantId },
      data: {
        showContactForInsured: plan.next.showContactForInsured,
        contactConsentAt: plan.next.contactConsentAt,
        contactConsentVersion: plan.next.contactConsentVersion,
      },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.insured_contact",
      entity: "Practitioner",
      entityId: practitionerId,
      // Nunca el número completo: solo los últimos 4 dígitos.
      payload: insuredContactAuditPayload(prev, plan.next, plan.consented),
    });
    return { kind: "changed" as const, state: plan.next };
  });
  if (res.kind === "notFound") return { ok: false, error: COPY.notFound };
  if (res.kind === "invalid") {
    return { ok: false, error: res.plan.error, fieldErrors: { [res.plan.field]: [res.plan.error] } };
  }
  if (res.kind === "changed") revalidateOwnPublic();
  return { ok: true, data: { showContactForInsured: res.state.showContactForInsured } };
}

export async function hidePractitionerInsuredContact(
  ...args: Parameters<typeof hidePractitionerInsuredContactImpl>
): ReturnType<typeof hidePractitionerInsuredContactImpl> {
  return withReadOnlyResult(() => hidePractitionerInsuredContactImpl(...args));
}

/**
 * El titular (`tenant.sensitive`) APAGA el WhatsApp para OS de un profesional del consultorio; nunca lo prende (el
 * consentimiento es del profesional). Mismo criterio y mismo filtro que `hidePractitionerLeadContact`.
 */
async function hidePractitionerInsuredContactImpl(
  practitionerId: string
): Promise<ActionResult<{ showContactForInsured: false }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  const id = PractitionerId.safeParse(practitionerId);
  if (!id.success) return { ok: false, error: COPY.notFound };
  const self = isActorPractitioner(actor, id.data);
  if (!self) {
    const caps = await capabilitiesForActor(actor);
    if (!caps.has("tenant.sensitive")) return { ok: false, error: COPY.insuredHideForbidden };
  }
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const prev = await lockLeadContact(tx, actor.tenantId, id.data);
    if (!prev) return "notFound" as const;
    if (!prev.showContactForInsured) return "same" as const;
    const next = { ...prev, showContactForInsured: false };
    await tx.practitioner.updateMany({ where: { id: id.data, tenantId: actor.tenantId }, data: { showContactForInsured: false } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.insured_contact",
      entity: "Practitioner",
      entityId: id.data,
      payload: { ...insuredContactAuditPayload(prev, next, false), hiddenBy: self ? "self" : "admin" },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") revalidateOwnPublic();
  return { ok: true, data: { showContactForInsured: false } };
}
