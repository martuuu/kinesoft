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
