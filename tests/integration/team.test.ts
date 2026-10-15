/**
 * Equipo y montos de configuración (A2b-S-cfg, 2026-09-30).
 *
 * - `removeMember` rechaza (con conteo) mientras el profesional tenga turnos
 *   futuros activos o pacientes asignados sin archivar, y no borra nada;
 * - `listPractitioners` lista solo profesionales con membresía aceptada: el
 *   removido (cuya fila Practitioner queda por historial) ya no aparece;
 * - quitar / cambiar de rol invalidan el tag `practitioners`;
 * - `updateService` / `updateInsurer` dejan audit antes/después de nombre y
 *   montos (solo lo que cambió).
 *
 * Llama a las actions REALES con getActor real (tests/helpers/actor.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  removeMember,
  changeMemberRole,
  createInvitation,
  resendInvitation,
  regenerateInvitationUrl,
  revokeInvitation,
  listPendingInvitations,
  listTeamMembers,
} from "@/lib/invitations";
import { ForbiddenError } from "@/lib/session";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { listPractitioners } from "@/lib/bookings";
import { updateService } from "@/lib/services";
import { updateInsurer } from "@/lib/insurers";
import { tags } from "@/lib/cache-tags";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("equipo · baja de profesional y listPractitioners", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId }, select: { id: true } });

  const addBooking = (practitionerId: string, at: Date, status: "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED" = "CONFIRMED") =>
    db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId,
        serviceId: A.serviceId,
        scheduledFor: at,
        durationMin: 45,
        status,
        idempotencyKey: randomUUID(),
      },
    });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    asUser(A.userId);
    revalidateTagSpy.mockClear();
  });

  it("rechaza quitar a un profesional con turnos futuros activos, con conteo, y no borra nada", async () => {
    const kine = await addPractitioner(db, A);
    await addBooking(kine.practitionerId, new Date(Date.now() + 2 * DAY));
    await addBooking(kine.practitionerId, new Date(Date.now() + 3 * DAY), "PENDING");
    // Estos no cuentan: pasado, cancelado futuro.
    await addBooking(kine.practitionerId, new Date(Date.now() - 2 * DAY), "COMPLETED");
    await addBooking(kine.practitionerId, new Date(Date.now() + 4 * DAY), "CANCELLED");
    const mem = await membershipOf(A, kine.userId);

    const r = await removeMember(mem.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("2 turnos futuros");
      expect(r.error).toContain("Reasignalos primero");
    }
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(1);
    expect((await listPractitioners()).map((p) => p.id)).toContain(kine.practitionerId);
    expect(revalidateTagSpy).not.toHaveBeenCalledWith(tags.practitioners(A.tenantId));
  });

  it("rechaza quitar a un profesional con pacientes asignados (los archivados no cuentan)", async () => {
    const kine = await addPractitioner(db, A);
    await addPatient(db, A, { assignedPractitionerId: kine.practitionerId });
    const archived = await addPatient(db, A, { assignedPractitionerId: kine.practitionerId });
    await db.patient.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    const mem = await membershipOf(A, kine.userId);

    const r = await removeMember(mem.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("1 paciente asignado");
      expect(r.error).not.toContain("turno");
    }
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(1);
  });

  it("sin turnos futuros ni pacientes, quita al profesional: sale de listPractitioners e invalida el tag", async () => {
    const kine = await addPractitioner(db, A);
    await addBooking(kine.practitionerId, new Date(Date.now() - 5 * DAY), "COMPLETED");
    const mem = await membershipOf(A, kine.userId);
    expect((await listPractitioners()).map((p) => p.id)).toContain(kine.practitionerId);

    const r = await removeMember(mem.id);
    expect(r.ok).toBe(true);
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(0);
    // La fila Practitioner queda (historial del turno pasado)…
    expect(await db.practitioner.count({ where: { id: kine.practitionerId } })).toBe(1);
    // …pero ya no se ofrece en la agenda.
    const ids = (await listPractitioners()).map((p) => p.id);
    expect(ids).not.toContain(kine.practitionerId);
    expect(ids).toContain(A.practitionerId);
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.practitioners(A.tenantId));
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, action: "membership.remove", entityId: mem.id },
    });
    expect(ev).not.toBeNull();
  });

  it("listPractitioners no lista membresías sin aceptar", async () => {
    const kine = await addPractitioner(db, A);
    await db.membership.updateMany({
      where: { tenantId: A.tenantId, userId: kine.userId },
      data: { acceptedAt: null },
    });
    expect((await listPractitioners()).map((p) => p.id)).not.toContain(kine.practitionerId);
  });

  it("no puede quitar un miembro de otro tenant", async () => {
    const memB = await membershipOf(B, B.userId);
    const r = await removeMember(memB.id);
    expect(r.ok).toBe(false);
    expect(await db.membership.count({ where: { id: memB.id } })).toBe(1);
  });

  it("cambiar de rol invalida el tag practitioners y audita de/a", async () => {
    const kine = await addPractitioner(db, A);
    const mem = await membershipOf(A, kine.userId);
    const r = await changeMemberRole(mem.id, "ADMIN");
    expect(r.ok).toBe(true);
    expect((await db.membership.findUniqueOrThrow({ where: { id: mem.id } })).role).toBe("ADMIN");
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.practitioners(A.tenantId));
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, action: "membership.role.change", entityId: mem.id },
    });
    expect(ev?.payload).toMatchObject({ from: "PRACTITIONER", role: "ADMIN" });
  });

  it("transferir el OWNER deja al anterior como ADMIN (en un tenant propio)", async () => {
    const T = await createEphemeralTenant(db);
    try {
      const kine = await addPractitioner(db, T);
      const mem = await membershipOf(T, kine.userId);
      asUser(T.userId);
      const r = await changeMemberRole(mem.id, "OWNER");
      expect(r.ok).toBe(true);
      const roles = await db.membership.findMany({
        where: { tenantId: T.tenantId },
        select: { userId: true, role: true },
      });
      expect(roles.find((x) => x.userId === kine.userId)?.role).toBe("OWNER");
      expect(roles.find((x) => x.userId === T.userId)?.role).toBe("ADMIN");
    } finally {
      await T.cleanup();
    }
  });

  it("[BO-Z] B1: dos transferencias simultáneas del mismo OWNER (a X y a Y) → exactamente un OWNER", async () => {
    const T = await createEphemeralTenant(db, { plan: "PRO" });
    try {
      const x = await addPractitioner(db, T);
      const y = await addPractitioner(db, T);
      const mx = await membershipOf(T, x.userId);
      const my = await membershipOf(T, y.userId);
      asUser(T.userId);
      const results = await Promise.all([changeMemberRole(mx.id, "OWNER"), changeMemberRole(my.id, "OWNER")]);
      // Una gana; la otra ve que quien transfería ya no es OWNER y revierte con el copy de carrera.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "El rol cambió mientras tanto. Recargá y probá de nuevo." });
      const owners = await db.membership.findMany({ where: { tenantId: T.tenantId, role: "OWNER" }, select: { userId: true } });
      expect(owners).toHaveLength(1);
      expect([x.userId, y.userId]).toContain(owners[0].userId);
      const prevOwner = await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: T.userId } });
      expect(prevOwner.role).toBe("ADMIN");
    } finally {
      await T.cleanup();
    }
  });
});

/**
 * IAM-2a · quién gestiona el equipo (IAM-D3, default de §19.10): OWNER y ADMIN. Antes era solo el OWNER
 * (`requireOwner`), y el ADMIN que «configura el consultorio» no podía sumar a la Secretaria. Límites del ADMIN:
 * no toca la membresía del OWNER ni asigna/transfiere el OWNER (si no, un ADMIN se quedaba con el consultorio).
 */
