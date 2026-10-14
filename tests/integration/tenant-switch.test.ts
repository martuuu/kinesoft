/**
 * IAM-3b · selector de consultorio en la app (decisión 6 de Martin del 14-oct: un usuario puede trabajar en varios
 * consultorios; después de elegir al entrar, cambia con el selector del sidebar).
 *
 * Símbolo REAL: la server action `switchTenant` (lib/tenant-switch.ts) sobre `setActiveTenant` (C-IAM7), contra
 * Postgres en los dos roles. Se mockea solo la red de Supabase (quién es el usuario, vía tests/helpers/actor.ts) y la
 * cookie (integration-setup). Efecto observable: la cookie `kine_tenant`, `UserPreferences.tenantId` y el consultorio
 * en el que entra `getActor` después; en los rechazos, que nada de eso cambie y que el error no nombre a nadie.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { getActor } from "@/lib/session";
import { switchTenant } from "@/lib/tenant-switch";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const COOKIE = "kine_tenant";

describe.skipIf(!RUN)("[IAM-3b] switchTenant (selector del sidebar)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  let outsider: EphemeralTenant;
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db, { vertical: "GENERAL" });
    C = await createEphemeralTenant(db);
    outsider = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: outsider.tenantId }, data: { name: `Ajeno ${outsider.slug}` } });
    await db.tenant.update({ where: { id: C.tenantId }, data: { name: `Suspendido ${C.slug}` } });
  });

  afterAll(async () => {
    for (const t of [A, B, C, outsider]) await t?.cleanup();
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
    asAnonymous();
  });

  async function join(userId: string, t: EphemeralTenant, o: { role?: Role; disabledAt?: Date | null } = {}) {
    await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    await db.membership.create({
      data: { userId, tenantId: t.tenantId, role: o.role ?? "PRACTITIONER", acceptedAt: new Date(), disabledAt: o.disabledAt ?? null },
    });
  }

  /** Usuario en A (ADMIN) y B (PRACTITIONER), suspendido en C; sin relación con `outsider`. */
  async function multiUser(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Ana Switch" } });
    users.push(id);
    await join(id, A, { role: "ADMIN" });
    await join(id, B);
    await join(id, C, { disabledAt: new Date() });
    asUser(id);
    return id;
  }

  it("cambia de consultorio: cookie = tenantId, preferencia persistida y getActor entra ahí", async () => {
    const u = await multiUser();
    expect(await switchTenant(A.tenantId)).toEqual({ ok: true, data: undefined });
    expect(cookies().get(COOKIE)?.value).toBe(A.tenantId);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: u } })).tenantId).toBe(A.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);

    expect(await switchTenant(B.tenantId)).toEqual({ ok: true, data: undefined });
    expect(cookies().get(COOKIE)?.value).toBe(B.tenantId);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: u } })).tenantId).toBe(B.tenantId);
    expect((await getActor()).tenantId).toBe(B.tenantId);
  });

  it("consultorio ajeno, suspendido, slug o basura: error en voseo que no nombra a nadie, sin tocar cookie ni preferencia", async () => {
    const u = await multiUser();
    await switchTenant(A.tenantId);
    for (const bad of [outsider.tenantId, C.tenantId, outsider.slug, "", "x".repeat(200)]) {
      const r = await switchTenant(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe("Ese consultorio ya no está disponible para tu usuario. Recargá la página y elegí otro.");
        // Nunca expone otros consultorios: ni nombre, ni slug, ni id en la respuesta.
        for (const leak of [outsider.slug, outsider.tenantId, C.slug, C.tenantId]) expect(JSON.stringify(r)).not.toContain(leak);
      }
    }
    expect(cookies().get(COOKIE)?.value).toBe(A.tenantId);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: u } })).tenantId).toBe(A.tenantId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
  });

  it("sin sesión: pide volver a entrar y no escribe nada", async () => {
    asAnonymous();
    expect(await switchTenant(A.tenantId)).toEqual({ ok: false, error: "Tu sesión venció. Volvé a iniciar sesión." });
    expect(cookies().get(COOKIE)).toBeUndefined();
  });

  it("un input que no es string (llamada adulterada) también se rechaza sin tirar", async () => {
    await multiUser();
    const r = await switchTenant(42 as unknown as string);
    expect(r.ok).toBe(false);
    expect(cookies().get(COOKIE)).toBeUndefined();
  });
});
