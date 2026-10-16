/**
 * BO1-A · acceso del consultorio, bloqueos de sesión y modo solo lectura (C-BO1, C-BO2, C-BO3; plan §19.5).
 *
 * Símbolos REALES contra Postgres en los dos roles: `getActor`/`tryGetActor`/`getSessionBlock`/`getAccessSnapshot`
 * (lib/session.ts), `decideAppGate` (lib/onboarding-logic.ts), `runWithRls` (lib/rls.ts), las actions de
 * preferencias y del alta, y `joinTenantInTx` (lib/invite-activation-internal.ts). Se mockean solo la sesión de
 * Supabase, la cookie y `next/cache` (integration-setup). `TENANT_ACCESS_ENFORCEMENT` se cambia en caliente
 * (`tenantAccessEnforcement()` lee `process.env` en cada llamada).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { cookies } from "next/headers";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ReadOnlyModeError,
  UnauthenticatedError,
  getAccessSnapshot,
  getActor,
  getSessionBlock,
  tryGetActor,
} from "@/lib/session";
import { getTenantChoiceState } from "@/lib/tenant-choice";
import { decideAppGate } from "@/lib/onboarding-logic";
import { runWithRls } from "@/lib/rls";
import { prisma } from "@/lib/db";
import { runWithRequestContext } from "@/lib/request-context";
import { READ_ONLY_MESSAGE, isReadOnlyViolation } from "@/lib/tenant-access";
import { randomUUID } from "node:crypto";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import {
  createBooking,
  createBookingsBatch,
  deleteBooking,
  markReceptionAction,
  setBookingCopagoPaid,
  setBookingInsurerPaid,
  setBookingStatus,
  updateBooking,
} from "@/lib/bookings";
import { createPatient, setPatientArchived, setPatientCoverage, updatePatient } from "@/lib/patients";
import { createTimeBlock } from "@/lib/time-blocks";
import { updateUserPreferences } from "@/lib/preferences";
import { openPendingInvitation, saveOnboardingClinic } from "@/lib/onboarding";
import { UserDisabledError, joinTenantInTx } from "@/lib/invite-activation-internal";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, addPatient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO1-A] acceso del consultorio y bloqueos de sesión", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) {
        await db.practitioner.deleteMany({ where: { userId: { in: users } } });
        await db.membership.deleteMany({ where: { userId: { in: users } } });
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete("kine_tenant");
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default `banner`
  });

  afterEach(() => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
  });

  async function tenant(opts: Parameters<typeof createEphemeralTenant>[1] = {}): Promise<EphemeralTenant> {
    const t = await createEphemeralTenant(db, opts);
    tenants.push(t);
    return t;
  }

  async function newUser(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `BO1A ${id}` } });
    users.push(id);
    return id;
  }

  async function join(userId: string, t: EphemeralTenant, acceptedAt = new Date()): Promise<void> {
    await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    await db.membership.create({ data: { userId, tenantId: t.tenantId, role: "PRACTITIONER", acceptedAt } });
  }

  /** Lo que haría el layout de la app con esta sesión (mismos símbolos que `app/(app)/layout.tsx`). */
  async function layoutGate(): Promise<string | null> {
    const actor = await tryGetActor();
    const snap = await getAccessSnapshot();
    const choice = await getTenantChoiceState();
    const block = await getSessionBlock();
    return decideAppGate({
      hasSession: !!snap,
      hasActor: !!actor,
      access: snap?.state ?? null,
      needsChoice: !!actor && !!snap && choice.needsChoice,
      role: actor ? (snap?.memberships.find((m) => m.tenantId === actor.tenantId)?.role ?? null) : null,
      onboardingCompleted: true,
      nextPath: null,
      block: block?.kind ?? null,
    });
  }

  // ── Usuario deshabilitado (UserProfile.disabledAt, M7) ────────────────────────────────────────────────────

  it("usuario deshabilitado: getActor tira, getSessionBlock = user_disabled y el gate va a /cuenta-desactivada", async () => {
    const A = await tenant({ disabled: true });
    asUser(A.userId);
    await expect(getActor()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await getSessionBlock()).toEqual({ kind: "user_disabled" });
    expect((await getAccessSnapshot())?.usable).toEqual([]);
    expect((await getTenantChoiceState()).options).toEqual([]);
    expect(await layoutGate()).toBe("/cuenta-desactivada");
  });

  it("usuario deshabilitado: el alta del consultorio y abrir una invitación se rechazan", async () => {
    const A = await tenant({ disabled: true });
    asUser(A.userId);
    const before = await db.tenant.count();
    const r = await saveOnboardingClinic({ name: "Consultorio de un deshabilitado" } as Parameters<typeof saveOnboardingClinic>[0]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/desactivada/) });
    expect(await db.tenant.count()).toBe(before);
    expect(await openPendingInvitation("cualquiera")).toMatchObject({ ok: false, error: expect.stringMatching(/desactivada/) });
  });

  it("usuario deshabilitado: aceptar/activar una invitación (joinTenantInTx) tira antes de escribir", async () => {
    const A = await tenant({ disabled: true });
    const B = await tenant();
    const inv = await db.invitation.create({
      data: {
        tenantId: B.tenantId,
        email: `${A.userId}@test.local`,
        firstName: "Des",
        lastName: "Habilitado",
        role: "PRACTITIONER",
        token: `tok-${uniqueSuffix()}`,
        invitedById: B.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      db.$transaction((tx) =>
        joinTenantInTx(tx, {
          invitation: { id: inv.id, tenantId: B.tenantId, role: "PRACTITIONER", specialty: null },
          userId: A.userId,
          email: `${A.userId}@test.local`,
          fullName: null,
          now: new Date(),
          via: "session",
        })
      )
    ).rejects.toBeInstanceOf(UserDisabledError);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    expect(await db.membership.count({ where: { userId: A.userId, tenantId: B.tenantId } })).toBe(0);
  });

  // ── Consultorio suspendido / dado de baja ─────────────────────────────────────────────────────────────────

  it("consultorio SUSPENDED como único: sin Actor, block tenant_suspended → /suspendido (con el default banner)", async () => {
    const S = await tenant({ status: "SUSPENDED" });
    asUser(S.userId);
    expect(await tryGetActor()).toBeNull();
    expect(await getSessionBlock()).toEqual({ kind: "tenant_suspended", tenantName: expect.stringMatching(/^Test /) });
    expect(await layoutGate()).toBe("/suspendido");
  });

  it("consultorio CLOSED → tenant_closed → /suspendido", async () => {
    const C = await tenant({ status: "CLOSED" });
    asUser(C.userId);
    expect((await getSessionBlock())?.kind).toBe("tenant_closed");
    expect(await layoutGate()).toBe("/suspendido");
  });

  it("con otro consultorio usable entra a ese, aunque la cookie apunte al suspendido", async () => {
    const S = await tenant({ status: "SUSPENDED" });
    const ok = await tenant();
    const u = await newUser();
    await join(u, S, new Date()); // el más reciente: antes ganaba la elección
    await join(u, ok, new Date(Date.now() - 3_600_000));
    cookies().set("kine_tenant", S.tenantId);
    asUser(u);
    const actor = await getActor();
    expect(actor.tenantId).toBe(ok.tenantId);
    expect(await getSessionBlock()).toBeNull();
    // Una sola usable: no hay nada que preguntar ni bloqueo.
    expect((await getTenantChoiceState()).options.map((o) => o.tenantId)).toEqual([ok.tenantId]);
    expect(await layoutGate()).toBeNull();
  });

  it("con `off` (interruptor de emergencia) ni la suspensión corta", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "off";
    const S = await tenant({ status: "SUSPENDED" });
    asUser(S.userId);
    const actor = await getActor();
    expect(actor.tenantId).toBe(S.tenantId);
    expect(actor.access.mode).toBe("suspended"); // el modo REAL viaja igual
    expect(await getSessionBlock()).toBeNull();
  });

  // ── Solo lectura ──────────────────────────────────────────────────────────────────────────────────────────

  async function readOnlyTenant(): Promise<EphemeralTenant> {
    const t = await tenant();
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    return t;
  }

  const newService = (tenantId: string) => ({
    tenantId,
    name: `RO ${uniqueSuffix()}`,
    durationMin: 30,
    priceCents: 1000,
  });

  it("cómo llega el 25006 por Prisma (verificación de isReadOnlyViolation, sin traducción)", async () => {
    const t = await tenant();
    const errs: unknown[] = [];
    for (const write of [
      (tx: Prisma.TransactionClient) => tx.service.create({ data: newService(t.tenantId) }),
      (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe(`UPDATE "Tenant" SET "name" = "name" WHERE "id" = $1`, t.tenantId),
    ]) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_tenant_id', $1, true), set_config('transaction_read_only', 'on', true)`,
            t.tenantId
          );
          await write(tx);
        });
      } catch (err) {
        errs.push(err);
      }
    }
    expect(errs).toHaveLength(2);
    // Operación de modelo: error desconocido con el PostgresError del conector en el texto.
    expect(errs[0]).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String((errs[0] as Error).message)).toMatch(/25006/);
    // Raw: P2010 con meta.code.
    expect(errs[1]).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((errs[1] as Prisma.PrismaClientKnownRequestError).code).toBe("P2010");
    expect((errs[1] as Prisma.PrismaClientKnownRequestError).meta?.code).toBe("25006");
    for (const e of errs) expect(isReadOnlyViolation(e)).toBe(true);
  });

  it("enforce + read_only: runWithRls rechaza el INSERT con ReadOnlyModeError y deja leer", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const t = await readOnlyTenant();
    asUser(t.userId);
    const actor = await getActor();
    expect(actor.access).toEqual({ mode: "read_only", reason: "cancelled", daysLeft: null });
    expect(actor.support).toBeNull();
    const before = await db.service.count({ where: { tenantId: t.tenantId } });

    await expect(runWithRls(actor.tenantId, (tx) => tx.service.create({ data: newService(actor.tenantId) }))).rejects.toBeInstanceOf(
      ReadOnlyModeError
    );
    // Leer sigue andando (la HC nunca se bloquea): servicios y pacientes.
    const rows = await runWithRls(actor.tenantId, (tx) => tx.service.findMany({ where: { tenantId: actor.tenantId } }));
    expect(rows.length).toBe(before);
    await expect(runWithRls(actor.tenantId, (tx) => tx.patient.findMany({ where: { tenantId: actor.tenantId } }))).resolves.toBeInstanceOf(Array);
    expect(await db.service.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });

  it("enforce + read_only: una escritura fuera de runWithRls (preferencias) se rechaza con el copy, sin escribir", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const t = await readOnlyTenant();
    asUser(t.userId);
    const r = await updateUserPreferences({ palette: "mint" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/modo lectura/) });
    expect(await db.userPreferences.count({ where: { userId: t.userId } })).toBe(0);
  });

  it("[BO3-F] enforce + read_only: las actions de agenda, pacientes y bloqueos DEVUELVEN el copy (no tiran ni dan el genérico)", async () => {
    // Sin esto el ReadOnlyModeError de `runWithRls` escapaba de la action y en prod Next redacta el mensaje (error
    // genérico); createBooking/createPatient/createTimeBlock lo tapaban con «No pudimos crear…». lib/read-only-result.ts.
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const t = await readOnlyTenant();
    const patientId = await addPatient(db, t);
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        // HOY a las 12:00 AR (no «ahora + 1 h»: pasadas las 23:00 AR caía mañana y la recepción, que opera turnos del día,
        // cortaba antes del write con otro copy; flake por la hora, ES4-Z).
        scheduledFor: new Date(localToARIso(`${toARDateKey(new Date())}T12:00`)),
        durationMin: 30,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    const v = b.updatedAt.toISOString();
    asUser(t.userId);
    expect((await getActor()).access.mode).toBe("read_only");
    const when = new Date(localToARIso("2031-06-02T10:00:00")).toISOString();
    const slot = { patientId, serviceId: t.serviceId, practitionerId: t.practitionerId, scheduledFor: when, allowOutOfHours: true };
    const actions: Array<[string, () => Promise<unknown>]> = [
      ["createBooking", () => createBooking({ ...slot, idempotencyKey: randomUUID() })],
      ["createBookingsBatch", () => createBookingsBatch({ ...slot, count: 2, daysOfWeek: [0], idempotencyKey: randomUUID() })],
      ["updateBooking", () => updateBooking({ id: b.id, notes: "x", expectedUpdatedAt: v } as never)],
      ["setBookingStatus", () => setBookingStatus(b.id, "CANCELLED", v)],
      ["markReceptionAction", () => markReceptionAction(b.id, "llego", v)],
      ["setBookingCopagoPaid", () => setBookingCopagoPaid(b.id, true, v)],
      ["setBookingInsurerPaid", () => setBookingInsurerPaid(b.id, true, v)],
      ["deleteBooking", () => deleteBooking(b.id, v)],
      ["createPatient", () => createPatient({ firstName: "Nuevo", lastName: "Paciente", documentId: `DNI-${uniqueSuffix()}` } as never)],
      ["updatePatient", () => updatePatient({ id: patientId, phone: "1122334455" } as never)],
      ["setPatientArchived", () => setPatientArchived({ id: patientId, archived: true })],
      // Con OS (sin OS y sin cobertura previa es un no-op que no escribe y da ok).
      ["setPatientCoverage", () => setPatientCoverage({ patientId, insurerName: "OSDE", memberId: "1" })],
      ["createTimeBlock", () => createTimeBlock({ practitionerId: t.practitionerId, startsAt: when, endsAt: new Date(new Date(when).getTime() + 3600_000).toISOString() })],
    ];
    const results: Record<string, { kind: string; message: string }> = {};
    for (const [name, act] of actions) {
      try {
        const r = (await act()) as { ok: boolean; error?: string };
        results[name] = { kind: r.ok ? "ok" : "error", message: r.ok ? "" : String(r.error) };
      } catch (e) {
        results[name] = { kind: "throw", message: e instanceof Error ? e.message : String(e) };
      }
    }
    expect(results).toEqual(Object.fromEntries(actions.map(([n]) => [n, { kind: "error", message: READ_ONLY_MESSAGE }])));
    // Nada escrito.
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.updatedAt.toISOString()).toBe(v);
    expect(await db.booking.count({ where: { tenantId: t.tenantId } })).toBe(1);
    expect(await db.patient.count({ where: { tenantId: t.tenantId } })).toBe(1);
    expect(await db.timeBlock.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("enforce: una tx de OTRO tenant en el mismo request (sin Actor de ese tenant: webhook, turnero) no se bloquea", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const t = await readOnlyTenant();
    const other = await tenant();
    asUser(t.userId);
    await getActor(); // deja el contexto del request en solo lectura para `t`
    const s = await runWithRls(other.tenantId, (tx) => tx.service.create({ data: newService(other.tenantId), select: { id: true } }));
    expect(s.id).toBeTruthy();
  });

  it("enforce: soporte dentro de una action supportWritable (C-BO4) sí escribe", async () => {
    const t = await readOnlyTenant();
    const s = await runWithRequestContext(
      { tenantId: t.tenantId, userId: t.userId, practitionerId: null, readOnly: true, supportWritable: true },
      () => runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId), select: { id: true } }))
    );
    expect(s.id).toBeTruthy();
    await expect(
      runWithRequestContext({ tenantId: t.tenantId, userId: t.userId, practitionerId: null, readOnly: true }, () =>
        runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId) }))
      )
    ).rejects.toBeInstanceOf(ReadOnlyModeError);
  });

  it("banner (default): no bloquea, pero el Actor trae el acceso real", async () => {
    const t = await readOnlyTenant();
    asUser(t.userId);
    const actor = await getActor();
    expect(actor.access.mode).toBe("read_only");
    const s = await runWithRls(actor.tenantId, (tx) => tx.service.create({ data: newService(actor.tenantId), select: { id: true } }));
    expect(s.id).toBeTruthy();
    expect(await updateUserPreferences({ palette: "mint" })).toMatchObject({ ok: true });
  });

  it("enforce + trial en gracia: escribe (grace = full para escribir)", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const t = await tenant();
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    asUser(t.userId);
    const actor = await getActor();
    expect(actor.access.mode).toBe("grace");
    const s = await runWithRls(actor.tenantId, (tx) => tx.service.create({ data: newService(actor.tenantId), select: { id: true } }));
    expect(s.id).toBeTruthy();
  });
});
