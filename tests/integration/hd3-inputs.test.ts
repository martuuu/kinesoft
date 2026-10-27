/**
 * PV · HD-3 (W1c) — zod y topes de entrada en ejercicios, sesiones, búsqueda, archivos, diagnóstico, timeline y media.
 *
 * Por qué: Next expone TODO export de un archivo `"use server"` como RPC. Sin topes, un cliente podía crear miles de
 * `Tag` GLOBALES (auto-tags de texto libre, compartidos por todos los consultorios), pedir listas sin `take`, mandar
 * strings gigantes (el límite de body es 4.5mb) o tirar la action con un tipo inesperado (`q.trim` de un no-string).
 *
 * Sobre los símbolos REALES de `lib/**` y el `getActor()` real; se mockea solo la sesión de Supabase (setup), `next/cache`
 * (setup) y el admin client de Storage (como `files-read-only.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createExercise, listExercises } from "@/lib/exercises";
import { addSessionExercise, reorderSessionExercises } from "@/lib/sessions";
import { globalSearch } from "@/lib/search";
import { uploadPatientFile } from "@/lib/files";
import { searchPatientsForAssignment } from "@/lib/diagnosis";
import { getPatientTimeline } from "@/lib/clinical-notes-read";
import { reorderExerciseMedia } from "@/lib/exercise-media";
import {
  addPatient,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan } from "@/tests/helpers/plan-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async (key: string) => ({ data: { path: key }, error: null }),
        createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://signed.test/${key}` }, error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
  }),
}));

// Prefijo corto (minúsculas/dígitos) para los slugs de tags: el campo de texto libre tiene tope de 200 caracteres.
const TOK = `h3${Math.random().toString(36).slice(2, 8)}`;
const tagCount = (db: PrismaClient) => db.tag.count({ where: { slug: { startsWith: TOK } } });

describe.skipIf(!RUN)("[HD-3] zod y topes de entrada (W1c)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let superId: string;
  let baseTagSlug: string;
  const globalExerciseIds: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super HD-3", isPlatformAdmin: true },
    });
    baseTagSlug = `${TOK}base`;
    await db.tag.create({ data: { slug: baseTagSlug, label: baseTagSlug, kind: "GOAL" } });
  });

  afterAll(async () => {
    asAnonymous();
    if (!db) return;
    await db.exerciseTag.deleteMany({ where: { tag: { slug: { startsWith: TOK } } } });
    await db.tag.deleteMany({ where: { slug: { startsWith: TOK } } });
    await db.exercise.deleteMany({ where: { id: { in: globalExerciseIds } } });
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ${superId}`,
    ]);
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  const exerciseCount = () => db.exercise.count({ where: { tenantId: A.tenantId } });

  // ── createExercise ──────────────────────────────────────────────────
  it("[HD-3] createExercise rechaza entradas fuera de tope sin crear filas (name 121, 21 tagSlugs, número no finito)", async () => {
    asUser(A.userId);
    const before = await exerciseCount();
    const tagsBefore = await tagCount(db);
    const bad: Parameters<typeof createExercise>[0][] = [
      { name: "a".repeat(121) },
      { name: `HD3 tags ${TOK}`, tagSlugs: Array.from({ length: 21 }, () => baseTagSlug) },
      { name: `HD3 inf ${TOK}`, difficulty: Number.POSITIVE_INFINITY },
      { name: `HD3 desc ${TOK}`, description: "d".repeat(2001) },
      { name: `HD3 kind ${TOK}`, kind: "FOO" as never },
      { name: `HD3 mg ${TOK}`, muscleGroups: "m".repeat(201) },
    ];
    for (const input of bad) {
      const r = await createExercise(input);
      expect(r.ok, JSON.stringify(input).slice(0, 80)).toBe(false);
      if (!r.ok) expect(r.error).toBeTruthy();
    }
    expect(await exerciseCount()).toBe(before);
    expect(await tagCount(db)).toBe(tagsBefore);
  });

  it("[HD-3] createExercise no vincula slugs reservados ni crea más de 10 auto-tags por campo (ni de más de 40)", async () => {
    asUser(A.userId);
    const tagsBefore = await tagCount(db);
    const labels = Array.from({ length: 15 }, (_, i) => `${TOK}m${i}`);
    const long = `${TOK}${"e".repeat(40)}`; // > 40 caracteres
    const r = await createExercise({
      name: `HD3 alta ${TOK}`,
      muscleGroups: labels.join(", "),
      equipment: long,
      tagSlugs: ["kinesiologia", baseTagSlug],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sin `Tag` nuevo por encima del tope: 10 del grupo muscular, ninguno del equipamiento largo.
    expect((await tagCount(db)) - tagsBefore).toBe(10);
    const links = await db.exerciseTag.findMany({
      where: { exerciseId: r.data.id },
      select: { tag: { select: { slug: true, kind: true } } },
    });
    expect(links.some((l) => l.tag.kind === "DISCIPLINE")).toBe(false);
    expect(links.some((l) => l.tag.slug === baseTagSlug)).toBe(true);
    expect(links.filter((l) => l.tag.kind === "MUSCLE_GROUP")).toHaveLength(10);
    // El texto libre se guarda completo (solo se acota la creación de tags).
    const ex = await db.exercise.findUniqueOrThrow({ where: { id: r.data.id }, select: { muscleGroups: true, equipment: true } });
    expect(ex.muscleGroups).toBe(labels.join(", "));
    expect(ex.equipment).toBe(long);
  });

  it("control: createExercise conserva los clamps de los números finitos", async () => {
    asUser(A.userId);
    const r = await createExercise({ name: `HD3 clamp ${TOK}`, difficulty: 99, defaultSets: 0, defaultReps: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ex = await db.exercise.findUniqueOrThrow({
      where: { id: r.data.id },
      select: { difficulty: true, defaultSets: true, defaultReps: true },
    });
    expect(ex).toEqual({ difficulty: 5, defaultSets: 1, defaultReps: 100 });
  });

  // ── listExercises ───────────────────────────────────────────────────
  it("[HD-3] listExercises: entrada inválida → [] sin tirar; nunca más de 1000 filas", async () => {
    asUser(A.userId);
    expect(await listExercises({ q: ["a"] as never })).toEqual([]);
    expect(await listExercises({ q: "x".repeat(101) })).toEqual([]);
    expect(await listExercises({ difficulty: Number.NaN })).toEqual([]);
    expect(await listExercises({ difficulty: 7 })).toEqual([]);
    expect(await listExercises({ muscleGroup: "m".repeat(65) })).toEqual([]);

    await db.exercise.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        tenantId: A.tenantId,
        slug: `${TOK}-bulk-${i}`,
        name: `HD3 bulk ${i}`,
      })),
    });
    const rows = await listExercises({ kind: "all", privateOnly: true });
    expect(rows.length).toBe(1000);
  });

  // ── sesiones ────────────────────────────────────────────────────────
  it("[HD-3] addSessionExercise / reorderSessionExercises: fuera de tope → {ok:false} sin filas ni cambios", async () => {
    asUser(A.userId);
    const plan = await createPlan(db, A, { sessions: 1 });
    const sessionId = plan.sessionIds[0];
    const ex = await db.exercise.create({
      data: { tenantId: A.tenantId, slug: `${TOK}-sess-${uniqueSuffix()}`, name: `HD3 sess ${TOK}` },
    });
    const ok = await addSessionExercise({ sessionId, exerciseId: ex.id, sets: 3, reps: 10 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const rowsBefore = await db.sessionExercise.count({ where: { sessionId } });

    expect((await addSessionExercise({ sessionId, exerciseId: ex.id, sets: -5 })).ok).toBe(false);
    expect((await addSessionExercise({ sessionId, exerciseId: ex.id, notes: "n".repeat(1001) })).ok).toBe(false);
    expect((await addSessionExercise({ sessionId, exerciseId: "x".repeat(65) })).ok).toBe(false);
    expect(await db.sessionExercise.count({ where: { sessionId } })).toBe(rowsBefore);

    // 201 ids (el real + 200 de relleno): antes el filtro `known.has` descartaba el relleno y el reorden pasaba.
    const orderedIds = [ok.data.id, ...Array.from({ length: 200 }, (_, i) => `junk-${i}`)];
    expect((await reorderSessionExercises({ sessionId, orderedIds })).ok).toBe(false);
    expect((await reorderSessionExercises({ sessionId, orderedIds: [ok.data.id] })).ok).toBe(true);
  });

  // ── búsqueda ────────────────────────────────────────────────────────
  it("[HD-3] globalSearch con un no-string no tira; q largo se acota", async () => {
    asUser(A.userId);
    await expect(globalSearch(123 as never)).resolves.toBeInstanceOf(Array);
    await expect(globalSearch({ a: 1 } as never)).resolves.toBeInstanceOf(Array);
    await expect(globalSearch("p".repeat(10_000))).resolves.toBeInstanceOf(Array);
  });

  // ── archivos ────────────────────────────────────────────────────────
  it("[HD-3] uploadPatientFile: descripción de 600 queda en 500 (trim) y el nombre en 255", async () => {
    asUser(A.userId);
    const patientId = await addPatient(db, A);
    const fd = new FormData();
    const longName = `${"n".repeat(296)}.pdf`; // 300
    fd.set("file", new File([new Uint8Array([37, 80, 68, 70])], longName, { type: "application/pdf" }));
    fd.set("category", "REPORT");
    fd.set("description", `  ${"d".repeat(600)}  `);
    const r = await uploadPatientFile(patientId, fd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await db.patientFile.findUniqueOrThrow({ where: { id: r.data.id }, select: { description: true, name: true } });
    expect(row.description).toBe("d".repeat(500));
    expect(row.name).toHaveLength(255);

    // Descripción que no es string (un Blob) → sin descripción.
    const fd2 = new FormData();
    fd2.set("file", new File([new Uint8Array([37, 80, 68, 70])], "b.pdf", { type: "application/pdf" }));
    fd2.set("description", new File([new Uint8Array([1, 2, 3])], "x.bin"));
    const r2 = await uploadPatientFile(patientId, fd2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const row2 = await db.patientFile.findUniqueOrThrow({ where: { id: r2.data.id }, select: { description: true } });
    expect(row2.description).toBeNull();
  });

  // ── diagnóstico y timeline ──────────────────────────────────────────
  it("[HD-3] searchPatientsForAssignment y getPatientTimeline con q inválido → [] / sin tirar", async () => {
    asUser(A.userId);
    const patientId = await addPatient(db, A);
    expect(await searchPatientsForAssignment(123 as never)).toEqual([]);
    expect(await searchPatientsForAssignment("x".repeat(101))).toEqual([]);
    await expect(getPatientTimeline({ patientId, q: 123 as never })).resolves.not.toBeUndefined();
    const page = await getPatientTimeline({ patientId, q: "q".repeat(5000) });
    expect(page).not.toBeNull();
  });

  // ── media del catálogo ──────────────────────────────────────────────
  it("[HD-3] reorderExerciseMedia con más de 100 ids → {ok:false} sin auditar", async () => {
    asUser(superId);
    const ex = await db.exercise.create({ data: { slug: `${TOK}-media-${uniqueSuffix()}`, name: `HD3 media`, tenantId: null } });
    globalExerciseIds.push(ex.id);
    const ids = Array.from({ length: 101 }, (_, i) => `m-${i}`);
    const r = await reorderExerciseMedia(ex.id, ids);
    expect(r.ok).toBe(false);
    expect(await db.platformAuditEvent.count({ where: { actorId: superId, entityId: ex.id } })).toBe(0);
    expect((await reorderExerciseMedia(ex.id, ids.slice(0, 100))).ok).toBe(true);
  });
});
