/**
 * PF-0b · sesión sin ida y vuelta a GoTrue + membresías en una sentencia, contra Postgres en los dos roles.
 *
 * Símbolos REALES: `getActor`, `getAccessSnapshot`, `getSessionBlock`, `loadAccessMemberships` (lib/session.ts),
 * `getTenantChoiceState` (lib/tenant-choice.ts) y `getSessionUser` (lib/session-user.ts) con la verificación local
 * de `lib/session-jwt.ts`. Se mockea solo lo externo: la cookie de Supabase (`getSession` devuelve el access token
 * que el test firma con el secreto del «proyecto»), GoTrue (`getUser`, que cuenta llamadas) y el ENV.
 *
 * El resto de la suite de integración sigue entrando por `getUser()` (su mock no tiene `getSession`: el camino
 * rápido cae a GoTrue, `lib/session-user.ts`); este archivo cubre el camino rápido de punta a punta.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { getAccessSnapshot, getActor, getSessionBlock, loadAccessMemberships, UnauthenticatedError } from "@/lib/session";
import { getTenantChoiceState } from "@/lib/tenant-choice";
import { getSessionUser } from "@/lib/session-user";
import { SUPPORT_COOKIE, makeSupportCookieValue } from "@/lib/support-session-internal";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const SECRET = "integration-pf0b-secret-not-a-real-key-0123456789";
const URL_PUB = "https://pf0b-test.supabase.co";
const ISS = `${URL_PUB}/auth/v1`;

const sb = vi.hoisted(() => ({ token: null as string | null, getUserCalls: 0, gotrueUserId: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: sb.token ? { access_token: sb.token } : null }, error: null }),
      // GoTrue: solo conoce lo que el test le diga (para los casos que caen acá).
      getUser: async () => {
        sb.getUserCalls++;
        return sb.gotrueUserId
          ? { data: { user: { id: sb.gotrueUserId, email: `${sb.gotrueUserId}@test.local`, email_confirmed_at: null, user_metadata: {} } }, error: null }
          : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
  }),
}));

const over = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k in over.values ? over.values[k] : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

const RUN = process.env.INTEGRATION === "1";
const COOKIE = "kine_tenant";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function tokenFor(sub: string, o: { exp?: number; iss?: string; secret?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: o.iss ?? ISS,
    sub,
    aud: "authenticated",
    exp: o.exp ?? now + 3600,
    iat: now - 5,
    email: `${sub}@test.local`,
    role: "authenticated",
    aal: "aal1",
    session_id: randomUUID(),
    user_metadata: {},
  };
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", o.secret ?? SECRET).update(input).digest("base64url")}`;
}

describe.skipIf(!RUN)("[PF-0b] sesión con JWT local", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db, { vertical: "GENERAL" });
    C = await createEphemeralTenant(db, { status: "SUSPENDED" });
  });

  afterAll(async () => {
    if (db) {
      await db.supportSession.deleteMany({ where: { superadminId: { in: users } } });
    }
    await A?.cleanup();
    await B?.cleanup();
    await C?.cleanup();
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
    over.values = { SUPABASE_JWT_SECRET: SECRET, NEXT_PUBLIC_SUPABASE_URL: URL_PUB };
    cookies().delete(COOKIE);
    cookies().delete(SUPPORT_COOKIE);
    sb.token = null;
    sb.getUserCalls = 0;
    sb.gotrueUserId = null;
  });

  /** Usuario de Supabase de verdad: id UUID (el `sub` de GoTrue). */
  async function newUser(o: { disabled?: boolean; platformAdmin?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.userProfile.create({
      data: {
        id,
        email: `${id}@test.local`,
        fullName: `Ana ${id.slice(0, 6)}`,
        isPlatformAdmin: !!o.platformAdmin,
        ...(o.disabled ? { disabledAt: new Date(), disabledReason: "test" } : {}),
      },
    });
    users.push(id);
    return id;
  }

  async function join(userId: string, t: EphemeralTenant, o: { role?: Role; practitioner?: boolean; acceptedAt?: Date | null; disabledAt?: Date | null } = {}) {
    if (o.practitioner !== false) await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    await db.membership.create({
      data: {
        userId,
        tenantId: t.tenantId,
        role: o.role ?? "PRACTITIONER",
        acceptedAt: o.acceptedAt === undefined ? new Date() : o.acceptedAt,
        disabledAt: o.disabledAt ?? null,
      },
    });
  }

  it("token válido → actor sin llamar a GoTrue", async () => {
    const u = await newUser();
    await join(u, A, { role: "OWNER" });
    sb.token = tokenFor(u);
    const actor = await getActor();
    expect(actor).toMatchObject({ userId: u, tenantId: A.tenantId, support: null });
    expect(actor.practitionerId).toEqual(expect.any(String));
    expect(sb.getUserCalls).toBe(0);
  });

  it("vencido / alterado / otra clave / otro iss → sin sesión (sin foto de acceso ni usuario)", async () => {
    // Se afirma sobre la foto y el usuario, no sobre `getActor`: con `KINESOFT_ALLOW_DEMO_ACTOR=1` (.env.local) un
    // request SIN sesión cae al actor demo en dev/test, y eso no es lo que se prueba acá.
    const u = await newUser();
    await join(u, A);
    const cases: Record<string, string> = {
      vencido: tokenFor(u, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      otraClave: tokenFor(u, { secret: "otra-clave-de-otro-proyecto-0123456789" }),
      otroIss: tokenFor(u, { iss: "https://otro.supabase.co/auth/v1" }),
    };
    const good = tokenFor(randomUUID()).split(".");
    const [, p] = tokenFor(u).split(".");
    cases.alterado = `${good[0]}.${p}.${good[2]}`; // payload de u con la firma de otro token
    for (const [name, tok] of Object.entries(cases)) {
      sb.token = tok;
      expect(await getSessionUser(), name).toBeNull();
      expect(await getAccessSnapshot(), name).toBeNull();
      expect(await getTenantChoiceState(), name).toEqual({ options: [], activeTenantId: null, needsChoice: false });
    }
    // El vencido no fue a la red; los otros tres los decidió GoTrue (que no los conoce), una vez por lectura.
    expect(sb.getUserCalls).toBe(3 * 3);
    // Control: el mismo usuario con un token bueno sí tiene foto.
    sb.token = tokenFor(u);
    expect((await getAccessSnapshot())?.userId).toBe(u);
  });

  it("usuario deshabilitado en la plataforma: con token válido igual queda cortado (disabledAt)", async () => {
    const u = await newUser({ disabled: true });
    await join(u, A, { role: "OWNER" });
    sb.token = tokenFor(u);
    // Con sesión (hay foto) no cae al demo: sin consultorio usable `getActor` tira.
    await expect(getActor()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect((await getAccessSnapshot())?.state.kind).not.toBe("ok");
    expect(await getSessionBlock()).toEqual({ kind: "user_disabled" });
    expect(sb.getUserCalls).toBe(0);
  });

  it("multi-consultorio: sin cookie pide elegir; con `kine_tenant` válida entra ahí; una cookie ajena se ignora", async () => {
    const u = await newUser();
    await join(u, A, { role: "ADMIN", acceptedAt: new Date(Date.now() - 3_600_000) });
    await join(u, B);
    await join(u, C, { role: "OWNER" }); // consultorio suspendido: no es usable
    sb.token = tokenFor(u);

    const st = await getTenantChoiceState();
    expect(st.options.map((o) => o.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort());
    expect(st.needsChoice).toBe(true);
    expect((await getActor()).tenantId).toBe(B.tenantId); // aceptado más reciente

    cookies().set(COOKIE, A.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
    expect(await getTenantChoiceState()).toMatchObject({ activeTenantId: A.tenantId, needsChoice: false });

    cookies().set(COOKIE, C.tenantId);
    expect((await getActor()).tenantId).toBe(B.tenantId);
    expect(sb.getUserCalls).toBe(0);
  });

  it("soporte: superadmin con sesión de soporte abierta entra al destino como antes", async () => {
    const s = await newUser({ platformAdmin: true });
    await join(s, B, { role: "OWNER" });
    const row = await db.supportSession.create({ data: { tenantId: A.tenantId, superadminId: s, reason: "PF-0b prueba de soporte" } });
    cookies().set(SUPPORT_COOKIE, makeSupportCookieValue(row.id, s));
    sb.token = tokenFor(s);
    const actor = await getActor();
    expect(actor).toMatchObject({ tenantId: A.tenantId, userId: s, isPlatformAdmin: true, practitionerId: null });
    expect(actor.support).toMatchObject({ sessionId: row.id });
    expect(sb.getUserCalls).toBe(0);
  });

  it("loadAccessMemberships (una sentencia) = la lectura anidada de Prisma de antes", async () => {
    const u = await newUser();
    await join(u, A, { role: "ADMIN" });
    await join(u, B, { role: "ASSISTANT", practitioner: false });
    await join(u, C, { role: "OWNER", acceptedAt: null, disabledAt: new Date("2026-10-01T12:00:00Z") });

    const got = await loadAccessMemberships(u);
    const ref = await db.userProfile.findUniqueOrThrow({
      where: { id: u },
      select: {
        fullName: true,
        email: true,
        isPlatformAdmin: true,
        disabledAt: true,
        memberships: {
          select: {
            tenantId: true,
            role: true,
            acceptedAt: true,
            disabledAt: true,
            tenant: {
              select: {
                id: true,
                slug: true,
                name: true,
                vertical: true,
                plan: true,
                publicBookingEnabled: true,
                onboardingCompletedAt: true,
                status: true,
                subscriptionStatus: true,
                trialEndsAt: true,
                subscriptionStatusChangedAt: true,
              },
            },
          },
        },
        practitioners: { select: { id: true, tenantId: true } },
      },
    });
    const prac = new Map(ref.practitioners.map((p) => [p.tenantId, p.id]));
    const expected = ref.memberships
      .map((m) => ({ ...m, hasPractitioner: prac.has(m.tenantId), practitionerId: prac.get(m.tenantId) ?? null }))
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
    expect(got.profile).toEqual({ fullName: ref.fullName, email: ref.email, isPlatformAdmin: false, disabledAt: null });
    expect([...got.memberships].sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1))).toEqual(expected);
    expect(got.memberships).toHaveLength(3);
    expect(got.preferredTenantId).toBeNull();
  });

  it("perfil sin membresías → perfil con lista vacía; usuario inexistente → null", async () => {
    const u = await newUser();
    expect(await loadAccessMemberships(u)).toMatchObject({ profile: { email: `${u}@test.local` }, memberships: [] });
    expect(await loadAccessMemberships(randomUUID())).toEqual({ profile: null, memberships: [], preferredTenantId: null });
  });
});
