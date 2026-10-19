/**
 * FC-1d (C-FC11): el ESCRITOR real (`scripts/diagnosis-import.ts`) contra el
 * Postgres local, con los fixtures SINTÉTICOS de `tests/fixtures/icd11/`
 * (códigos 9Z**), nunca con la tabulación real de la OMS.
 *
 * Afirma el efecto observable en `DiagnosisCode` (filas, títulos oficiales sin
 * sangría, URI, release, retiro sin borrado) y en `CatalogImportRun` (kind y
 * sha256). Escribe por el canal owner/BYPASSRLS (`prismaService`), igual que
 * en prod; con el rol de la app tiene que negarse.
 *
 * `existingScope` limita lo «existente» al prefijo del fixture: la base local
 * es compartida y un import real retira todo lo que no viene en el archivo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { icdPlanHasChanges, summarizeIcdPlan } from "@/lib/diagnoses-import-core";
import { assertBypassRls, resolveImportTarget, runDiagnosisImport } from "../../scripts/diagnosis-import";
import { appRoleBypassesRls } from "../helpers/db-role";

const FIX = join(process.cwd(), "tests/fixtures/icd11");
const MINI = join(FIX, "simple-tabulation.mini.txt");
const V2 = join(FIX, "simple-tabulation.v2.txt");
const RAN_BY = "vitest-diagnosis-import";
const PREFIX = "9Z";
const SCOPE = { codePrefix: PREFIX };
const quiet = () => {};

const run = (file: string, release: string, apply: boolean, extra: Partial<Parameters<typeof runDiagnosisImport>[0]> = {}) =>
  runDiagnosisImport({ db: prismaService, file, release, apply, ranBy: RAN_BY, log: quiet, existingScope: SCOPE, ...extra });

async function cleanup() {
  // Los favoritos tienen FK RESTRICT: un test que dejó uno sobre un 9Z** haría fallar el borrado (y es correcto que falle).
  await prismaService.diagnosisCode.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prismaService.catalogImportRun.deleteMany({ where: { ranBy: RAN_BY } });
}

const rows = () =>
  prismaService.diagnosisCode.findMany({ where: { code: { startsWith: PREFIX } }, orderBy: { code: "asc" } });

beforeAll(cleanup);
afterAll(cleanup);

describe("[FC-1d] diagnosis-import (escritor, Docker local)", () => {
  it("[FC-1d] dry-run: planifica pero no escribe", async () => {
    const r = await run(MINI, "2025-01", false);
    expect(r.applied).toBe(false);
    expect(summarizeIcdPlan(r.plan)).toMatchObject({ create: 7, retire: 0, excluded: 3, conflicts: 0 });
    expect(await rows()).toEqual([]);
    expect(await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } })).toBe(0);
  });

  it("[FC-1d] --apply crea las categorías de 01-26 y V con título oficial, URI y release; registra CatalogImportRun con sha256", async () => {
    const r = await run(MINI, "2025-01", true);
    expect(r.result).toEqual({ created: 7, updated: 0, retired: 0, unretired: 0 });
    const all = await rows();
    expect(all.map((x) => x.code)).toEqual(["9Z10", "9Z10.0", "9Z10.Y", "9Z10.Z", "9Z11", "9Z1A", "9ZV1"]); // sin 9ZX1
    expect(all.find((x) => x.code === "9Z1A")).toMatchObject({
      system: "ICD11_MMS",
      title: "Contractura sintética del músculo cuádriceps, niño",
      uri: "http://id.who.int/icd/release/11/2025-01/mms/900000030",
      foundationUri: "http://id.who.int/icd/entity/900000030",
      chapter: "15",
      isLeaf: true,
      isResidual: false,
      release: "2025-01",
      language: "es",
      searchText: "9z1a contractura sintetica del musculo cuadriceps nino",
      retiredAt: null,
      retiredInRelease: null,
    });
    expect(all.find((x) => x.code === "9Z11")!.title).toBe("Cervicalgia sintética - tipo mecánico");

    const runs = await prismaService.catalogImportRun.findMany({ where: { ranBy: RAN_BY } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      file: "simple-tabulation.mini.txt",
      kind: "icd11-mms-es@2025-01",
      created: 7,
      updated: 0,
      skipped: 3,
      conflicts: [],
      sha256: createHash("sha256").update(readFileSync(MINI)).digest("hex"),
    });
  });

  it("[FC-1d] segunda corrida: 0 cambios y no toca updatedAt", async () => {
    const before = await rows();
    const r = await run(MINI, "2025-01", true);
    expect(icdPlanHasChanges(r.plan)).toBe(false);
    expect(r.result).toEqual({ created: 0, updated: 0, retired: 0, unretired: 0 });
    expect((await rows()).map((x) => x.updatedAt.getTime())).toEqual(before.map((x) => x.updatedAt.getTime()));
    expect(await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } })).toBe(2);
  });

  it("[FC-1d] v2 retira (sin borrar) y actualiza; un downgrade se rechaza", async () => {
    const r = await run(V2, "2026-01", true);
    expect(r.result).toEqual({ created: 1, updated: 6, retired: 1, unretired: 0 });
    const all = await rows();
    expect(all).toHaveLength(8); // nada se borró
    expect(all.find((x) => x.code === "9Z11")).toMatchObject({ retiredInRelease: "2026-01", release: "2025-01" });
    expect(all.find((x) => x.code === "9Z11")!.retiredAt).toBeInstanceOf(Date);
    expect(all.find((x) => x.code === "9Z10.0")).toMatchObject({
      title: "Lumbalgia sintética aguda con irradiación",
      release: "2026-01",
      uri: "http://id.who.int/icd/release/11/2026-01/mms/900000011",
    });
    expect(all.find((x) => x.code === "9Z12")).toMatchObject({ release: "2026-01", retiredAt: null });

    const snapshot = await rows();
    await expect(run(MINI, "2025-01", true)).rejects.toThrow(/downgrade rechazado/);
    expect(await rows()).toEqual(snapshot);

    // Idempotente también en v2.
    expect(icdPlanHasChanges((await run(V2, "2026-01", true)).plan)).toBe(false);
  });

  it("[FC-1d] --allow-downgrade reactiva lo retirado y retira lo nuevo", async () => {
    const r = await run(MINI, "2025-01", true, { allowDowngrade: true });
    expect(r.result).toMatchObject({ created: 0, retired: 1, unretired: 1 });
    const all = await rows();
    expect(all.find((x) => x.code === "9Z11")).toMatchObject({ retiredAt: null, retiredInRelease: null, release: "2025-01" });
    expect(all.find((x) => x.code === "9Z12")).toMatchObject({ retiredInRelease: "2025-01" });
  });

  it("[T4Z-B4] retiro masivo (archivo truncado): el --apply aborta sin escribir; con --allow-mass-retire pasa", async () => {
    // 30 vigentes más del alcance que V2 no trae: V2 retiraría 31 (30 + 9Z11) de 37, por encima del tope (25).
    await prismaService.diagnosisCode.createMany({
      data: ["Q", "R", "S"].flatMap((l) =>
        Array.from({ length: 10 }, (_, i) => ({
          code: `9Z${l}${i}`,
          title: `Sintético masivo ${l}${i}`,
          uri: `http://id.who.int/icd/release/11/2026-01/mms/9000009${l.charCodeAt(0)}${i}`,
          chapter: "01",
          release: "2026-01",
          searchText: `9z${l.toLowerCase()}${i} sintetico masivo`,
        })),
      ),
    });
    const before = await rows();
    const runs = await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } });
    const dry = await run(V2, "2026-01", false);
    expect(summarizeIcdPlan(dry.plan).retire).toBe(31);
    await expect(run(V2, "2026-01", true)).rejects.toThrow(/--allow-mass-retire/);
    expect(await rows()).toEqual(before);
    expect(await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } })).toBe(runs);

    const r = await run(V2, "2026-01", true, { allowMassRetire: true });
    expect(r.result).toMatchObject({ retired: 31 });
    expect(await prismaService.diagnosisCode.count({ where: { code: { startsWith: "9ZQ" }, retiredAt: null } })).toBe(0);
  });

  it("[FC-1d] --apply sin --by no escribe", async () => {
    const before = await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } });
    await expect(run(V2, "2026-01", true, { ranBy: null })).rejects.toThrow(/--by/);
    expect(await prismaService.catalogImportRun.count({ where: { ranBy: RAN_BY } })).toBe(before);
  });

  it("[FC-1d] sin BYPASSRLS el escritor se niega", async () => {
    if (await appRoleBypassesRls()) return; // test:integration:owner: el rol de la app ES owner
    const app = new PrismaClient();
    try {
      await expect(assertBypassRls(app)).rejects.toThrow(/BYPASSRLS/);
      await expect(runDiagnosisImport({ db: app, file: V2, release: "2026-01", apply: true, ranBy: RAN_BY, log: quiet })).rejects.toThrow(
        /BYPASSRLS/,
      );
    } finally {
      await app.$disconnect();
    }
  });

  it("[FC-1d] destino remoto sin confirmación aborta; con KINESOFT_CONFIRM_PROD=<ref> pasa; local libre", () => {
    // URLs falsas: assertSafeTarget decide antes de conectar.
    const remote = "postgresql://postgres.abcdefghijklmnop:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres";
    expect(() => resolveImportTarget({ DIRECT_URL: remote }, quiet)).toThrow(/KINESOFT_CONFIRM_PROD=abcdefghijklmnop/);
    expect(() => resolveImportTarget({ DIRECT_URL: remote, KINESOFT_CONFIRM_PROD: "otro" }, quiet)).toThrow(/destino remoto/);
    expect(resolveImportTarget({ DIRECT_URL: remote, KINESOFT_CONFIRM_PROD: "abcdefghijklmnop" }, quiet).target.isSupabase).toBe(true);
    // DIRECT_URL (owner) gana sobre DATABASE_URL (app).
    const local = resolveImportTarget(
      { DATABASE_URL: remote, DIRECT_URL: "postgresql://postgres:x@localhost:5433/kinesoft" },
      quiet,
    );
    expect(local).toMatchObject({ envName: "DIRECT_URL", target: { isLocal: true } });
    expect(() => resolveImportTarget({}, quiet)).toThrow(/Falta DATABASE_URL/);
  });
});
