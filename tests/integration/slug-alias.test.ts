/**
 * BO2-D · cambio de slug con alias permanente (BO-D9), contra Postgres real y con los dos roles.
 *
 * Se fija:
 *   - el slug viejo queda en `TenantSlugAlias` apuntando al CONSULTORIO; dos cambios seguidos → los dos alias
 *     resuelven al slug vigente;
 *   - un alias nunca choca con un slug vivo ni se reutiliza (tampoco el propio), validado en la misma tx;
 *   - carrera: B deja `x` mientras A pide `x` → A nunca se queda con `x` y ningún alias choca con un slug vivo;
 *   - `/c/<viejo>/booking` responde redirect PERMANENTE al nuevo (página real; `permanentRedirect` = 308, ver
 *     desvío en el reporte) sin leer la sesión ni hacer prefill;
 *   - el slug vivo gana sobre un alias (un alias pisado por un alta nueva no secuestra el turnero).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { changePlatformTenantSlug } from "@/lib/platform-tenant-lifecycle";
import { getPlatformTenantDetail, listPlatformTenants } from "@/lib/platform-tenants-read";
import { getPublicBookingGate, loadPublicBookingPage, resolveSlugAlias } from "@/lib/public-booking-internal";
import { getPublicClinic } from "@/lib/public-booking";
import PublicBookingPage from "@/app/(booking)/c/[slug]/booking/page";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { revalidatePathSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const STALE = "Otro cambio se guardó antes. Recargá y revisá.";

/** Slug válido y único (SLUG_RE: 3-40, minúsculas/números/guiones). */
const freshSlug = (p: string) => `${p}-${uniqueSuffix()}`.toLowerCase();

/** Lo que tira `permanentRedirect` de Next 14: `NEXT_REDIRECT;<tipo>;<url>;<status>`. */
function redirectOf(e: unknown): { url: string; status: number } | null {
  const digest = (e as { digest?: unknown })?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  const parts = digest.split(";");
  return { url: parts[2], status: Number(parts[3]) };
}

