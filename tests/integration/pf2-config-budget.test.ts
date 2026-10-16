/**
 * [PF2-d] `/configuracion` en ≤ 3 transacciones (C-PF8, brief PF §2.4) sin cambiar ningún resultado.
 *
 * Qué se fija, sobre el loader REAL que llama la página (`loadConfiguracionPage(actor, caps)`, mismos argumentos:
 * el actor de `getActor()` y las capacidades de `capabilitiesForActor`, que es lo que hace `getCapabilities()`):
 *   1. Presupuesto: el Titular (todas las pestañas + «Plan y uso» + Facturación) abre ≤ 3 tx: 1 de Configuración y
 *      las 2 de los lectores de plata de PL (`getTenantPlanUsage`, `getBillingOverview`), que no se reescriben.
 *      Quien no tiene «Planes y pagos» (ADMIN con «Configuración») o un Profesional sin delegaciones: 1 tx.
 *   2. Igualdad: cada lista sale IGUAL que el lector de siempre (`listInsurers`, `listServicesWithCounts`,
 *      `listTeamMembers`, `listPendingInvitations`, `getTenantSettings`, `listCustomConditions`,
 *      `listLocations({ includeArchived })`, `getPractitionerScheduleSummary`, `listRooms({ includeArchived })`,
 *      `listSupportSessionsForTenant`). Se compara contra los símbolos reales, no contra una copia: si alguien cambia
 *      un lector y no la variante en tx (o al revés), esto se pone rojo.
 *   3. Aislamiento: nada de otro consultorio se cuela (en el rol owner BYPASSRLS el `where: { tenantId }` a mano es
 *      la única barrera).
 *   4. [DIR-3c] Con `DIRECTORY_MODE=preview` la pestaña «Directorio» y las especialidades entran en la MISMA tx (el
 *      Titular sigue en ≤ 3) + una lectura del canal service sin tx (estado del perfil, SERVICE_ONLY); estados por
 *      profesional; sin `userId`, email ni datos del perfil personal en lo que viaja; nada del otro consultorio; y con
 *      `off` (default) no se lee nada del directorio.
 *
 * `@/lib/db` se instrumenta con `installQueryCounter` (solo un listener de `query`); el loader corre tal cual.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { getActor } from "@/lib/session";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { cookies } from "next/headers";
import { uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { capabilitiesForActor } from "@/lib/authz";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { getTenantSettings } from "@/lib/tenant-settings";
import { listInsurers } from "@/lib/insurers";
import { listServicesWithCounts } from "@/lib/services";
import { listTeamMembers, listPendingInvitations } from "@/lib/invitations";
import { listCustomConditions } from "@/lib/conditions";
import { listLocations } from "@/lib/locations";
import { listRooms } from "@/lib/rooms";
import { getPractitionerScheduleSummary } from "@/lib/practitioner-schedule";
import { listSupportSessionsForTenant } from "@/lib/platform-support";

// [DIR-3c] Entrar como soporte pide el step-up de 2FA; se da por hecho (el corte real lo prueba two-factor.test.ts).
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Fechas a string como las ve el cliente (props serializadas): la igualdad es de lo que viaja. */
const plain = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe.skipIf(!RUN)("[PF2-d] /configuracion: presupuesto de tx e igualdad con los lectores", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  let practitionerUserId: string;
  let adminUserId: string;

  async function seed(t: EphemeralTenant, tag: string) {
    const loc = await db.location.create({ data: { tenantId: t.tenantId, name: `Sede ${tag}`, isPrimary: true } });
    const archived = await db.location.create({ data: { tenantId: t.tenantId, name: `Vieja ${tag}`, active: false } });
    const room = await db.room.create({ data: { tenantId: t.tenantId, locationId: loc.id, name: `Consultorio ${tag}` } });
    await db.room.create({ data: { tenantId: t.tenantId, locationId: archived.id, name: `Archivada ${tag}`, active: false } });
    await db.practitionerSchedule.create({
      data: { tenantId: t.tenantId, practitionerId: t.practitionerId, locationId: loc.id, roomId: room.id, dow: 1, startMin: 540, endMin: 780 },
    });
    // Vencida: no cuenta en el resumen ni en el `scheduleCount` de la sala.
    await db.practitionerSchedule.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: t.practitionerId,
        locationId: loc.id,
        roomId: room.id,
        dow: 3,
        startMin: 600,
        endMin: 720,
        validUntil: new Date(Date.now() - 30 * DAY),
      },
    });
    await db.condition.create({ data: { slug: `pf2d-${randomBytes(5).toString("hex")}`, name: `Lumbalgia ${tag}`, tenantId: t.tenantId } });
    await db.insurer.create({ data: { tenantId: t.tenantId, name: `OSDE ${tag}`, copagoCents: 150000, active: false } });
    const inv = await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email: `inv-${randomBytes(4).toString("hex")}@test.local`,
        firstName: "Inv",
        lastName: tag,
        role: "PRACTITIONER",
        token: randomBytes(16).toString("hex"),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + 7 * DAY),
      },
    });
    await db.emailLog.create({
      data: {
        tenantId: t.tenantId,
        kind: "staff_invite",
        entity: "Invitation",
        entityId: inv.id,
        toHash: randomBytes(32).toString("hex"),
        toMasked: "i***@test.local",
        status: "sent",
        transport: "resend",
      },
    });
    await db.supportSession.create({
      data: { tenantId: t.tenantId, superadminId: t.userId, reason: `Ayuda con la agenda ${tag}`, endedAt: new Date() },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    // Clínica: salas prendidas; Kinesiología (default de la base): diagnóstico prendido.
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    U = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    practitionerUserId = (await addPractitioner(db, T, "PRACTITIONER")).userId;
    adminUserId = (await addPractitioner(db, T, "ADMIN")).userId;
    await seed(T, "T");
    await seed(U, "U");
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of [T, U]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  async function load(userId: string) {
    asUser(userId);
    const actor = await getActor();
    const caps = await capabilitiesForActor(actor);
    return measure(() => loadConfiguracionPage(actor, caps));
  }

  it("Titular: ≤ 3 tx (1 de Configuración + las 2 de plata de PL) y todas las pestañas iguales a sus lectores", async () => {
    const { result: r, m } = await load(T.userId);
    console.info(`[PF2-d] /configuracion Titular: ${m.transactions} tx · ${m.statements} sentencias · ${m.dbMs} ms DB`);
    expect(m.transactions).toBeLessThanOrEqual(3);

    asUser(T.userId);
    const [settings, insurers, services, team, pending, conditions, locations, summary, rooms, support] =
      await Promise.all([
        getTenantSettings(),
        listInsurers(),
        listServicesWithCounts(),
        listTeamMembers(),
        listPendingInvitations(),
        listCustomConditions(),
        listLocations({ includeArchived: true }),
        getPractitionerScheduleSummary(),
        listRooms({ includeArchived: true }),
        listSupportSessionsForTenant(),
      ]);
    expect(plain(r.tenant)).toEqual(plain(settings));
    expect(plain(r.insurers)).toEqual(plain(insurers));
    expect(plain(r.services)).toEqual(plain(services));
    expect(plain(r.team)).toEqual(plain(team));
    expect(plain(r.pending)).toEqual(plain(pending));
    expect(plain(r.customConditions)).toEqual(plain(conditions));
    expect(plain(r.locations)).toEqual(plain(locations));
    expect(plain(r.scheduleSummary)).toEqual(plain(summary));
    expect(plain(r.rooms)).toEqual(plain(rooms));
    expect(plain(r.supportSessions)).toEqual(plain(support));
    // Los pickers de profesionales: los mismos (y en el mismo orden) que el resumen de horarios.
    expect(r.practitioners).toEqual(summary.map((s) => ({ id: s.practitionerId, name: s.name })));
    expect(r.planUsage).not.toBeNull();
    expect(r.billingOverview).not.toBeNull();

    // Fixture no trivial: si una lista viniera vacía, la igualdad no diría nada.
    expect(insurers.length).toBe(2);
    expect(team.length).toBe(3);
    expect(pending.length).toBe(1);
    expect(pending[0].lastEmail).not.toBeNull();
    expect(conditions.length).toBe(1);
    expect(locations.map((l) => l.active)).toEqual([true, false]);
    expect(rooms.length).toBe(2);
    expect(rooms.find((x) => x.active)?.scheduleCount).toBe(1);
    expect(summary.find((s) => s.practitionerId === T.practitionerId)?.rangeCount).toBe(1);
    expect(support.length).toBe(1);

    // Aislamiento: nada de U (los nombres de U terminan en « U»).
    const blob = JSON.stringify(r);
    expect(blob).not.toContain(U.tenantId);
    expect(blob).not.toMatch(/(Sede|Vieja|Consultorio|Archivada|Lumbalgia|OSDE) U"/);
    expect(blob).not.toContain("agenda U");
  });

  it("ADMIN con «Configuración» y sin «Planes y pagos»: 1 tx, sin plan ni facturación", async () => {
    const { result: r, m } = await load(adminUserId);
    console.info(`[PF2-d] /configuracion ADMIN: ${m.transactions} tx · ${m.statements} sentencias`);
    expect(m.transactions).toBeLessThanOrEqual(1);
    expect(r.planUsage).toBeNull();
    expect(r.billingOverview).toBeNull();
    expect(r.catalog).toEqual([]);
    expect(r.tenant?.slug).toBe(T.slug);
    expect(r.team?.length).toBe(3);
  });

  it("Profesional sin delegaciones: 1 tx y solo «Accesos de soporte»", async () => {
    const { result: r, m } = await load(practitionerUserId);
    expect(m.transactions).toBeLessThanOrEqual(1);
    expect(r.tenant).toBeNull();
    expect(r.team).toBeNull();
    expect(r.pending).toBeNull();
    for (const k of ["insurers", "services", "practitioners", "customConditions", "locations", "scheduleSummary", "rooms"] as const) {
      expect(r[k]).toEqual([]);
    }
    expect(r.planUsage).toBeNull();
    asUser(practitionerUserId);
    expect(plain(r.supportSessions)).toEqual(plain(await listSupportSessionsForTenant()));
    expect(r.supportSessions?.length).toBe(1);
  });
});

describe.skipIf(!RUN)("[DIR-3c] /configuracion: pestaña «Directorio» dentro de la tx de PF2", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  let published: { userId: string; practitionerId: string };
  let hidden: { userId: string; practitionerId: string };
  let withdrawn: { userId: string; practitionerId: string };
  const specialtyIds: string[] = [];
  let archivedSpecialtyId = "";
  let prevMode: string | undefined;
  let serviceOff = -1;

  beforeAll(async () => {
    prevMode = process.env.DIRECTORY_MODE;
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    U = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    published = await addPractitioner(db, T, "PRACTITIONER");
    hidden = await addPractitioner(db, T, "PRACTITIONER");
    withdrawn = await addPractitioner(db, T, "PRACTITIONER");
    const now = new Date();
    await db.tenant.update({
      where: { id: T.tenantId },
      data: {
        directoryListed: true,
        directoryListedAt: now,
        publicDescription: "Kinesiología deportiva en el centro.",
        directoryHiddenAt: now,
        directoryHiddenReason: "Datos de contacto incompletos",
        directoryHiddenById: T.userId,
        publicBookingEnabled: true,
      },
    });
    await db.practitioner.update({ where: { id: published.practitionerId }, data: { publicBookingEnabled: true } });
    await db.practitioner.update({ where: { id: hidden.practitionerId }, data: { publicBookingEnabled: false } });
    const consent = { consentAt: now, consentVersion: "2026-10-v1" };
    await db.professionalPublicProfile.create({
      data: { userId: published.userId, publicName: "Lic. Publicada DIR3C", listed: true, ...consent, licenseKind: "MN", licenseNumber: "DIR3C-777" },
    });
    await db.professionalPublicProfile.create({
      data: { userId: hidden.userId, publicName: "Oculta DIR3C", listed: true, ...consent, hiddenAt: now, hiddenReason: "Matrícula dudosa", hiddenById: T.userId },
    });
    await db.professionalPublicProfile.create({
      data: { userId: withdrawn.userId, publicName: "Retirada DIR3C", listed: false, ...consent, consentWithdrawnAt: now },
    });
    // Del otro consultorio: publicado (no tiene que verse desde T).
    await db.professionalPublicProfile.create({ data: { userId: U.userId, publicName: "Ajena DIR3C", listed: true, ...consent } });
    const src = { aliases: [], source: "CURATED" as const, sourceDate: new Date("2026-09-01") };
    for (const n of ["A", "B"]) {
      const sfx = uniqueSuffix();
      specialtyIds.push((await db.specialty.create({ data: { slug: `dir3c-${sfx}`, name: `Esp DIR3C ${n} ${sfx}`, matchKey: `dir3c ${sfx}`, ...src } })).id);
    }
    const sfx = uniqueSuffix();
    archivedSpecialtyId = (
      await db.specialty.create({
        data: { slug: `dir3c-arch-${sfx}`, name: `Archivada DIR3C ${sfx}`, matchKey: `dir3c arch ${sfx}`, archivedAt: new Date(), ...src },
      })
    ).id;
    await db.practitionerSpecialty.createMany({
      data: [
        { tenantId: T.tenantId, practitionerId: published.practitionerId, specialtyId: specialtyIds[0] },
        { tenantId: T.tenantId, practitionerId: published.practitionerId, specialtyId: archivedSpecialtyId },
        { tenantId: U.tenantId, practitionerId: U.practitionerId, specialtyId: specialtyIds[1] },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
    else process.env.DIRECTORY_MODE = prevMode;
    if (db) {
      const ids = [...specialtyIds, archivedSpecialtyId].filter(Boolean);
      await db.practitionerSpecialty.deleteMany({ where: { specialtyId: { in: ids } } });
      for (const t of [T, U]) await t?.cleanup();
      await db.specialty.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  });

  async function load(userId: string) {
    asUser(userId);
    const actor = await getActor();
    const caps = await capabilitiesForActor(actor);
    return measure(() => loadConfiguracionPage(actor, caps));
  }

  it("modo off (default): sin pestaña ni lecturas del directorio", async () => {
    delete process.env.DIRECTORY_MODE;
    const { result: r, m } = await load(T.userId);
    expect(r.directory).toBeNull();
    // El resto de la página ya usa el canal service (catálogo de planes, acceso): se compara contra preview.
    serviceOff = m.byClient.service;
  });

  it("modo preview, Titular: ≤ 3 tx, 1 lectura service sin tx, estados, moderación y especialidades vigentes", async () => {
    process.env.DIRECTORY_MODE = "preview";
    const { result: r, m } = await load(T.userId);
    console.info(`[DIR-3c] /configuracion Titular (preview): ${m.transactions} tx · ${m.statements} sentencias`);
    expect(m.transactions).toBeLessThanOrEqual(3);
    // Exactamente UNA sentencia más por el canal service (el estado de los perfiles, SERVICE_ONLY), sin tx propia.
    expect(serviceOff).toBeGreaterThanOrEqual(0);
    expect(m.byClient.service).toBe(serviceOff + 1);
    const d = r.directory!;
    expect(d).not.toBeNull();
    expect(d.mode).toBe("preview");
    expect(d.slug).toBe(T.slug);
    expect(d.listed).toBe(true);
    expect(d.description).toBe("Kinesiología deportiva en el centro.");
    expect(d.hidden?.reason).toBe("Datos de contacto incompletos");
    expect(d.turneroOn).toBe(true);
    const by = Object.fromEntries(d.practitioners.map((p) => [p.practitionerId, p]));
    expect(by[published.practitionerId]).toMatchObject({ status: "published", inTurnero: true });
    expect(by[hidden.practitionerId]).toMatchObject({ status: "hidden", inTurnero: false });
    expect(by[withdrawn.practitionerId]?.status).toBe("none");
    expect(by[T.practitionerId]?.status).toBe("none"); // el Titular: sin perfil
    // Mismo orden y nombres que los pickers (sin email: decisión 19).
    expect(d.practitioners.map((p) => ({ id: p.practitionerId, name: p.name }))).toEqual(r.practitioners);
    // Especialidades: la archivada no se ofrece ni se cuenta como asignada.
    expect(d.specialtyCatalog.map((c) => c.id)).toEqual(expect.arrayContaining(specialtyIds));
    expect(d.specialtyCatalog.map((c) => c.id)).not.toContain(archivedSpecialtyId);
    expect(d.specialtiesByPractitioner[published.practitionerId]).toEqual([specialtyIds[0]]);
    // `tenant` sigue siendo exactamente `getTenantSettings` (los campos del directorio no se cuelan).
    asUser(T.userId);
    expect(plain(r.tenant)).toEqual(plain(await getTenantSettings()));

    // Privacidad y aislamiento: ni userIds, ni emails, ni datos del perfil personal, ni nada de U.
    const blob = JSON.stringify(d);
    for (const id of [T.userId, published.userId, hidden.userId, withdrawn.userId, U.userId]) expect(blob).not.toContain(id);
    expect(blob).not.toContain("@");
    expect(blob).not.toMatch(/DIR3C-777|Publicada DIR3C|Matrícula dudosa|Ajena DIR3C/);
    expect(blob).not.toContain(U.practitionerId);
    expect(Object.keys(d.specialtiesByPractitioner)).not.toContain(U.practitionerId);
  });

  it("soporte la lee (solo lectura en la UI) y un Profesional sin delegaciones no", async () => {
    process.env.DIRECTORY_MODE = "public";
    const pro = await load(published.userId);
    expect(pro.result.directory).toBeNull();

    // Plataforma «como soporte»: `SUPPORT_CAPS` trae `tenant.admin`, así que ve la pestaña (las actions lo rechazan,
    // tests/integration/directory-settings.test.ts). Admin de Plataforma en un consultorio aparte, como allá.
    const H = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    try {
      cookies().delete(SUPPORT_COOKIE);
      asUser(H.userId);
      const started = await startSupport(T.tenantId, "Revisar el directorio (DIR-3c)");
      if (!started.ok) throw new Error(started.error);
      const actor = await getActor();
      expect(actor.support).toBeTruthy();
      const caps = await capabilitiesForActor(actor);
      const r = await loadConfiguracionPage(actor, caps);
      expect(r.directory?.mode).toBe("public");
      expect(r.directory?.practitioners.length).toBe(4);
    } finally {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
      await H.cleanup();
    }
  });
});
