/**
 * [P4-S24a] Identidad del portal: la autorización es por (tenantId, userId), nunca por email.
 *
 * Antes (hasta ES4) el portal autorizaba por coincidencia de email entre consultorios: una ficha con el email de la
 * cuenta pero SIN vincular (`Patient.userId` null) ya le mostraba plan, turnos y check-in. Y el vínculo, con dos fichas
 * del mismo email en un consultorio (familia; el único (tenantId, email) distingue mayúsculas), elegía «la más vieja»
 * y escribía con `update({ where: { id } })`: sin CAS, una ficha tomada entre la lectura y la escritura se pisaba.
 *
 * Contrato (brief ES4 §3.1/§3.2, PD-15): auto-vínculo solo si hay EXACTAMENTE una ficha libre con ese email en ese
 * consultorio; 0 o >1 → invitación. El CAS exige count 1 y un P2002 es «conflict», nunca un 500.
 *
 * Símbolos reales de lib/portal.ts, lib/portal-identity-internal.ts y lib/portal-link-internal.ts; solo se mockea la
 * sesión de Supabase (tests/helpers/actor.ts → `<userId>@test.local`, verificado).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPortalAuth, getPortalPlan, submitCheckIn } from "@/lib/portal";
import { requirePortalPatient, listPortalPatients, getPortalUser } from "@/lib/portal-identity-internal";
import {
  linkPatientCas,
  linkPortalPatientOnCallback,
  linkPortalPatientsOnSignIn,
} from "@/lib/portal-link-internal";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
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

describe.skipIf(!RUN)("[P4-S24a] portal · identidad por (tenantId, userId)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const profiles: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());
  afterEach(() => vi.restoreAllMocks());

  /** Cuenta de paciente (UserProfile, sin Membership): `Patient.userId` tiene FK a UserProfile. */
  const account = async () => {
    const id = `test-pid-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return { id, email: `${id}@test.local` };
  };
  const verified = (u: { id: string; email: string }) => ({ id: u.id, email: u.email, emailVerified: true });

  const addPlan = async (t: EphemeralTenant, patientId: string, title = "Plan lumbar") => {
    const program = await db.treatmentProgram.create({
      data: { tenantId: t.tenantId, patientId, title, startDate: new Date() },
    });
    const session = await db.session.create({
      data: {
        programId: program.id,
        practitionerId: t.practitionerId,
        index: 1,
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });
    return { programId: program.id, sessionId: session.id };
  };

  // ── it.fails dados vuelta (tests primero) ──────────────────────────────────────────────────────────────────────

  it("[P4-S24a] ficha con el email pero sin userId no aparece en getPortalAuth", async () => {
    const me = await account();
    const patientId = await addPatient(db, A, { email: me.email });
    const { sessionId } = await addPlan(A, patientId);
    asUser(me.id);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await getPortalPlan(A.slug)).toBeNull();
    expect(await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 5 })).toEqual({ ok: false, error: "Sin acceso." });
    expect(await db.evaScore.count({ where: { patientId } })).toBe(0);
  });

  it("[P4-S24a] dos fichas Ana@x / ana@x en un consultorio → no vincula, outcome ambiguous", async () => {
    const me = await account();
    const p1 = await addPatient(db, A, { email: me.email });
    const p2 = await addPatient(db, A, { email: me.email.toUpperCase() });
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    vi.spyOn(logger, "warn").mockImplementation((msg: string, ctx?: Record<string, unknown>) => {
      warns.push([msg, ctx]);
    });

    expect(await linkPortalPatientOnCallback(verified(me), A.slug)).toBe("ambiguous");
    expect(await linkPortalPatientsOnSignIn(verified(me), "/portal")).toEqual(["ambiguous"]);
    expect(await db.patient.count({ where: { id: { in: [p1, p2] }, userId: { not: null } } })).toBe(0);
    expect(await db.patientTenantLink.count({ where: { patientId: { in: [p1, p2] } } })).toBe(0);
    // Log de rechazo con slug y motivo, sin el email (IAM-3c).
    const refused = warns.filter(([m]) => m === "portal.link.refused");
    expect(refused.length).toBeGreaterThan(0);
    for (const [, ctx] of refused) {
      expect(ctx).toMatchObject({ tenantSlug: A.slug, reason: "ambiguous" });
      expect(JSON.stringify(ctx)).not.toContain("@");
    }
  });

  it("[P4-S24a] CAS: ficha tomada entre el read y el write → conflict, sin 500", async () => {
    const me = await account();
    const other = await account();
    const patientId = await addPatient(db, A, { email: me.email });
    // La carrera: la lectura de candidatas ve la ficha libre; justo después otra cuenta la toma (otra pestaña, la
    // invitación de otro). Se inyecta DESPUÉS de que la lectura real devolvió, sobre la misma base. Parche a mano y
    // no `vi.spyOn`: el delegate de Prisma es un proxy y `restoreAllMocks` lo dejaba sin `findMany` para el resto.
    const delegate = prismaService.patient as unknown as { findMany: (args: unknown) => Promise<unknown> };
    const original = delegate.findMany;
    let injected = false;
    delegate.findMany = async (args: unknown) => {
      const rows = await original.call(delegate, args);
      if (!injected) {
        injected = true;
        await db.patient.update({ where: { id: patientId }, data: { userId: other.id } });
      }
      return rows;
    };
    let r: string;
    try {
      r = await linkPortalPatientOnCallback(verified(me), A.slug);
    } finally {
      delegate.findMany = original;
    }
    expect(injected).toBe(true);
    expect(r).toBe("conflict");
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBe(other.id);
    expect(await db.patientTenantLink.count({ where: { patientId } })).toBe(0);
  });

  // ── Verdes nuevos ──────────────────────────────────────────────────────────────────────────────────────────────

  it("exactamente una ficha libre → vincula; la segunda entrada es «already» y no reescribe", async () => {
    const me = await account();
    const patientId = await addPatient(db, A, { email: me.email.toUpperCase() });
    expect(await linkPortalPatientOnCallback(verified(me), A.slug)).toBe("linked");
    const after = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(after.userId).toBe(me.id);
    expect(await db.patientTenantLink.count({ where: { patientId, tenantId: A.tenantId } })).toBe(1);

    expect(await linkPortalPatientOnCallback(verified(me), A.slug)).toBe("already");
    // Sin escritura en el re-login: `updatedAt` es el optimistic lock de la ficha del lado consultorio.
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).updatedAt).toEqual(after.updatedAt);
  });

  it("2 consultorios, misma cuenta → 2 vínculos sin P2002, y el portal ve las dos fichas", async () => {
    const me = await account();
    const pa = await addPatient(db, A, { email: me.email });
    const pb = await addPatient(db, B, { email: me.email.toUpperCase() });
    expect((await linkPortalPatientsOnSignIn(verified(me), "/portal")).sort()).toEqual(["linked", "linked"]);
    expect(await db.patient.count({ where: { id: { in: [pa, pb] }, userId: me.id } })).toBe(2);

    asUser(me.id);
    const auth = await getPortalAuth();
    expect(auth.signedIn && auth.patients.map((p) => p.id).sort()).toEqual([pa, pb].sort());
    const refs = await listPortalPatients(me.id);
    expect(refs.map((r) => [r.tenantId, r.patientId]).sort()).toEqual(
      [
        [A.tenantId, pa],
        [B.tenantId, pb],
      ].sort()
    );
    const ref = await requirePortalPatient(B.slug);
    expect(ref).toMatchObject({ userId: me.id, tenantId: B.tenantId, patientId: pb, tenant: { slug: B.slug } });
    expect(ref?.modules instanceof Set).toBe(true);
    expect(typeof ref?.surfacesOpen).toBe("boolean");
    // El ref no lleva el email de la ficha ni el de la cuenta (PHI mínimo).
    expect(JSON.stringify({ ...ref, modules: [...(ref?.modules ?? [])] })).not.toContain("@");
  });

  it("staff (con Membership) → no vincula ni ve, aunque haya una ficha vinculada a su cuenta", async () => {
    const staffEmail = `${A.userId}@test.local`;
    const free = await addPatient(db, B, { email: staffEmail });
    expect(await linkPortalPatientOnCallback({ id: A.userId, email: staffEmail, emailVerified: true }, B.slug)).toBe(
      "staff"
    );
    expect((await db.patient.findUniqueOrThrow({ where: { id: free } })).userId).toBeNull();

    // Ficha vinculada «a mano» (dato viejo): igual no la ve (§5.22).
    await db.patient.update({ where: { id: free }, data: { userId: A.userId } });
    await addPlan(B, free);
    asUser(A.userId);
    expect((await getPortalUser())?.isStaff).toBe(true);
    const auth = await getPortalAuth();
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await requirePortalPatient(B.slug)).toBeNull();
    expect(await getPortalPlan(B.slug)).toBeNull();
  });

  it("sin vínculo → requirePortalPatient null (y por ende sin plan ni check-in); slug inexistente → null", async () => {
    const me = await account();
    await addPatient(db, A, { email: me.email });
    asUser(me.id);
    expect(await requirePortalPatient(A.slug)).toBeNull();
    expect(await requirePortalPatient(`no-existe-${uniqueSuffix()}`)).toBeNull();
    expect(await listPortalPatients(me.id)).toEqual([]);
  });

  it("vínculo de OTRO consultorio no autoriza en este (por tenantId, no solo por userId)", async () => {
    const me = await account();
    const pa = await addPatient(db, A, { email: me.email });
    await db.patient.update({ where: { id: pa }, data: { userId: me.id } });
    await addPatient(db, B, { email: me.email }); // en B la ficha existe pero no está vinculada
    asUser(me.id);
    expect((await requirePortalPatient(A.slug))?.patientId).toBe(pa);
    expect(await requirePortalPatient(B.slug)).toBeNull();
    expect(await getPortalPlan(B.slug)).toBeNull();
  });

  it("ES4-D4: ficha vinculada pero archivada → no ve el portal de ese consultorio", async () => {
    const me = await account();
    const pa = await addPatient(db, A, { email: me.email });
    await db.patient.update({ where: { id: pa }, data: { userId: me.id, archivedAt: new Date() } });
    asUser(me.id);
    expect(await requirePortalPatient(A.slug)).toBeNull();
    const auth = await getPortalAuth();
    if (auth.signedIn) expect(auth.patients).toEqual([]);
  });

  describe("linkPatientCas", () => {
    it("ficha de otra cuenta → conflict sin escribir", async () => {
      const me = await account();
      const other = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      await db.patient.update({ where: { id: patientId }, data: { userId: other.id } });
      expect(await linkPatientCas({ userId: me.id, tenantId: A.tenantId, patientId })).toBe("conflict");
      expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBe(other.id);
    });

    it("la cuenta ya tiene OTRA ficha en ese consultorio → P2002 capturado como conflict (sin 500)", async () => {
      const me = await account();
      const first = await addPatient(db, A, { email: me.email });
      await db.patient.update({ where: { id: first }, data: { userId: me.id } });
      const second = await addPatient(db, A, { email: `otra-${uniqueSuffix()}@test.local` });
      expect(await linkPatientCas({ userId: me.id, tenantId: A.tenantId, patientId: second })).toBe("conflict");
      expect((await db.patient.findUniqueOrThrow({ where: { id: second } })).userId).toBeNull();
      expect(await db.patientTenantLink.count({ where: { patientId: second } })).toBe(0);
    });

    it("tenantId que no es el de la ficha → conflict sin escribir (las FK saltean RLS)", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      expect(await linkPatientCas({ userId: me.id, tenantId: B.tenantId, patientId })).toBe("conflict");
      expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBeNull();
    });

    it("libre → linked (+ PatientTenantLink); misma cuenta otra vez → already", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      expect(await linkPatientCas({ userId: me.id, tenantId: A.tenantId, patientId })).toBe("linked");
      expect(await linkPatientCas({ userId: me.id, tenantId: A.tenantId, patientId })).toBe("already");
      expect(await db.patientTenantLink.count({ where: { patientId, tenantId: A.tenantId } })).toBe(1);
    });
  });
});
