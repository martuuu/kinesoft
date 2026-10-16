/**
 * ES4 S24e · «Ejercicios» del portal (brief ES4 §4 S24e, §6 PHI).
 *
 * Símbolos REALES: `getPortalExercisesView` (lib/portal-exercises.ts), `loadPortalExercises` /
 * `resolvePortalExerciseMedia` (lib/portal-exercises-internal.ts) y la página `/portal/c/[slug]/ejercicios`. Se mockea
 * solo la sesión de Supabase (tests/helpers/actor.ts) y la RED de Storage (`storageSign`: en integración el admin
 * client es null y la firma daría `unconfigured`; el mock deja ver que se pide con TTL 600). `signExerciseMedia`
 * corre real (lee la fila de ExerciseMedia y exige ejercicio global).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as React from "react";

// La config de integración no tiene el transform JSX automático (esbuild usa el clásico → `React.createElement`):
// para renderizar la página real alcanza con exponer React como global. Solo afecta a este proceso de test.
(globalThis as { React?: typeof React }).React = React;

vi.mock("@/lib/storage-internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-internal")>();
  return {
    ...actual,
    storageSign: vi.fn(async (bucket: string, key: string, ttl: number) => ({
      ok: true as const,
      data: `https://storage.test/${bucket}/${key}?ttl=${ttl}`,
    })),
  };
});

import { getPortalExercisesView } from "@/lib/portal-exercises";
import { loadPortalExercises, resolvePortalExerciseMedia } from "@/lib/portal-exercises-internal";
import PortalExercisesPage from "@/app/(portal)/portal/c/[slug]/ejercicios/page";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("portal · ejercicios del plan (S24e)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología: planes + ejercicios en todos los planes SaaS
  let G: EphemeralTenant; // Clínica general: sin planes ni ejercicios
  const profiles: string[] = [];
  const globals: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
  });
  afterAll(async () => {
    await K?.cleanup();
    await G?.cleanup();
    // Los globales (tenantId null) no caen con el tenant: van después (las sesiones que los referencian ya no están).
    if (globals.length) await db.exercise.deleteMany({ where: { id: { in: globals } } });
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });

  const patientIdentity = async () => {
    const id = `test-portal-ex-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return id;
  };
  const linkedPatient = async (T: EphemeralTenant, uid: string) => {
    const patientId = await addPatient(db, T, { email: `${uid}@test.local` });
    await db.patient.update({ where: { id: patientId }, data: { userId: uid } });
    return patientId;
  };
  const exercise = async (
    data: { name: string; tenantId: string | null; kind?: "EXERCISE" | "MANUAL_THERAPY"; videoUrl?: string } & {
      instructions?: string;
      durationSeconds?: number;
    }
  ) => {
    const ex = await db.exercise.create({ data: { slug: `pex-${uniqueSuffix()}`, ...data } });
    if (data.tenantId === null) globals.push(ex.id);
    return ex.id;
  };
  const program = async (
    T: EphemeralTenant,
    patientId: string,
    o: { title?: string; startDate?: Date; status?: "ACTIVE" | "COMPLETED"; notes?: string } = {}
  ) =>
    (
      await db.treatmentProgram.create({
        data: {
          tenantId: T.tenantId,
          patientId,
          title: o.title ?? "Plan lumbar",
          startDate: o.startDate ?? new Date(),
          status: o.status ?? "ACTIVE",
          notes: o.notes,
        },
      })
    ).id;
  const session = async (
    T: EphemeralTenant,
    programId: string,
    index: number,
    exs: { exerciseId: string; sets?: number; reps?: number; notes?: string }[],
    o: { notes?: string; archived?: boolean } = {}
  ) => {
    const s = await db.session.create({
      data: {
        programId,
        practitionerId: T.practitionerId,
        index,
        scheduledFor: new Date(Date.UTC(2026, 9, 10 + index, 13, 0)),
        notes: o.notes,
        archivedAt: o.archived ? new Date() : null,
      },
    });
    for (const [order, e] of exs.entries()) {
      await db.sessionExercise.create({
        data: { sessionId: s.id, exerciseId: e.exerciseId, order, sets: e.sets ?? 3, reps: e.reps ?? 12, notes: e.notes },
      });
    }
    return s.id;
  };

  it("[P4-S24e] maniobras y notas del kine no salen", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(K, uid);
    const SECRET_SE = `nota-se-${uniqueSuffix()}`;
    const SECRET_SESSION = `nota-sesion-${uniqueSuffix()}`;
    const SECRET_PROGRAM = `nota-plan-${uniqueSuffix()}`;
    const RAW_URL = `https://videos.example.com/privado-${uniqueSuffix()}.mp4`;
    const puente = await exercise({
      name: "Puente de glúteos",
      tenantId: K.tenantId,
      instructions: "- Apretá los glúteos\n- Subí despacio",
      videoUrl: RAW_URL,
    });
    const plancha = await exercise({ name: "Plancha", tenantId: K.tenantId, durationSeconds: 30 });
    const maniobra = await exercise({ name: "Maniobra de Mulligan", tenantId: K.tenantId, kind: "MANUAL_THERAPY" });
    const pid = await program(K, patientId, { notes: SECRET_PROGRAM });
    await session(
      K,
      pid,
      1,
      [
        { exerciseId: puente, sets: 3, reps: 10, notes: SECRET_SE },
        { exerciseId: maniobra },
        { exerciseId: plancha, sets: 2, reps: 1 },
      ],
      { notes: SECRET_SESSION }
    );
    // Sesión solo con una maniobra: no aparece (no hay nada para hacer en casa).
    await session(K, pid, 2, [{ exerciseId: maniobra }]);
    asUser(uid);

    const view = await getPortalExercisesView(K.slug);
    expect(view.kind).toBe("ok");
    if (view.kind !== "ok") return;
    expect(view.data).toEqual({
      programTitle: "Plan lumbar",
      sessions: [
        {
          index: 1,
          date: new Date(Date.UTC(2026, 9, 11, 13, 0)).toISOString(),
          exercises: [
            {
              name: "Puente de glúteos",
              sets: 3,
              reps: 10,
              durationSeconds: null,
              instructions: "- Apretá los glúteos\n- Subí despacio",
              // ES4-D6: ejercicio propio con un link que no es YouTube → sin media (nunca el videoUrl crudo).
              media: null,
            },
            { name: "Plancha", sets: 2, reps: 1, durationSeconds: 30, instructions: null, media: null },
          ],
        },
      ],
    });
    // Ninguna de estas cadenas viaja en el payload (también en lo que renderiza la página).
    const payload = JSON.stringify(view);
    for (const s of [SECRET_SE, SECRET_SESSION, SECRET_PROGRAM, RAW_URL, "Mulligan"]) expect(payload).not.toContain(s);

    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await PortalExercisesPage({ params: { slug: K.slug } }));
    expect(html).toContain("Puente de glúteos");
    for (const s of [SECRET_SE, SECRET_SESSION, SECRET_PROGRAM, RAW_URL, "Mulligan"]) expect(html).not.toContain(s);
  });

  it("[P4-S24e] media de un ejercicio fuera de sus sesiones → null", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(K, uid);
    const otherUid = await patientIdentity();
    const otherPatientId = await linkedPatient(K, otherUid);

    const enPlan = await exercise({ name: "Sentadilla", tenantId: null });
    await db.exerciseMedia.create({ data: { exerciseId: enPlan, type: "VIDEO", url: "global/sentadilla.mp4" } });
    const ytGlobal = await exercise({ name: "Estocada", tenantId: null });
    await db.exerciseMedia.create({
      data: { exerciseId: ytGlobal, type: "YOUTUBE", url: "https://youtu.be/dQw4w9WgXcQ" },
    });
    const propioYt = await exercise({
      name: "Gato-camello",
      tenantId: K.tenantId,
      videoUrl: "https://www.youtube.com/watch?v=abcDEF12345",
    });
    const fueraDelPlan = await exercise({ name: "Remo", tenantId: null });
    await db.exerciseMedia.create({ data: { exerciseId: fueraDelPlan, type: "IMAGE", url: "global/remo.png" } });
    const deOtroPaciente = await exercise({ name: "Press", tenantId: null });
    await db.exerciseMedia.create({ data: { exerciseId: deOtroPaciente, type: "IMAGE", url: "global/press.png" } });
    const enSesionArchivada = await exercise({ name: "Saltos", tenantId: null });
    await db.exerciseMedia.create({ data: { exerciseId: enSesionArchivada, type: "IMAGE", url: "global/saltos.png" } });
    const enPlanViejo = await exercise({ name: "Caminata", tenantId: null });
    await db.exerciseMedia.create({ data: { exerciseId: enPlanViejo, type: "IMAGE", url: "global/caminata.png" } });

    // Plan viejo (COMPLETED, empezó antes): no es el que ve el paciente (ES4-D5).
    const viejo = await program(K, patientId, { title: "Plan viejo", startDate: new Date(Date.UTC(2026, 0, 1)), status: "COMPLETED" });
    await session(K, viejo, 1, [{ exerciseId: enPlanViejo }]);
    const pid = await program(K, patientId);
    await session(K, pid, 1, [{ exerciseId: enPlan }, { exerciseId: ytGlobal }, { exerciseId: propioYt }]);
    await session(K, pid, 2, [{ exerciseId: enPlan }, { exerciseId: enSesionArchivada }], { archived: true });
    const ajeno = await program(K, otherPatientId);
    await session(K, ajeno, 1, [{ exerciseId: deOtroPaciente }]);

    const scope = { tenantId: K.tenantId, patientId };
    expect(await resolvePortalExerciseMedia(scope, enPlan)).toEqual({
      kind: "video",
      url: "https://storage.test/exercise-media/global/sentadilla.mp4?ttl=600",
    });
    expect(await resolvePortalExerciseMedia(scope, ytGlobal)).toEqual({
      kind: "youtube",
      url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
    expect(await resolvePortalExerciseMedia(scope, propioYt)).toEqual({
      kind: "youtube",
      url: "https://www.youtube-nocookie.com/embed/abcDEF12345",
    });
    for (const id of [fueraDelPlan, deOtroPaciente, enSesionArchivada, enPlanViejo, "no-existe", ""]) {
      expect(await resolvePortalExerciseMedia(scope, id)).toBeNull();
    }
    // Otro consultorio con el mismo patientId no resuelve nada.
    expect(await resolvePortalExerciseMedia({ tenantId: G.tenantId, patientId }, enPlan)).toBeNull();

    // El listado: solo la sesión viva, con la media resuelta; ni la archivada ni el plan viejo.
    const dto = await loadPortalExercises(scope);
    expect(dto?.sessions.map((s) => s.index)).toEqual([1]);
    expect(dto?.sessions[0].exercises.map((e) => [e.name, e.media?.kind ?? null])).toEqual([
      ["Sentadilla", "video"],
      ["Estocada", "youtube"],
      ["Gato-camello", "youtube"],
    ]);
  });

  it("[P4-S24e] sin ejercicios → página 404", async () => {
    // Consultorio de Clínica general (sin `planes` ni `ejercicios`) con un plan y ejercicios igual cargados (filas
    // viejas): el portal no los muestra.
    const uid = await patientIdentity();
    const patientId = await linkedPatient(G, uid);
    const ex = await exercise({ name: "Puente", tenantId: G.tenantId });
    const pid = await program(G, patientId);
    await session(G, pid, 1, [{ exerciseId: ex }]);
    asUser(uid);

    expect(await getPortalExercisesView(G.slug)).toEqual({ kind: "notFound", movedSlug: null });
    await expect(PortalExercisesPage({ params: { slug: G.slug } })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sin vínculo, staff o anónimo: nada", async () => {
    // Ficha con el email de la cuenta pero SIN vincular (S24a): 404.
    const uid = await patientIdentity();
    const patientId = await addPatient(db, K, { email: `${uid}@test.local` });
    const pid = await program(K, patientId);
    await session(K, pid, 1, [{ exerciseId: await exercise({ name: "Puente", tenantId: K.tenantId }) }]);
    asUser(uid);
    expect(await getPortalExercisesView(K.slug)).toEqual({ kind: "notFound", movedSlug: null });

    // Staff (OWNER de K) con una ficha vinculada a su cuenta: tampoco (AUDIT §5.22).
    const staffPatient = await linkedPatient(K, K.userId);
    const spid = await program(K, staffPatient);
    await session(K, spid, 1, [{ exerciseId: await exercise({ name: "Puente", tenantId: K.tenantId }) }]);
    asUser(K.userId);
    expect(await getPortalExercisesView(K.slug)).toEqual({ kind: "notFound", movedSlug: null });

    asAnonymous();
    expect(await getPortalExercisesView(K.slug)).toEqual({ kind: "signedOut" });
  });

  it("vinculado sin plan activo con ejercicios → vacío (no error)", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(K, uid);
    asUser(uid);
    let view = await getPortalExercisesView(K.slug);
    expect(view).toMatchObject({ kind: "ok", data: null });

    // Plan activo pero sin ejercicios en ninguna sesión: también vacío.
    const pid = await program(K, patientId);
    await session(K, pid, 1, []);
    view = await getPortalExercisesView(K.slug);
    expect(view).toMatchObject({ kind: "ok", data: null });
  });
});
