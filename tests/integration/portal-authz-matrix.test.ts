/**
 * [ES4-S26p] Matriz de autorización del PORTAL del paciente (brief ES4 §5, tabla «Columnas portal»; ES4-D12: archivo
 * aparte de `authz-matrix.test.ts`, que es la matriz del staff).
 *
 * Por qué una matriz: el portal corre por el canal service (BYPASSRLS, sin Actor). La única barrera es el vínculo
 * `Patient.userId` por (tenantId, userId) que resuelve `requirePortalPatient` / `listPortalPatients`
 * (lib/portal-identity-internal.ts). Hasta ES4 se autorizaba por coincidencia de email y una ficha sin vincular ya
 * mostraba PHI (AUDIT `portal-auth-por-email-no-userid`). Cada celda de la tabla se prueba acá contra Postgres con el
 * símbolo REAL (actions, lecturas y pages), y cada ⛔ afirma que no se escribió NADA (fichas, EVA, pedidos,
 * notificaciones, notas clínicas: foto antes/después de todas las filas de los consultorios del test).
 *
 * Sujetos (brief §5):
 *   P            vinculado en K (Kinesiología) · P-otro: vinculado en K2, pide con el slug de K
 *   P-sinvínculo verificado, con el email de una ficha de K sin `userId`
 *   P-sinverif   sesión con email SIN confirmar (y, peor caso, con su ficha de K ya vinculada)
 *   STAFF        Membership en otro consultorio (O), con una ficha en K con su email y encima vinculada (§5.22)
 *   P-General    vinculado en G (Clínica general: sin `planes`, `evaluaciones` ni `ejercicios`), con filas de plan viejas
 *   P-susp       vinculado en S (Kinesiología suspendida, `surfacesOpen = false`)
 *
 * Fila «sin evoluciones»: cada ficha de los sujetos tiene una evolución sembrada con textos centinela; se barre el
 * payload SERIALIZADO de todas las lecturas, actions y pages del portal (los props de los server components son lo que
 * viaja en el RSC) y no puede aparecer ni el contenido ni el identificador del modelo.
 *
 * Lo que la tabla dice y el código no hace queda como `it.fails("[ES4-S26p] …")` (hallazgo; no se toca producción).
 *
 * Fronteras mockeadas: la sesión de Supabase (con `email_confirmed_at` controlable, para P-sinverif), la consulta de
 * proveedores OAuth de la home (red a GoTrue) y, solo con el interruptor prendido, la caída de la base de audit
 * ([FC-1e], para el 503 de la descarga).
 *
 * [FC-1e] «Documentos» (T4, C-FC8): filas `it.fails` de lo compartido con el paciente (solo el propio y vivo, ningún
 * id de nota, staff → 404, audit antes de los bytes). Las dan vuelta FC-2h (lectura + ruta) y FC-4a (páginas).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** Sesión de Supabase del test: `confirmed = false` es P-sinverif. */
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; confirmed: boolean } }));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({
        data: {
          user: session.user
            ? {
                id: session.user.id,
                email: session.user.email,
                email_confirmed_at: session.user.confirmed ? new Date(0).toISOString() : null,
                user_metadata: {},
              }
            : null,
        },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/oauth-providers-public", () => ({ visibleOAuthProviders: async () => ["google"] }));

/**
 * [FC-1e] Frontera «la base de auditoría no responde»: la descarga del portal tiene que fallar cerrada (503 sin bytes,
 * C-FC8). Es la única forma de provocarlo sin tirar Postgres; con `on = false` corre el `auditSecurityEvent` REAL.
 */
const auditFault = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    auditSecurityEvent: async (...args: Parameters<typeof real.auditSecurityEvent>) => {
      if (auditFault.on) throw new Error("[FC-1e] audit caído (falla inyectada)");
      return real.auditSecurityEvent(...args);
    },
  };
});

// La config de integración compila JSX con el runtime clásico: las pages se ejecutan como funciones (server components).
import * as ReactNs from "react";
(globalThis as { React?: unknown }).React = ReactNs;

import { getPortalAuth, getPortalPlan, submitCheckIn } from "@/lib/portal";
import { getPortalAccount, getPortalAccountPage } from "@/lib/portal-account";
import { getPortalExercisesView } from "@/lib/portal-exercises";
import { requestPortalProfileChange } from "@/lib/portal-profile";
import { loadPortalProfile } from "@/lib/portal-profile-internal";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { linkPortalByInvite } from "@/lib/portal-vincular";
import { makePortalInviteToken } from "@/lib/portal-invite-token";
import { __rateLimitInternals } from "@/lib/rate-limit";
import PortalHome from "@/app/(portal)/portal/page";
import PortalMe from "@/app/(portal)/portal/me/page";
import PortalTenantPage from "@/app/(portal)/portal/c/[slug]/page";
import PortalAccountPageRoute from "@/app/(portal)/portal/c/[slug]/cuenta/page";
import PortalExercisesPage from "@/app/(portal)/portal/c/[slug]/ejercicios/page";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanBooking, addPlanSession } from "@/tests/helpers/plan-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

type Account = { id: string; email: string };

/** Allowlist literal de `PortalAccountDTO` (brief §3.5): cualquier otra clave en el DTO rompe la celda «✅ allowlist». */
const ACCOUNT_KEYS = new Set([
  "plans",
  "looseBookings",
  "totals",
  "programId",
  "title",
  "sessionWord",
  "agreed",
  "collectedCents",
  "pendingCents",
  "creditCents",
  "inProcessCents",
  "id",
  "date",
  "serviceName",
  "amount",
  "paid",
  "inProcess",
  "pending",
  "cancelled",
  "kind",
  "cents",
]);

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

/** Serializa lo que viaja: datos y props de los elementos (las funciones/símbolos no viajan; los ciclos se cortan). */
function serialize(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === "function" || typeof x === "symbol") return undefined;
    if (x && typeof x === "object") {
      if (seen.has(x)) return undefined;
      seen.add(x);
    }
    return x;
  });
}

