/**
 * EV2-2a · escrituras de evoluciones (`lib/clinical-notes.ts`, C-EV2-4; brief EV2 §1 EV2-D1..D24, §4 «2a»).
 *
 * Matriz de escritura del brief, completa. Cada fila afirma el efecto OBSERVABLE: la fila de ClinicalNote (o su
 * ausencia), ClinicalNoteRevision cuando corresponde y el AuditEvent (`clinicalNote.*`, entity "Patient",
 * entityId = paciente, `payload.noteId`, sin texto clínico ni motivo). Un rechazo afirma el copy exacto de
 * CLINICAL_NOTE_COPY y que no quedó ni nota ni audit.
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- clinical-notes` = kinesoft_app con RLS;
 * `:owner` = BYPASSRLS como prod). Se mockea solo lo externo (sesión de Supabase, cookies, `next/cache`:
 * integration-setup), el step-up de 2FA de Plataforma (para abrir la sesión de soporte) y el despacho del mail de
 * soporte. Las notas «viejas» (pasadas las 24 h) las siembra el owner con SQL: la app escribe `createdAt` = ahora.
 *
 * ClinicalNote no se puede borrar (trigger): cada caso usa su propio paciente para que los conteos no se pisen; la
 * limpieza va por deleteTenantDeep (modo réplica).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import {
  amendClinicalNote,
  createClinicalNote,
  editClinicalNote,
  voidClinicalNote,
} from "@/lib/clinical-notes";
import { CLINICAL_NOTE_COPY } from "@/lib/clinical-notes-types";
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __setEmailTransportForTests } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { getActor } from "@/lib/session";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// La sesión de soporte se abre con la action real; el step-up de 2FA se da por hecho (se prueba en two-factor.test.ts).
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const H = 60 * 60 * 1000;
const C = CLINICAL_NOTE_COPY;

type Member = { userId: string; practitionerId: string | null };

describe.skipIf(!RUN)("[EV2-2a] escrituras de evoluciones", () => {
  let db: PrismaClient;
  /** Consultorio principal: OWNER clínico (Titular) + equipo. */
  let A: EphemeralTenant;
  /** Otro consultorio (cruce de tenant). */
  let B: EphemeralTenant;
  /** Titular que NO atiende (Membership.clinical = false). */
  let N: EphemeralTenant;
  /** Consultorio en solo lectura (deuda). */
  let RO: EphemeralTenant;
  /** Consultorio «casa» del superadmin de soporte. */
  let S: EphemeralTenant;

  let P1: Member; // profesional dueño (asignado a los pacientes de `patient()`)
  let P2: Member; // profesional con share
  let P3: Member; // profesional básico (sin asignación ni share)
  let ADM: Member; // ADMIN con fila `clinical = true` y profesional (forma vieja): nunca atiende
  let SEC: Member; // Secretaria
  let FAC: Member; // Facturación

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    N = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    await db.membership.update({ where: { userId_tenantId: { userId: N.userId, tenantId: N.tenantId } }, data: { clinical: false } });
    RO = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    S = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });

    P1 = await addPractitioner(db, A);
    P2 = await addPractitioner(db, A);
    P3 = await addPractitioner(db, A);
    ADM = await addPractitioner(db, A, "ADMIN");
    await db.membership.update({ where: { userId_tenantId: { userId: ADM.userId, tenantId: A.tenantId } }, data: { clinical: true } });
    SEC = await staff("ASSISTANT");
    FAC = await staff("BILLING");
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      for (const t of [A, B, N, RO, S]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    cookies().delete(SUPPORT_COOKIE);
  });

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Secretaria / Facturación: sin `Practitioner` (IAM-4a). */
  async function staff(role: "ASSISTANT" | "BILLING"): Promise<Member> {
    const userId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({ data: { userId, tenantId: A.tenantId, role, acceptedAt: new Date() } });
    return { userId, practitionerId: null };
  }

  /** Paciente de A asignado a P1 y compartido con P2. */
  async function patient(t: EphemeralTenant = A): Promise<string> {
    if (t !== A) return addPatient(db, t);
    const id = await addPatient(db, A, { assignedPractitionerId: P1.practitionerId });
    await db.patientShare.create({ data: { tenantId: A.tenantId, patientId: id, practitionerId: P2.practitionerId!, sharedById: P1.userId } });
    return id;
  }

  async function booking(
    t: EphemeralTenant,
    patientId: string | null,
    opts: { at?: Date; status?: BookingStatus } = {}
  ): Promise<{ id: string; scheduledFor: Date }> {
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        ...(patientId ? {} : { guestName: "Invitado Test", guestPhone: "1155550000" }),
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: opts.at ?? new Date(Date.now() - 2 * H),
        durationMin: 45,
        status: opts.status ?? "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
      select: { id: true, scheduledFor: true },
    });
    return b;
  }

  /** Nota sembrada por el owner (para edades que la app no puede producir: createdAt de hace 25 h). */
  async function seedNote(
    t: EphemeralTenant,
    patientId: string,
    author: { userId: string; practitionerId: string },
    opts: { ageMs?: number; bookingId?: string | null; amendsNoteId?: string | null } = {}
  ): Promise<string> {
    const id = `ev2-2a-${uniqueSuffix()}`;
    const createdAt = new Date(Date.now() - (opts.ageMs ?? 0));
    await db.clinicalNote.create({
      data: {
        id,
        tenantId: t.tenantId,
        patientId,
        bookingId: opts.bookingId ?? null,
        amendsNoteId: opts.amendsNoteId ?? null,
        body: "Nota sembrada",
        occurredAt: createdAt,
        authorUserId: author.userId,
        authorPractitionerId: author.practitionerId,
        authorName: "Kine Sembrado",
        idempotencyKey: randomUUID(),
        createdAt,
      },
    });
    return id;
  }

  const notesOf = (patientId: string) => db.clinicalNote.findMany({ where: { patientId }, orderBy: { createdAt: "asc" } });
  const auditsOf = (patientId: string, action?: string) =>
    db.auditEvent.findMany({
      where: { entity: "Patient", entityId: patientId, action: action ?? { startsWith: "clinicalNote." } },
      orderBy: { createdAt: "asc" },
    });

  /** Rechazo: copy exacto, ninguna nota nueva ni audit `clinicalNote.*` del paciente. */
  async function expectRejected(
    r: { ok: boolean; error?: string },
    error: string,
    patientId: string,
    notesBefore = 0
  ): Promise<void> {
    expect(r).toMatchObject({ ok: false, error });
    expect(await db.clinicalNote.count({ where: { patientId } })).toBe(notesBefore);
    expect(await db.auditEvent.count({ where: { entity: "Patient", entityId: patientId, action: { startsWith: "clinicalNote." } } })).toBe(0);
  }

  function createAs(user: string, input: Parameters<typeof createClinicalNote>[0]) {
    asUser(user);
    return createClinicalNote(input);
  }

  const newInput = (patientId: string, over: Partial<Parameters<typeof createClinicalNote>[0]> = {}) => ({
    patientId,
    body: "  Dolor lumbar 6/10, mejora con movilidad.  ",
    idempotencyKey: randomUUID(),
    ...over,
  });

  /** Crea por la action (como `user`) y devuelve el id; tira si falla. */
  async function created(user: string, patientId: string, over: Partial<Parameters<typeof createClinicalNote>[0]> = {}) {
    const r = await createAs(user, newInput(patientId, over));
    if (!r.ok) throw new Error(`create: ${r.error}`);
    return r.data.note;
  }

  // ── Crear: quién ────────────────────────────────────────────────────────────────────────────────────────────

  it("Titular clínico crea en un turno: fila con autor congelado, occurredAt = turno, cuerpo con trim, audit sin texto", async () => {
    const pid = await patient();
    const b = await booking(A, pid);
    const before = Date.now();
    const r = await createAs(A.userId, newInput(pid, { bookingId: b.id }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.replayed).toBe(false);

    const [row] = await notesOf(pid);
    const owner = await db.userProfile.findUniqueOrThrow({ where: { id: A.userId }, select: { fullName: true } });
    expect(row).toMatchObject({
      id: r.data.note.id,
      tenantId: A.tenantId,
      bookingId: b.id,
      amendsNoteId: null,
      kind: "EVOLUTION",
      title: null,
      body: "Dolor lumbar 6/10, mejora con movilidad.",
      authorUserId: A.userId,
      authorPractitionerId: A.practitionerId,
      authorName: owner.fullName,
      revision: 1,
      voidedAt: null,
    });
    expect(row.occurredAt.getTime()).toBe(b.scheduledFor.getTime());
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    expect(r.data.note).toMatchObject({ id: row.id, bookingId: b.id, revision: 1, voided: null, booking: { id: b.id, serviceName: "Consulta" } });
    expect(r.data.note.permissions).toMatchObject({ canEdit: true, canAmend: true, canVoid: true });

    const audits = await auditsOf(pid);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A.tenantId, actorId: A.userId, action: "clinicalNote.create", entity: "Patient", entityId: pid });
    expect(audits[0].payload).toMatchObject({ noteId: row.id, bookingId: b.id, kind: "EVOLUTION" });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Dolor");
  });

  it("profesional dueño crea sin turno: tipo y título, occurredAt = ahora", async () => {
    const pid = await patient();
    const r = await createAs(P1.userId, newInput(pid, { kind: "FIRST_VISIT", title: "  Ingreso  " }));
    expect(r.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect(row).toMatchObject({ bookingId: null, kind: "FIRST_VISIT", title: "Ingreso", authorUserId: P1.userId, authorPractitionerId: P1.practitionerId });
    expect(Math.abs(row.occurredAt.getTime() - Date.now())).toBeLessThan(10_000);
    expect(await auditsOf(pid, "clinicalNote.create")).toHaveLength(1);
  });

  it("profesional con share crea", async () => {
    const pid = await patient();
    const r = await createAs(P2.userId, newInput(pid));
    expect(r.ok).toBe(true);
    const [row] = await notesOf(pid);
    expect(row).toMatchObject({ authorUserId: P2.userId, authorPractitionerId: P2.practitionerId });
    expect(await auditsOf(pid, "clinicalNote.create")).toHaveLength(1);
  });

  it("profesional básico, Secretaria, Facturación y ADMIN (aunque la fila diga clinical=true) → forbidden, sin fila", async () => {
    for (const m of [P3, SEC, FAC, ADM]) {
      const pid = await patient();
      await expectRejected(await createAs(m.userId, newInput(pid)), C.forbidden, pid);
    }
  });

  it("Titular sin agenda (no atiende) → forbidden, sin fila", async () => {
    const pid = await patient(N);
    await expectRejected(await createAs(N.userId, newInput(pid)), C.forbidden, pid);
  });

  it("soporte (sesión de soporte, solo lectura y sin clínico) → {ok:false}, sin fila", async () => {
    const pid = await patient();
    __rateLimitInternals.reset();
    __setEmailTransportForTests(async () => ({ ok: true, transport: "resend", providerId: "fake" }));
    asUser(S.userId);
    const s = await startSupport(A.tenantId, "Ayuda con evoluciones del consultorio");
    if (!s.ok) throw new Error(s.error);
    expect((await getActor()).support?.sessionId).toBe(s.data.sessionId);
    const r = await createClinicalNote(newInput(pid));
    await expectRejected(r, C.forbidden, pid);
    await db.supportSession.update({ where: { id: s.data.sessionId }, data: { endedAt: new Date(), endedReason: "test" } });
  });

  it("consultorio en solo lectura (deuda) → {ok:false} con el copy del modo lectura, sin fila", async () => {
    const pid = await patient(RO);
    await db.tenant.update({ where: { id: RO.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    asUser(RO.userId);
    expect((await getActor()).access.mode).toBe("read_only");
    await expectRejected(await createClinicalNote(newInput(pid)), READ_ONLY_MESSAGE, pid);
  });

  // ── Crear: turno y fecha ────────────────────────────────────────────────────────────────────────────────────

  it("cruce de tenant: paciente de otro consultorio → forbidden; turno de otro consultorio → bookingNotFound", async () => {
    const foreign = await patient(B);
    await expectRejected(await createAs(A.userId, newInput(foreign)), C.forbidden, foreign);
    const pid = await patient();
    const foreignBooking = await booking(B, foreign);
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: foreignBooking.id })), C.bookingNotFound, pid);
  });

  it("turno de otro paciente o de invitado → bookingOtherPatient", async () => {
    const pid = await patient();
    const other = await patient();
    const b = await booking(A, other);
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: b.id })), C.bookingOtherPatient, pid);
    const guest = await booking(A, null);
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: guest.id })), C.bookingOtherPatient, pid);
  });

  it("turno cancelado → bookingCancelled; ausente → bookingNoShow", async () => {
    const pid = await patient();
    const c = await booking(A, pid, { status: "CANCELLED" });
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: c.id })), C.bookingCancelled, pid);
    const ns = await booking(A, pid, { status: "NO_SHOW", at: new Date(Date.now() - 5 * H) });
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: ns.id })), C.bookingNoShow, pid);
  });

  it("turno a 13 h → future; a 11 h → ok; occurredAt explícito a 13 h → future", async () => {
    const pid = await patient();
    const far = await booking(A, pid, { at: new Date(Date.now() + 13 * H) });
    await expectRejected(await createAs(A.userId, newInput(pid, { bookingId: far.id })), C.future, pid);
    await expectRejected(
      await createAs(A.userId, newInput(pid, { occurredAt: new Date(Date.now() + 13 * H).toISOString() })),
      C.future,
      pid
    );
    const near = await booking(A, pid, { at: new Date(Date.now() + 11 * H) });
    const r = await createAs(A.userId, newInput(pid, { bookingId: near.id }));
    expect(r.ok).toBe(true);
    const rows = await notesOf(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurredAt.getTime()).toBe(near.scheduledFor.getTime());
    expect(await auditsOf(pid, "clinicalNote.create")).toHaveLength(1);
  });

  it("segunda raíz en el turno → bookingTaken (secuencial y en paralelo con claves distintas); anulada libera el turno", async () => {
    const pid = await patient();
    const b = await booking(A, pid);
    const first = await created(P1.userId, pid, { bookingId: b.id });
    const r = await createAs(A.userId, newInput(pid, { bookingId: b.id }));
    expect(r).toMatchObject({ ok: false, error: C.bookingTaken });
    expect(await db.clinicalNote.count({ where: { patientId: pid } })).toBe(1);

    asUser(P1.userId);
    const v = await voidClinicalNote({ noteId: first.id, expectedRevision: 1, reason: "Cargada en el turno equivocado" });
    expect(v.ok).toBe(true);
    const again = await created(P1.userId, pid, { bookingId: b.id });
    expect(again.id).not.toBe(first.id);

    // Carrera: dos editores distintos sobre un turno libre → una fila; el otro, bookingTaken (23505 del parcial).
    const pid2 = await patient();
    const b2 = await booking(A, pid2);
    asUser(P1.userId);
    const both = await Promise.all([
      createClinicalNote(newInput(pid2, { bookingId: b2.id })),
      createClinicalNote(newInput(pid2, { bookingId: b2.id })),
    ]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(both.find((x) => !x.ok)).toMatchObject({ ok: false, error: C.bookingTaken });
    expect(await db.clinicalNote.count({ where: { patientId: pid2 } })).toBe(1);
    expect(await auditsOf(pid2, "clinicalNote.create")).toHaveLength(1);
  });

  it("doble envío (misma clave, en paralelo) → una fila, un audit, el otro replayed con la misma nota", async () => {
    const pid = await patient();
    const b = await booking(A, pid);
    const input = newInput(pid, { bookingId: b.id });
    asUser(P1.userId);
    const [x, y] = await Promise.all([createClinicalNote(input), createClinicalNote(input)]);
    expect(x.ok && y.ok).toBe(true);
    if (!x.ok || !y.ok) return;
    expect(x.data.note.id).toBe(y.data.note.id);
    expect([x.data.replayed, y.data.replayed].sort()).toEqual([false, true]);
    expect(await db.clinicalNote.count({ where: { patientId: pid } })).toBe(1);
    expect(await auditsOf(pid, "clinicalNote.create")).toHaveLength(1);
    // Tercer envío secuencial: replay por la lectura previa (sin pasar por el 23505).
    const z = await createClinicalNote(input);
    expect(z).toMatchObject({ ok: true, data: { replayed: true, note: { id: x.data.note.id } } });
  });

  it("clave reusada en otro paciente → keyReused, sin fila", async () => {
    const pid = await patient();
    const other = await patient();
    const key = randomUUID();
    await created(P1.userId, pid, { idempotencyKey: key });
    await expectRejected(await createAs(P1.userId, newInput(other, { idempotencyKey: key })), C.keyReused, other);
  });

  // ── Editar ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("el autor edita dentro de 24 h: revision 2 (la sube el trigger), versión anterior en ClinicalNoteRevision, audit", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    const r = await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: " Dolor 4/10. ", title: "Control" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.note).toMatchObject({ id: n.id, revision: 2, body: "Dolor 4/10.", title: "Control" });
    const row = await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ revision: 2, body: "Dolor 4/10.", title: "Control" });
    const revs = await db.clinicalNoteRevision.findMany({ where: { noteId: n.id } });
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revision: 1, body: "Dolor lumbar 6/10, mejora con movilidad.", title: null });
    const audits = await auditsOf(pid, "clinicalNote.edit");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: P1.userId, entityId: pid });
    expect(audits[0].payload).toMatchObject({ noteId: n.id, revision: 2 });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Dolor");
  });

  it("CAS viejo (expectedRevision vieja) → stale, sin cambios", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    expect((await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "v2" })).ok).toBe(true);
    const r = await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "v3 pisando" });
    expect(r).toMatchObject({ ok: false, error: C.stale });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ revision: 2, body: "v2" });
    expect(await auditsOf(pid, "clinicalNote.edit")).toHaveLength(1);
  });

  it("no autor edita → notAuthor (también el Titular)", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    for (const u of [P2.userId, A.userId]) {
      asUser(u);
      expect(await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "ajeno" })).toMatchObject({ ok: false, error: C.notAuthor });
    }
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ revision: 1 });
    expect(await auditsOf(pid, "clinicalNote.edit")).toHaveLength(0);
  });

  it("fuera de 24 h: editar → windowClosed; la enmienda sí (autor y otro profesional)", async () => {
    const pid = await patient();
    const b = await booking(A, pid, { at: new Date(Date.now() - 30 * H) });
    const id = await seedNote(A, pid, { userId: P1.userId, practitionerId: P1.practitionerId! }, { ageMs: 25 * H, bookingId: b.id });
    asUser(P1.userId);
    expect(await editClinicalNote({ noteId: id, expectedRevision: 1, body: "tarde" })).toMatchObject({ ok: false, error: C.windowClosed });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id } })).toMatchObject({ revision: 1, body: "Nota sembrada" });

    const key = randomUUID();
    const before = Date.now();
    const a = await amendClinicalNote({ noteId: id, body: "  Aclaración: dolor 5/10.  ", idempotencyKey: key });
    expect(a).toMatchObject({ ok: true, data: { replayed: false } });
    if (!a.ok) return;
    const row = await db.clinicalNote.findUniqueOrThrow({ where: { id: a.data.note.id } });
    expect(row).toMatchObject({
      amendsNoteId: id,
      patientId: pid,
      bookingId: b.id,
      kind: "EVOLUTION",
      body: "Aclaración: dolor 5/10.",
      authorUserId: P1.userId,
      revision: 1,
      idempotencyKey: key,
    });
    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const audits = await auditsOf(pid, "clinicalNote.amend");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: P1.userId });
    expect(audits[0].payload).toMatchObject({ noteId: row.id, bookingId: b.id, kind: "EVOLUTION" });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Aclaración");

    // Replay de la enmienda.
    const again = await amendClinicalNote({ noteId: id, body: "Aclaración: dolor 5/10.", idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, data: { replayed: true, note: { id: row.id } } });

    // Otro profesional con escritura sobre el paciente también enmienda (EV2-D14).
    asUser(P2.userId);
    const o = await amendClinicalNote({ noteId: id, body: "Visto por P2.", idempotencyKey: randomUUID() });
    expect(o.ok).toBe(true);
    expect(await db.clinicalNote.count({ where: { amendsNoteId: id } })).toBe(2);
    expect(await auditsOf(pid, "clinicalNote.amend")).toHaveLength(2);
  });

  it("la red de la base (P0001, 24 h + 10 min) se traduce a windowClosed: reloj de la app 25 h atrasado", async () => {
    const pid = await patient();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 25 * H });
    const n = await created(P1.userId, pid);
    // Con el reloj de la app la nota tiene segundos (editDecision pasa); para la base tiene 25 h.
    const r = await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "tarde para la base" });
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false, error: C.windowClosed });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ revision: 1 });
    expect(await db.clinicalNoteRevision.count({ where: { noteId: n.id } })).toBe(0);
    expect(await auditsOf(pid, "clinicalNote.edit")).toHaveLength(0);
  });

  it("editar o enmendar una anulada → voided; enmendar una enmienda → amendTarget; profesional básico → forbidden", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    const am = await amendClinicalNote({ noteId: n.id, body: "Enmienda", idempotencyKey: randomUUID() });
    if (!am.ok) throw new Error(am.error);
    expect(await amendClinicalNote({ noteId: am.data.note.id, body: "Sobre la enmienda", idempotencyKey: randomUUID() })).toMatchObject({
      ok: false,
      error: C.amendTarget,
    });
    asUser(P3.userId);
    expect(await amendClinicalNote({ noteId: n.id, body: "Básico", idempotencyKey: randomUUID() })).toMatchObject({
      ok: false,
      error: C.forbidden,
    });

    asUser(P1.userId);
    expect((await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Paciente equivocado" })).ok).toBe(true);
    expect(await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "x" })).toMatchObject({ ok: false, error: C.voided });
    expect(await amendClinicalNote({ noteId: n.id, body: "x", idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: C.voided });
    expect(await db.clinicalNote.count({ where: { patientId: pid } })).toBe(2);
    expect(await auditsOf(pid, "clinicalNote.amend")).toHaveLength(1);
    expect(await auditsOf(pid, "clinicalNote.edit")).toHaveLength(0);
  });

  it("nota de otro consultorio: editar, enmendar y anular → notFound, intacta", async () => {
    const foreign = await patient(B);
    const id = await seedNote(B, foreign, { userId: B.userId, practitionerId: B.practitionerId });
    asUser(A.userId);
    expect(await editClinicalNote({ noteId: id, expectedRevision: 1, body: "x" })).toMatchObject({ ok: false, error: C.notFound });
    expect(await amendClinicalNote({ noteId: id, body: "x", idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: C.notFound });
    expect(await voidClinicalNote({ noteId: id, expectedRevision: 1, reason: "Ajena" })).toMatchObject({ ok: false, error: C.notFound });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id } })).toMatchObject({ revision: 1, voidedAt: null, body: "Nota sembrada" });
    expect(await db.clinicalNote.count({ where: { patientId: foreign } })).toBe(1);
    expect(await auditsOf(foreign)).toHaveLength(0);
  });

  // ── Anular ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("el autor anula: voided con motivo (trim), revisión intacta, audit sin el motivo; doble anulación idempotente", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    const r = await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "  Cargada en el paciente equivocado " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.note.voided).toMatchObject({ byUserId: P1.userId, reason: "Cargada en el paciente equivocado" });
    const row = await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ revision: 1, voidedByUserId: P1.userId, voidReason: "Cargada en el paciente equivocado" });
    expect(row.voidedAt).not.toBeNull();
    const audits = await auditsOf(pid, "clinicalNote.void");
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({ noteId: n.id });
    expect(JSON.stringify(audits[0].payload)).not.toContain("equivocado");

    // Mismo actor otra vez (doble click): ok, sin segundo audit; nada cambia.
    const again = await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Otro motivo" });
    expect(again).toMatchObject({ ok: true, data: { note: { id: n.id, voided: { reason: "Cargada en el paciente equivocado" } } } });
    expect(await auditsOf(pid, "clinicalNote.void")).toHaveLength(1);
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ voidReason: "Cargada en el paciente equivocado" });

    // Otro (el Titular) sobre la ya anulada → voided.
    asUser(A.userId);
    expect(await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Otro motivo" })).toMatchObject({ ok: false, error: C.voided });
  });

  it("dos anulaciones del mismo actor en paralelo → las dos ok, una sola anulación y un audit", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    const both = await Promise.all([
      voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Duplicada" }),
      voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Duplicada" }),
    ]);
    expect(both.every((x) => x.ok)).toBe(true);
    expect(await auditsOf(pid, "clinicalNote.void")).toHaveLength(1);
  });

  it("el Titular clínico anula la nota de un profesional; otro profesional (con share) → voidForbidden", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P2.userId);
    expect(await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "No es mía" })).toMatchObject({ ok: false, error: C.voidForbidden });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ voidedAt: null });
    asUser(SEC.userId);
    expect(await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Secretaria" })).toMatchObject({ ok: false, error: C.forbidden });
    expect(await auditsOf(pid, "clinicalNote.void")).toHaveLength(0);

    asUser(A.userId);
    const r = await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Duplicada" });
    expect(r.ok).toBe(true);
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ voidedByUserId: A.userId, voidReason: "Duplicada" });
    const audits = await auditsOf(pid, "clinicalNote.void");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: A.userId });
  });

  it("anular: motivo de 2 letras → inválido; revisión vieja → stale; sin cambios", async () => {
    const pid = await patient();
    const n = await created(P1.userId, pid);
    asUser(P1.userId);
    const short = await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: " ab " });
    expect(short.ok).toBe(false);
    expect(short.ok ? "" : short.error).toBe("El motivo tiene que tener entre 3 y 500 caracteres.");
    expect((await editClinicalNote({ noteId: n.id, expectedRevision: 1, body: "v2" })).ok).toBe(true);
    expect(await voidClinicalNote({ noteId: n.id, expectedRevision: 1, reason: "Vieja" })).toMatchObject({ ok: false, error: C.stale });
    expect(await db.clinicalNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ voidedAt: null, revision: 2 });
    expect(await auditsOf(pid, "clinicalNote.void")).toHaveLength(0);
  });
});
