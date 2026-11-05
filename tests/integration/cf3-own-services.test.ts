/**
 * [CF3-AUC1..9] CF3 AU-C (§30, D-CF3-3/5/6) — servicios propios del profesional y los dos switches nuevos de «Mi
 * agenda», contra Postgres en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS = prod, donde el
 * `where: { tenantId }` y el `practitionerId` del Actor son la única barrera).
 *
 * Contrato (D-CF3-6, decisión de Martin del 04-nov «Todo + crear servicios»):
 *   • un miembro clínico con `Practitioner` y SIN «Configuración» crea servicios → `Service.practitionerId = él`, y
 *     SOLO él queda habilitado (a los demás no se les habilita solo, `next-free.ts:162-185`);
 *   • edita y borra solo los suyos; los del consultorio (practitionerId null) y los de otro profesional siguen pidiendo
 *     `tenant.admin` (ForbiddenError con el copy de siempre, sin escribir); no puede pasar el suyo a compartido ni a otro;
 *   • tope de 30 servicios propios por la vía propia;
 *   • la Secretaria (sin agenda propia) no crea; el Titular con «Configuración» sigue creando y editando todo;
 *   • audit en la tx (`via: "self"` cuando entra por la vía propia) y revalidación de la sede y el directorio.
 *   • `setOwnShowPublicPrice` (D-CF3-3) y `setOwnInsuredContact` (D-CF3-5): solo el propio; el de OS exige número y el
 *     consentimiento VIGENTE; el titular solo lo apaga (`hidePractitionerInsuredContact`).
 *
 * Símbolos reales; se mockea solo la cookie (`asUser`) y `next/cache` (integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createService, deleteService, updateService } from "@/lib/services";
import { OWN_SERVICES_MAX, SERVICES_COPY } from "@/lib/services-types";
import {
  hidePractitionerInsuredContact,
  setOwnInsuredContact,
  setOwnShowPublicPrice,
} from "@/lib/practitioner-self-settings";
import { SELF_SETTINGS_COPY as COPY } from "@/lib/practitioner-self-settings-logic";
import { LEAD_CONTACT_CONSENT_VERSION } from "@/lib/public-lead-contact";
import { CLINIC_SITES_TAG, DIRECTORY_TAG } from "@/lib/cache-tags";
import { asUser } from "@/tests/helpers/actor";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ADMIN_MSG = "Solo el titular o quien tenga el permiso «Configuración» puede modificar los servicios del consultorio.";

describe.skipIf(!RUN)("[CF3-AUC] servicios propios y switches de «Mi agenda»", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let P1: { userId: string; practitionerId: string };
  let P2: { userId: string; practitionerId: string };
  let P3: { userId: string; practitionerId: string };
  let secretary: string;
  let billing: string;
  let clinicServiceId: string;
  let p2ServiceId: string;

  const svc = (id: string) => db.service.findUnique({ where: { id }, select: { name: true, priceCents: true, practitionerId: true } });
  const audits = (action: string, entityId: string) =>
    db.auditEvent.findMany({ where: { tenantId: A.tenantId, action, entityId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P1 = await addPractitioner(db, A);
    P2 = await addPractitioner(db, A);
    P3 = await addPractitioner(db, A);
    secretary = (await addStaff(db, A, "ASSISTANT")).userId;
    billing = (await addStaff(db, A, "BILLING")).userId;
    clinicServiceId = (await db.service.create({ data: { tenantId: A.tenantId, name: "Del consultorio", priceCents: 1000 } })).id;
    p2ServiceId = (
      await db.service.create({ data: { tenantId: A.tenantId, name: "De P2", priceCents: 2000, practitionerId: P2.practitionerId } })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidateTagSpy.mockClear();
  });

  it("[CF3-AUC1] el profesional sin «Configuración» crea un servicio: queda suyo, solo él habilitado, audit via self", async () => {
    asUser(P1.userId);
    const r = await createService({ name: "Osteo P1", durationMin: 50, priceCents: 1_500_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await svc(r.data.id)).toEqual({ name: "Osteo P1", priceCents: 1_500_000, practitionerId: P1.practitionerId });
    const ps = await db.practitionerService.findMany({ where: { serviceId: r.data.id }, select: { practitionerId: true, enabled: true } });
    expect(ps).toEqual([{ practitionerId: P1.practitionerId, enabled: true }]);
    const ev = await audits("service.create", r.data.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].actorId).toBe(P1.userId);
    expect(ev[0].payload).toMatchObject({ name: "Osteo P1", priceCents: 1_500_000, via: "self" });
    expect(revalidateTagSpy).toHaveBeenCalledWith(CLINIC_SITES_TAG);
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);
  });

  it("[CF3-AUC2] crear a nombre de otro profesional o «compartido» por la vía propia: rechazo sin escribir", async () => {
    asUser(P1.userId);
    await expect(createService({ name: "Hack P2", durationMin: 30, priceCents: 0, practitionerId: P2.practitionerId })).rejects.toThrow(
      SERVICES_COPY.ownOnly
    );
    await expect(createService({ name: "Hack otro tenant", durationMin: 30, priceCents: 0, practitionerId: B.practitionerId })).rejects.toThrow(
      SERVICES_COPY.ownOnly
    );
    expect(await db.service.count({ where: { name: { startsWith: "Hack" } } })).toBe(0);
  });

  it("[CF3-AUC3] edita y borra lo suyo; lo del consultorio y lo de otro profesional, no (y no lo pasa a compartido)", async () => {
    asUser(P1.userId);
    const own = await createService({ name: "Propio P1", durationMin: 30, priceCents: 100 });
    if (!own.ok) throw new Error(own.error);
    expect(await updateService(own.data.id, { priceCents: 999, name: "Propio P1 v2" })).toEqual({ ok: true, data: undefined });
    expect(await svc(own.data.id)).toEqual({ name: "Propio P1 v2", priceCents: 999, practitionerId: P1.practitionerId });
    const up = await audits("service.update", own.data.id);
    expect(up.at(-1)?.payload).toMatchObject({ via: "self", before: { priceCents: 100 }, after: { priceCents: 999 } });

    await expect(updateService(clinicServiceId, { priceCents: 1 })).rejects.toThrow(ADMIN_MSG);
    await expect(updateService(p2ServiceId, { priceCents: 1 })).rejects.toThrow(ADMIN_MSG);
    await expect(updateService(own.data.id, { practitionerId: "" })).rejects.toThrow(SERVICES_COPY.ownOnly);
    await expect(updateService(own.data.id, { practitionerId: P2.practitionerId })).rejects.toThrow(SERVICES_COPY.ownOnly);
    expect(await svc(clinicServiceId)).toMatchObject({ priceCents: 1000, practitionerId: null });
    expect(await svc(p2ServiceId)).toMatchObject({ priceCents: 2000, practitionerId: P2.practitionerId });
    expect(await svc(own.data.id)).toMatchObject({ practitionerId: P1.practitionerId });

    await expect(deleteService(clinicServiceId)).rejects.toThrow(ADMIN_MSG);
    await expect(deleteService(p2ServiceId)).rejects.toThrow(ADMIN_MSG);
    expect(await svc(clinicServiceId)).not.toBeNull();
    expect(await svc(p2ServiceId)).not.toBeNull();
    expect(await deleteService(own.data.id)).toEqual({ ok: true, data: undefined });
    expect(await svc(own.data.id)).toBeNull();
    expect(revalidateTagSpy).toHaveBeenCalledWith(CLINIC_SITES_TAG);
  });

  it("[CF3-AUC4] la Secretaria y Facturación (sin agenda propia) no crean ni editan", async () => {
    for (const u of [secretary, billing]) {
      asUser(u);
      await expect(createService({ name: "Hack staff", durationMin: 30, priceCents: 0 })).rejects.toThrow(ADMIN_MSG);
      await expect(updateService(clinicServiceId, { priceCents: 5 })).rejects.toThrow(ADMIN_MSG);
    }
    expect(await db.service.count({ where: { tenantId: A.tenantId, name: "Hack staff" } })).toBe(0);
    expect(await svc(clinicServiceId)).toMatchObject({ priceCents: 1000 });
  });

  it("[CF3-AUC5] el Titular con «Configuración» crea para otro, compartidos y edita lo de cualquiera (via config)", async () => {
    asUser(A.userId);
    const forP2 = await createService({ name: "Titular para P2", durationMin: 30, priceCents: 0, practitionerId: P2.practitionerId });
    expect(forP2.ok).toBe(true);
    const shared = await createService({ name: "Titular compartido", durationMin: 30, priceCents: 0 });
    if (!shared.ok) throw new Error(shared.error);
    expect(await svc(shared.data.id)).toMatchObject({ practitionerId: null });
    expect(await updateService(p2ServiceId, { priceCents: 2500 })).toEqual({ ok: true, data: undefined });
    expect((await audits("service.create", shared.data.id))[0].payload).not.toHaveProperty("via");
  });

  it("[CF3-AUC6] tope de servicios propios: el 31 rebota con copy y no se escribe", async () => {
    await db.service.createMany({
      data: Array.from({ length: OWN_SERVICES_MAX }, (_, i) => ({
        tenantId: A.tenantId,
        name: `Tope P3 ${i}`,
        practitionerId: P3.practitionerId,
      })),
    });
    asUser(P3.userId);
    expect(await createService({ name: "Tope P3 extra", durationMin: 30, priceCents: 0 })).toEqual({
      ok: false,
      error: SERVICES_COPY.ownLimit,
    });
    expect(await db.service.count({ where: { tenantId: A.tenantId, practitionerId: P3.practitionerId } })).toBe(OWN_SERVICES_MAX);
  });

  it("[CF3-AUC7] setOwnShowPublicPrice: el propio apaga y prende (audit); sin profesional, no", async () => {
    asUser(P1.userId);
    expect(await setOwnShowPublicPrice(false)).toEqual({ ok: true, data: { showPublicPrice: false } });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: P1.practitionerId } })).showPublicPrice).toBe(false);
    expect(await setOwnShowPublicPrice(false)).toEqual({ ok: true, data: { showPublicPrice: false } });
    const ev = await audits("practitioner.public_price", P1.practitionerId);
    expect(ev.map((e) => e.payload)).toEqual([{ from: true, to: false }]);
    expect(revalidateTagSpy).toHaveBeenCalledWith(CLINIC_SITES_TAG);
    expect(await setOwnShowPublicPrice(true)).toEqual({ ok: true, data: { showPublicPrice: true } });
    // Un no-booleano no prende ni apaga nada.
    expect(await setOwnShowPublicPrice("false" as unknown as boolean)).toEqual({ ok: false, error: COPY.invalid });

    asUser(secretary);
    expect(await setOwnShowPublicPrice(false)).toEqual({ ok: false, error: COPY.ownOnly });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: P1.practitionerId } })).showPublicPrice).toBe(true);
  });

  it("[CF3-AUC8] setOwnInsuredContact: sin número o sin consentimiento vigente, rechazo sin escribir; aceptando, sella", async () => {
    asUser(P2.userId);
    expect(await setOwnInsuredContact(true, { acceptConsent: true })).toEqual({
      ok: false,
      error: COPY.insuredNeedsPhone,
      fieldErrors: { contactWhatsapp: [COPY.insuredNeedsPhone] },
    });
    // Número cargado con un consentimiento de un texto viejo: hay que aceptar el vigente.
    await db.practitioner.update({
      where: { id: P2.practitionerId },
      data: { contactWhatsapp: "+5491155550303", contactConsentAt: new Date("2026-10-01T12:00:00Z"), contactConsentVersion: "cf3-test-old" },
    });
    expect(await setOwnInsuredContact(true)).toEqual({
      ok: false,
      error: COPY.insuredConsentRequired,
      fieldErrors: { acceptConsent: [COPY.insuredConsentRequired] },
    });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: P2.practitionerId } })).showContactForInsured).toBe(false);

    expect(await setOwnInsuredContact(true, { acceptConsent: true })).toEqual({ ok: true, data: { showContactForInsured: true } });
    const row = await db.practitioner.findUniqueOrThrow({ where: { id: P2.practitionerId } });
    expect(row).toMatchObject({ showContactForInsured: true, contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION });
    const ev = await audits("practitioner.insured_contact", P2.practitionerId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ from: { show: false }, to: { show: true }, phone: "…0303", consentVersion: LEAD_CONTACT_CONSENT_VERSION });
    expect(JSON.stringify(ev[0].payload)).not.toContain("5491155550303");
    expect(revalidateTagSpy).toHaveBeenCalledWith(CLINIC_SITES_TAG);

    asUser(secretary);
    expect(await setOwnInsuredContact(true, { acceptConsent: true })).toEqual({ ok: false, error: COPY.ownOnly });
  });

  it("[CF3-AUC9] hidePractitionerInsuredContact: otro profesional no; el Titular solo apaga", async () => {
    asUser(P1.userId);
    expect(await hidePractitionerInsuredContact(P2.practitionerId)).toEqual({ ok: false, error: COPY.insuredHideForbidden });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: P2.practitionerId } })).showContactForInsured).toBe(true);
    asUser(A.userId);
    expect(await hidePractitionerInsuredContact(B.practitionerId)).toEqual({ ok: false, error: COPY.notFound });
    expect(await hidePractitionerInsuredContact(P2.practitionerId)).toEqual({ ok: true, data: { showContactForInsured: false } });
    const row = await db.practitioner.findUniqueOrThrow({ where: { id: P2.practitionerId } });
    // Apagar conserva el número y el sello (como el contacto de CF2).
    expect(row).toMatchObject({ showContactForInsured: false, contactWhatsapp: "+5491155550303" });
    const ev = await audits("practitioner.insured_contact", P2.practitionerId);
    expect(ev.at(-1)?.payload).toMatchObject({ to: { show: false }, hiddenBy: "admin" });
  });

  it("[CF3-AUC10] loader «Mi agenda»: los switches propios tal cual están en la base y el link propio (D-CF3-12)", async () => {
    await db.practitioner.update({ where: { id: P1.practitionerId }, data: { showPublicPrice: false, publicBookingEnabled: false } });
    asUser(P1.userId);
    const actor = await getActor();
    const r = await loadConfiguracionPage(actor, await capabilitiesForActor(actor));
    expect(r.miAgenda).toMatchObject({
      practitionerId: P1.practitionerId,
      showPublicPrice: false,
      showContactForInsured: false,
      ownPublicBookingEnabled: false,
      tenantSlug: A.slug,
      bookingUrl: `/c/${A.slug}/booking?pro=${P1.practitionerId}`,
    });
    expect(JSON.stringify(r.miAgenda)).not.toContain(P2.practitionerId);
    await db.practitioner.update({ where: { id: P1.practitionerId }, data: { showPublicPrice: true, publicBookingEnabled: true } });
  });
  it("[CF3-AUC11] cambiar el precio de un servicio propio desde «Editar» limpia el override viejo de su fila", async () => {
    asUser(P1.userId);
    const r = await createService({ name: "RPG P1 override", durationMin: 45, priceCents: 1_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Un precio cargado antes en la fila (PractitionerService) ganaría en la escalera y el Drawer no tendría efecto.
    await db.practitionerService.updateMany({ where: { serviceId: r.data.id, practitionerId: P1.practitionerId }, data: { priceCents: 900_000 } });
    const u = await updateService(r.data.id, { name: "RPG P1 override", durationMin: 45, priceCents: 1_200_000 });
    expect(u.ok).toBe(true);
    expect((await svc(r.data.id))?.priceCents).toBe(1_200_000);
    const row = await db.practitionerService.findFirst({ where: { serviceId: r.data.id, practitionerId: P1.practitionerId }, select: { priceCents: true } });
    expect(row?.priceCents).toBeNull();
  });
});

/**
 * [CF3-SV1..6] CF3b, sesión SV (decisión de Martin del 05-nov, reemplaza D-CF3-6): el Titular y los profesionales crean
 * servicios del consultorio o propios con el checkbox «Para todo el consultorio» (`forClinic` en `createService`).
 *   • por la vía propia (sin «Configuración»), marcado → `Service.practitionerId = null`; el creador queda habilitado y
 *     PUBLIC, el resto de los profesionales habilitados pero PRIVATE (se da en la agenda; en el turnero de cada uno
 *     aparece recién si cada uno lo publica). Después lo edita y borra solo quien tiene «Configuración»;
 *   • con «Configuración»: marcado → del consultorio (todos PUBLIC, como siempre), desmarcado → del propio usuario si
 *     atiende, o del profesional elegido; sin agenda propia, siempre del consultorio;
 *   • el tope de `OWN_SERVICES_MAX` cuenta solo los propios; audit con `scope: "clinic" | "own"` en la tx.
 * Tenant propio (C): no depende del orden de los [CF3-AUC*] de arriba.
 */
