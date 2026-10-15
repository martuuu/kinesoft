/**
 * EV2-2b · Lecturas de evoluciones (`lib/clinical-notes-read.ts`, C-EV2-5; brief EV2 §4 «2b»).
 *
 * Contra la base real con el `getActor()` real (solo se mockea la sesión de Supabase, la cookie jar y `next/cache`,
 * tests/helpers/integration-setup.ts; acá además el step-up de 2FA para abrir el soporte, molde readonly-config).
 * Corre con los dos roles: `kinesoft_app` (RLS) y el owner BYPASSRLS (`test:integration:owner`, = prod): con
 * BYPASSRLS lo ajeno tiene que seguir sin salir por el `tenantId` a mano.
 *
 * Las notas se siembran por Prisma directo con el owner (no por `lib/clinical-notes.ts`, que escribe EV2-2a en
 * paralelo): lo que se prueba acá es la LECTURA.
 *
 * Qué se prueba:
 *   - null (no `{ note: null }`) para Secretaria, Facturación, soporte, Titular sin agenda, ADMIN, profesional básico
 *     y otro consultorio, en las 4 lecturas; también en un turno CON evolución y en un turno guest;
 *   - lee: Titular clínico, profesional dueño, profesional con share;
 *   - orden y cursor estables con empates de instante (nota ↔ nota, nota ↔ sesión, ids con `-`/`_`/mayúsculas);
 *   - búsqueda con `%` y `_` literales (y la enmienda que matchea trae su raíz);
 *   - sesiones solo con el módulo `sesiones` (General: solo notas) y agrupadas con la evolución de su turno;
 *   - anuladas presentes y marcadas; historial en orden (más nueva primero).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { ClinicalNoteKind, PrismaClient } from "@prisma/client";
import {
  getBookingClinicalNote,
  getClinicalNoteHistory,
  getPatientClinicalSummary,
  getPatientTimeline,
} from "@/lib/clinical-notes-read";
import type { TimelineItem } from "@/lib/clinical-notes-types";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// PL-Z (a2#4): `support.start` es `high` y pide el step-up de la 2FA del superadmin. Este archivo prueba la lectura
// clínica del soporte, no el step-up (que prueba two-factor.test.ts): se reemplaza la dependencia, no la action.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

type Author = { userId: string; practitionerId: string; name: string };
type NoteSeed = {
  id?: string;
  patientId: string;
  bookingId?: string | null;
  amendsNoteId?: string | null;
  kind?: ClinicalNoteKind;
  title?: string | null;
  body: string;
  occurredAt: Date;
  createdAt?: Date;
  author: Author;
};

/** Inserción directa (owner). `createdAt` explícito como la app (R11 del brief). */
async function seedNote(db: PrismaClient, t: EphemeralTenant, n: NoteSeed): Promise<string> {
  const row = await db.clinicalNote.create({
    data: {
      ...(n.id ? { id: n.id } : {}),
      tenantId: t.tenantId,
      patientId: n.patientId,
      bookingId: n.bookingId ?? null,
      amendsNoteId: n.amendsNoteId ?? null,
      kind: n.kind ?? "EVOLUTION",
      title: n.title ?? null,
      body: n.body,
      occurredAt: n.occurredAt,
      authorUserId: n.author.userId,
      authorPractitionerId: n.author.practitionerId,
      authorName: n.author.name,
      idempotencyKey: randomUUID(),
      createdAt: n.createdAt ?? new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function voidNote(db: PrismaClient, id: string, byUserId: string, reason: string) {
  await db.clinicalNote.update({ where: { id }, data: { voidedAt: new Date(), voidedByUserId: byUserId, voidReason: reason } });
}

async function seedBooking(
  db: PrismaClient,
  t: EphemeralTenant,
  o: { patientId: string | null; at: Date; status?: "CONFIRMED" | "COMPLETED" | "CANCELLED"; programId?: string; sessionId?: string }
): Promise<string> {
  const b = await db.booking.create({
    data: {
      tenantId: t.tenantId,
      practitionerId: t.practitionerId,
      serviceId: t.serviceId,
      patientId: o.patientId,
      guestName: o.patientId ? null : "Invitado EV2-2b",
      scheduledFor: o.at,
      durationMin: 45,
      status: o.status ?? "COMPLETED",
      idempotencyKey: randomUUID(),
      programId: o.programId ?? null,
      sessionId: o.sessionId ?? null,
    },
    select: { id: true },
  });
  return b.id;
}

async function seedProgram(db: PrismaClient, t: EphemeralTenant, patientId: string, title: string): Promise<string> {
  const p = await db.treatmentProgram.create({
    data: { tenantId: t.tenantId, patientId, title, startDate: new Date("2026-01-01T03:00:00Z"), practitionerId: t.practitionerId },
    select: { id: true },
  });
  return p.id;
}

async function seedCompletedSession(
  db: PrismaClient,
  t: EphemeralTenant,
  o: { id?: string; programId: string; index: number; completedAt: Date; notes?: string | null }
): Promise<string> {
  const s = await db.session.create({
    data: {
      ...(o.id ? { id: o.id } : {}),
      programId: o.programId,
      practitionerId: t.practitionerId,
      index: o.index,
      scheduledFor: o.completedAt,
      completedAt: o.completedAt,
      notes: o.notes ?? null,
    },
    select: { id: true },
  });
  return s.id;
}

/** Todas las páginas con el cursor; corta si algo no avanza (un cursor roto no cuelga el test). */
async function allPages(patientId: string, limit: number, q?: string): Promise<{ pages: TimelineItem[][]; keys: string[] }> {
  const pages: TimelineItem[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await getPatientTimeline({ patientId, cursor, limit, q });
    if (!page) throw new Error("timeline null");
    pages.push(page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { pages, keys: pages.flat().map((i) => i.key) };
}

const jsDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

describe.skipIf(!RUN)("EV2-2b · lecturas de evoluciones", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología (módulo `sesiones`)
  let G: EphemeralTenant; // General (sin `sesiones`)
  let Other: EphemeralTenant;
  let H: EphemeralTenant; // superadmin para el soporte
  let owner: Author;
  let pro: Author;
  const users = {} as Record<"PRO" | "PRO_SHARE" | "PRO_BASIC" | "ASSISTANT" | "BILLING" | "ADMIN", string>;
  let patientId: string; // asignado a PRO, compartido con PRO_SHARE
  let bookingWithNote: string;
  let guestBooking: string;
  let emptyBooking: string;
  let liveRoot: string;
  let voidedRoot: string;
  let amendment: string;
  let editedNote: string;
  let otherPatientId: string;
  let otherNote: string;
  let otherBooking: string;
  let gPatientId: string;
  let gNote: string;

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", saasPlan: "CONSULTORIO" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    H = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });

    const p = await addPractitioner(db, K, "PRACTITIONER");
    const share = await addPractitioner(db, K, "PRACTITIONER");
    const basic = await addPractitioner(db, K, "PRACTITIONER");
    users.PRO = p.userId;
    users.PRO_SHARE = share.userId;
    users.PRO_BASIC = basic.userId;
    users.ASSISTANT = (await addPractitioner(db, K, "ASSISTANT")).userId;
    users.BILLING = (await addPractitioner(db, K, "BILLING")).userId;
    // ADMIN con `clinical = true` en la fila (forma vieja, la factory la deja así): igual nunca atiende (§20.17).
    users.ADMIN = (await addPractitioner(db, K, "ADMIN")).userId;
    await db.membership.update({
      where: { userId_tenantId: { userId: users.ADMIN, tenantId: K.tenantId } },
      data: { clinical: true },
    });
    owner = { userId: K.userId, practitionerId: K.practitionerId, name: "Titular EV2-2b" };
    pro = { userId: p.userId, practitionerId: p.practitionerId, name: "Kine EV2-2b" };

    patientId = await addPatient(db, K, { assignedPractitionerId: p.practitionerId });
    await db.patientShare.create({ data: { tenantId: K.tenantId, patientId, practitionerId: share.practitionerId } });

    // Turno con: raíz anulada, raíz viva (después de anular la primera, EV2-D2) y una enmienda de la viva.
    bookingWithNote = await seedBooking(db, K, { patientId, at: new Date("2026-03-10T13:00:00Z") });
    voidedRoot = await seedNote(db, K, {
      patientId,
      bookingId: bookingWithNote,
      body: "Primera versión anulada",
      occurredAt: new Date("2026-03-10T13:00:00Z"),
      createdAt: new Date("2026-03-10T14:00:00Z"),
      author: pro,
    });
    await voidNote(db, voidedRoot, pro.userId, "Cargada en el paciente equivocado");
    liveRoot = await seedNote(db, K, {
      patientId,
      bookingId: bookingWithNote,
      kind: "FIRST_VISIT",
      title: "Lumbalgia",
      body: "Dolor lumbar EV2-2b",
      occurredAt: new Date("2026-03-10T13:00:00Z"),
      createdAt: new Date("2026-03-10T15:00:00Z"),
      author: pro,
    });
    amendment = await seedNote(db, K, {
      patientId,
      bookingId: bookingWithNote,
      amendsNoteId: liveRoot,
      kind: "FIRST_VISIT",
      body: "Enmienda: además irradia a la pierna",
      occurredAt: new Date("2026-03-12T12:00:00Z"),
      createdAt: new Date("2026-03-12T12:00:00Z"),
      author: owner,
    });
    guestBooking = await seedBooking(db, K, { patientId: null, at: new Date("2026-03-11T13:00:00Z") });
    emptyBooking = await seedBooking(db, K, { patientId, at: new Date("2026-03-11T15:00:00Z") });

    // Editada dos veces (dentro de las 24 h: `createdAt` = ahora): el trigger guarda las versiones anteriores.
    editedNote = await seedNote(db, K, { patientId, body: "v1", title: "T1", occurredAt: new Date("2026-02-01T12:00:00Z"), author: pro });
    await db.clinicalNote.update({ where: { id: editedNote }, data: { body: "v2", title: "T2" } });
    await db.clinicalNote.update({ where: { id: editedNote }, data: { body: "v3", title: "T3" } });

    otherPatientId = await addPatient(db, Other);
    otherBooking = await seedBooking(db, Other, { patientId: otherPatientId, at: new Date("2026-03-10T13:00:00Z") });
    otherNote = await seedNote(db, Other, {
      patientId: otherPatientId,
      bookingId: otherBooking,
      body: "Nota de otro consultorio",
      occurredAt: new Date("2026-03-10T13:00:00Z"),
      author: { userId: Other.userId, practitionerId: Other.practitionerId, name: "Otro" },
    });

    gPatientId = await addPatient(db, G);
    gNote = await seedNote(db, G, {
      patientId: gPatientId,
      body: "Consulta general",
      occurredAt: new Date("2026-03-01T12:00:00Z"),
      author: { userId: G.userId, practitionerId: G.practitionerId, name: "Gral" },
    });
    // Una sesión completada en el consultorio General (dato heredado): no tiene que salir sin el módulo `sesiones`.
    const gProgram = await seedProgram(db, G, gPatientId, "Plan heredado");
    await seedCompletedSession(db, G, { programId: gProgram, index: 1, completedAt: new Date("2026-03-02T12:00:00Z") });
  });

  afterAll(async () => {
    cookies().delete(SUPPORT_COOKIE);
    if (db && H) await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
    await K?.cleanup();
    await G?.cleanup();
    await Other?.cleanup();
    await H?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    cookies().delete(SUPPORT_COOKIE);
  });

  /** Las 4 lecturas sobre lo de K; todas tienen que dar null. */
  async function expectAllNull(label: string) {
    expect(await getPatientTimeline({ patientId }), label).toBeNull();
    expect(await getClinicalNoteHistory(editedNote), label).toBeNull();
    expect(await getClinicalNoteHistory(liveRoot), label).toBeNull();
    // Turno CON evolución: null, no `{ note: null }` (no revela que la tiene).
    expect(await getBookingClinicalNote(bookingWithNote), label).toBeNull();
    expect(await getBookingClinicalNote(emptyBooking), label).toBeNull();
    expect(await getPatientClinicalSummary(patientId), label).toBeNull();
  }

  describe("acceso", () => {
    it.each(["PRO_BASIC", "ASSISTANT", "BILLING", "ADMIN"] as const)("%s → null en las 4 lecturas", async (role) => {
      asUser(users[role]);
      await expectAllNull(role);
    });

    it("Titular sin agenda (clinical = false) → null", async () => {
      await db.membership.update({
        where: { userId_tenantId: { userId: K.userId, tenantId: K.tenantId } },
        data: { clinical: false },
      });
      try {
        asUser(K.userId);
        await expectAllNull("titular sin agenda");
      } finally {
        await db.membership.update({
          where: { userId_tenantId: { userId: K.userId, tenantId: K.tenantId } },
          data: { clinical: true },
        });
      }
    });

    describe("soporte", () => {
      beforeEach(async () => {
        await db.supportSession.updateMany({
          where: { superadminId: H.userId, endedAt: null },
          data: { endedAt: new Date(), endedReason: "test" },
        });
        asUser(H.userId);
        const r = await startSupport(K.tenantId, "Ayuda con la agenda del consultorio");
        if (!r.ok) throw new Error(r.error);
      });
      afterEach(() => {
        cookies().delete(SUPPORT_COOKIE);
      });

      it("el soporte (SUPPORT_CAPS, sin clínico) → null", async () => {
        await expectAllNull("soporte");
      });
    });

    it("otro consultorio → null (paciente, nota y turno ajenos), también con BYPASSRLS", async () => {
      asUser(Other.userId);
      await expectAllNull("otro consultorio");
      // Y al revés: el Titular de K no ve lo de Other.
      asUser(K.userId);
      expect(await getPatientTimeline({ patientId: otherPatientId })).toBeNull();
      expect(await getClinicalNoteHistory(otherNote)).toBeNull();
      expect(await getBookingClinicalNote(otherBooking)).toBeNull();
      expect(await getPatientClinicalSummary(otherPatientId)).toBeNull();
    });

    it("turno guest → null; ids con forma inválida → null sin tirar", async () => {
      asUser(K.userId);
      expect(await getBookingClinicalNote(guestBooking)).toBeNull();
      expect(await getBookingClinicalNote("x' OR 1=1 --")).toBeNull();
      expect(await getClinicalNoteHistory("")).toBeNull();
      expect(await getPatientTimeline({ patientId: "a".repeat(65) })).toBeNull();
      expect(await getPatientClinicalSummary("no/valido")).toBeNull();
    });

    it.each(["OWNER", "PRO", "PRO_SHARE"] as const)("%s (clínico con acceso full) lee", async (role) => {
      asUser(role === "OWNER" ? K.userId : users[role]);
      const page = await getPatientTimeline({ patientId });
      expect(page).not.toBeNull();
      expect(page!.items.some((i) => i.type === "note" && i.note.id === liveRoot)).toBe(true);
      expect(await getPatientClinicalSummary(patientId)).not.toBeNull();
      expect(await getBookingClinicalNote(bookingWithNote)).not.toBeNull();
      expect(await getClinicalNoteHistory(editedNote)).not.toBeNull();
    });
  });

  describe("contenido", () => {
    it("getBookingClinicalNote: raíz viva, su enmienda, la anulada aparte con su motivo, y permisos por actor", async () => {
      asUser(pro.userId);
      const v = await getBookingClinicalNote(bookingWithNote);
      expect(v).not.toBeNull();
      expect(v!.note).toMatchObject({
        id: liveRoot,
        kind: "FIRST_VISIT",
        title: "Lumbalgia",
        body: "Dolor lumbar EV2-2b",
        voided: null,
        author: { userId: pro.userId, practitionerId: pro.practitionerId, name: "Kine EV2-2b" },
        booking: { id: bookingWithNote, status: "COMPLETED", serviceName: "Consulta" },
      });
      // Autor, pero creada hace meses: fuera de las 24 h. Enmendar y anular sí (autor).
      expect(v!.note!.permissions).toEqual({ canEdit: false, canAmend: true, canVoid: true, editableUntil: null });
      expect(v!.amendments.map((a) => a.id)).toEqual([amendment]);
      expect(v!.voided).toHaveLength(1);
      expect(v!.voided[0]).toMatchObject({
        id: voidedRoot,
        voided: { byUserId: pro.userId, reason: "Cargada en el paciente equivocado" },
      });
      // Ya hay raíz viva: no se puede crear otra.
      expect(v!.canCreate).toBe(false);

      // Con share (puede escribir, no es autor ni Titular): no anula.
      asUser(users.PRO_SHARE);
      const s = await getBookingClinicalNote(bookingWithNote);
      expect(s!.note!.permissions).toEqual({ canEdit: false, canAmend: true, canVoid: false, editableUntil: null });
      // Titular clínico: anula aunque no sea el autor (EV2-D15).
      asUser(K.userId);
      const o = await getBookingClinicalNote(bookingWithNote);
      expect(o!.note!.permissions.canVoid).toBe(true);
    });

    it("getBookingClinicalNote en un turno sin evolución: { note: null } y canCreate para quien escribe", async () => {
      asUser(pro.userId);
      expect(await getBookingClinicalNote(emptyBooking)).toEqual({ note: null, amendments: [], voided: [], canCreate: true });
    });

    it("getClinicalNoteHistory: versiones anteriores, más nueva primero", async () => {
      asUser(pro.userId);
      const h = await getClinicalNoteHistory(editedNote);
      expect(h!.map((r) => [r.revision, r.title, r.body])).toEqual([
        [2, "T2", "v2"],
        [1, "T1", "v1"],
      ]);
      for (const r of h!) {
        expect(Date.parse(r.replacedAt)).toBeGreaterThanOrEqual(Date.parse(r.savedAt));
        expect(r.occurredAt).toBe("2026-02-01T12:00:00.000Z");
      }
      // Sin ediciones → lista vacía (no null).
      expect(await getClinicalNoteHistory(liveRoot)).toEqual([]);
    });

    it("getPatientClinicalSummary: última viva por occurredAt y conteo de raíces vivas (sin anuladas ni enmiendas)", async () => {
      asUser(pro.userId);
      const s = await getPatientClinicalSummary(patientId);
      expect(s!.latest?.id).toBe(liveRoot);
      // liveRoot + editedNote (la anulada y la enmienda no cuentan).
      expect(s!.liveCount).toBe(2);
    });

    it("timeline: anuladas presentes y marcadas; enmiendas debajo de su raíz", async () => {
      asUser(pro.userId);
      const page = await getPatientTimeline({ patientId });
      const notes = page!.items.filter((i): i is Extract<TimelineItem, { type: "note" }> => i.type === "note");
      const live = notes.find((i) => i.note.id === liveRoot)!;
      expect(live.amendments.map((a) => a.id)).toEqual([amendment]);
      const voided = notes.find((i) => i.note.id === voidedRoot)!;
      expect(voided.note.voided?.reason).toBe("Cargada en el paciente equivocado");
      // La enmienda no sale como ítem propio.
      expect(notes.some((i) => i.note.id === amendment)).toBe(false);
      expect(page!.nextCursor).toBeNull();
    });
  });

  describe("orden, cursor y búsqueda (paciente propio)", () => {
    let P: string;
    const AT = new Date("2026-05-05T15:00:00.000Z");
    let tieNoteIds: string[];
    let tieSessionIds: string[];
    let groupedNote: string;
    let groupedSession: string;
    let sfx: string;

    beforeAll(async () => {
      sfx = uniqueSuffix().replace(/[^A-Za-z0-9]/g, "");
      P = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });
      // Empates en el MISMO instante, con ids que ordenan distinto en en_US que por unidades de código (`-` < `A` <
      // `_` < `a`): si la lectura no usa el mismo orden que `mergeTimeline`, la paginación repite o pierde.
      tieNoteIds = [`ev2b${sfx}-x`, `ev2b${sfx}Ax`, `ev2b${sfx}_x`, `ev2b${sfx}ax`, `ev2b${sfx}bx`];
      for (const id of tieNoteIds) await seedNote(db, K, { id, patientId: P, body: `empate ${id}`, occurredAt: AT, author: pro });
      const program = await seedProgram(db, K, P, "Plan EV2-2b");
      tieSessionIds = [`ev2b${sfx}-s`, `ev2b${sfx}Zs`];
      let idx = 1;
      for (const id of tieSessionIds) await seedCompletedSession(db, K, { id, programId: program, index: idx++, completedAt: AT });
      // Antes y después del empate.
      await seedNote(db, K, { patientId: P, body: "nota nueva", occurredAt: new Date("2026-05-06T12:00:00Z"), author: pro });
      await seedNote(db, K, { patientId: P, body: "nota vieja", occurredAt: new Date("2026-05-01T12:00:00Z"), author: pro });
      // Sesión + evolución del MISMO turno: van juntas (la sesión se completa después de la hora del turno).
      const sid = await seedCompletedSession(db, K, { programId: program, index: idx++, completedAt: new Date("2026-05-03T14:00:00Z") });
      const bid = await seedBooking(db, K, { patientId: P, at: new Date("2026-05-03T13:00:00Z"), programId: program, sessionId: sid });
      groupedSession = sid;
      groupedNote = await seedNote(db, K, {
        patientId: P,
        bookingId: bid,
        body: "evolución del turno con sesión",
        occurredAt: new Date("2026-05-03T13:00:00Z"),
        author: pro,
      });
      // Una sesión archivada y una no completada: nunca salen.
      await db.session.create({
        data: { programId: program, practitionerId: K.practitionerId, index: idx++, scheduledFor: AT, completedAt: AT, archivedAt: new Date() },
      });
      await db.session.create({ data: { programId: program, practitionerId: K.practitionerId, index: idx++, scheduledFor: AT } });
      // Búsqueda: `%` y `_` literales.
      await seedNote(db, K, { patientId: P, title: "Mejoró 50% la movilidad", body: "x", occurredAt: new Date("2026-04-01T12:00:00Z"), author: pro });
      await seedNote(db, K, { patientId: P, title: "Mejoró 50 grados", body: "x", occurredAt: new Date("2026-04-02T12:00:00Z"), author: pro });
      await seedNote(db, K, { patientId: P, body: "flexión a_b", occurredAt: new Date("2026-04-03T12:00:00Z"), author: pro });
      await seedNote(db, K, { patientId: P, body: "flexión axb", occurredAt: new Date("2026-04-04T12:00:00Z"), author: pro });
      const searchRoot = await seedNote(db, K, { patientId: P, body: "raíz sin la palabra", occurredAt: new Date("2026-04-05T12:00:00Z"), author: pro });
      await seedNote(db, K, {
        patientId: P,
        amendsNoteId: searchRoot,
        body: "enmienda con zanahoria",
        occurredAt: new Date("2026-04-06T12:00:00Z"),
        author: pro,
      });
    });

    it("la paginación (de a 1, 2, 3 y 50) recorre todo una sola vez y en orden (at DESC, key DESC por unidades de código)", async () => {
      asUser(pro.userId);
      const full = await allPages(P, 50);
      expect(full.pages).toHaveLength(1);
      // Orden esperado en el empate: sesiones ('s:') antes que notas ('n:'), y dentro de cada tipo por id desc (JS).
      const tieKeys = [...tieSessionIds.map((id) => `s:${id}`), ...tieNoteIds.map((id) => `n:${id}`)].sort(jsDesc);
      const at = full.pages[0].map((i) => i.at);
      const firstTie = at.indexOf(AT.toISOString());
      expect(full.keys.slice(firstTie, firstTie + tieKeys.length)).toEqual(tieKeys);
      // at no creciente en todo el recorrido.
      for (let i = 1; i < at.length; i++) expect(Date.parse(at[i])).toBeLessThanOrEqual(Date.parse(at[i - 1]));

      for (const limit of [1, 2, 3]) {
        const paged = await allPages(P, limit);
        expect(paged.keys, `limit ${limit}`).toEqual(full.keys);
        expect(new Set(paged.keys).size).toBe(paged.keys.length);
        for (const page of paged.pages.slice(0, -1)) expect(page.length).toBeLessThanOrEqual(limit);
      }
    });

    it("sesiones: la completada del turno va adentro de su evolución; archivadas y pendientes no salen", async () => {
      asUser(pro.userId);
      const { pages } = await allPages(P, 50);
      const items = pages.flat();
      const grouped = items.find((i) => i.type === "note" && i.note.id === groupedNote);
      expect(grouped?.type === "note" && grouped.session?.id).toBe(groupedSession);
      expect(items.some((i) => i.type === "session" && i.session.id === groupedSession)).toBe(false);
      const sessionIds = items.flatMap((i) => (i.type === "session" ? [i.session.id] : i.session ? [i.session.id] : []));
      expect(sessionIds.sort()).toEqual([...tieSessionIds, groupedSession].sort());
      const s = items.find((i) => i.type === "session")!;
      expect(s.type === "session" && s.session).toMatchObject({ programTitle: "Plan EV2-2b", exercisesDone: 0, exercisesTotal: 0 });
    });

    it("búsqueda: `%` y `_` son literales; la enmienda que matchea trae su raíz", async () => {
      asUser(pro.userId);
      const pct = await getPatientTimeline({ patientId: P, q: "50%" });
      expect(pct!.items.map((i) => (i.type === "note" ? i.note.title : null))).toEqual(["Mejoró 50% la movilidad"]);
      const und = await getPatientTimeline({ patientId: P, q: "  A_B " });
      expect(und!.items.map((i) => (i.type === "note" ? i.note.body : null))).toEqual(["flexión a_b"]);
      const am = await getPatientTimeline({ patientId: P, q: "zanahoria" });
      expect(am!.items).toHaveLength(1);
      expect(am!.items[0].type === "note" && am!.items[0].amendments.map((a) => a.body)).toEqual(["enmienda con zanahoria"]);
      // Vacío o solo espacios = sin filtro.
      const blank = await getPatientTimeline({ patientId: P, q: "   ", limit: 50 });
      expect(blank!.items.length).toBeGreaterThan(10);
    });

    it("cursor basura → primera página (no tira)", async () => {
      asUser(pro.userId);
      const first = await getPatientTimeline({ patientId: P, limit: 2 });
      const junk = await getPatientTimeline({ patientId: P, limit: 2, cursor: "no-es-un-cursor" });
      expect(junk!.items.map((i) => i.key)).toEqual(first!.items.map((i) => i.key));
    });
  });

  it("consultorio General (sin módulo `sesiones`): solo notas", async () => {
    asUser(G.userId);
    const page = await getPatientTimeline({ patientId: gPatientId });
    expect(page!.items.map((i) => i.type)).toEqual(["note"]);
    expect(page!.items[0].type === "note" && page!.items[0].note.id).toBe(gNote);
  });
});