/** Resultado de una page: lo que devolvió, o el 404 / redirect que tiró Next. */
type PageOutcome = { kind: "ok"; tree: unknown } | { kind: "notFound" } | { kind: "redirect"; url: string };
async function pageOf(p: Promise<unknown> | unknown): Promise<PageOutcome> {
  try {
    return { kind: "ok", tree: await p };
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (digest === "NEXT_NOT_FOUND") return { kind: "notFound" };
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return { kind: "redirect", url: digest.split(";")[2] ?? "" };
    }
    throw err;
  }
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe.skipIf(!RUN)("[ES4-S26p] matriz de autorización del portal", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología: planes + evaluaciones + ejercicios + turnero
  let K2: EphemeralTenant; // otro Kine (P-otro)
  let G: EphemeralTenant; // Clínica general
  let G2: EphemeralTenant; // otro General (vínculo por invitación de P-General)
  let O: EphemeralTenant; // consultorio del STAFF
  let S: EphemeralTenant; // Kine suspendido
  const profiles: string[] = [];

  // Sujetos.
  let P: Account, POtro: Account, PFree: Account, PUnver: Account, PGen: Account, PSusp: Account;
  let STAFF: Account;

  // Fichas.
  let pK: string, pOtherK: string, pOtroK2: string, pFreeK: string, pUnverK: string, pStaffK: string, pG: string;
  let pSusp: string;

  // Planes / sesiones.
  let planK: string, sK: string, sOtherK: string, sUnverK: string, sStaffK: string, sG: string, sSusp: string;
  let looseK: string, looseG: string, legacyPlanG: string;

  // Centinelas.
  const SFX = uniqueSuffix();
  const EVO_BODY = `EVO-CUERPO-${SFX}`;
  const EVO_TITLE = `EVO-TITULO-${SFX}`;
  const EVO_AUTHOR = `EVO-FIRMA-${SFX}`;
  const NOTE_PROGRAM = `NOTA-PLAN-${SFX}`;
  const NOTE_SESSION = `NOTA-SESION-${SFX}`;
  const NOTE_SE = `NOTA-EJERCICIO-${SFX}`;
  const MANEUVER = `Maniobra-${SFX}`;
  const NOTE_PATIENT = `NOTA-FICHA-${SFX}`;
  const evolutionIds: string[] = [];

  const account = async (): Promise<Account> => {
    const id = `test-s26p-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return { id, email: `${id}@test.local` };
  };
  const as = (a: Account | null, confirmed = true) => {
    session.user = a ? { id: a.id, email: a.email, confirmed } : null;
  };
  const linked = async (t: EphemeralTenant, a: Account, data: Parameters<typeof addPatient>[2] = {}) => {
    const id = await addPatient(db, t, { email: a.email, notes: NOTE_PATIENT, ...data });
    await db.patient.update({ where: { id }, data: { userId: a.id } });
    return id;
  };
  /** Plan ACTIVE vinculado (con turno) de una sesión futura; notas del kine centinela en plan y sesión. */
  const plan = async (t: EphemeralTenant, patientId: string, daysAhead: number, title = "Plan lumbar") => {
    const program = await db.treatmentProgram.create({
      data: { tenantId: t.tenantId, patientId, title, startDate: new Date(), notes: NOTE_PROGRAM },
    });
    const scheduledFor = new Date(Date.now() + daysAhead * DAY);
    const sessionId = await addPlanSession(db, program.id, { index: 1, practitionerId: t.practitionerId, scheduledFor });
    await db.session.update({ where: { id: sessionId }, data: { notes: NOTE_SESSION } });
    await addPlanBooking(db, t, { programId: program.id, sessionId, patientId, scheduledFor });
    return { programId: program.id, sessionId };
  };
  const evolution = async (t: EphemeralTenant, patientId: string) => {
    const row = await db.clinicalNote.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        kind: "EVOLUTION",
        title: EVO_TITLE,
        body: EVO_BODY,
        occurredAt: new Date(Date.now() - DAY),
        authorUserId: t.userId,
        authorPractitionerId: t.practitionerId,
        authorName: EVO_AUTHOR,
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    evolutionIds.push(row.id);
  };

  /**
   * Foto de TODO lo que el portal podría escribir en los consultorios del test. Un ⛔ la compara antes/después: no
   * alcanza con mirar la fila «esperada» (un bug escribiría en otra).
   */
  const writeState = async () => {
    const tenantIds = [K, K2, G, G2, O, S].map((t) => t.tenantId);
    const [patients, eva, requests, notifications, notes, documents] = await Promise.all([
      db.patient.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { id: true, userId: true, updatedAt: true, phone: true, email: true, notes: true },
        orderBy: { id: "asc" },
      }),
      db.evaScore.findMany({
        where: { patient: { tenantId: { in: tenantIds } } },
        select: { id: true, value: true, sessionId: true },
        orderBy: { id: "asc" },
      }),
      db.patientChangeRequest.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { id: true, updatedAt: true, status: true },
        orderBy: { id: "asc" },
      }),
      db.notification.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true }, orderBy: { id: "asc" } }),
      db.clinicalNote.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
      // [FC-1e] el portal solo LEE lo compartido: nunca crea ni revoca documentos.
      db.patientDocument.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { id: true, revokedAt: true },
        orderBy: { id: "asc" },
      }),
    ]);
    return serialize({ patients, eva, requests, notifications, notes, documents });
  };
  /** ⛔: corre la llamada y afirma que no cambió nada. Devuelve el resultado para afirmar el rechazo. */
  async function refusedWithoutWrite<T>(run: () => Promise<T>): Promise<T> {
    __rateLimitInternals.reset();
    const before = await writeState();
    const r = await run();
    expect(await writeState()).toBe(before);
    return r;
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db);
    K2 = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    G2 = await createEphemeralTenant(db, { vertical: "GENERAL" });
    O = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db, { status: "SUSPENDED" });

    [P, POtro, PFree, PUnver, PGen, PSusp] = [
      await account(),
      await account(),
      await account(),
      await account(),
      await account(),
      await account(),
    ];
    STAFF = { id: O.userId, email: `${O.userId}@test.local` };

    // P en K: plan vinculado con ejercicio propio (notas del kine) + maniobra, turno suelto, evolución.
    pK = await linked(K, P);
    ({ programId: planK, sessionId: sK } = await plan(K, pK, 2));
    const puente = await db.exercise.create({
      data: { slug: `s26p-${uniqueSuffix()}`, name: "Puente de glúteos", tenantId: K.tenantId },
    });
    const maniobra = await db.exercise.create({
      data: { slug: `s26p-${uniqueSuffix()}`, name: MANEUVER, tenantId: K.tenantId, kind: "MANUAL_THERAPY" },
    });
    await db.sessionExercise.create({
      data: { sessionId: sK, exerciseId: puente.id, order: 0, sets: 3, reps: 12, notes: NOTE_SE },
    });
    await db.sessionExercise.create({ data: { sessionId: sK, exerciseId: maniobra.id, order: 1, sets: 1, reps: 1 } });
    looseK = await addPlanBooking(db, K, {
      patientId: pK,
      scheduledFor: new Date(Date.now() - 3 * DAY),
      status: "COMPLETED",
      copagoCents: 150_000,
    });
    await evolution(K, pK);

    // Otro paciente de K (sin cuenta), con su plan: su sesión no es de P.
    pOtherK = await addPatient(db, K);
    ({ sessionId: sOtherK } = await plan(K, pOtherK, 3, "Plan de otro paciente"));

    // P-otro: vinculado en K2.
    pOtroK2 = await linked(K2, POtro);
    await plan(K2, pOtroK2, 2, "Plan en K2");
    await evolution(K2, pOtroK2);

    // P-sinvínculo: ficha de K con su email, sin userId.
    pFreeK = await addPatient(db, K, { email: PFree.email, notes: NOTE_PATIENT });
    await plan(K, pFreeK, 4, "Plan de la ficha libre");
    await evolution(K, pFreeK);

    // P-sinverif: su ficha de K está vinculada (peor caso); la sesión no confirmó el email.
    pUnverK = await linked(K, PUnver);
    ({ sessionId: sUnverK } = await plan(K, pUnverK, 5, "Plan de sinverif"));
    await evolution(K, pUnverK);

    // STAFF: OWNER de O, con ficha en K con su email y vinculada (dato viejo, AUDIT §5.22).
    pStaffK = await linked(K, STAFF);
    ({ sessionId: sStaffK } = await plan(K, pStaffK, 6, "Plan del staff"));
    await evolution(K, pStaffK);

    // P-General: vinculado en G, con filas de plan viejas (el módulo no existe) y un turno suelto.
    pG = await linked(G, PGen);
    ({ programId: legacyPlanG, sessionId: sG } = await plan(G, pG, 2, "Plan legacy en General"));
    looseG = await addPlanBooking(db, G, {
      patientId: pG,
      scheduledFor: new Date(Date.now() - 2 * DAY),
      status: "COMPLETED",
      copagoCents: 40_000,
    });
    await evolution(G, pG);

    // P-susp: Kine suspendido.
    pSusp = await linked(S, PSusp);
    ({ sessionId: sSusp } = await plan(S, pSusp, 2, "Plan en suspendido"));
    await evolution(S, pSusp);
  });

  afterAll(async () => {
    // K primero: tiene una ficha vinculada al OWNER de O (FK Patient.userId → UserProfile de O).
    for (const t of [K, K2, G, G2, O, S]) await t?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    as(null);
  });

  // ── getPortalAuth ────────────────────────────────────────────────────────────────────────────────────────────────

  describe("getPortalAuth", () => {
    it("P en K: lista K con su plan", async () => {
      as(P);
      const auth = await getPortalAuth();
      expect(auth.signedIn).toBe(true);
      if (!auth.signedIn) return;
      expect(auth.patients.map((p) => [p.id, p.tenantSlug])).toEqual([[pK, K.slug]]);
      expect(auth.patients[0].programs.map((p) => p.id)).toEqual([planK]);
    });

    it("P-otro: lista K2, nunca K", async () => {
      as(POtro);
      const auth = await getPortalAuth();
      if (!auth.signedIn) throw new Error("debería tener sesión");
      expect(auth.patients.map((p) => p.tenantSlug)).toEqual([K2.slug]);
    });

    it("P-sinvínculo: sesión sin fichas (el email de la ficha no autoriza) y no se auto-vincula al leer", async () => {
      as(PFree);
      const auth = await refusedWithoutWrite(() => getPortalAuth());
      expect(auth).toMatchObject({ signedIn: true, patients: [] });
    });

    it("P-sinverif: signedIn:false aunque su ficha esté vinculada", async () => {
      as(PUnver, false);
      expect(await getPortalAuth()).toEqual({ signedIn: false });
    });

    it("STAFF: sesión sin fichas aunque tenga una vinculada con su email (§5.22)", async () => {
      as(STAFF);
      expect(await getPortalAuth()).toMatchObject({ signedIn: true, patients: [] });
    });

    it("P-General: lista G sin programs (gate `planes`) aunque haya filas de plan", async () => {
      as(PGen);
      const auth = await getPortalAuth();
      if (!auth.signedIn) throw new Error("debería tener sesión");
      expect(auth.patients.map((p) => p.tenantSlug)).toEqual([G.slug]);
      expect(auth.patients[0].programs).toEqual([]);
      expect(auth.patients[0].sections).not.toContain("plan");
      expect(serialize(auth)).not.toContain(legacyPlanG);
    });
  });

  // ── getPortalPlan ────────────────────────────────────────────────────────────────────────────────────────────────

  describe("getPortalPlan(K)", () => {
    it("P en K: su plan, sin notas del kine", async () => {
      as(P);
      const plan = await getPortalPlan(K.slug);
      expect(plan?.programId).toBe(planK);
      expect(plan?.sessions.map((s) => s.id)).toEqual([sK]);
      const json = serialize(plan);
      for (const s of [NOTE_PROGRAM, NOTE_SESSION, NOTE_SE, "\"notes\""]) expect(json).not.toContain(s);
    });

    it.each([
      ["P-otro", () => as(POtro)],
      ["P-sinvínculo", () => as(PFree)],
      ["P-sinverif", () => as(PUnver, false)],
      ["STAFF", () => as(STAFF)],
    ])("%s → null", async (_who, login) => {
      login();
      expect(await getPortalPlan(K.slug)).toBeNull();
    });

    it("P-General → null en G (sin `planes`) aunque el plan exista", async () => {
      as(PGen);
      expect(await getPortalPlan(G.slug)).toBeNull();
      expect(await getPortalPlan(K.slug)).toBeNull();
    });
  });

  // ── submitCheckIn ────────────────────────────────────────────────────────────────────────────────────────────────

  describe("submitCheckIn", () => {
    it("⛔ P con el sessionId de OTRO paciente de K: no escribe", async () => {
      as(P);
      const r = await refusedWithoutWrite(() => submitCheckIn({ tenantSlug: K.slug, sessionId: sOtherK, pain: 5 }));
      expect(r.ok).toBe(false);
    });

    it.each([
      ["P-otro (sesión de P)", () => as(POtro), () => sK],
      ["P-sinvínculo (sesión de P)", () => as(PFree), () => sK],
      ["P-sinverif (su propia sesión)", () => as(PUnver, false), () => sUnverK],
      ["STAFF (sesión de su ficha vinculada)", () => as(STAFF), () => sStaffK],
    ])("⛔ %s en K: no escribe", async (_who, login, sid) => {
      login();
      const r = await refusedWithoutWrite(() =>
        submitCheckIn({ tenantSlug: K.slug, sessionId: sid(), pain: 7, notes: "me duele" })
      );
      expect(r).toEqual({ ok: false, error: "Sin acceso." });
    });

    it("⛔ P-General en G (sin `evaluaciones`): no escribe", async () => {
      as(PGen);
      const r = await refusedWithoutWrite(() => submitCheckIn({ tenantSlug: G.slug, sessionId: sG, pain: 3 }));
      expect(r.ok).toBe(false);
    });

    it("✅ P en K: crea la EvaScore con note + sessionId, sin tocar la ficha", async () => {
      as(P);
      const before = await db.patient.findUniqueOrThrow({ where: { id: pK }, select: { notes: true, updatedAt: true } });
      const r = await submitCheckIn({ tenantSlug: K.slug, sessionId: sK, pain: 6, notes: "  Me tira la lumbar  " });
      expect(r).toEqual({ ok: true, data: undefined });
      const eva = await db.evaScore.findMany({ where: { patientId: pK } });
      expect(eva).toHaveLength(1);
      expect(eva[0]).toMatchObject({ value: 6, sessionId: sK, note: "Me tira la lumbar", source: `checkin-${sK}` });
      expect(await db.patient.findUniqueOrThrow({ where: { id: pK }, select: { notes: true, updatedAt: true } })).toEqual(
        before
      );
    });
  });

  // ── Estado de cuenta ─────────────────────────────────────────────────────────────────────────────────────────────

  describe("cuenta /c/<slug>/cuenta", () => {
    it("✅ P en K: DTO por allowlist, con su plan y su turno suelto", async () => {
      as(P);
      const acc = await getPortalAccount(K.slug);
      expect(acc).not.toBeNull();
      expect(allKeys(acc).filter((k) => !ACCOUNT_KEYS.has(k))).toEqual([]);
      expect(acc!.plans.map((p) => p.programId)).toEqual([planK]);
      expect(acc!.looseBookings.map((b) => b.id)).toEqual([looseK]);
      expect((await pageOf(PortalAccountPageRoute({ params: { slug: K.slug } }))).kind).toBe("ok");
    });

    it.each([
      ["P-otro", () => as(POtro)],
      ["P-sinvínculo", () => as(PFree)],
      ["STAFF", () => as(STAFF)],
    ])("%s → 404", async (_who, login) => {
      login();
      expect(await getPortalAccount(K.slug)).toBeNull();
      expect(await pageOf(PortalAccountPageRoute({ params: { slug: K.slug } }))).toEqual({ kind: "notFound" });
    });

    // Hallazgo [ES4-S26p] `portal-cuenta-sin-sesion-404`, cerrado en ES4 P4.Z: la page de cuenta no distinguía «sin
    // sesión» de «no es tuyo» y respondía 404. Ahora, como /c/<slug> y /ejercicios, muestra el CTA a `/portal?c=<slug>`.
    it("[ES4-S26p] P-sinverif → login (CTA a /portal?c=<slug>), no 404", async () => {
      as(PUnver, false);
      expect(await getPortalAccount(K.slug)).toBeNull();
      const out = await pageOf(PortalAccountPageRoute({ params: { slug: K.slug } }));
      expect(out.kind).toBe("ok");
      expect(serialize(out)).toContain(`/portal?c=${K.slug}`);
    });

    it("P-sinverif: sin datos (la lectura devuelve null)", async () => {
      as(PUnver, false);
      expect(await getPortalAccount(K.slug)).toBeNull();
      expect(await getPortalAccountPage(K.slug)).toBeNull();
    });

    it("✅ P-General: solo turnos sueltos (sin sección de planes)", async () => {
      as(PGen);
      const page = await getPortalAccountPage(G.slug);
      expect(page?.showPlans).toBe(false);
      expect(page?.account.plans).toEqual([]);
      expect(page?.account.looseBookings.map((b) => b.id)).toEqual([looseG]);
      expect(serialize(page)).not.toContain(legacyPlanG);
    });
  });

  // ── Ejercicios ───────────────────────────────────────────────────────────────────────────────────────────────────

  describe("ejercicios /c/<slug>/ejercicios", () => {
    it("✅ P en K: el ejercicio, sin notas del kine ni maniobras", async () => {
      as(P);
      const view = await getPortalExercisesView(K.slug);
      expect(view.kind).toBe("ok");
      const json = serialize(view);
      expect(json).toContain("Puente de glúteos");
      for (const s of [MANEUVER, NOTE_SE, NOTE_SESSION, NOTE_PROGRAM]) expect(json).not.toContain(s);
      expect((await pageOf(PortalExercisesPage({ params: { slug: K.slug } }))).kind).toBe("ok");
    });

    it.each([
      ["P-otro", () => as(POtro), () => K.slug],
      ["P-sinvínculo", () => as(PFree), () => K.slug],
      ["STAFF", () => as(STAFF), () => K.slug],
      ["P-General (sin `planes` ∧ `ejercicios`)", () => as(PGen), () => G.slug],
    ])("%s → 404", async (_who, login, slug) => {
      login();
      expect(await getPortalExercisesView(slug())).toEqual({ kind: "notFound", movedSlug: null });
      expect(await pageOf(PortalExercisesPage({ params: { slug: slug() } }))).toEqual({ kind: "notFound" });
    });

    it("P-sinverif → login (CTA a /portal?c=<slug>)", async () => {
      as(PUnver, false);
      expect(await getPortalExercisesView(K.slug)).toEqual({ kind: "signedOut" });
      const out = await pageOf(PortalExercisesPage({ params: { slug: K.slug } }));
      expect(out.kind).toBe("ok");
      expect(serialize(out)).toContain(`/portal?c=${K.slug}`);
    });
  });

  // ── «Mis datos» ──────────────────────────────────────────────────────────────────────────────────────────────────

  describe("«Mis datos»: enviar pedido", () => {
    const PHONE = "+54 9 11 4444-0000";

    it.each([
      ["P-otro", () => as(POtro)],
      ["P-sinvínculo", () => as(PFree)],
      ["P-sinverif", () => as(PUnver, false)],
      ["STAFF", () => as(STAFF)],
    ])("⛔ %s sobre K: no escribe", async (_who, login) => {
      login();
      const r = await refusedWithoutWrite(() =>
        requestPortalProfileChange({ tenantSlug: K.slug, changes: { phone: PHONE } })
      );
      expect(r).toEqual({
        ok: false,
        error: "No encontramos tu ficha en este consultorio. Volvé a Mis consultorios y probá de nuevo.",
      });
    });

    it.each([
      ["P en K", () => as(P), () => K, () => pK],
      ["P-General en G", () => as(PGen), () => G, () => pG],
    ])("✅ %s: deja un pedido PENDING y no toca la ficha", async (_who, login, t, patientId) => {
      login();
      const before = await db.patient.findUniqueOrThrow({
        where: { id: patientId() },
        select: { phone: true, email: true, updatedAt: true },
      });
      const r = await requestPortalProfileChange({ tenantSlug: t().slug, changes: { phone: PHONE } });
      expect(r).toEqual({ ok: true, data: { fields: ["phone"] } });
      const reqs = await db.patientChangeRequest.findMany({ where: { patientId: patientId(), tenantId: t().tenantId } });
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ status: "PENDING", changes: { phone: PHONE } });
      expect(
        await db.patient.findUniqueOrThrow({
          where: { id: patientId() },
          select: { phone: true, email: true, updatedAt: true },
        })
      ).toEqual(before);
    });
  });

  // ── Consultorio suspendido ───────────────────────────────────────────────────────────────────────────────────────

  describe("consultorio suspendido (surfacesOpen = false)", () => {
    it("lectura ✅: lista, plan, cuenta y ejercicios", async () => {
      as(PSusp);
      const auth = await getPortalAuth();
      if (!auth.signedIn) throw new Error("debería tener sesión");
      expect(auth.patients.map((p) => p.tenantSlug)).toEqual([S.slug]);
      expect((await getPortalPlan(S.slug))?.sessions.map((s) => s.id)).toEqual([sSusp]);
      expect(await getPortalAccount(S.slug)).not.toBeNull();
      expect((await getPortalExercisesView(S.slug)).kind).toBe("ok");
    });

    it("escrituras ⛔: check-in y «Mis datos» no escriben", async () => {
      as(PSusp);
      const c = await refusedWithoutWrite(() => submitCheckIn({ tenantSlug: S.slug, sessionId: sSusp, pain: 4 }));
      expect(c.ok).toBe(false);
      const m = await refusedWithoutWrite(() =>
        requestPortalProfileChange({ tenantSlug: S.slug, changes: { phone: "11-1234" } })
      );
      expect(m.ok).toBe(false);
    });
  });

  // ── «sin evoluciones»: barrido del payload serializado ───────────────────────────────────────────────────────────

  describe("«sin evoluciones»: ninguna respuesta del portal las trae", () => {
    // Evolución sembrada + (de paso) las demás notas del kine: ficha, plan, sesión, ejercicio de la sesión, maniobra.
    const BANNED_LITERALS = [EVO_BODY, EVO_TITLE, EVO_AUTHOR, NOTE_PATIENT, NOTE_PROGRAM, NOTE_SESSION, NOTE_SE, MANEUVER];
    // Identificadores del modelo y sus columnas propias: si aparecen, alguien hizo `include` de la relación.
    const BANNED_PATTERN = /clinicalNote|ClinicalNote|clinical-notes|EVOLUTION|amendsNoteId|voidReason|authorPractitionerId/;

    /** Todo lo que el portal le devuelve a una sesión: lecturas, actions (con entradas que no escriben) y pages. */
    async function everything(slugs: string[]): Promise<string> {
      const out: unknown[] = [];
      out.push(await getPortalAuth());
      out.push(await loadPortalProfile());
      out.push(await pageOf(PortalHome({ searchParams: {} })));
      out.push(await pageOf(PortalMe()));
      for (const slug of slugs) {
        out.push(await getPortalPlan(slug));
        out.push(await getPortalAccountPage(slug));
        out.push(await getPortalExercisesView(slug));
        out.push(await pageOf(PortalTenantPage({ params: { slug } })));
        out.push(await pageOf(PortalAccountPageRoute({ params: { slug } })));
        out.push(await pageOf(PortalExercisesPage({ params: { slug } })));
        // Actions con entradas que se rechazan antes de escribir (las escrituras ya se probaron arriba).
        __rateLimitInternals.reset();
        out.push(await submitCheckIn({ tenantSlug: slug, sessionId: "no-existe", pain: 1 }));
        out.push(await requestPortalProfileChange({ tenantSlug: slug, changes: {} }));
      }
      out.push(await linkPortalByInvite(form({ t: "no-es-un-token" })));
      return serialize(out);
    }

    it("la evolución sembrada existe (el barrido no es un falso verde)", async () => {
      const rows = await db.clinicalNote.findMany({ where: { id: { in: evolutionIds } }, select: { body: true } });
      expect(rows).toHaveLength(evolutionIds.length);
      expect(rows.every((r) => r.body === EVO_BODY)).toBe(true);
    });

    it.each([
      ["P en K", () => as(P), () => [K.slug], () => [planK, "Puente de glúteos"]],
      ["P-otro", () => as(POtro), () => [K.slug, K2.slug], () => ["Plan en K2"]],
      ["P-sinvínculo", () => as(PFree), () => [K.slug], () => [] as string[]],
      ["P-sinverif", () => as(PUnver, false), () => [K.slug], () => [] as string[]],
      ["STAFF", () => as(STAFF), () => [K.slug], () => [] as string[]],
      ["P-General", () => as(PGen), () => [G.slug], () => [looseG]],
      ["sin sesión", () => as(null), () => [K.slug], () => [] as string[]],
    ])("%s: ausente", async (_who, login, slugs, mustContain) => {
      login();
      const json = await refusedWithoutWrite(() => everything(slugs()));
      // Control positivo: el barrido ve el payload real de ese sujeto.
      for (const s of mustContain()) expect(json).toContain(s);
      for (const s of BANNED_LITERALS) expect(json).not.toContain(s);
      for (const id of evolutionIds) expect(json).not.toContain(id);
      expect(json).not.toMatch(BANNED_PATTERN);
    });
  });

  // ── [FC-1e] «Documentos» (T4, C-FC8): solo lo compartido y vivo de la ficha propia ────────────────────────────────
  //
  // T4 deshace EV2-D5 de forma ACOTADA: el portal lee `PatientDocument` (la foto HcPrintable v1 que el profesional
  // compartió), nunca la nota. Las filas nacen `it.fails` porque la lectura, la ruta del PDF (FC-2h) y las páginas
  // (FC-4a) todavía no existen; se cargan con `import()` dinámico para que este archivo compile y corra sin ellas. Las
  // da vuelta el integrador de cada tanda (FC-2i / FC-4i) cuando el símbolo real exista.
  //
  // Fixture: la NOTA de origen lleva un centinela propio (NOTE_SRC_BODY) que el snapshot no tiene. Si el portal lo
  // muestra, leyó la nota y no la foto. Los ids de las notas tampoco pueden viajar.

  describe("[FC-1e] «Documentos»: solo lo compartido y vivo del paciente propio (C-FC8)", () => {
    const SHARED_BODY = `SHARED-BODY-${SFX}`;
    const SHARED_BODY_NEWER = `SHARED-BODY-NUEVO-${SFX}`;
    const SHARED_TITLE = `Ficha compartida ${SFX}`;
    const SHARED_TITLE_NEWER = `Ficha compartida nueva ${SFX}`;
    const NOTE_SRC_BODY = `NOTA-ORIGEN-${SFX}`;
    const REVOKED_BODY = `REVOCADO-${SFX}`;
    const FOREIGN_BODY = `AJENO-${SFX}`;
    const UA = "FC1e-matriz/1.0";
    const IP = "203.0.113.7";
    const docNoteIds: string[] = [];
    let dLive = "", dNewer = "", dRevoked = "", dOther = "", dStaff = "", dUnver = "", dFree = "", dK2 = "";

    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    /** HcPrintable v1 mínima (lib/hc-print-types.ts) con el centinela en el cuerpo; `label` es texto, nunca el enum. */
    const snapshot = (title: string, body: string) => ({
      v: 1,
      content: {
        letterhead: { tenantName: "Consultorio FC-1e", addressLine: null, phone: null, hasLogo: false },
        patient: { fullName: "Paciente FC-1e", documentId: null, dateOfBirth: null },
        fichas: [
          {
            main: {
              label: "Evolución",
              title,
              occurredAt: new Date(Date.now() - 3 * DAY).toISOString(),
              dateLabel: "hace 3 días",
              body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
              diagnoses: [],
              signature: { line: "Lic. Ana Pérez · MN 1234", imageRef: null },
              marks: { lateEntry: null, imported: null, voided: null },
              revisionLabel: "",
            },
            amendments: [],
          },
        ],
        icdAttribution: null,
      },
      meta: { generatedAt: new Date().toISOString(), purpose: "shared", generatedByName: "Ana Pérez", verificationCode: "A1B2-C3D4-E5F6", truncated: false },
    });
    /** Nota raíz viva + documento vivo (insert directo, sin la action de compartir: acá se mide la lectura). */
    const shareDoc = async (t: EphemeralTenant, patientId: string, title: string, body: string, sharedAgoDays: number) => {
      const note = await db.clinicalNote.create({
        data: {
          tenantId: t.tenantId,
          patientId,
          kind: "EVOLUTION",
          title,
          body: NOTE_SRC_BODY,
          occurredAt: new Date(Date.now() - 3 * DAY),
          authorUserId: t.userId,
          authorPractitionerId: t.practitionerId,
          authorName: "Ana Pérez",
          idempotencyKey: randomUUID(),
        },
        select: { id: true },
      });
      docNoteIds.push(note.id);
      const snap = snapshot(title, body);
      const doc = await db.patientDocument.create({
        data: {
          tenantId: t.tenantId,
          patientId,
          noteId: note.id,
          noteRevision: 1,
          sourceDigest: sha(`src-${note.id}`),
          title,
          occurredAt: new Date(Date.now() - 3 * DAY),
          snapshot: snap,
          snapshotSha256: sha(JSON.stringify(snap)),
          pdfStorageKey: `stub:${note.id}`,
          pdfSha256: sha(`pdf-${note.id}`),
          pdfSizeBytes: 1000,
          sharedByUserId: t.userId,
          sharedByPractitionerId: t.practitionerId,
          sharedAt: new Date(Date.now() - sharedAgoDays * DAY),
          idempotencyKey: randomUUID(),
        },
        select: { id: true },
      });
      return doc.id;
    };

    // Contratos C-FC8 (los tipos reales los publica FC-2h; acá alcanza la forma que se afirma).
    type Ref = NonNullable<Awaited<ReturnType<typeof requirePortalPatient>>>;
    type DocsLib = {
      listPortalDocuments(ref: Ref): Promise<{ id: string; title: string; occurredAt: string; sharedAt: string }[]>;
      getPortalDocument(ref: Ref, id: string): Promise<{ id: string; title: string; content: unknown } | null>;
    };
    type Page = (props: { params: Record<string, string> }) => unknown;
    type Route = (req: Request, ctx: { params: { slug: string; id: string } }) => Promise<Response>;
    // `import()` con specifier variable: si el módulo no existe, falla la fila (it.fails), no el archivo entero.
    const load = (spec: string) => import(/* @vite-ignore */ spec);
    const docsLib = async () => (await load("@/lib/portal-documents-internal")) as DocsLib;
    const listPage = async () => ((await load("@/app/(portal)/portal/c/[slug]/documentos/page")) as { default: Page }).default;
    const viewPage = async () => ((await load("@/app/(portal)/portal/c/[slug]/documentos/[id]/page")) as { default: Page }).default;
    const pdfRoute = async () => ((await load("@/app/(portal)/portal/c/[slug]/documentos/[id]/pdf/route")) as { GET: Route }).GET;
    const pdfRequest = (slug: string, id: string) =>
      new Request(`http://localhost/portal/c/${slug}/documentos/${id}/pdf`, {
        headers: { "x-forwarded-for": IP, "user-agent": UA },
      });
    const downloadAudits = (id: string) =>
      db.auditEvent.findMany({ where: { action: "patientDocument.download", payload: { path: ["documentId"], equals: id } }, select: { tenantId: true, actorId: true, ip: true, userAgent: true } });
    const allSentinels = () => [SHARED_BODY, SHARED_BODY_NEWER, SHARED_TITLE, SHARED_TITLE_NEWER, NOTE_SRC_BODY, REVOKED_BODY, FOREIGN_BODY];
    /** Ni el modelo de notas, ni sus columnas propias, ni los ids de las notas de origen, ni las claves internas del doc. */
    const expectNoNoteTrace = (json: string) => {
      expect(json).not.toMatch(BANNED_PATTERN_DOCS);
      for (const id of [...docNoteIds, ...evolutionIds]) expect(json).not.toContain(id);
      expect(json).not.toContain(NOTE_SRC_BODY);
      for (const k of ["noteId", "sourceDigest", "pdfStorageKey", "idempotencyKey", "sharedByUserId", "sharedByPractitionerId", "snapshotSha256"]) {
        expect(json, k).not.toContain(`"${k}"`);
      }
    };
    const BANNED_PATTERN_DOCS = /clinicalNote|ClinicalNote|clinical-notes|EVOLUTION|amendsNoteId|voidReason|authorPractitionerId/;

    beforeAll(async () => {
      dLive = await shareDoc(K, pK, SHARED_TITLE, SHARED_BODY, 2);
      dNewer = await shareDoc(K, pK, SHARED_TITLE_NEWER, SHARED_BODY_NEWER, 1);
      dRevoked = await shareDoc(K, pK, `Revocada ${SFX}`, REVOKED_BODY, 3);
      await db.patientDocument.update({
        where: { id: dRevoked },
        data: { revokedAt: new Date(), revokedByUserId: K.userId, revokeReason: "MANUAL" },
      });
      dOther = await shareDoc(K, pOtherK, `Ajena ${SFX}`, FOREIGN_BODY, 1);
      dStaff = await shareDoc(K, pStaffK, `Del staff ${SFX}`, FOREIGN_BODY, 1);
      dUnver = await shareDoc(K, pUnverK, `De sinverif ${SFX}`, FOREIGN_BODY, 1);
      dFree = await shareDoc(K, pFreeK, `De la ficha libre ${SFX}`, FOREIGN_BODY, 1);
      dK2 = await shareDoc(K2, pOtroK2, `De K2 ${SFX}`, FOREIGN_BODY, 1);
    });

    it("la fixture existe (el barrido no es un falso verde): 2 vivos de P, 1 revocado, ajenos vivos", async () => {
      const rows = await db.patientDocument.findMany({
        where: { id: { in: [dLive, dNewer, dRevoked, dOther, dStaff, dUnver, dFree, dK2] } },
        select: { id: true, revokedAt: true },
      });
      expect(rows).toHaveLength(8);
      expect(rows.filter((r) => r.revokedAt).map((r) => r.id)).toEqual([dRevoked]);
    });

    it("[FC-2h] matriz del portal: P ve el suyo (centinela SHARED_BODY); revocado y ajeno → null", async () => {
      as(P);
      const ref = await requirePortalPatient(K.slug);
      if (!ref) throw new Error("P debería tener ficha en K");
      const lib = await docsLib();
      const list = await lib.listPortalDocuments(ref);
      // Solo los vivos propios, el más nuevo primero.
      expect(list.map((d) => d.id)).toEqual([dNewer, dLive]);
      const view = await lib.getPortalDocument(ref, dLive);
      const json = serialize({ list, view });
      expect(json).toContain(SHARED_BODY); // vista desde el snapshot
      expect(json).toContain(SHARED_TITLE_NEWER);
      expect(json).not.toContain(REVOKED_BODY);
      expect(json).not.toContain(FOREIGN_BODY);
      expectNoNoteTrace(json);
      expect(await lib.getPortalDocument(ref, dRevoked)).toBeNull();
      expect(await lib.getPortalDocument(ref, dOther)).toBeNull();
      expect(await lib.getPortalDocument(ref, dK2)).toBeNull();
    });

    it.fails("[FC-4a] matriz del portal: P ve el suyo en las páginas (centinela SHARED_BODY)", async () => {
      as(P);
      const [List, View] = [await listPage(), await viewPage()];
      const list = await pageOf(List({ params: { slug: K.slug } }));
      const view = await pageOf(View({ params: { slug: K.slug, id: dLive } }));
      expect(list.kind).toBe("ok");
      expect(view.kind).toBe("ok");
      const json = serialize({ list, view });
      expect(json).toContain(SHARED_TITLE);
      expect(json).toContain(SHARED_TITLE_NEWER);
      expect(json).toContain(SHARED_BODY);
      expect(json).not.toContain(REVOKED_BODY);
      expect(json).not.toContain(FOREIGN_BODY);
      expectNoNoteTrace(json);
      for (const id of [dRevoked, dOther, dK2]) {
        expect((await pageOf(View({ params: { slug: K.slug, id } }))).kind, id).toBe("notFound");
      }
    });

    // P-otro, otro consultorio, sin vínculo, sin verificar, STAFF y sin sesión: ni la lista ni la vista de K (ni K2
    // para P) devuelven contenido. 404 o login (P-sinverif / sin sesión, como cuenta y ejercicios), nunca «ok».
    const DENIED: [string, () => void, () => string, () => string][] = [
      ["P-otro", () => as(POtro), () => K.slug, () => dLive],
      ["P en otro consultorio (K2)", () => as(P), () => K2.slug, () => dK2],
      ["P-sinvínculo", () => as(PFree), () => K.slug, () => dFree],
      ["P-sinverif", () => as(PUnver, false), () => K.slug, () => dUnver],
      ["STAFF", () => as(STAFF), () => K.slug, () => dStaff],
      ["sin sesión", () => as(null), () => K.slug, () => dLive],
    ];
    for (const [who, login, slug, id] of DENIED) {
      it.fails(`[FC-4a] matriz del portal: ${who} no ve documentos (lista, vista ni PDF)`, async () => {
        const [List, View, GET] = [await listPage(), await viewPage(), await pdfRoute()];
        login();
        const auditsBefore = (await downloadAudits(id())).length;
        const list = await pageOf(List({ params: { slug: slug() } }));
        const view = await pageOf(View({ params: { slug: slug(), id: id() } }));
        expect(list.kind, who).not.toBe("ok");
        expect(view.kind, who).not.toBe("ok");
        __rateLimitInternals.reset();
        const res = await GET(pdfRequest(slug(), id()), { params: { slug: slug(), id: id() } });
        expect(res.status, who).toBe(404);
        const json = serialize({ list, view }) + (await res.text());
        for (const s of allSentinels()) expect(json, who).not.toContain(s);
        expectNoNoteTrace(json);
        expect((await downloadAudits(id())).length).toBe(auditsBefore); // un 404 no deja rastro de descarga
      });
    }

    it("[FC-2h] descarga: audit (ip/ua) antes de los bytes; revocado y ajeno → 404", async () => {
      const GET = await pdfRoute();
      as(P);
      const res = await GET(pdfRequest(K.slug, dLive), { params: { slug: K.slug, id: dLive } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/pdf/);
      // ANTES de leer el cuerpo: la fila de audit ya existe (la ruta audita antes de entregar los bytes).
      expect(await downloadAudits(dLive)).toEqual([{ tenantId: K.tenantId, actorId: P.id, ip: IP, userAgent: UA }]);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
      expect(res.headers.get("content-disposition") ?? "").not.toMatch(new RegExp(docNoteIds.join("|")));
      for (const id of [dRevoked, dOther, dK2]) {
        __rateLimitInternals.reset();
        const r = await GET(pdfRequest(K.slug, id), { params: { slug: K.slug, id } });
        expect(r.status, id).toBe(404);
        expect(await downloadAudits(id)).toEqual([]);
      }
    });

    it("[FC-2h] descarga: audit caído → 503 sin bytes", async () => {
      const GET = await pdfRoute();
      as(P);
      auditFault.on = true;
      try {
        const res = await GET(pdfRequest(K.slug, dNewer), { params: { slug: K.slug, id: dNewer } });
        expect(res.status).toBe(503);
        const body = new Uint8Array(await res.arrayBuffer());
        expect(Buffer.from(body.slice(0, 5)).toString("latin1")).not.toBe("%PDF-");
      } finally {
        auditFault.on = false;
      }
    });
  });

  // ── linkPortalByInvite (al final: escribe vínculos) ──────────────────────────────────────────────────────────────

  describe("linkPortalByInvite", () => {
    const token = (patientId: string, t: EphemeralTenant, email: string) =>
      makePortalInviteToken({ patientId, tenantId: t.tenantId, email });

    it("✅ P con el token propio (ya vinculada): ok, sin escribir", async () => {
      as(P);
      const r = await refusedWithoutWrite(() => linkPortalByInvite(form({ t: token(pK, K, P.email) })));
      expect(r).toEqual({ ok: true, data: { slug: K.slug } });
    });

    it("⛔ P-otro con un token ajeno (el de P-sinvínculo): no escribe", async () => {
      as(POtro);
      const r = await refusedWithoutWrite(() => linkPortalByInvite(form({ t: token(pFreeK, K, PFree.email) })));
      expect(r.ok).toBe(false);
    });

    it("⛔ P-sinverif con el token de su ficha libre: no escribe", async () => {
      const free = await addPatient(db, K2, { email: PUnver.email });
      as(PUnver, false);
      const r = await refusedWithoutWrite(() => linkPortalByInvite(form({ t: token(free, K2, PUnver.email) })));
      expect(r.ok).toBe(false);
    });

    it("⛔ STAFF con un token a una ficha libre con su email: no escribe", async () => {
      const free = await addPatient(db, K2, { email: STAFF.email });
      as(STAFF);
      const r = await refusedWithoutWrite(() => linkPortalByInvite(form({ t: token(free, K2, STAFF.email) })));
      expect(r.ok).toBe(false);
    });

    it("✅ P-sinvínculo con su token: vincula la ficha y desde ahí el portal la ve", async () => {
      as(PFree);
      const r = await linkPortalByInvite(form({ t: token(pFreeK, K, PFree.email) }));
      expect(r).toEqual({ ok: true, data: { slug: K.slug } });
      expect((await db.patient.findUniqueOrThrow({ where: { id: pFreeK }, select: { userId: true } })).userId).toBe(
        PFree.id
      );
      const auth = await getPortalAuth();
      if (!auth.signedIn) throw new Error("debería tener sesión");
      expect(auth.patients.map((p) => p.id)).toEqual([pFreeK]);
    });

    it("✅ P-General con el token de otro consultorio General: vincula", async () => {
      const free = await addPatient(db, G2, { email: PGen.email });
      as(PGen);
      const r = await linkPortalByInvite(form({ t: token(free, G2, PGen.email) }));
      expect(r).toEqual({ ok: true, data: { slug: G2.slug } });
      expect((await db.patient.findUniqueOrThrow({ where: { id: free }, select: { userId: true } })).userId).toBe(PGen.id);
    });

    // Hallazgo [ES4-S26p] `portal-vincular-consultorio-suspendido`, decidido en ES4 P4.Z (default del orquestador, lo
    // confirma Martin): vincular NO es una escritura del consultorio. Solo habilita LECTURAS (plan, turnos, cuenta), que
    // con el consultorio suspendido siguen permitidas (Ley 26.529, BO2-D). Las escrituras del paciente (check-in, «Mis
    // datos») siguen cortadas por `publicSurfacesOpenFor`. Antes era un it.fails que pedía el rechazo.
    it("[ES4-S26p] consultorio suspendido: la invitación SÍ vincula (vincular habilita solo lecturas)", async () => {
      const someone = await account();
      const free = await addPatient(db, S, { email: someone.email });
      as(someone);
      const r = await linkPortalByInvite(form({ t: token(free, S, someone.email) }));
      expect(r).toEqual({ ok: true, data: { slug: S.slug } });
      expect((await db.patient.findUniqueOrThrow({ where: { id: free }, select: { userId: true } })).userId).toBe(
        someone.id
      );
    });
  });
});
