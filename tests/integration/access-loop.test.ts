/**
 * IAM-3a · acceso sin bucles (plan §19.1 [A] bucle de redirecciones, §19.2 decisión 6).
 *
 * El bug (14-oct): `buildActor` tomaba la membresía aceptada invitada más recientemente y, si en ese consultorio
 * no había `Practitioner`, tiraba `no_membership` aunque hubiera otro consultorio sano. El layout mandaba a
 * /onboarding, que veía membresías y decía «done» → /dashboard → layout → /onboarding → … Lo dispara un removido
 * que acepta otra invitación (Practitioner viejo en A sin membresía, membresía en B sin Practitioner de B).
 *
 * Símbolos REALES contra Postgres en los dos roles: `getActor`/`tryGetActor` (lib/session.ts),
 * `loadOnboardingContext` (lib/onboarding-internal.ts), `decideAppGate` (lib/onboarding-logic.ts). Se mockea solo
 * la sesión de Supabase y la cookie (integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { UnauthenticatedError, getAccessSnapshot, getActor, tryGetActor } from "@/lib/session";
import { getTenantChoiceState } from "@/lib/tenant-choice";
import { loadOnboardingContext } from "@/lib/onboarding-internal";
import { decideAppGate } from "@/lib/onboarding-logic";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[IAM-3a] acceso sin bucles", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      if (users.length) {
        await db.practitioner.deleteMany({ where: { userId: { in: users } } });
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete("kine_tenant");
  });

  async function newUser(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Loop ${id}` } });
    users.push(id);
    return id;
  }

  async function join(
    userId: string,
    t: EphemeralTenant,
    o: { role?: Role; practitioner?: boolean; membership?: boolean; acceptedAt?: Date | null; disabledAt?: Date | null; invitedAt?: Date } = {}
  ): Promise<void> {
    if (o.practitioner ?? true) await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    if (o.membership ?? true) {
      await db.membership.create({
        data: {
          userId,
          tenantId: t.tenantId,
          role: o.role ?? "PRACTITIONER",
          acceptedAt: o.acceptedAt === undefined ? new Date() : o.acceptedAt,
          disabledAt: o.disabledAt ?? null,
          invitedAt: o.invitedAt,
        },
      });
    }
  }

  const sessionUser = (id: string) => ({ id, email: `${id}@test.local`, emailVerified: true, fullName: null });

  /** Lo que haría el layout de la app con esta sesión (mismos símbolos que `app/(app)/layout.tsx`). */
  async function layoutGate(nextPath: string | null = null): Promise<string | null> {
    const actor = await tryGetActor();
    const snap = await getAccessSnapshot();
    const choice = await getTenantChoiceState();
    return decideAppGate({
      hasSession: !!snap,
      hasActor: !!actor,
      access: snap?.state ?? null,
      needsChoice: !!actor && !!snap && choice.needsChoice,
      role: actor ? (snap?.memberships.find((m) => m.tenantId === actor.tenantId)?.role ?? null) : null,
      onboardingCompleted: true,
      nextPath,
    });
  }

  // Arrancó como it.fails (verde contra el código de antes: tryGetActor null + loadOnboardingContext «done»).
  it("[IAM-3a] un removido que acepta otra invitación no queda en bucle", async () => {
    const u = await newUser();
    await join(u, A, { membership: false }); // Practitioner viejo en A, sin membresía (lo sacaron)
    await join(u, B, { practitioner: false }); // membresía en B sin Practitioner de B
    asUser(u);
    expect(await tryGetActor()).toBeNull();
    await expect(getActor()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect((await getAccessSnapshot())?.state).toEqual({ kind: "no_access", reason: "missing_practitioner" });
    // El layout ya no lo manda a /onboarding sino a /sin-acceso…
    expect(await layoutGate("/agenda")).toBe("/sin-acceso");
    // …y /onboarding (si va a mano) ya no dice «done» → /dashboard: le ofrece invitaciones o su propio alta.
    expect((await loadOnboardingContext(sessionUser(u))).kind).not.toBe("done");
  });

  // Arrancó como it.fails: la membresía rota, invitada después, tapaba a la sana y `buildActor` tiraba.
  it("[IAM-3a] una membresía rota no tira si hay otra usable", async () => {
    const u = await newUser();
    await join(u, A, { invitedAt: new Date(Date.now() - 60_000) });
    await join(u, B, { practitioner: false }); // invitada después: antes la elegía y tiraba
    asUser(u);
    const actor = await getActor();
    expect(actor).toMatchObject({ tenantId: A.tenantId, userId: u });
    expect(actor.practitionerId).toBe((await db.practitioner.findFirstOrThrow({ where: { userId: u, tenantId: A.tenantId } })).id);
    // Una sola usable: no hay nada que preguntar.
    expect((await getTenantChoiceState()).needsChoice).toBe(false);
    expect(await layoutGate()).toBeNull();
    expect((await loadOnboardingContext(sessionUser(u))).kind).toBe("done");
  });

  it("dos consultorios usables sin cookie: getActor entra al aceptado más reciente y el gate pide elegir", async () => {
    const u = await newUser();
    await join(u, A, { acceptedAt: new Date(Date.now() - 3_600_000) });
    // Invitado ANTES pero aceptado DESPUÉS: manda `acceptedAt`, no `invitedAt`.
    await join(u, B, { acceptedAt: new Date(), invitedAt: new Date(Date.now() - 7_200_000) });
    asUser(u);
    expect((await getActor()).tenantId).toBe(B.tenantId);
    const choice = await getTenantChoiceState();
    expect(choice.needsChoice).toBe(true);
    expect(choice.activeTenantId).toBe(B.tenantId);
    expect(choice.options.map((o) => o.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort());
    expect(await layoutGate("/agenda?d=2026-10-14")).toBe("/elegir-consultorio?next=%2Fagenda%3Fd%3D2026-10-14");
  });

  it("con cookie válida entra a ese consultorio y no pregunta", async () => {
    const u = await newUser();
    await join(u, A, { acceptedAt: new Date(Date.now() - 3_600_000) });
    await join(u, B);
    asUser(u);
    cookies().set("kine_tenant", A.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
    expect((await getTenantChoiceState()).needsChoice).toBe(false);
    expect(await layoutGate()).toBeNull();
  });

  it("cookie a un consultorio ajeno o no usable → se ignora", async () => {
    const u = await newUser();
    await join(u, A, { acceptedAt: new Date(Date.now() - 3_600_000) });
    await join(u, B, { disabledAt: new Date() }); // suspendido en B
    asUser(u);

    // Ajeno: C no es suyo (el slug o el id de otro consultorio no abren nada).
    const C = await createEphemeralTenant(db);
    try {
      cookies().set("kine_tenant", C.tenantId);
      expect((await getActor()).tenantId).toBe(A.tenantId);
      cookies().set("kine_tenant", C.slug);
      expect((await getActor()).tenantId).toBe(A.tenantId);
    } finally {
      await C.cleanup();
    }
    // No usable: suspendido en B.
    cookies().set("kine_tenant", B.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
    const snap = await getAccessSnapshot();
    expect(snap?.cookieValid).toBe(false);
    expect((await getTenantChoiceState()).options.map((o) => o.tenantId)).toEqual([A.tenantId]);
  });

  it("UserPreferences.tenantId ya no decide (decisión 6: la cookie es la única fuente); sin cookie manda el acceptedAt más reciente y se pregunta", async () => {
    const u = await newUser();
    await join(u, A, { acceptedAt: new Date(Date.now() - 3_600_000) });
    await join(u, B);
    await db.userPreferences.create({ data: { userId: u, tenantId: A.tenantId } });
    asUser(u);
    expect((await getActor()).tenantId).toBe(B.tenantId);
    expect((await getTenantChoiceState()).needsChoice).toBe(true);
  });

  it("todas las membresías con disabledAt → /sin-acceso (all_disabled), sin tirar", async () => {
    const u = await newUser();
    await join(u, A, { disabledAt: new Date() });
    await join(u, B, { disabledAt: new Date() });
    asUser(u);
    expect(await tryGetActor()).toBeNull();
    expect((await getAccessSnapshot())?.state).toEqual({ kind: "no_access", reason: "all_disabled" });
    expect(await layoutGate()).toBe("/sin-acceso");
    expect((await loadOnboardingContext(sessionUser(u))).kind).not.toBe("done");
  });

  it("solo membresías sin aceptar → /sin-acceso (pending_only)", async () => {
    const u = await newUser();
    await join(u, A, { acceptedAt: null });
    asUser(u);
    expect(await tryGetActor()).toBeNull();
    expect((await getAccessSnapshot())?.state).toEqual({ kind: "no_access", reason: "pending_only" });
    expect(await layoutGate()).toBe("/sin-acceso");
  });

  it("sin ninguna membresía → /onboarding; sin sesión → /login", async () => {
    const u = await newUser();
    asUser(u);
    expect(await layoutGate()).toBe("/onboarding");
    asAnonymous();
    expect(await getAccessSnapshot()).toBeNull();
    expect(await getTenantChoiceState()).toEqual({ options: [], activeTenantId: null, needsChoice: false });
    // (Sin sesión `tryGetActor` puede devolver el actor demo si KINESOFT_ALLOW_DEMO_ACTOR=1 en .env.local: el gate
    // de ese caso está en el unit. Acá: sin foto el gate manda al login.)
    expect(decideAppGate({ hasSession: false, hasActor: false, access: null, needsChoice: false, role: null, onboardingCompleted: false, nextPath: "/agenda" })).toBe("/login?next=%2Fagenda");
  });
});