describe.skipIf(!RUN)("[CF3-SV] «Para todo el consultorio» al crear un servicio", () => {
  let db: PrismaClient;
  let C: EphemeralTenant;
  let P1: { userId: string; practitionerId: string };
  let P2: { userId: string; practitionerId: string };
  let secretary: string;
  let secretaryConfig: string;

  const svc = (id: string) => db.service.findUnique({ where: { id }, select: { name: true, priceCents: true, practitionerId: true } });
  const rowsOf = (serviceId: string) =>
    db.practitionerService.findMany({
      where: { serviceId },
      select: { practitionerId: true, enabled: true, visibility: true },
      orderBy: { practitionerId: "asc" },
    });
  const byPrac = (rows: { practitionerId: string; enabled: boolean; visibility: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.practitionerId, { enabled: r.enabled, visibility: r.visibility }]));
  const createAudit = async (entityId: string) =>
    (await db.auditEvent.findMany({ where: { tenantId: C.tenantId, action: "service.create", entityId } })).map((e) => e.payload);

  beforeAll(async () => {
    db = ownerClient();
    C = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P1 = await addPractitioner(db, C);
    P2 = await addPractitioner(db, C);
    secretary = (await addStaff(db, C, "ASSISTANT")).userId;
    secretaryConfig = (await addStaff(db, C, "ASSISTANT", { grantSettings: true })).userId;
  }, 60_000);

  afterAll(async () => {
    await C?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidateTagSpy.mockClear();
  });

  it("[CF3-SV1] el profesional sin «Configuración» lo crea para todo el consultorio: sin dueño, él PUBLIC y los demás PRIVATE", async () => {
    asUser(P1.userId);
    const r = await createService({ name: "SV compartido P1", durationMin: 45, priceCents: 1_000_000, forClinic: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await svc(r.data.id)).toEqual({ name: "SV compartido P1", priceCents: 1_000_000, practitionerId: null });
    // Todos los profesionales aceptados quedan habilitados (se puede dar en la agenda), pero solo el creador en el
    // turnero: a un colega no se le publica un servicio que no decidió. La Secretaria no atiende: sin fila.
    expect(byPrac(await rowsOf(r.data.id))).toEqual({
      [P1.practitionerId]: { enabled: true, visibility: "PUBLIC" },
      [P2.practitionerId]: { enabled: true, visibility: "PRIVATE" },
      [C.practitionerId]: { enabled: true, visibility: "PRIVATE" },
    });
    expect(await createAudit(r.data.id)).toEqual([
      { name: "SV compartido P1", priceCents: 1_000_000, scope: "clinic", via: "self" },
    ]);
    expect(revalidateTagSpy).toHaveBeenCalledWith(CLINIC_SITES_TAG);
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);
  });

  it("[CF3-SV2] desmarcado por la vía propia sigue siendo suyo; marcado con otro profesional en el input: rechazo sin escribir", async () => {
    asUser(P1.userId);
    const own = await createService({ name: "SV propio P1", durationMin: 30, priceCents: 500, forClinic: false });
    if (!own.ok) throw new Error(own.error);
    expect(await svc(own.data.id)).toMatchObject({ practitionerId: P1.practitionerId });
    expect(byPrac(await rowsOf(own.data.id))).toEqual({ [P1.practitionerId]: { enabled: true, visibility: "PUBLIC" } });
    expect(await createAudit(own.data.id)).toEqual([{ name: "SV propio P1", priceCents: 500, scope: "own", via: "self" }]);
    // Un input armado a mano que mezcla el checkbox con el profesional de otro: el contrato de siempre (ownOnly).
    await expect(
      createService({ name: "SV hack mezcla", durationMin: 30, priceCents: 0, forClinic: true, practitionerId: P2.practitionerId })
    ).rejects.toThrow(SERVICES_COPY.ownOnly);
    // Un no-booleano no decide el alcance.
    const bad = await createService({ name: "SV hack tipo", durationMin: 30, priceCents: 0, forClinic: "true" as unknown as boolean });
    expect(bad.ok).toBe(false);
    expect(await db.service.count({ where: { tenantId: C.tenantId, name: { startsWith: "SV hack" } } })).toBe(0);
  });

  it("[CF3-SV3] el creador por la vía propia NO edita ni borra el compartido después; quien tiene «Configuración», sí", async () => {
    asUser(P1.userId);
    const r = await createService({ name: "SV compartido a editar", durationMin: 45, priceCents: 700, forClinic: true });
    if (!r.ok) throw new Error(r.error);
    await expect(updateService(r.data.id, { priceCents: 1 })).rejects.toThrow(ADMIN_MSG);
    await expect(updateService(r.data.id, { practitionerId: P1.practitionerId })).rejects.toThrow(ADMIN_MSG);
    await expect(deleteService(r.data.id)).rejects.toThrow(ADMIN_MSG);
    expect(await svc(r.data.id)).toEqual({ name: "SV compartido a editar", priceCents: 700, practitionerId: null });

    asUser(C.userId);
    expect(await updateService(r.data.id, { priceCents: 800 })).toEqual({ ok: true, data: undefined });
    expect(await deleteService(r.data.id)).toEqual({ ok: true, data: undefined });
    expect(await svc(r.data.id)).toBeNull();
  });

  it("[CF3-SV4] el Titular: desmarcado → suyo (o del elegido), marcado → del consultorio aunque venga un profesional", async () => {
    asUser(C.userId);
    const mine = await createService({ name: "SV propio Titular", durationMin: 30, priceCents: 900, forClinic: false });
    if (!mine.ok) throw new Error(mine.error);
    expect(await svc(mine.data.id)).toMatchObject({ practitionerId: C.practitionerId });
    expect(byPrac(await rowsOf(mine.data.id))).toEqual({ [C.practitionerId]: { enabled: true, visibility: "PUBLIC" } });
    // Por «Configuración» el audit queda como antes (sin `via`), con el alcance.
    expect(await createAudit(mine.data.id)).toEqual([{ name: "SV propio Titular", priceCents: 900, scope: "own" }]);

    // El checkbox gana en el alta: marcado = del consultorio aunque el selector traiga a P2; todos PUBLIC (decisión 7).
    const shared = await createService({ name: "SV Titular compartido", durationMin: 30, priceCents: 0, forClinic: true, practitionerId: P2.practitionerId });
    if (!shared.ok) throw new Error(shared.error);
    expect(await svc(shared.data.id)).toMatchObject({ practitionerId: null });
    expect(byPrac(await rowsOf(shared.data.id))).toEqual({
      [C.practitionerId]: { enabled: true, visibility: "PUBLIC" },
      [P1.practitionerId]: { enabled: true, visibility: "PUBLIC" },
      [P2.practitionerId]: { enabled: true, visibility: "PUBLIC" },
    });
    expect(await createAudit(shared.data.id)).toEqual([{ name: "SV Titular compartido", priceCents: 0, scope: "clinic" }]);

    // Desmarcado con el selector en otro profesional: de ese (el selector de siempre).
    const forP2 = await createService({ name: "SV Titular para P2", durationMin: 30, priceCents: 0, forClinic: false, practitionerId: P2.practitionerId });
    if (!forP2.ok) throw new Error(forP2.error);
    expect(await svc(forP2.data.id)).toMatchObject({ practitionerId: P2.practitionerId });

    // Sin el campo (cliente de antes): "" = del consultorio, como siempre.
    const legacy = await createService({ name: "SV Titular legado", durationMin: 30, priceCents: 0, practitionerId: "" });
    if (!legacy.ok) throw new Error(legacy.error);
    expect(await svc(legacy.data.id)).toMatchObject({ practitionerId: null });
  });

  it("[CF3-SV5] la Secretaria sin «Configuración» no crea; con «Configuración» y sin agenda propia, siempre del consultorio", async () => {
    asUser(secretary);
    for (const forClinic of [true, false]) {
      await expect(createService({ name: "SV hack secretaria", durationMin: 30, priceCents: 0, forClinic })).rejects.toThrow(ADMIN_MSG);
    }
    expect(await db.service.count({ where: { tenantId: C.tenantId, name: "SV hack secretaria" } })).toBe(0);

    asUser(secretaryConfig);
    const r = await createService({ name: "SV de la secretaria", durationMin: 30, priceCents: 0, forClinic: false });
    if (!r.ok) throw new Error(r.error);
    expect(await svc(r.data.id)).toMatchObject({ practitionerId: null });
    expect(await createAudit(r.data.id)).toEqual([{ name: "SV de la secretaria", priceCents: 0, scope: "clinic" }]);
  });

  it("[CF3-SV6] el tope cuenta solo los propios: con el máximo, el compartido entra; los compartidos no suman al tope", async () => {
    // P2 ya puede tener alguno (el Titular le creó uno en [CF3-SV4]): se completa hasta quedar a uno del tope.
    const already = await db.service.count({ where: { tenantId: C.tenantId, practitionerId: P2.practitionerId } });
    await db.service.createMany({
      data: Array.from({ length: OWN_SERVICES_MAX - 1 - already }, (_, i) => ({
        tenantId: C.tenantId,
        name: `SV tope P2 ${i}`,
        practitionerId: P2.practitionerId,
      })),
    });
    asUser(P2.userId);
    const shared = await createService({ name: "SV tope compartido 1", durationMin: 30, priceCents: 0, forClinic: true });
    expect(shared.ok).toBe(true);
    // El compartido no se contó: el 30.º propio entra.
    const last = await createService({ name: "SV tope propio 30", durationMin: 30, priceCents: 0, forClinic: false });
    expect(last.ok).toBe(true);
    expect(await createService({ name: "SV tope propio 31", durationMin: 30, priceCents: 0 })).toEqual({
      ok: false,
      error: SERVICES_COPY.ownLimit,
    });
    // Con el tope lleno, para todo el consultorio sigue pudiendo.
    const shared2 = await createService({ name: "SV tope compartido 2", durationMin: 30, priceCents: 0, forClinic: true });
    expect(shared2.ok).toBe(true);
    expect(await db.service.count({ where: { tenantId: C.tenantId, practitionerId: P2.practitionerId } })).toBe(OWN_SERVICES_MAX);
  });
});
