/**
 * EV1-D · catálogo global de ejercicios desde Plataforma (`lib/exercises-admin.ts`) contra Postgres real, con los
 * dos roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod). Símbolos reales con el
 * `requirePlatformAdmin` real; solo se mockea la sesión de Supabase (`asUser`) y `next/cache`.
 *
 * Se fija:
 *   - «Común/Pro» muerto: desde EV0 `Exercise.isBasic` no decide nada (`catalogScope` en lib/plan-gating.ts), así
 *     que crear/editar ya no lo escribe (zod descarta la clave), el filtro `tier` se ignora, el orden `tier` cae a
 *     nombre y la fila de la tabla no lo expone. La columna queda en la DB (sin migración).
 *   - búsqueda: Prisma NO escapa `%`/`_` en `contains` + `mode: "insensitive"` (ILIKE '%<texto>%'; medido en EV1-D):
 *     buscar «%» traía todo el catálogo. Ahora son literales.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  listGlobalExercisesForAdmin,
  createGlobalExercise,
  updateGlobalExercise,
} from "@/lib/exercises-admin";
import { asUser } from "@/tests/helpers/actor";
import { sanitizeCatalogPrefs, type CatalogFilters, type CatalogSortCol } from "@/lib/preferences-constants";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[EV1-D] exercises-admin · sin «Común/Pro» y búsqueda sin comodines", () => {
  let db: PrismaClient;
  let superId: string;
  const tag = uniqueSuffix().replace(/[^a-z0-9]/gi, "");
  const exerciseIds: string[] = [];

  async function newGlobal(name: string, isBasic: boolean) {
    const ex = await db.exercise.create({
      data: { slug: `ev1d-${uniqueSuffix()}`, name, isBasic, tenantId: null },
    });
    exerciseIds.push(ex.id);
    return ex;
  }

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super EV1-D", isPlatformAdmin: true },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    // Las escrituras dejan filas en PlatformAuditEvent (solo inserción → modo réplica).
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ${superId}`,
    ]);
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[EV1-D] buscar: `%` y `_` son literales", async () => {
    const pct = await newGlobal(`Plancha 100% ${tag}`, true);
    await newGlobal(`Plancha 1000 ${tag}`, true); // matchea `100%` si `%` fuera comodín
    const und = await newGlobal(`Puente A_B ${tag}`, false);
    await newGlobal(`Puente AxB ${tag}`, false); // matchea `A_B` si `_` fuera comodín
    asUser(superId);

    const byPct = await listGlobalExercisesForAdmin({ filters: { q: `100% ${tag}` } });
    expect(byPct.rows.map((r) => r.id)).toEqual([pct.id]);
    const byUnd = await listGlobalExercisesForAdmin({ filters: { q: `A_B ${tag}` } });
    expect(byUnd.rows.map((r) => r.id)).toEqual([und.id]);
    // «%» solo: sin escape traía todo el catálogo global.
    const onlyPct = await listGlobalExercisesForAdmin({ filters: { q: "%" } });
    expect(onlyPct.total).toBe(await db.exercise.count({ where: { tenantId: null, archivedAt: null, name: { contains: "\\%" } } }));
    expect(onlyPct.rows.map((r) => r.id)).toContain(pct.id);
    expect(onlyPct.rows.every((r) => r.name.includes("%"))).toBe(true);
  });

  it("[EV1-D] filtro `tier` y orden `tier` (URL/pref vieja) se ignoran; la fila no expone isBasic", async () => {
    const t = `${tag}tier`;
    const b = await newGlobal(`Zeta ${t}`, true);
    const p = await newGlobal(`Alfa ${t}`, false);
    asUser(superId);

    // `tier` ya no está en el tipo (EV1): se fuerza para fijar que una pref vieja que llegue cruda no filtra ni rompe.
    const comun = await listGlobalExercisesForAdmin({ filters: { q: t, tier: "comun" } as Partial<CatalogFilters> });
    const pro = await listGlobalExercisesForAdmin({ filters: { q: t, tier: "pro" } as Partial<CatalogFilters> });
    expect(comun.rows.map((r) => r.id).sort()).toEqual([b.id, p.id].sort());
    expect(pro.rows.map((r) => r.id).sort()).toEqual([b.id, p.id].sort());

    // Antes «tier asc» = Común primero (Zeta); ahora cae a nombre (Alfa primero).
    const sorted = await listGlobalExercisesForAdmin({ filters: { q: t }, sortCol: "tier" as unknown as CatalogSortCol, sortDir: "asc" });
    expect(sorted.rows.map((r) => r.id)).toEqual([p.id, b.id]);
    // Y la pref/URL vieja se normaliza antes de llegar al server.
    const clean = sanitizeCatalogPrefs({ sortCol: "tier", filters: { tier: "pro", q: "x" } });
    expect(clean.sortCol).toBe("name");
    expect(Object.keys(clean.filters)).not.toContain("tier");
    expect(Object.keys(sorted.rows[0])).not.toContain("isBasic");
  });

  it("[EV1-D] crear y editar no escriben isBasic aunque el cliente lo mande", async () => {
    asUser(superId);
    const created = await createGlobalExercise({ name: `Nuevo ${tag}`, isBasic: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    exerciseIds.push(created.data.id);
    // Default de la columna (false), no lo que mandó el cliente.
    expect((await db.exercise.findUniqueOrThrow({ where: { id: created.data.id } })).isBasic).toBe(false);

    const basic = await newGlobal(`Editable ${tag}`, true);
    const upd = await updateGlobalExercise({ id: basic.id, isBasic: false, difficulty: 3 });
    expect(upd.ok).toBe(true);
    const row = await db.exercise.findUniqueOrThrow({ where: { id: basic.id } });
    expect(row.isBasic).toBe(true);
    expect(row.difficulty).toBe(3);

    // El registro de plataforma lista solo las claves que sí se aplicaron.
    const audit = await db.platformAuditEvent.findFirstOrThrow({
      where: { actorId: superId, action: "platform.catalog.exercise.update", entityId: basic.id },
    });
    expect(audit.payload).toMatchObject({ changed: ["difficulty"] });
  });
});
