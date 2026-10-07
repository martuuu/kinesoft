/**
 * Planes P2 · S13x — biblioteca por disciplina + `ensureTag` (lib/exercises.ts).
 *
 * Sobre los símbolos REALES de `lib/**` y el `getActor()` real; se mockea solo la
 * sesión de Supabase y `next/cache` (este archivo pisa el mock del setup para
 * CAPTURAR las claves de `unstable_cache`, sin dejar de ejecutar la función).
 *
 *  - Los 2 tags `DISCIPLINE` (`kinesiologia`, `osteopatia`) los inserta M1 en el
 *    catálogo global y filtran la biblioteca por disciplina. `Tag` es una tabla
 *    GLOBAL (sin tenantId): si un consultorio pudiera crear un tag DISCIPLINE, o
 *    "ocupar" uno de esos slugs con otro kind, contaminaba el filtro de todos.
 *  - `listExercises({disciplineSlug})` = con ese slug **o** sin ninguno de los
 *    dos; si el tag no existe, no filtra.
 *  - Claves de `unstable_cache` con `gate.catalogScope` (enmienda EV0): antes
 *    "none" (General) y "own" (Kine base) compartían la clave "basic", así que
 *    tras un cambio de vertical desde /plataforma se servía el slot del otro
 *    alcance.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { ensureTag, createExercise, listExercises, getExercise, loadFilterFacets } from "@/lib/exercises";
import { loadCatalog } from "@/lib/diagnosis";
import {
  ownerClient,
  createEphemeralTenant,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const cacheKeys = vi.hoisted(() => [] as string[][]);
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T, keyParts?: string[]) => {
    cacheKeys.push(keyParts ?? []);
    return fn;
  },
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_noStore: () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("P2-S13x · ejercicios por disciplina + ensureTag", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kine FREE: catalogScope "own"
  let P: EphemeralTenant; // Kine PRO: catalogScope "full"
  let G: EphemeralTenant; // General: catalogScope "none"
  const s = uniqueSuffix();
  const ids = { kine: "", osteo: "", none: "", foreignKine: "" };
  const createdTagSlugs: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    P = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO" });
    // M1 inserta los 2 tags; sin ellos el test no prueba nada.
    const disc = await db.tag.findMany({
      where: { slug: { in: ["kinesiologia", "osteopatia"] } },
      select: { slug: true, kind: true },
    });
    expect(disc.map((t) => `${t.slug}:${t.kind}`).sort()).toEqual([
      "kinesiologia:DISCIPLINE",
      "osteopatia:DISCIPLINE",
    ]);
    const mk = async (tenantId: string, name: string, tagSlug?: string) =>
      (
        await db.exercise.create({
          data: {
            tenantId,
            slug: `s13x-${name}-${s}`,
            name: `S13x ${name} ${s}`,
            ...(tagSlug ? { tags: { create: [{ tag: { connect: { slug: tagSlug } } }] } } : {}),
          },
          select: { id: true },
        })
      ).id;
    ids.kine = await mk(K.tenantId, "kine", "kinesiologia");
    ids.osteo = await mk(K.tenantId, "osteo", "osteopatia");
    ids.none = await mk(K.tenantId, "sin");
    ids.foreignKine = await mk(P.tenantId, "ajeno", "kinesiologia");
  });

  afterAll(async () => {
    asAnonymous();
    // `Tag` es global (no cascadea con el tenant).
    await db?.exerciseTag.deleteMany({ where: { tag: { slug: { startsWith: "s13x-" } } } });
    await db?.tag.deleteMany({ where: { slug: { startsWith: "s13x-" } } });
    if (createdTagSlugs.length) await db?.tag.deleteMany({ where: { slug: { in: createdTagSlugs } } });
    for (const t of [K, P, G]) await t?.cleanup();
    await db?.$disconnect();
  });

  // ── ensureTag ───────────────────────────────────────────────────────
  describe("ensureTag", () => {
    it("[P2-S13x] ensureTag('Kinesiología','DISCIPLINE') → rechazo", async () => {
      asUser(K.userId);
      await expect(ensureTag("Kinesiología", "DISCIPLINE")).rejects.toThrow();
      // Kind DISCIPLINE con un slug nuevo: tampoco se crea.
      const label = `s13x-disc-${s}`;
      await expect(ensureTag(label, "DISCIPLINE")).rejects.toThrow();
      expect(await db.tag.count({ where: { label } })).toBe(0);
    });

    it("slugs reservados de disciplina con otro kind → rechazo, el tag queda DISCIPLINE", async () => {
      asUser(K.userId);
      await expect(ensureTag("Osteopatía")).rejects.toThrow();
      await expect(ensureTag("kinesiologia", "GOAL")).rejects.toThrow();
      const t = await db.tag.findUnique({ where: { slug: "osteopatia" }, select: { kind: true } });
      expect(t?.kind).toBe("DISCIPLINE");
    });

    it("kinds fuera de la allowlist (diagnóstico) → rechazo y no crea", async () => {
      asUser(K.userId);
      const label = `s13x-zona-${s}`;
      await expect(ensureTag(label, "ZONE")).rejects.toThrow();
      expect(await db.tag.count({ where: { label } })).toBe(0);
    });

    it("control: GOAL / MUSCLE_GROUP / EQUIPMENT se crean", async () => {
      asUser(K.userId);
      const r = await ensureTag(`s13x-goal-${s}`, "GOAL");
      expect(r.slug).toBe(`s13x-goal-${s}`);
      const row = await db.tag.findUnique({ where: { slug: r.slug }, select: { kind: true } });
      expect(row?.kind).toBe("GOAL");
      await expect(ensureTag(`s13x-mg-${s}`, "MUSCLE_GROUP")).resolves.toBeTruthy();
      await expect(ensureTag(`s13x-eq-${s}`, "EQUIPMENT")).resolves.toBeTruthy();
    });

    it("preserva EV0 N2: General → Forbidden", async () => {
      asUser(G.userId);
      await expect(ensureTag(`s13x-g-${s}`)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  // ── createExercise ──────────────────────────────────────────────────
  describe("createExercise (auto-tags del texto libre)", () => {
    it("un grupo muscular 'Kinesiología' no vincula ni crea el tag de disciplina", async () => {
      asUser(K.userId);
      const name = `S13x alta ${s}`;
      const res = await createExercise({ name, muscleGroups: `Kinesiología, s13x-musculo-${s}`, equipment: "Osteopatía" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const links = await db.exerciseTag.findMany({
        where: { exerciseId: res.data.id },
        select: { tag: { select: { slug: true, kind: true } } },
      });
      expect(links.map((l) => `${l.tag.slug}:${l.tag.kind}`)).toEqual([`s13x-musculo-${s}:MUSCLE_GROUP`]);
    });

    it("preserva EV0 N2: General → copy del módulo, sin fila", async () => {
      asUser(G.userId);
      const res = await createExercise({ name: `S13x G ${s}` });
      expect(res.ok).toBe(false);
      expect(await db.exercise.count({ where: { tenantId: G.tenantId } })).toBe(0);
    });
  });

  // ── listExercises({disciplineSlug}) ────────────────────────────────
  describe("listExercises por disciplina", () => {
    const mine = async (f: Parameters<typeof listExercises>[0]) =>
      new Set((await listExercises({ kind: "all", q: s, ...f })).map((e) => e.id));

    it("kinesiologia → los de Kine + los sin disciplina; nunca los de otro consultorio", async () => {
      asUser(K.userId);
      const got = await mine({ disciplineSlug: "kinesiologia" });
      expect(got.has(ids.kine)).toBe(true);
      expect(got.has(ids.none)).toBe(true);
      expect(got.has(ids.osteo)).toBe(false);
      expect(got.has(ids.foreignKine)).toBe(false);
    });

    it("osteopatia → los de Osteo + los sin disciplina", async () => {
      asUser(K.userId);
      const got = await mine({ disciplineSlug: "osteopatia" });
      expect(got.has(ids.osteo)).toBe(true);
      expect(got.has(ids.none)).toBe(true);
      expect(got.has(ids.kine)).toBe(false);
    });

    it("sin disciplina o con un slug inexistente / que no es de disciplina → no filtra", async () => {
      asUser(K.userId);
      const all = await mine({});
      expect([ids.kine, ids.osteo, ids.none].every((id) => all.has(id))).toBe(true);
      expect(await mine({ disciplineSlug: `no-existe-${s}` })).toEqual(all);
      const goal = await ensureTag(`s13x-goal2-${s}`, "GOAL");
      expect(await mine({ disciplineSlug: goal.slug })).toEqual(all);
    });

    it("General sigue sin ver nada con el filtro", async () => {
      asUser(G.userId);
      expect(await listExercises({ kind: "all", disciplineSlug: "kinesiologia" })).toEqual([]);
    });
  });

  // ── claves de cache ─────────────────────────────────────────────────
  describe("claves de unstable_cache con catalogScope", () => {
    const keysFor = async (userId: string, run: () => Promise<unknown>) => {
      asUser(userId);
      cacheKeys.length = 0;
      await run();
      return cacheKeys.map((k) => k.join("|"));
    };

    it("getExercise / loadFilterFacets / loadCatalog distinguen none, own y full", async () => {
      for (const [t, scope] of [[G, "none"], [K, "own"], [P, "full"]] as const) {
        const ex = await keysFor(t.userId, () => getExercise(`s13x-kine-${s}`));
        expect(ex.some((k) => k.startsWith("exercise:slug|") && k.endsWith(`|${scope}`))).toBe(true);
        const facets = await keysFor(t.userId, () => loadFilterFacets());
        expect(facets.some((k) => k.startsWith("exercise-facets|") && k.includes(`"scope":"${scope}"`))).toBe(true);
        const dx = await keysFor(t.userId, () => loadCatalog());
        // General no tiene `diagnostico`: loadCatalog puede devolver vacío sin
        // pasar por la cache; si pasa, la clave lleva el alcance.
        const dxKey = dx.find((k) => k.startsWith("diagnosis:catalog|"));
        if (dxKey) expect(dxKey.endsWith(`|${scope}`)).toBe(true);
        else expect(scope).toBe("none");
      }
    });
  });
});
