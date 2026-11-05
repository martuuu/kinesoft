/**
 * CF3 (BR-L) · logo del consultorio dentro de la app: `GET /api/consultorio/logo?t=<tenantId>&v=<logoUpdatedAt ms>`.
 *
 * Corre el route handler REAL (`app/api/consultorio/logo/route.ts`) sobre la foto de acceso real (`getAccessSnapshot`
 * de lib/session.ts, que ahora trae `logoUpdatedAt` y `palette` en la MISMA sentencia) y `getTenantChoiceState` real.
 * Red mockeada: la sesión de Supabase (tests/helpers/actor.ts, vía integration-setup) y el admin client de Storage
 * (`tests/helpers/storage-fake.ts`). Se corre con los dos roles (`kinesoft_app` y owner BYPASSRLS).
 *
 * Lo observable: status, headers de cache, bytes servidos y que Storage NO se toque cuando no corresponde (sin
 * sesión, consultorio ajeno, `v` vieja).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { storageFake } from "@/tests/helpers/storage-fake";
import { jpeg, png } from "@/tests/helpers/image-bytes";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { __rateLimitInternals } from "@/lib/rate-limit";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});

const RUN = process.env.INTEGRATION === "1";
const BUCKET = "practice-assets";
const ORIGIN = "http://localhost";

describe.skipIf(!RUN)("[CF3-BRL] logo del consultorio en la app", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let A: EphemeralTenant; // con logo PNG
  let B: EphemeralTenant; // ajeno, con logo
  let J: EphemeralTenant; // con logo JPEG
  let NOLOGO: EphemeralTenant;
  const logoAt = new Date("2026-11-05T12:00:00.000Z");
  const vA = String(logoAt.getTime());
  const route = () => import("@/app/api/consultorio/logo/route");
  const get = async (qs: string) => (await route()).GET(new Request(`${ORIGIN}/api/consultorio/logo${qs}`));
  const downloads = () => storageFake.calls.filter((c) => c.op === "download");

  async function withLogo(t: EphemeralTenant, bytes: Uint8Array, mime: string, at = logoAt): Promise<string> {
    const key = `${t.tenantId}/logo/${uniqueSuffix()}.${mime === "image/jpeg" ? "jpg" : "png"}`;
    await db.tenant.update({ where: { id: t.tenantId }, data: { logoStorageKey: key, logoUpdatedAt: at } });
    storageFake.put(BUCKET, key, bytes, mime);
    return key;
  }

  beforeAll(async () => {
    if (!RUN) return;
    db = ownerClient();
    storageFake.reset();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    J = await createEphemeralTenant(db);
    NOLOGO = await createEphemeralTenant(db);
    tenants.push(A, B, J, NOLOGO);
    await withLogo(A, png(40, 20), "image/png");
    await withLogo(B, png(10, 10), "image/png");
    await withLogo(J, jpeg(30, 30), "image/jpeg");
    await db.tenant.update({ where: { id: A.tenantId }, data: { palette: "mint" } });
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db && users.length) {
      await db.membership.deleteMany({ where: { userId: { in: users } } });
      await db.practitioner.deleteMany({ where: { userId: { in: users } } });
      await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
      await db.userProfile.deleteMany({ where: { id: { in: users } } });
    }
    await db?.$disconnect();
    storageFake.reset();
  });

  beforeEach(() => {
    cookies().delete("kine_tenant");
    __rateLimitInternals.reset();
    storageFake.calls = [];
    asAnonymous();
  });

  afterEach(() => {
    asAnonymous();
  });

  it("[CF3-BRL1] sin sesión → 401 no-store, sin tocar Storage", async () => {
    for (const qs of [`?t=${A.tenantId}&v=${vA}`, "", `?t=${A.tenantId}`]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(401);
      expect(res.headers.get("cache-control"), qs).toBe("private, no-store");
    }
    expect(downloads()).toEqual([]);
  });

  it("[CF3-BRL2] miembro con ?t y ?v vigentes → 200, PNG real, cache privada inmutable y nosniff", async () => {
    asUser(A.userId);
    const res = await get(`?t=${A.tenantId}&v=${vA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(40, 20));
    expect(downloads()).toHaveLength(1);
  });

  it("[CF3-BRL3] el Content-Type sale de los bytes (JPEG), no de la subida", async () => {
    asUser(J.userId);
    const res = await get(`?t=${J.tenantId}&v=${logoAt.getTime()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("[CF3-BRL4] consultorio ajeno (con logo) → 404 privado, sin tocar Storage; igual que un id inexistente o roto", async () => {
    asUser(A.userId);
    for (const qs of [`?t=${B.tenantId}&v=${logoAt.getTime()}`, `?t=${B.tenantId}`, "?t=no-existe&v=1", "?t=%27%3B--&v=1"]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(404);
      expect(res.headers.get("cache-control"), qs).toBe("private, no-store");
    }
    expect(downloads()).toEqual([]);
  });

  it("[CF3-BRL5] sin ?v, con una vieja o al azar → 308 a ?t&v vigentes, privado, sin bajar nada", async () => {
    asUser(A.userId);
    for (const v of [undefined, "123", "", "zzz", `${vA}0`]) {
      storageFake.calls = [];
      const res = await get(`?t=${A.tenantId}${v === undefined ? "" : `&v=${v}`}`);
      expect(res.status, String(v)).toBe(308);
      const loc = new URL(res.headers.get("location")!, ORIGIN);
      expect(loc.pathname).toBe("/api/consultorio/logo");
      expect([...loc.searchParams.entries()]).toEqual([
        ["t", A.tenantId],
        ["v", vA],
      ]);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(downloads(), String(v)).toEqual([]);
    }
  });

  // CF3 ZF4a (M, auditoría de PH-S): antes solo se miraba `v`, así que `?t=&v=<vigente>&x=<random>` bajaba el objeto de
  // Storage en cada request (cada query distinta es otra clave de cache del navegador; el rate limit era la única red).
  it("[CF3-ZF4a2] ?t y ?v vigentes con un parámetro de más, repetido o en otro orden → 308 a la canónica sin bajar el objeto", async () => {
    asUser(A.userId);
    for (const qs of [
      `?t=${A.tenantId}&v=${vA}&x=1`,
      `?t=${A.tenantId}&v=${vA}&utm_source=mail`,
      `?t=${A.tenantId}&v=${vA}&v=${vA}`,
      `?t=${A.tenantId}&t=${A.tenantId}&v=${vA}`,
      `?v=${vA}&t=${A.tenantId}`,
      `?t=${A.tenantId}&v=${vA}&`,
    ]) {
      storageFake.calls = [];
      const res = await get(qs);
      expect(res.status, qs).toBe(308);
      const loc = new URL(res.headers.get("location")!, ORIGIN);
      expect(loc.pathname).toBe("/api/consultorio/logo");
      expect([...loc.searchParams.entries()], qs).toEqual([
        ["t", A.tenantId],
        ["v", vA],
      ]);
      expect(res.headers.get("cache-control"), qs).toBe("private, no-store");
      expect(downloads(), qs).toEqual([]);
    }
    // La canónica exacta sigue bajando los bytes.
    expect((await get(`?t=${A.tenantId}&v=${vA}`)).status).toBe(200);
  });

  it("[CF3-BRL6] sin ?t = el consultorio activo del actor → 308 a su URL vigente", async () => {
    asUser(A.userId);
    const res = await get("");
    expect(res.status).toBe(308);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.searchParams.get("t")).toBe(A.tenantId);
    expect(loc.searchParams.get("v")).toBe(vA);
    expect(downloads()).toEqual([]);
  });

  it("[CF3-BRL7] consultorio sin logo → 404 (con y sin ?v)", async () => {
    asUser(NOLOGO.userId);
    expect((await get(`?t=${NOLOGO.tenantId}&v=1`)).status).toBe(404);
    expect((await get(`?t=${NOLOGO.tenantId}`)).status).toBe(404);
    expect((await get("")).status).toBe(404);
  });

  it("[CF3-BRL8] membresía deshabilitada en ese consultorio → 404 (aunque tenga otro usable)", async () => {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Ana Logo" } });
    for (const [t, disabledAt] of [
      [A, null],
      [B, new Date()],
    ] as const) {
      await db.practitioner.create({ data: { tenantId: t.tenantId, userId: id, specialty: "Test" } });
      await db.membership.create({ data: { userId: id, tenantId: t.tenantId, role: "PRACTITIONER", acceptedAt: new Date(), disabledAt } });
    }
    asUser(id);
    expect((await get(`?t=${B.tenantId}&v=${logoAt.getTime()}`)).status).toBe(404);
    expect((await get(`?t=${A.tenantId}&v=${vA}`)).status).toBe(200);
  });

  it("[CF3-BRL9] superadmin SIN membresía en el consultorio → 404 (la plataforma no da acceso al logo)", async () => {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Root", isPlatformAdmin: true } });
    await db.practitioner.create({ data: { tenantId: NOLOGO.tenantId, userId: id, specialty: "Test" } });
    await db.membership.create({ data: { userId: id, tenantId: NOLOGO.tenantId, role: "OWNER", acceptedAt: new Date() } });
    asUser(id);
    expect((await get(`?t=${A.tenantId}&v=${vA}`)).status).toBe(404);
    expect(downloads()).toEqual([]);
  });

  it("[CF3-BRL10] con la 2FA pendiente → 401 (sin el segundo factor la sesión no ve sus consultorios)", async () => {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Dos Pasos", twoFactorEmail: true } });
    await db.practitioner.create({ data: { tenantId: A.tenantId, userId: id, specialty: "Test" } });
    await db.membership.create({ data: { userId: id, tenantId: A.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    asUser(id);
    const res = await get(`?t=${A.tenantId}&v=${vA}`);
    expect(res.status).toBe(401);
    expect(downloads()).toEqual([]);
  });

  it("[CF3-BRL11] objeto reemplazado por algo que no es PNG/JPEG → 404 no-store", async () => {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    const at = new Date("2026-11-05T13:00:00.000Z");
    await withLogo(t, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png", at);
    asUser(t.userId);
    const res = await get(`?t=${t.tenantId}&v=${at.getTime()}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("[CF3-BRL12] rate limit por usuario solo en la descarga: pasado el tope → 429; el 308 no consume cupo", async () => {
    const { TENANT_LOGO_RATE_LIMIT } = await import("@/lib/tenant-logo");
    asUser(A.userId);
    for (let i = 0; i < 5; i++) expect((await get(`?t=${A.tenantId}&v=1`)).status).toBe(308);
    for (let i = 0; i < TENANT_LOGO_RATE_LIMIT.limit; i++) {
      expect((await get(`?t=${A.tenantId}&v=${vA}`)).status, String(i)).toBe(200);
    }
    const res = await get(`?t=${A.tenantId}&v=${vA}`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("[CF3-BRL13] la foto trae logo y paleta: getTenantChoiceState arma la URL por consultorio en la misma lectura", async () => {
    const { getTenantChoiceState } = await import("@/lib/tenant-choice");
    const { getAccessSnapshot } = await import("@/lib/session");
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Multi" } });
    for (const t of [A, NOLOGO]) {
      await db.practitioner.create({ data: { tenantId: t.tenantId, userId: id, specialty: "Test" } });
      await db.membership.create({ data: { userId: id, tenantId: t.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    }
    asUser(id);
    const snap = await getAccessSnapshot();
    const mA = snap!.memberships.find((m) => m.tenantId === A.tenantId)!;
    expect(mA.tenant.logoUpdatedAt?.getTime()).toBe(logoAt.getTime());
    expect(mA.tenant.palette).toBe("mint");
    const { options } = await getTenantChoiceState();
    const byId = new Map(options.map((o) => [o.tenantId, o.logoUrl]));
    expect(byId.get(A.tenantId)).toBe(`/api/consultorio/logo?t=${A.tenantId}&v=${vA}`);
    expect(byId.get(NOLOGO.tenantId)).toBeNull();
  });

  it("[CF3-BRL14] el layout real de (app) le pasa al shell la marca del consultorio activo (nombre, logo, paleta)", async () => {
    const { default: AppLayout } = await import("@/app/(app)/layout");
    const { isValidElement } = await import("react");
    /** El elemento del árbol que recibe `brand` (el AppShell), sin depender de la identidad del componente. */
    const findBrand = (node: unknown): unknown => {
      if (Array.isArray(node)) {
        for (const n of node) {
          const r = findBrand(n);
          if (r !== undefined) return r;
        }
        return undefined;
      }
      if (!isValidElement(node)) return undefined;
      const props = node.props as { brand?: unknown; children?: unknown };
      return "brand" in props ? props.brand : findBrand(props.children);
    };
    const name = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } })).name;
    asUser(A.userId);
    expect(findBrand(await AppLayout({ children: null }))).toEqual({
      name,
      logoUrl: `/api/consultorio/logo?t=${A.tenantId}&v=${vA}`,
      palette: "mint",
    });
    asUser(NOLOGO.userId);
    expect(findBrand(await AppLayout({ children: null }))).toMatchObject({ logoUrl: null, palette: "sky" });
  });
});
