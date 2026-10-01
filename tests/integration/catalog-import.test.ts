/**
 * B1.1 CAT-import: el ESCRITOR real (`scripts/catalog-import.ts`) contra el
 * Postgres local, con fixtures chicos (`tests/fixtures/catalog/**`, slugs
 * `test-cat-*`), nunca con los CSV reales de `prisma/catalog/`.
 *
 * Afirma el efecto observable en las tablas: filas creadas con sus campos,
 * planes GLOBALES (`tenantId null`), fila curada intacta, seed create-only,
 * un `CatalogImportRun` por archivo y segunda corrida = 0 cambios. El
 * escritor usa el canal owner/BYPASSRLS (`prismaService`), igual que en prod;
 * con el rol de la app tiene que negarse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { CatalogFormatError, diffHasChanges, summarizeDiff } from "@/lib/catalog/import-core";
import { assertBypassRls, runCatalogImport } from "../../scripts/catalog-import";
import { appRoleBypassesRls } from "../helpers/db-role";

const FIX = join(process.cwd(), "tests/fixtures/catalog");
const RAN_BY = "vitest-catalog-import";
const PREFIX = "test-cat-";
const quiet = () => {};

const run = (dir: string, apply: boolean, only?: Parameters<typeof runCatalogImport>[0]["only"]) =>
  runCatalogImport({ db: prismaService, dir: join(FIX, dir), apply, only, ranBy: RAN_BY, log: quiet });

async function cleanup() {
  const db = prismaService;
  await db.payerPlan.deleteMany({ where: { payer: { slug: { startsWith: PREFIX } } } });
  await db.payer.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.practiceSpecialty.deleteMany({ where: { practice: { slug: { startsWith: PREFIX } } } });
  await db.practice.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.specialty.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.catalogImportRun.deleteMany({ where: { ranBy: RAN_BY } });
}

const counts = async () => ({
  specialties: await prismaService.specialty.count({ where: { slug: { startsWith: PREFIX } } }),
  practices: await prismaService.practice.count({ where: { slug: { startsWith: PREFIX } } }),
  links: await prismaService.practiceSpecialty.count({ where: { practice: { slug: { startsWith: PREFIX } } } }),
  payers: await prismaService.payer.count({ where: { slug: { startsWith: PREFIX } } }),
  plans: await prismaService.payerPlan.count({ where: { payer: { slug: { startsWith: PREFIX } } } }),
  runs: await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } }),
});

beforeAll(cleanup);
afterAll(cleanup);

describe("catalog-import (escritor, Docker local)", () => {
  it("dry-run: planifica pero no escribe nada", async () => {
    const r = await run("v1", false);
    expect(r.applied).toBe(false);
    expect(r.diffs.map(summarizeDiff).map((s) => [s.file, s.create, s.skipped, s.conflicts])).toEqual([
      ["specialties.csv", 2, 0, 0],
      ["practices.csv", 2, 0, 0],
      ["practice-specialties.csv", 2, 0, 1],
      ["payers.csv", 2, 0, 3],
      ["payer-plans.csv", 2, 0, 1],
      ["payers.seed-2026-09.csv", 1, 1, 0],
      ["payer-plans.seed-2026-09.csv", 1, 2, 0],
    ]);
    expect(await counts()).toEqual({ specialties: 0, practices: 0, links: 0, payers: 0, plans: 0, runs: 0 });
  });

  it("--apply: crea las filas válidas, saltea conflictos y registra un CatalogImportRun por archivo", async () => {
    await run("v1", true);
    expect(await counts()).toEqual({ specialties: 2, practices: 2, links: 2, payers: 3, plans: 3, runs: 7 });

    const osde = await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-osde" } });
    expect(osde).toMatchObject({
      name: "Test Cat OSDE",
      matchKey: "test cat osde",
      // "Test Cat O.S.D.E." tiene la misma matchKey que el nombre → no suma
      aliases: ["Test Cat Binario"],
      kind: "PREPAGA",
      legalName: "Test Cat Organización de Servicios Directos Empresarios",
      registryCode: "999901",
      cuit: "30-00000000-1",
      province: null,
      source: "RNEMP",
      sourceRef: "999901",
      curatedAt: null,
    });
    expect(osde.sourceDate.toISOString()).toBe("2026-09-30T00:00:00.000Z");

    const kine = await prismaService.practice.findUniqueOrThrow({ where: { slug: "test-cat-kinesioterapia" } });
    expect(kine).toMatchObject({
      name: "Test Cat Kinesioterapia, por sesión",
      code: "250102",
      nomenclador: "Nacional",
      defaultDurationMin: 45,
      source: "PMO",
    });

    // Conflictos e inválidas no se escribieron; el seed duplicado de OSDE tampoco.
    const slugs = (await prismaService.payer.findMany({ where: { slug: { startsWith: PREFIX } }, select: { slug: true } }))
      .map((p) => p.slug)
      .sort();
    expect(slugs).toEqual(["test-cat-galeno", "test-cat-osde", "test-cat-union"]);

    // Planes GLOBALES: tenantId null (el único parcial vive en SQL, sin @@unique en Prisma).
    const plans = await prismaService.payerPlan.findMany({
      where: { payer: { slug: { startsWith: PREFIX } } },
      select: { slug: true, tenantId: true, name: true, payer: { select: { slug: true } } },
      orderBy: { slug: "asc" },
    });
    expect(plans).toEqual([
      { slug: "test-cat-210", tenantId: null, name: "Test Cat 210", payer: { slug: "test-cat-osde" } },
      { slug: "test-cat-310", tenantId: null, name: "Test Cat 310", payer: { slug: "test-cat-osde" } },
      { slug: "test-cat-oro", tenantId: null, name: "Test Cat Oro", payer: { slug: "test-cat-galeno" } },
    ]);

    const runs = await prismaService.catalogImportRun.findMany({ where: { ranBy: RAN_BY }, orderBy: { ranAt: "asc" } });
    const payersRun = runs.find((r) => r.file === "payers.csv")!;
    expect(payersRun).toMatchObject({ kind: "payers", created: 2, updated: 0, skipped: 0 });
    expect(payersRun.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((payersRun.conflicts as { slug: string; reason: string }[]).map((c) => [c.slug, c.reason]).sort()).toEqual([
      ["test-cat-choque-a", "alias-ambiguo"],
      ["test-cat-choque-b", "alias-ambiguo"],
      ["test-cat-invalida", "invalido"],
    ]);
    expect(runs.find((r) => r.file === "payers.seed-2026-09.csv")).toMatchObject({ created: 1, skipped: 1 });
  });

  it("idempotente: la segunda corrida da 0 cambios y no toca updatedAt", async () => {
    const before = await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-osde" } });
    const r = await run("v1", true);
    expect(r.diffs.filter(diffHasChanges).map((d) => d.file)).toEqual([]);
    expect(r.results.every((x) => x.created === 0 && x.updated === 0)).toBe(true);
    const after = await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-osde" } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await counts()).runs).toBe(14); // un run por archivo, también sin cambios
  });

  it("fila curada: v2 no pisa nombre ni campos, solo suma alias; las no curadas se actualizan", async () => {
    await prismaService.payer.update({
      where: { slug: "test-cat-osde" },
      data: { name: "Test Cat OSDE Curada", matchKey: "test cat osde curada", legalName: "Curada SA", curatedAt: new Date() },
    });

    const r = await run("v2", true);
    const byFile = Object.fromEntries(r.diffs.map((d) => [d.file, summarizeDiff(d)]));
    expect(byFile["payers.csv"]).toMatchObject({ create: 0, update: 0, aliasAdd: 1, unchanged: 1, conflicts: 0 });
    expect(byFile["specialties.csv"]).toMatchObject({ update: 1, unchanged: 1 });
    expect(byFile["payer-plans.csv"]).toMatchObject({ update: 1, unchanged: 1 });
    expect(byFile["payers.seed-2026-09.csv"]).toMatchObject({ create: 0, skipped: 2 });

    const osde = await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-osde" } });
    expect(osde).toMatchObject({ name: "Test Cat OSDE Curada", matchKey: "test cat osde curada", legalName: "Curada SA" });
    expect(osde.sourceDate.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(osde.aliases).toEqual(["Test Cat Binario", "Test Cat OSDE Oficial", "Test Cat O.S.D.E.", "Test Cat Neo"]);

    // No curada: se renombra y el nombre viejo queda como alias.
    const osteo = await prismaService.specialty.findUniqueOrThrow({ where: { slug: "test-cat-osteopatia" } });
    expect(osteo).toMatchObject({
      name: "Test Cat Osteopatía Estructural",
      matchKey: "test cat osteopatia estructural",
      aliases: ["Test Cat Osteopatía"],
    });
    expect(osteo.sourceDate.toISOString()).toBe("2026-10-15T00:00:00.000Z");

    const plan210 = await prismaService.payerPlan.findFirstOrThrow({
      where: { slug: "test-cat-210", tenantId: null, payer: { slug: "test-cat-osde" } },
    });
    expect(plan210.name).toBe("Test Cat 210 Nuevo");

    // Seed create-only: el rename del seed de Galeno no se aplica.
    expect((await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-galeno" } })).name).toBe("Test Cat Galeno");

    // Y otra vez v2: nada.
    const again = await run("v2", true);
    expect(again.diffs.filter(diffHasChanges).map((d) => d.file)).toEqual([]);
  });

  it("origen de un merge (archivado + curado, su nombre es alias del destino): no se desarchiva ni da conflicto", async () => {
    // Lo que deja mergePayer de B1.3: origen archivado + curatedAt, conserva slug y matchKey.
    const union = await prismaService.payer.update({
      where: { slug: "test-cat-union" },
      data: { archivedAt: new Date(), curatedAt: new Date() },
    });
    await prismaService.payer.update({
      where: { slug: "test-cat-osde" },
      data: { aliases: { push: [union.name] } },
    });

    const r = await run("v2", true);
    const payers = summarizeDiff(r.diffs.find((d) => d.file === "payers.csv")!);
    expect(payers).toMatchObject({ create: 0, update: 0, aliasAdd: 0, archived: 1, conflicts: 0 });
    const after = await prismaService.payer.findUniqueOrThrow({ where: { slug: "test-cat-union" } });
    expect(after.archivedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBe(union.updatedAt.getTime());
  });

  it("--only=payers: procesa solo payers.csv y su seed", async () => {
    const r = await run("v2", false, "payers");
    expect(r.diffs.map((d) => d.file)).toEqual(["payers.csv", "payers.seed-2026-09.csv"]);
  });

  it("header fuera de contrato: aborta ANTES de escribir (ni siquiera los archivos sanos)", async () => {
    const before = await counts();
    await clearTestSpecialties();
    await expect(run("bad-header", true)).rejects.toBeInstanceOf(CatalogFormatError);
    // specialties.csv del mismo directorio era válido y NO se escribió.
    expect(await prismaService.specialty.count({ where: { slug: { startsWith: PREFIX } } })).toBe(0);
    expect((await counts()).runs).toBe(before.runs);
  });

  it("con el rol de la app (RLS) el escritor se niega", async () => {
    if (await appRoleBypassesRls()) return; // test:integration:owner: el rol de la app ES owner
    const app = new PrismaClient();
    try {
      await expect(assertBypassRls(app)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await app.$disconnect();
    }
  });
});

/** Deja specialties vacía para afirmar que el import abortado no creó nada. */
async function clearTestSpecialties() {
  await prismaService.practiceSpecialty.deleteMany({ where: { practice: { slug: { startsWith: PREFIX } } } });
  await prismaService.specialty.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}