describe.skipIf(!RUN)("BO2-D · slug con alias 301", () => {
  let db: PrismaClient;
  let S: EphemeralTenant;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  const slugOf = async (id: string) => (await db.tenant.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug;
  const v = async (id: string) =>
    (await db.tenant.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.toISOString();
  const change = async (T: EphemeralTenant, slug: string) =>
    changePlatformTenantSlug({ tenantId: T.tenantId, expectedUpdatedAt: await v(T.tenantId), slug });

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    asAnonymous();
    await A?.cleanup();
    await B?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    revalidatePathSpy.mockClear();
    asUser(S.userId);
  });

  it("cambia el slug: el viejo queda como alias del consultorio, audit doble con from/to", async () => {
    const old = B.slug;
    const next = freshSlug("nuevo");
    const res = await change(B, `  ${next.toUpperCase()} `);
    expect(res.ok).toBe(true);
    expect(await slugOf(B.tenantId)).toBe(next);
    expect(await db.tenantSlugAlias.findUnique({ where: { slug: old } })).toMatchObject({ tenantId: B.tenantId });

    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: B.tenantId, action: "platform.tenant.slug" } });
    expect(ev.actorId).toBe(S.userId);
    expect(ev.payload).toMatchObject({ changed: ["slug"], before: { slug: old }, after: { slug: next } });
    expect(await db.platformAuditEvent.count({ where: { tenantId: B.tenantId, action: "platform.tenant.slug" } })).toBe(1);
    expect(revalidatePathSpy).toHaveBeenCalledWith(`/c/${old}/booking`);

    // DTO: alias vigentes; y la lista encuentra el consultorio por el slug viejo.
    const d = await getPlatformTenantDetail(B.tenantId);
    expect(d?.slugAliases).toEqual([old]);
    expect(d?.publicBookingPath).toBe(`/c/${next}/booking`);
    expect((await listPlatformTenants({ q: old })).rows.map((r) => r.id)).toEqual([B.tenantId]);
  });

  it("dos cambios seguidos: los dos alias resuelven al slug vigente; mismo slug = no-op", async () => {
    const first = (await db.tenantSlugAlias.findMany({ where: { tenantId: B.tenantId } }))[0].slug;
    const middle = await slugOf(B.tenantId);
    const last = freshSlug("ultimo");
    expect((await change(B, last)).ok).toBe(true);
    expect(await resolveSlugAlias(first)).toEqual({ tenantId: B.tenantId, slug: last });
    expect(await resolveSlugAlias(middle)).toEqual({ tenantId: B.tenantId, slug: last });

    const n = await db.auditEvent.count({ where: { tenantId: B.tenantId, action: "platform.tenant.slug" } });
    const before = await v(B.tenantId);
    const same = await change(B, last);
    expect(same).toEqual({ ok: true, data: { updatedAt: before } });
    expect(await db.auditEvent.count({ where: { tenantId: B.tenantId, action: "platform.tenant.slug" } })).toBe(n);
  });

  it("rechaza: slug vivo de otro, alias de otro, alias propio, reservado o inválido; CAS stale", async () => {
    const bAlias = (await db.tenantSlugAlias.findMany({ where: { tenantId: B.tenantId } }))[0].slug;
    const before = await slugOf(A.tenantId);
    const aliasCount = await db.tenantSlugAlias.count();

    expect(await change(A, await slugOf(B.tenantId))).toMatchObject({ ok: false, error: "Ese slug ya lo usa otro consultorio." });
    expect(await change(A, bAlias)).toMatchObject({ ok: false, fieldErrors: { slug: ["Ya se usó antes."] } });
    for (const bad of ["plataforma", "c", "ab", "-empieza-mal", "con espacio", "x".repeat(41), "ñandú"]) {
      __rateLimitInternals.reset(); // 10 por ventana (`tenant.slug.update`): acá se prueban 11 rechazos
      const r = await change(A, bad);
      expect(r.ok, bad).toBe(false);
    }
    // Volver al slug viejo PROPIO tampoco: un alias nunca se reutiliza.
    expect(await change(B, bAlias)).toMatchObject({ ok: false, fieldErrors: { slug: ["Ya se usó antes."] } });

    const stale = await changePlatformTenantSlug({
      tenantId: A.tenantId,
      expectedUpdatedAt: new Date(Date.parse(await v(A.tenantId)) - 1).toISOString(),
      slug: freshSlug("stale"),
    });
    expect(stale).toMatchObject({ ok: false, error: STALE });

    expect(await slugOf(A.tenantId)).toBe(before);
    expect(await db.tenantSlugAlias.count()).toBe(aliasCount);
  });

  it("carrera: B deja `x` mientras A pide `x` → A nunca se queda con `x` ni queda un alias que choque", async () => {
    for (let i = 0; i < 3; i++) {
      __rateLimitInternals.reset();
      const x = await slugOf(B.tenantId);
      const [ra, rb] = await Promise.all([change(A, x), change(B, freshSlug("huye"))]);
      expect(rb.ok).toBe(true);
      expect(ra.ok).toBe(false);
      expect(await slugOf(A.tenantId)).not.toBe(x);
    }
    // Invariante global: ningún alias es el slug vivo de un consultorio.
    const clash = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "TenantSlugAlias" a JOIN "Tenant" t ON t."slug" = a."slug"`;
    expect(Number(clash[0].n)).toBe(0);
  });

  it("/c/<viejo>/booking: redirect permanente al slug vigente, sin sesión ni prefill; el vigente abre", async () => {
    const current = await slugOf(B.tenantId);
    const old = (await db.tenantSlugAlias.findMany({ where: { tenantId: B.tenantId }, orderBy: { createdAt: "asc" } }))[0]
      .slug;
    expect(await getPublicBookingGate(old)).toEqual({ state: "moved", slug: current });
    expect(await loadPublicBookingPage(old)).toEqual({ state: "moved", slug: current });
    // Las actions del wizard no resuelven alias: el wizard siempre corre con el slug vigente.
    expect(await getPublicClinic(old)).toBeNull();

    const err = await PublicBookingPage({ params: { slug: old } }).then(
      () => null,
      (e) => e
    );
    expect(redirectOf(err)).toEqual({ url: `/c/${current}/booking`, status: 308 });

    expect(await getPublicBookingGate(current)).toEqual({ state: "open" });
    expect((await loadPublicBookingPage(current))?.state).toBe("open");
    expect(await getPublicBookingGate(`no-existe-${uniqueSuffix()}`)).toBeNull();
  });

  it("el slug vivo gana sobre un alias (alias pisado por un alta que no tomó el lock)", async () => {
    // Fixture directa: un alias de B con el slug vivo de A (lo que dejaría un `bootstrapTenant` que no mira alias).
    const aSlug = await slugOf(A.tenantId);
    await db.tenantSlugAlias.create({ data: { slug: aSlug, tenantId: B.tenantId } });
    try {
      expect(await getPublicBookingGate(aSlug)).toEqual({ state: "open" });
      const page = await loadPublicBookingPage(aSlug);
      expect(page?.state).toBe("open");
      if (page?.state === "open") expect(page.clinic.slug).toBe(aSlug);
    } finally {
      await db.tenantSlugAlias.delete({ where: { slug: aSlug } });
    }
  });
});