describe.skipIf(!RUN)("equipo · gestión por OWNER y ADMIN (IAM-D3)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let invId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    const inv = await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `gate-${uniqueSuffix()}@test.local`,
        firstName: "Gate",
        lastName: "Test",
        token: `gate-${uniqueSuffix()}`,
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    invId = inv.id;
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());

  it("ADMIN invita, lista, cambia rol y quita a un profesional", async () => {
    const admin = await addPractitioner(db, A, "ADMIN");
    asUser(admin.userId);
    const r = await createInvitation({ email: `adm-${uniqueSuffix()}@test.local`, firstName: "S", lastName: "R", role: "ASSISTANT" });
    expect(r.ok).toBe(true);
    expect((await listPendingInvitations()).length).toBeGreaterThan(0);
    expect((await listTeamMembers()).some((m) => m.isYou)).toBe(true);

    const kine = await addPractitioner(db, A);
    const mem = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: kine.userId } });
    expect(await changeMemberRole(mem.id, "BILLING")).toEqual({ ok: true, data: undefined });
    expect(await removeMember(mem.id)).toEqual({ ok: true, data: undefined });
  });

  it("ADMIN no toca la membresía del OWNER ni asigna el OWNER", async () => {
    const admin = await addPractitioner(db, A, "ADMIN");
    asUser(admin.userId);
    const ownerMem = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: A.userId } });
    expect((await changeMemberRole(ownerMem.id, "ADMIN")).ok).toBe(false);
    expect((await removeMember(ownerMem.id)).ok).toBe(false);
    const kine = await addPractitioner(db, A);
    const mem = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: kine.userId } });
    expect((await changeMemberRole(mem.id, "OWNER")).ok).toBe(false);
    const own = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: admin.userId } });
    expect((await changeMemberRole(own.id, "OWNER")).ok).toBe(false);
    expect((await db.membership.findFirstOrThrow({ where: { id: ownerMem.id } })).role).toBe("OWNER");
    expect((await db.membership.findFirstOrThrow({ where: { id: mem.id } })).role).toBe("PRACTITIONER");
  });

  for (const role of ["PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
    it(`${role} → Forbidden en todas las acciones del equipo, sin escribir nada`, async () => {
      const u = await addPractitioner(db, A, role);
      asUser(u.userId);
      const before = await db.invitation.findUniqueOrThrow({ where: { id: invId } });
      await expect(createInvitation({ email: `no-${uniqueSuffix()}@test.local`, firstName: "N", lastName: "O" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(resendInvitation(invId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(regenerateInvitationUrl(invId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(revokeInvitation(invId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listPendingInvitations()).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listTeamMembers()).rejects.toBeInstanceOf(ForbiddenError);
      const mem = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: u.userId } });
      await expect(changeMemberRole(mem.id, "ADMIN")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeMember(mem.id)).rejects.toBeInstanceOf(ForbiddenError);
      const after = await db.invitation.findUniqueOrThrow({ where: { id: invId } });
      expect(after).toEqual(before);
    });
  }
});

describe.skipIf(!RUN)("configuración · audit antes/después de montos", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => asUser(A.userId));

  it("updateService audita nombre y precio de antes y después (solo lo que cambió)", async () => {
    const r = await updateService(A.serviceId, { priceCents: 150050, durationMin: 60 });
    expect(r.ok).toBe(true);
    const row = await db.service.findUniqueOrThrow({ where: { id: A.serviceId } });
    expect(row.priceCents).toBe(150050);
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "service.update", entityId: A.serviceId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toEqual({ before: { priceCents: 5000 }, after: { priceCents: 150050 } });
  });

  it("updateService sin cambios de nombre/monto no guarda payload", async () => {
    const r = await updateService(A.serviceId, { durationMin: 30 });
    expect(r.ok).toBe(true);
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "service.update", entityId: A.serviceId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toBeNull();
  });

  it("updateInsurer audita nombre y montos de antes y después", async () => {
    const name = `OS ${uniqueSuffix()}`;
    const id = await addInsurer(db, A, { name, copagoCents: 5000, fixedFeeCents: 200000 });
    const r = await updateInsurer(id, { name: `${name} Plus`, copagoCents: 7550, fixedFeeCents: 200000 });
    expect(r.ok).toBe(true);
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "insurer.update", entityId: id },
    });
    expect(ev.payload).toEqual({
      before: { name, copagoCents: 5000 },
      after: { name: `${name} Plus`, copagoCents: 7550 },
    });
  });

  it("updateInsurer con un nombre repetido devuelve error en vez de tirar", async () => {
    const a = await addInsurer(db, A, { name: `Dup ${uniqueSuffix()}` });
    const bName = `Dup ${uniqueSuffix()}`;
    await addInsurer(db, A, { name: bName });
    const r = await updateInsurer(a, { name: bName });
    // @@unique([tenantId, name]) en Insurer: antes el P2002 del update subía
    // como 500; ahora es un error legible y la fila no cambia.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Ya existe");
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, name: bName } })).toBe(1);
  });
});
