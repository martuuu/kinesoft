/**
 * IAM-3a · elección de consultorio (C-IAM7, decisión 6 de Martin del 14-oct: «cada vez que inicia sesión con más
 * de un consultorio usable, la app le pregunta a cuál entrar»).
 *
 * Símbolos REALES contra Postgres en los dos roles: `getTenantChoiceState`/`setActiveTenant` (lib/tenant-choice.ts),
 * la action de `/elegir-consultorio`, los route handlers de login/logout y `getActor`. Se mockea solo la red de
 * Supabase (quién es el usuario; signIn/signOut OK) y la cookie (integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { ForbiddenError, UnauthenticatedError, getActor } from "@/lib/session";
import { getTenantChoiceState, setActiveTenant } from "@/lib/tenant-choice";
import { chooseTenantAction } from "@/app/elegir-consultorio/choose-action";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asAnonymous, asUser, currentTestUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

// La sesión la sigue diciendo tests/helpers/actor.ts; se suman signIn/signOut (los route handlers los llaman).
const sb = vi.hoisted(() => ({ signIns: 0, signOuts: 0 }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser: who } = await import("@/tests/helpers/actor");
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: who() }, error: null }),
        signInWithPassword: async () => {
          sb.signIns++;
          return { data: {}, error: null };
        },
        signOut: async () => {
          sb.signOuts++;
          return { error: null };
        },
      },
    }),
  };
});

const RUN = process.env.INTEGRATION === "1";
const COOKIE = "kine_tenant";

/** `redirect()` de Next tira un error con `digest = "NEXT_REDIRECT;<tipo>;<url>;<status>"`. */
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw e;
  }
  throw new Error("no redirigió");
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe.skipIf(!RUN)("[IAM-3a] elección de consultorio (C-IAM7)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db, { vertical: "GENERAL" });
    C = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: A.tenantId }, data: { name: `Zeta ${A.slug}` } });
    await db.tenant.update({ where: { id: B.tenantId }, data: { name: `Alfa ${B.slug}` } });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await C?.cleanup();
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
    cookies().delete(COOKIE);
    __rateLimitInternals.reset();
    asAnonymous();
  });

  async function newUser(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Ana María ${id}` } });
    users.push(id);
    return id;
  }

  async function join(userId: string, t: EphemeralTenant, o: { role?: Role; disabledAt?: Date | null; acceptedAt?: Date } = {}) {
    await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    await db.membership.create({
      data: { userId, tenantId: t.tenantId, role: o.role ?? "PRACTITIONER", acceptedAt: o.acceptedAt ?? new Date(), disabledAt: o.disabledAt ?? null },
    });
  }

  /** Usuario con A (aceptado antes, ADMIN), B (después, PRACTITIONER en GENERAL) y C suspendido. */
  async function multiUser(): Promise<string> {
    const u = await newUser();
    await join(u, A, { role: "ADMIN", acceptedAt: new Date(Date.now() - 3_600_000) });
    await join(u, B);
    await join(u, C, { disabledAt: new Date() });
    asUser(u);
    return u;
  }

  it("getTenantChoiceState: solo las usables, ordenadas por nombre, con rol y tipo; pide elegir sin cookie", async () => {
    await multiUser();
    const st = await getTenantChoiceState();
    expect(st.options).toEqual([
      { tenantId: B.tenantId, name: `Alfa ${B.slug}`, slug: B.slug, role: "PRACTITIONER", vertical: "GENERAL" },
      { tenantId: A.tenantId, name: `Zeta ${A.slug}`, slug: A.slug, role: "ADMIN", vertical: "KINESIOLOGY" },
    ]);
    expect(st.activeTenantId).toBe(B.tenantId); // aceptado más reciente
    expect(st.needsChoice).toBe(true);
  });

  it("setActiveTenant: cookie httpOnly = tenantId, UserPreferences.tenantId, y getActor entra ahí sin volver a preguntar", async () => {
    const u = await multiUser();
    await setActiveTenant(A.tenantId);
    expect(cookies().get(COOKIE)?.value).toBe(A.tenantId);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: u } })).tenantId).toBe(A.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
    expect(await getTenantChoiceState()).toMatchObject({ activeTenantId: A.tenantId, needsChoice: false });
    // Cambiar de nuevo actualiza la misma fila (upsert).
    await setActiveTenant(B.tenantId);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: u } })).tenantId).toBe(B.tenantId);
    expect((await getActor()).tenantId).toBe(B.tenantId);
  });

  it("setActiveTenant rechaza un consultorio ajeno, uno suspendido y basura: ForbiddenError, sin tocar cookie ni preferencia", async () => {
    const u = await multiUser();
    const outsider = await createEphemeralTenant(db);
    try {
      for (const bad of [outsider.tenantId, C.tenantId, "", " ", "x".repeat(200), A.slug]) {
        await expect(setActiveTenant(bad)).rejects.toBeInstanceOf(ForbiddenError);
      }
    } finally {
      await outsider.cleanup();
    }
    expect(cookies().get(COOKIE)).toBeUndefined();
    expect(await db.userPreferences.findUnique({ where: { userId: u } })).toBeNull();
  });

  it("setActiveTenant sin sesión: UnauthenticatedError", async () => {
    asAnonymous();
    await expect(setActiveTenant(A.tenantId)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("la action de /elegir-consultorio elige y vuelve a `next` saneado; ajeno → vuelve a la pantalla con error", async () => {
    await multiUser();
    expect(await redirectOf(chooseTenantAction(form({ tenantId: A.tenantId, next: "/agenda?d=2026-10-14" })))).toBe("/agenda?d=2026-10-14");
    expect(cookies().get(COOKIE)?.value).toBe(A.tenantId);
    // Open redirect y volver a la misma pantalla → /dashboard.
    expect(await redirectOf(chooseTenantAction(form({ tenantId: B.tenantId, next: "//evil.com" })))).toBe("/dashboard");
    expect(await redirectOf(chooseTenantAction(form({ tenantId: B.tenantId, next: "/elegir-consultorio?next=/x" })))).toBe("/dashboard");
    expect(cookies().get(COOKIE)?.value).toBe(B.tenantId);
    // Suspendido: no cambia nada y vuelve con el aviso.
    expect(await redirectOf(chooseTenantAction(form({ tenantId: C.tenantId, next: "/agenda" })))).toBe(
      "/elegir-consultorio?error=no_disponible&next=%2Fagenda"
    );
    expect(cookies().get(COOKIE)?.value).toBe(B.tenantId);
  });

  it("login borra la cookie: con 2+ consultorios vuelve a preguntar (decisión 6); logout también la borra", async () => {
    const u = await multiUser();
    await setActiveTenant(A.tenantId);
    expect((await getTenantChoiceState()).needsChoice).toBe(false);

    const res = await signIn(
      new Request("http://localhost:3000/api/auth/sign-in?next=/agenda", {
        method: "POST",
        body: form({ email: `${u}@test.local`, password: "una-clave" }),
      })
    );
    expect(sb.signIns).toBeGreaterThan(0);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/agenda");
    expect(cookies().get(COOKIE)?.value ?? "").toBe("");
    expect((await getTenantChoiceState()).needsChoice).toBe(true);
    // Sin cookie, una action que llegue igual tiene Actor (uno de sus consultorios usables); la pantalla pregunta.
    expect([A.tenantId, B.tenantId]).toContain((await getActor()).tenantId);

    await setActiveTenant(B.tenantId);
    const out = await signOut(new Request("http://localhost:3000/api/auth/sign-out", { method: "POST" }));
    expect(out.status).toBe(303);
    expect(sb.signOuts).toBeGreaterThan(0);
    expect(cookies().get(COOKIE)?.value ?? "").toBe("");
    expect(currentTestUser()).not.toBeNull(); // (la sesión del mock no cambia: lo que se afirma es la cookie)
  });

  it("login con credenciales malas NO toca la cookie (solo un login exitoso arranca de cero)", async () => {
    await multiUser();
    await setActiveTenant(A.tenantId);
    const res = await signIn(
      new Request("http://localhost:3000/api/auth/sign-in", { method: "POST", body: form({ email: "", password: "" }) })
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("missing_credentials");
    expect(cookies().get(COOKIE)?.value).toBe(A.tenantId);
  });
});
