/**
 * Invitaciones de equipo (A3b-S-auth, 2026-09-30).
 *
 * - re-invitar un email con invitación viva ACTUALIZA rol y datos (antes se
 *   ignoraban) y lo audita;
 * - staff ≠ paciente: `createInvitation` rechaza un email que en el propio
 *   consultorio es un paciente con portal vinculado; `acceptInvite` rechaza
 *   una identidad vinculada como paciente en cualquier consultorio.
 *
 * Actions REALES; solo se mockea la sesión de Supabase (actor.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createInvitation } from "@/lib/invitations";
import { findInvitationByRawToken } from "@/lib/invitations-internal";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("invitaciones · re-invitar y staff ≠ paciente", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const extraUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (extraUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    asUser(A.userId);
  });

  it("re-invitar actualiza rol, nombre y especialidad de la invitación viva, y lo audita", async () => {
    const email = `nueva-${uniqueSuffix()}@test.local`;
    const first = await createInvitation({ email, firstName: "Ana", lastName: "Pérez", role: "PRACTITIONER" });
    expect(first.ok).toBe(true);
    __rateLimitInternals.reset();

    const second = await createInvitation({
      email: email.toUpperCase(),
      firstName: "Anabel",
      lastName: "Pérez",
      role: "ADMIN",
      specialty: "Osteopatía",
    });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data.id).toBe(first.data.id);

    const rows = await db.invitation.findMany({ where: { tenantId: A.tenantId, email } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "ADMIN", firstName: "Anabel", specialty: "Osteopatía" });

    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "invitation.reinvite", entityId: rows[0].id },
    });
    expect(ev.payload).toMatchObject({
      changed: { role: { from: "PRACTITIONER", to: "ADMIN" }, firstName: { from: "Ana", to: "Anabel" } },
    });
  });

  // Hallazgo del 14-oct (§19.1, cuentas muertas): re-invitar rotaba el token y el link del primer mail daba 404.
  it("[IAM-2a] re-invitar no deja 404 en el link anterior", async () => {
    const email = `relink-${uniqueSuffix()}@test.local`;
    const first = await createInvitation({ email, firstName: "Ana", lastName: "Pérez" });
    if (!first.ok || !first.data.url) throw new Error("sin url");
    const oldRaw = first.data.url.split("/invite/")[1];
    __rateLimitInternals.reset();
    const second = await createInvitation({ email, firstName: "Ana", lastName: "Pérez" });
    expect(second.ok).toBe(true);
    const found = await findInvitationByRawToken(oldRaw);
    expect(found?.status).toBe("pending");
  });

  it("createInvitation rechaza el email de un paciente del consultorio con portal vinculado", async () => {
    const uid = `test-user-pac-${uniqueSuffix()}`;
    extraUsers.push(uid);
    await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
    const pid = await addPatient(db, A, { email: `${uid}@test.local`.toUpperCase() });
    await db.patient.update({ where: { id: pid }, data: { userId: uid } });

    const r = await createInvitation({ email: `${uid}@test.local`, firstName: "X", lastName: "Y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("portal");
    expect(await db.invitation.count({ where: { tenantId: A.tenantId, email: `${uid}@test.local` } })).toBe(0);
  });

  it("acceptInvite rechaza una identidad vinculada como paciente en OTRO consultorio y no crea membresía", async () => {
    const uid = `test-user-pac-${uniqueSuffix()}`;
    extraUsers.push(uid);
    await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
    const pid = await addPatient(db, B, { email: `${uid}@test.local` });
    await db.patient.update({ where: { id: pid }, data: { userId: uid } });

    const raw = randomBytes(24).toString("base64url");
    await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `${uid}@test.local`,
        firstName: "Pac",
        lastName: "Iente",
        role: "PRACTITIONER",
        token: hashInviteToken(raw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    asUser(uid);

    const r = await acceptInvite(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("portal de pacientes");
    expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
    expect(await db.practitioner.count({ where: { userId: uid } })).toBe(0);
  });

  it("acceptInvite de una identidad sin ficha de paciente sigue funcionando", async () => {
    const uid = `test-user-new-${uniqueSuffix()}`;
    extraUsers.push(uid);
    const raw = randomBytes(24).toString("base64url");
    await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `${uid}@test.local`,
        firstName: "Nuevo",
        lastName: "Kine",
        role: "PRACTITIONER",
        token: hashInviteToken(raw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    asUser(uid);
    const r = await acceptInvite(raw);
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await db.membership.count({ where: { userId: uid, tenantId: A.tenantId } })).toBe(1);
  });
});
