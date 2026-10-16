/**
 * BO2-E · sesión de soporte (C-BO3, C-BO4, C-BO9; plan §19.5; decisión 3 de Martin, literal):
 *   «Entrar como soporte» abre el consultorio con banda visible y registro en ese consultorio; sin vencimiento
 *   (termina con «Salir de soporte» o al cerrar sesión); solo lectura en todo salvo Configuración, donde puede crear y
 *   modificar (usuarios/equipo, obras sociales, servicios, sedes/salas, horarios, datos del consultorio, turnero) para
 *   ayudar al consultorio. Sin acceso clínico (ve lo que ve la Secretaria). Mail al OWNER al empezar.
 *
 * Símbolos REALES contra Postgres en los dos roles (kinesoft_app y owner BYPASSRLS): `startSupport`/`endSupport`
 * (actions), `getActor` (rama de soporte de buildActor), las actions del consultorio y los route handlers de export.
 * Se mockea solo lo externo: la sesión de Supabase, la cookie jar y `next/cache` (integration-setup) y el DESPACHO
 * del mail (`__setEmailTransportForTests`: validación, sink de EmailLog y log siguen corriendo).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { getActor, tryGetActor, ReadOnlyModeError } from "@/lib/session";
import { SUPPORT_READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { getCapabilities, getMembershipRole } from "@/lib/authz";
import { SUPPORT_CAPS } from "@/lib/capabilities";
import { endSupport, listSupportSessionsForTenant, startSupport } from "@/lib/platform-support";
import {
  SUPPORT_COOKIE,
  endSupportSession,
  makeSupportCookieValue,
  resolveSupportSession,
} from "@/lib/support-session-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import {
  createBooking,
  setBookingStatus,
  setBookingCopagoPaid,
  deleteBooking,
  markReceptionAction,
} from "@/lib/bookings";
import {
  createPatient,
  updatePatient,
  setPatientArchived,
  setPatientCoverage,
  setPatientDiagnosis,
  getPatientCore,
} from "@/lib/patients";
import { createPlan } from "@/lib/plans";
import { createTimeBlock } from "@/lib/time-blocks";
import { updateUserPreferences } from "@/lib/preferences";
import { createInsurer, updateInsurer } from "@/lib/insurers";
import { createService, updateService } from "@/lib/services";
import { createLocation } from "@/lib/locations";
import { createRoom } from "@/lib/rooms";
import { setPublicBookingEnabled, setSharedPatientView } from "@/lib/tenant-settings";
import { changeMemberRole, createInvitation, listTeamMembers, reactivateMember } from "@/lib/invitations";
import { GET as exportPatients } from "@/app/api/pacientes/export/route";
import { GET as exportAgenda } from "@/app/api/agenda/export/route";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const REASON = "El OWNER pidió ayuda con las obras sociales";
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("[BO2-E] sesión de soporte", () => {
  let db: PrismaClient;
  /** Consultorio destino (kine, con HC sembrada). */
  let T: EphemeralTenant;
  /** Otro destino (para «una sola abierta por superadmin»). */
  let T2: EphemeralTenant;
  /** Consultorio propio del superadmin S. */
  let H: EphemeralTenant;
  /** Superadmin con consultorio propio (H es su home: OWNER). */
  let S: string;
  /** Superadmin sin consultorio. */
  let S2: string;
  let patientId: string;
  let bookingId: string;
  let bookingUpdatedAt: string;
  const users: string[] = [];
  const mails: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    T2 = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    H = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    S = H.userId;
    await db.userProfile.update({ where: { id: S }, data: { isPlatformAdmin: true } });
    S2 = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: S2, email: `${S2}@test.local`, fullName: "Soporte Sin Casa", isPlatformAdmin: true } });
    users.push(S2);

    patientId = await addPatient(db, T, { notes: "NOTA CLÍNICA SECRETA" });
    await db.patient.update({ where: { id: patientId }, data: { diagnosisTitle: "Lumbalgia", diagnosisNote: "DIAG SECRETO" } });
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar("2031-05-05", "10:00")),
        durationMin: 45,
        status: "CONFIRMED",
        title: "Evolución",
        notes: "NOTA DEL TURNO",
        idempotencyKey: randomUUID(),
      },
    });
    bookingId = b.id;
    bookingUpdatedAt = b.updatedAt.toISOString();
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    // Las filas de SupportSession de S (home H) y S2 se borran antes (FK RESTRICT a UserProfile/Tenant).
    if (db) {
      await db.supportSession.deleteMany({ where: { superadminId: { in: [S, S2].filter(Boolean) } } });
      for (const t of [T, T2, H]) await t?.cleanup();
      if (users.length) {
        await db.$transaction([
          db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
          db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ANY(${users})`,
        ]);
        await db.emailLog.deleteMany({ where: { actorId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    cookies().delete(SUPPORT_COOKIE);
    cookies().delete("kine_tenant");
    __rateLimitInternals.reset();
    mails.length = 0;
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: `fake-${mails.length}` };
    });
    // Cada test arranca sin sesión de soporte abierta.
    await db.supportSession.updateMany({ where: { superadminId: { in: [S, S2] }, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
  });

  afterEach(() => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
  });

  async function enter(user: string, tenant: EphemeralTenant = T): Promise<string> {
    asUser(user);
    const r = await startSupport(tenant.tenantId, REASON);
    if (!r.ok) throw new Error(r.error);
    return r.data.sessionId;
  }

  /** Resultado observable de una action: tirado o `{ ok:false, error }`. */
  async function outcome(p: () => Promise<unknown>): Promise<{ kind: "ok" | "error" | "throw"; error?: unknown; message: string }> {
    try {
      const r = (await p()) as { ok?: boolean; error?: string } | null;
      if (r && typeof r === "object" && "ok" in r) return r.ok ? { kind: "ok", message: "" } : { kind: "error", message: String(r.error) };
      return { kind: "ok", message: JSON.stringify(r)?.slice(0, 80) ?? "" };
    } catch (e) {
      return { kind: "throw", error: e, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Cookie ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("al empezar: fila abierta, audit en el consultorio y en el registro global, mail al OWNER y cookie", async () => {
    const sessionId = await enter(S);
    const row = await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row).toMatchObject({ tenantId: T.tenantId, superadminId: S, reason: REASON, endedAt: null, scope: "ADMIN_CONFIG" });

    const ev = await db.auditEvent.findFirst({ where: { tenantId: T.tenantId, action: "platform.support.start", entityId: sessionId } });
    expect(ev).toMatchObject({ actorId: S, entity: "SupportSession" });
    // El motivo (texto libre) NO va al registro (solo inserción): queda en la fila.
    expect(JSON.stringify(ev?.payload)).not.toContain(REASON);
    // [BO4] el registro dice si la sesión pasó por TOTP (acá, con el flag en off y sin factor: false).
    expect(typeof (ev?.payload as { mfa?: unknown } | null)?.mfa).toBe("boolean");
    const pe = await db.platformAuditEvent.findFirst({ where: { tenantId: T.tenantId, action: "platform.support.start", entityId: sessionId } });
    expect(pe).toMatchObject({ actorId: S, actorEmail: `${S}@test.local` });
    // Nada en el consultorio propio del superadmin.
    expect(await db.auditEvent.count({ where: { tenantId: H.tenantId, action: { startsWith: "platform.support" } } })).toBe(0);

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: `${T.userId}@test.local`, kind: "support_access", tenantId: T.tenantId, entityId: sessionId });
    // Motivo GENÉRICO en el mail (integrador BO2): el texto libre del superadmin es una nota interna (puede nombrar
    // un paciente o un ticket); el OWNER lo ve en Configuración → Accesos de soporte, detrás del login.
    expect(mails[0].text).not.toContain(REASON);
    expect(mails[0].text).toContain("Accesos de soporte");
    expect(mails[0].text).toContain(`${S}@test.local`);
    // BO3-F: el link lleva directo a la pestaña de soporte de Configuración.
    expect(mails[0].text).toContain("/configuracion?tab=soporte");
    expect(mails[0].html).toContain("/configuracion?tab=soporte");
    expect(await db.emailLog.count({ where: { tenantId: T.tenantId, kind: "support_access", entityId: sessionId, status: "sent" } })).toBe(1);

    expect(cookies().get(SUPPORT_COOKIE)?.value).toBe(makeSupportCookieValue(sessionId, S));
    expect(await resolveSupportSession(S)).toEqual({ sessionId, tenantId: T.tenantId });
  });

  it("no superadmin con la cookie (y su fila) → se ignora y se borra: entra a su consultorio", async () => {
    // Una fila abierta a nombre del no-superadmin y su cookie bien firmada: lo único que falta es ser superadmin.
    const row = await db.supportSession.create({ data: { tenantId: T.tenantId, superadminId: T2.userId, reason: REASON } });
    asUser(T2.userId);
    cookies().set(SUPPORT_COOKIE, makeSupportCookieValue(row.id, T2.userId));
    const a = await getActor();
    expect(a).toMatchObject({ tenantId: T2.tenantId, support: null });
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();
    await db.supportSession.delete({ where: { id: row.id } });
  });

  it("cookie alterada / de otro superadmin / de una fila cerrada → se ignora y se borra", async () => {
    const sessionId = await enter(S);
    const good = cookies().get(SUPPORT_COOKIE)!.value;

    // Alterada (otra sesión con la firma de esta).
    cookies().set(SUPPORT_COOKIE, good.replace(sessionId, `${sessionId}x`));
    expect(await getActor()).toMatchObject({ tenantId: H.tenantId, support: null });
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();

    // La cookie de S copiada a otro superadmin.
    asUser(S2);
    cookies().set(SUPPORT_COOKIE, good);
    expect(await tryGetActor()).toBeNull(); // S2 no tiene consultorio propio
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();

    // Fila cerrada por fuera (p. ej. desde otro navegador).
    asUser(S);
    cookies().set(SUPPORT_COOKIE, good);
    expect((await getActor()).support?.sessionId).toBe(sessionId);
    await db.supportSession.update({ where: { id: sessionId }, data: { endedAt: new Date(), endedReason: "exit" } });
    expect(await getActor()).toMatchObject({ tenantId: H.tenantId, support: null });
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();
  });

  it("superadmin deshabilitado: la cookie se ignora", async () => {
    await enter(S2);
    await db.userProfile.update({ where: { id: S2 }, data: { disabledAt: new Date() } });
    try {
      expect(await tryGetActor()).toBeNull();
      expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();
    } finally {
      await db.userProfile.update({ where: { id: S2 }, data: { disabledAt: null } });
    }
  });

  // ── Actor ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("Actor de soporte: consultorio destino, support lleno, sin profesional, capacidades de Secretaria sin clínico", async () => {
    const sessionId = await enter(S);
    const a = await getActor();
    expect(a).toMatchObject({
      tenantId: T.tenantId,
      tenantSlug: T.slug,
      practitionerId: null,
      userId: S,
      isPlatformAdmin: true,
      support: { sessionId, superadminEmail: `${S}@test.local` },
    });
    expect(a.access.mode).toBe("full");
    const caps = await getCapabilities();
    expect([...caps].sort()).toEqual([...SUPPORT_CAPS].sort());
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("tenant.admin")).toBe(true);
    expect(await getMembershipRole(a)).toBe("ASSISTANT");
  });

  it("superadmin que es miembro del consultorio → no se abre soporte (entra con su rol)", async () => {
    asUser(S);
    const r = await startSupport(H.tenantId, REASON);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Ya sos parte/) });
    expect(await db.supportSession.count({ where: { superadminId: S, tenantId: H.tenantId } })).toBe(0);
    expect(mails).toHaveLength(0);
  });

  it("no superadmin → startSupport tira Forbidden y no abre nada", async () => {
    asUser(T.userId);
    await expect(startSupport(T2.tenantId, REASON)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await db.supportSession.count({ where: { superadminId: T.userId } })).toBe(0);
  });

  it("motivo corto → rechazo sin fila", async () => {
    asUser(S);
    expect(await startSupport(T.tenantId, "corto")).toMatchObject({ ok: false });
    expect(await db.supportSession.count({ where: { superadminId: S, endedAt: null } })).toBe(0);
  });

  // ── Auditoría y PHI ────────────────────────────────────────────────────────────────────────────────────────

  // PL-A (plan §20.5.9): las lecturas de PHI ya no se auditan; que el audit de soporte lleve `supportSessionId` lo
  // cubre platform-audit.test.ts (`auditInTx` / `auditSecurityEvent` bajo contexto de soporte).
  it("el perfil del paciente no expone lo clínico y su lectura no escribe audit", async () => {
    const sessionId = await enter(S);
    const since = new Date();
    const p = await getPatientCore(patientId);
    expect(p).not.toBeNull();
    // Nunca full (lo clínico): soporte = nivel de la Secretaria.
    expect(p!.access).toBe("admin");
    const json = JSON.stringify(p);
    for (const secret of ["NOTA CLÍNICA SECRETA", "DIAG SECRETO", "Lumbalgia"]) expect(json).not.toContain(secret);
    expect(sessionId).toBeTruthy();
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, actorId: S, entityId: patientId, createdAt: { gte: since } } })).toBe(0);
  });

  // «Ve lo que ve la Secretaria» = nivel `admin` (contacto y cobertura para operar, sin HC). Arrancó como it.fails:
  // sin membresía, visibility caía en `role ?? "PRACTITIONER"` sin profesional → `basic`.
  it("[BO2-E] soporte ve al paciente con el nivel de la Secretaria (admin)", async () => {
    await enter(S);
    expect((await getPatientCore(patientId))!.access).toBe("admin");
  });

  // Arrancó como it.fails (PHI): sin membresía, `role ?? "PRACTITIONER"` + «Consultorio común» daba acceso FULL al
  // soporte. lib/visibility.ts fuerza ASSISTANT cuando `actor.support`.
  it("[BO2-E] con «Consultorio común» (sharedPatientView) soporte tampoco ve lo clínico", async () => {
    await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: true } });
    try {
      await enter(S);
      const p = await getPatientCore(patientId);
      expect(p!.access).toBe("admin");
      expect(JSON.stringify(p)).not.toContain("DIAG SECRETO");
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: false } });
    }
  });

  // ── Solo lectura fuera de Configuración ─────────────────────────────────────────────────────────────────────

  it("13 actions de afuera de Configuración (turno, estado, recepción, cobro, paciente, cobertura, nota clínica, plan, bloqueo, preferencias…) → rechazadas y nada escrito", async () => {
    const sessionId = await enter(S);
    expect((await getActor()).support?.sessionId).toBe(sessionId);
    const snapshot = async () => ({
      bookings: await db.booking.findMany({ where: { tenantId: T.tenantId }, select: { id: true, updatedAt: true, status: true, paymentStatus: true } }),
      patients: await db.patient.findMany({ where: { tenantId: T.tenantId }, select: { id: true, updatedAt: true, archivedAt: true, diagnosisTitle: true } }),
      coverages: await db.coverage.count({ where: { patient: { tenantId: T.tenantId } } }),
      programs: await db.treatmentProgram.count({ where: { tenantId: T.tenantId } }),
      blocks: await db.timeBlock.count({ where: { tenantId: T.tenantId } }),
      prefs: await db.userPreferences.count({ where: { userId: S } }),
      audits: await db.auditEvent.count({ where: { tenantId: T.tenantId, actorId: S, NOT: { action: { startsWith: "patient.read" } } } }),
    });
    const before = await snapshot();
    const v = bookingUpdatedAt;
    const actions: Array<[string, () => Promise<unknown>]> = [
      ["crear turno", () => createBooking({ patientId, serviceId: T.serviceId, practitionerId: T.practitionerId, scheduledFor: ar("2031-05-06", "10:00"), idempotencyKey: randomUUID() })],
      ["cambiar estado del turno", () => setBookingStatus(bookingId, "CANCELLED", v)],
      ["recepción (llegó)", () => markReceptionAction(bookingId, "llego", v)],
      ["cobrar copago", () => setBookingCopagoPaid(bookingId, true, v)],
      ["borrar turno", () => deleteBooking(bookingId, v)],
      ["crear paciente", () => createPatient({ firstName: "Nuevo", lastName: "Paciente", documentId: `DNI-${uniqueSuffix()}` } as never, { assignTo: T.practitionerId })],
      ["editar paciente", () => updatePatient({ id: patientId, phone: "1122334455" } as never)],
      ["archivar paciente", () => setPatientArchived({ id: patientId, archived: true })],
      ["cobertura del paciente", () => setPatientCoverage({ patientId, planName: "Libre", memberId: "1" } as never)],
      ["nota clínica (diagnóstico)", () => setPatientDiagnosis(patientId, "Otro", "Nota")],
      ["plan", () => createPlan({ idempotencyKey: randomUUID(), patientId, discipline: "KINESIOLOGY", practitionerId: T.practitionerId, serviceId: T.serviceId, locationId: null, title: "Plan", schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] }, startDayKey: "2031-01-06", totalSessions: 2, pricing: null, rows: [], stateToken: "sin-preview" } as never)],
      ["bloqueo de agenda", () => createTimeBlock({ practitionerId: T.practitionerId, startsAt: ar("2031-05-07", "10:00"), endsAt: ar("2031-05-07", "11:00") })],
      ["preferencias (fuera de runWithRls)", () => updateUserPreferences({ palette: "mint" } as never)],
    ];
    // La red de solo lectura: `runWithRls` tira ReadOnlyModeError en la tx del soporte. Desde BO3-F las actions de
    // agenda/pacientes/bloqueos lo devuelven con su copy (lib/read-only-result.ts); otras todavía pueden atraparlo con
    // un copy genérico, así que también se mira el log del error.
    const errLogs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      errLogs.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    const results: Record<string, string> = {};
    try {
      for (const [name, act] of actions) {
        const o = await outcome(act);
        results[name] = `${o.kind}: ${o.message}`;
        // Nunca escribe.
        expect(o.kind, `${name} → ${o.message}`).not.toBe("ok");
      }
    } finally {
      spy.mockRestore();
    }
    expect(Object.keys(results)).toHaveLength(13);
    // Las que llegan al write chocan contra la tx en solo lectura (copy de soporte o el de modo lectura, devuelto o
    // logueado). Las demás cortan ANTES por el nivel de acceso (soporte no es miembro: nunca full) o por permiso.
    const hitReadOnly = Object.entries(results).filter(([, r]) => /solo podés mirar|modo lectura/.test(r)).length +
      errLogs.filter((l) => /modo lectura|solo podés mirar/.test(l)).length;
    expect(hitReadOnly, JSON.stringify({ results, errLogs }, null, 2)).toBeGreaterThanOrEqual(3);
    for (const r of Object.values(results)) expect(r).not.toMatch(/^ok/);
    expect(await snapshot()).toEqual(before);
  });

  it("[BO3-F] con soporte, las actions de agenda/pacientes/bloqueos DEVUELVEN el error (no tiran) y las que llegan al write, el copy de soporte", async () => {
    // Sin esto, en prod Next redacta el mensaje de la excepción y el superadmin ve un error genérico
    // (lib/read-only-result.ts); createBooking/createPatient/createTimeBlock devolvían su copy genérico
    // («No pudimos crear…»). Turno de un invitado (sin paciente) HOY: el soporte ve como la Secretaria (acceso
    // básico a los pacientes), así que con un paciente las actions cortan antes por acceso, sin llegar al write.
    // HOY en AR, a las 12:00 AR. Antes era «ahora + 1 h»: pasadas las 23:00 AR el turno caía MAÑANA y la recepción
    // (solo turnos del día) cortaba antes del write con otro mensaje: flake por la hora (ES4-Z).
    const todayNoonAr = new Date(localToARIso(`${toARDateKey(new Date())}T12:00`));
    const guest = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: todayNoonAr,
        durationMin: 30,
        status: "CONFIRMED",
        guestName: "Invitado Soporte",
        idempotencyKey: randomUUID(),
      },
    });
    try {
      await enter(S);
      const v = guest.updatedAt.toISOString();
      const actions: Array<[string, () => Promise<unknown>]> = [
        ["createBooking", () => createBooking({ guestName: "Otro Invitado", serviceId: T.serviceId, practitionerId: T.practitionerId, scheduledFor: ar("2031-05-06", "11:00"), idempotencyKey: randomUUID() } as never)],
        ["setBookingStatus", () => setBookingStatus(guest.id, "CANCELLED", v)],
        ["markReceptionAction", () => markReceptionAction(guest.id, "llego", v)],
        ["setBookingCopagoPaid", () => setBookingCopagoPaid(guest.id, true, v)],
        ["deleteBooking", () => deleteBooking(guest.id, v)],
        ["createPatient", () => createPatient({ firstName: "Nuevo", lastName: "Paciente", documentId: `DNI-${uniqueSuffix()}` } as never, { assignTo: T.practitionerId })],
        ["createTimeBlock", () => createTimeBlock({ practitionerId: T.practitionerId, startsAt: ar("2031-05-07", "12:00"), endsAt: ar("2031-05-07", "13:00") })],
      ];
      const results: Record<string, { kind: string; message: string }> = {};
      for (const [name, act] of actions) {
        const o = await outcome(act);
        results[name] = { kind: o.kind, message: o.message };
      }
      // Las que llegan a la tx de escritura: copy de soporte devuelto. El resto corta antes por acceso (el soporte
      // tiene acceso básico, aun con un invitado: `bookingFieldAccess`), también devuelto. Ninguna tira. El camino
      // completo de agenda/pacientes con un Actor que sí llega al write está en tenant-access.test.ts ([BO3-F]).
      for (const n of ["markReceptionAction", "createPatient", "createTimeBlock"]) {
        expect(results[n], n).toEqual({ kind: "error", message: SUPPORT_READ_ONLY_MESSAGE });
      }
      for (const [n, r] of Object.entries(results)) expect(r.kind, `${n}: ${r.message}`).toBe("error");
      const after = await db.booking.findUniqueOrThrow({ where: { id: guest.id } });
      expect(after.updatedAt.toISOString()).toBe(v);
      expect(after.status).toBe("CONFIRMED");
      expect(after.arrivedAt).toBeNull();
    } finally {
      await db.booking.deleteMany({ where: { id: guest.id } });
    }
  });

  it("ReadOnlyModeError tirado por runWithRls en un write directo del soporte", async () => {
    await enter(S);
    const a = await getActor();
    const { runWithRls } = await import("@/lib/rls");
    const p = runWithRls(a.tenantId, (tx) => tx.insurer.create({ data: { tenantId: a.tenantId, name: `x-${uniqueSuffix()}` } }));
    await expect(p).rejects.toBeInstanceOf(ReadOnlyModeError);
    // Copy de soporte, no el del consultorio en lectura («Escribinos para reactivarlo» no aplica al superadmin).
    await expect(p).rejects.toThrow("Entraste como soporte: acá solo podés mirar.");
  });

  // ── Configuración sí escribe ─────────────────────────────────────────────────────────────────────────────────

  it("las actions de Configuración envueltas sí escriben, y su audit lleva el supportSessionId", async () => {
    const sessionId = await enter(S);
    const ins = await createInsurer({ name: `OS soporte ${uniqueSuffix()}`, copagoCents: 0, fixedFeeCents: 0 });
    expect(ins, JSON.stringify(ins)).toMatchObject({ ok: true });
    if (!ins.ok) return;
    expect((await updateInsurer(ins.data.id, { copagoCents: 1500 } as never)).ok).toBe(true);
    expect(await db.insurer.findUniqueOrThrow({ where: { id: ins.data.id } })).toMatchObject({ tenantId: T.tenantId, copagoCents: 1500 });

    const svc = await createService({ name: `Serv soporte ${uniqueSuffix()}`, durationMin: 30, priceCents: 0 });
    expect(svc, JSON.stringify(svc)).toMatchObject({ ok: true });
    if (svc.ok) expect((await updateService(svc.data.id, { priceCents: 1000 })).ok).toBe(true);

    const loc = await createLocation({ name: `Sede soporte ${uniqueSuffix()}` });
    expect(loc, JSON.stringify(loc)).toMatchObject({ ok: true });
    if (loc.ok) {
      const room = await createRoom({ locationId: loc.data.id, name: "Box 1" });
      expect(room, JSON.stringify(room)).toMatchObject({ ok: true });
    }

    const audits = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, actorId: S, entityId: ins.data.id } });
    expect(audits.length).toBeGreaterThan(0);
    for (const e of audits) expect((e.payload as { supportSessionId?: string }).supportSessionId).toBe(sessionId);
  });

  // Integrador BO2: los wrappers de lib/tenant-settings.ts y lib/invitations.ts (handoff de BO2-E).
  it("datos del consultorio y equipo: soporte prende el turnero e invita (como ADMIN); «Consultorio común» no", async () => {
    const before = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { publicBookingEnabled: true, sharedPatientView: true } });
    const sessionId = await enter(S);
    try {
      const pb = await setPublicBookingEnabled(!before.publicBookingEnabled);
      expect(pb, JSON.stringify(pb)).toMatchObject({ ok: true });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).publicBookingEnabled).toBe(!before.publicBookingEnabled);

      // Cambia QUIÉN ve la HC: fuera de la allowlist a propósito → solo lectura.
      const sv = await outcome(() => setSharedPatientView(!before.sharedPatientView));
      expect(sv.kind).not.toBe("ok");
      expect((await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).sharedPatientView).toBe(before.sharedPatientView);

      // Soporte gestiona el equipo con los límites del ADMIN: ve la lista e invita (Secretaria: no ocupa cupo).
      expect((await listTeamMembers()).length).toBeGreaterThan(0);
      const email = `sop-inv-${uniqueSuffix()}@test.local`;
      const inv = await createInvitation({ email, firstName: "Sole", lastName: "Soporte", role: "ASSISTANT" });
      expect(inv, JSON.stringify(inv)).toMatchObject({ ok: true });
      const row = await db.invitation.findFirstOrThrow({ where: { tenantId: T.tenantId, email } });
      expect(row).toMatchObject({ role: "ASSISTANT", invitedById: S });
      const ev = await db.auditEvent.findFirst({ where: { tenantId: T.tenantId, actorId: S, entityId: row.id } });
      expect((ev?.payload as { supportSessionId?: string } | null)?.supportSessionId).toBe(sessionId);
      await db.invitation.delete({ where: { id: row.id } });
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: before });
    }
  });

  it("enforce + consultorio en solo lectura por su suscripción: ni Configuración se habilita para soporte", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    await db.tenant.update({ where: { id: T2.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    try {
      await enter(S, T2);
      const r = await outcome(() => createInsurer({ name: `OS ro ${uniqueSuffix()}`, copagoCents: 0, fixedFeeCents: 0 }));
      expect(r.kind).not.toBe("ok");
      expect(await db.insurer.count({ where: { tenantId: T2.tenantId, name: { startsWith: "OS ro" } } })).toBe(0);
    } finally {
      await db.tenant.update({ where: { id: T2.tenantId }, data: { subscriptionStatus: "ACTIVE" } });
    }
  });

  // ── Exports ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("exports de pacientes y agenda → 403 para soporte (y siguen andando para el OWNER)", async () => {
    await enter(S);
    expect((await exportPatients(new Request("http://localhost/api/pacientes/export"))).status).toBe(403);
    expect((await exportAgenda(new Request("http://localhost/api/agenda/export"))).status).toBe(403);
    asUser(T.userId);
    cookies().delete(SUPPORT_COOKIE);
    __rateLimitInternals.reset();
    expect((await exportPatients(new Request("http://localhost/api/pacientes/export"))).status).toBe(200);
  });

  // ── Salir, logout, una sola abierta, Plataforma ─────────────────────────────────────────────────────────────

  it("salir → vuelve al consultorio propio; la fila se cierra (exit) y se audita", async () => {
    const sessionId = await enter(S);
    expect((await getActor()).tenantId).toBe(T.tenantId);
    expect(await endSupport()).toMatchObject({ ok: true });
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();
    expect(await getActor()).toMatchObject({ tenantId: H.tenantId, support: null, practitionerId: H.practitionerId });
    expect(await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ endedReason: "exit" });
    expect((await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "platform.support.end", entityId: sessionId } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { action: "platform.support.end", entityId: sessionId } })).toBe(1);
  });

  it("salir sin consultorio propio → sin Actor (no se queda en el destino)", async () => {
    await enter(S2);
    expect((await getActor()).tenantId).toBe(T.tenantId);
    await endSupport();
    expect(await tryGetActor()).toBeNull();
  });

  it("cerrar sesión cierra la fila (logout) aunque la cookie ya no esté", async () => {
    const sessionId = await enter(S);
    cookies().delete(SUPPORT_COOKIE); // p. ej. el logout llega desde otro navegador
    await endSupportSession("logout");
    expect(await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ endedReason: "logout" });
  });

  it("una sola abierta por superadmin: empezar otra cierra la anterior (replaced) y el actor pasa al nuevo destino", async () => {
    const first = await enter(S, T);
    const second = await enter(S, T2);
    expect(await db.supportSession.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ endedReason: "replaced" });
    expect(await db.supportSession.count({ where: { superadminId: S, endedAt: null } })).toBe(1);
    expect(await getActor()).toMatchObject({ tenantId: T2.tenantId, support: { sessionId: second } });
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "platform.support.end", entityId: first } })).toBe(1);
  });

  it("estando en soporte, /plataforma sigue pudiendo escribir (canal service, no el read-only del consultorio)", async () => {
    await enter(S, T);
    await getActor(); // deja el request en solo lectura para T
    // Una escritura de Plataforma sobre el MISMO consultorio en soporte: abrir soporte en otro cierra este y audita en
    // los dos (escribe en T por el canal service).
    const r = await startSupport(T2.tenantId, REASON);
    expect(r).toMatchObject({ ok: true });
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "platform.support.end", actorId: S } })).toBeGreaterThan(0);
  });

  // ── Lista de Configuración ──────────────────────────────────────────────────────────────────────────────────

  it("OWNER: «Accesos de soporte» con DTO cerrado", async () => {
    await enter(S);
    asUser(T.userId);
    cookies().delete(SUPPORT_COOKIE);
    const rows = await listSupportSessionsForTenant();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["endedAt", "endedReason", "id", "open", "reason", "startedAt", "superadminEmail"]);
    }
    expect(rows[0]).toMatchObject({ superadminEmail: `${S}@test.local`, reason: REASON, open: true });
    // Solo los de este consultorio.
    expect(await db.supportSession.count({ where: { id: { in: rows.map((r) => r.id) }, tenantId: { not: T.tenantId } } })).toBe(0);
  });

  // PL-F1b (decisión de Martin, 16-oct: «profesionales también, porque pueden necesitar ayuda con algo»): la lista la
  // ve CUALQUIER miembro del consultorio, no solo Titular/Administrador/a. Sigue siendo de solo lectura: desde el
  // consultorio no hay action para terminar un acceso (la RLS de M7 es FOR SELECT) y eso no cambia acá.
  it("[PL-F1b] Profesional y Secretaria ven «Accesos de soporte» de SU consultorio, no los de otro", async () => {
    await enter(S, T);
    cookies().delete(SUPPORT_COOKIE);
    const kine = await addPractitioner(db, T, "PRACTITIONER");
    const secre = await addPractitioner(db, T, "ASSISTANT");
    for (const userId of [kine.userId, secre.userId]) {
      asUser(userId);
      const rows = await listSupportSessionsForTenant();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ superadminEmail: `${S}@test.local`, reason: REASON, open: true });
      expect(await db.supportSession.count({ where: { id: { in: rows.map((r) => r.id) }, tenantId: { not: T.tenantId } } })).toBe(0);
    }
    // Un Profesional de OTRO consultorio no ve los accesos de T.
    const other = await addPractitioner(db, T2, "PRACTITIONER");
    asUser(other.userId);
    const rows2 = await listSupportSessionsForTenant();
    expect(await db.supportSession.count({ where: { id: { in: rows2.map((r) => r.id) }, tenantId: T.tenantId } })).toBe(0);
  });
  // ── BO-Z ────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[BO-Z] A2: soporte no invita roles clínicos ni cuentas de Plataforma; Secretaria sí", async () => {
    await enter(S);
    const deny = /Como soporte solo podés dar roles sin acceso a historias clínicas/;
    for (const role of ["PRACTITIONER", "ADMIN"] as const) {
      const email = `sop-clin-${uniqueSuffix()}@test.local`;
      const r = await createInvitation({ email, firstName: "No", lastName: "Clínico", role });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(deny) });
      expect(await db.invitation.count({ where: { tenantId: T.tenantId, email } })).toBe(0);
    }
    // Email de un superadmin (otro o el propio): ni como Secretaria.
    for (const email of [`${S2}@test.local`, `${S}@test.local`]) {
      const r = await createInvitation({ email, firstName: "Super", lastName: "Admin", role: "ASSISTANT" });
      expect(r).toEqual({ ok: false, error: expect.stringContaining("cuenta de Plataforma") });
      expect(await db.invitation.count({ where: { tenantId: T.tenantId, email } })).toBe(0);
    }
    const email = `sop-ok-${uniqueSuffix()}@test.local`;
    const ok = await createInvitation({ email, firstName: "Sí", lastName: "Secretaria", role: "ASSISTANT" });
    expect(ok).toMatchObject({ ok: true });
    await db.invitation.deleteMany({ where: { tenantId: T.tenantId, email } });
  });

  it("[BO-Z] A2: soporte no asciende a un rol clínico ni reactiva a un clínico suspendido", async () => {
    const sec = await addPractitioner(db, T, "ASSISTANT");
    const kine = await addPractitioner(db, T, "PRACTITIONER");
    const secMem = await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: sec.userId } });
    const kineMem = await db.membership.update({
      where: { userId_tenantId: { userId: kine.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
    await enter(S);
    const deny = /Como soporte solo podés dar roles sin acceso a historias clínicas/;
    for (const role of ["PRACTITIONER", "ADMIN"] as const) {
      expect(await changeMemberRole(secMem.id, role)).toEqual({ ok: false, error: expect.stringMatching(deny) });
    }
    expect((await db.membership.findUniqueOrThrow({ where: { id: secMem.id } })).role).toBe("ASSISTANT");
    // Entre roles no clínicos, sí.
    expect(await changeMemberRole(secMem.id, "BILLING")).toMatchObject({ ok: true });
    expect(await reactivateMember(kineMem.id)).toEqual({ ok: false, error: expect.stringMatching(deny) });
    expect((await db.membership.findUniqueOrThrow({ where: { id: kineMem.id } })).disabledAt).not.toBeNull();
  });

  // PL-2a (decisión de Martin, plan §20.5.5): se quitó el corte de BO-Z B3. Arrancó como
  // `it.fails("[PL-2a] soporte en prod exige MFA")` (con el corte, Production + enforcement `off` rechazaba) y se dio
  // vuelta al borrar el requisito de `lib/platform-support.ts`.
  it("[PL-2a] en Production con PLATFORM_MFA_ENFORCEMENT apagado, «Entrar como soporte» abre (sin MFA de Plataforma)", async () => {
    const prev = { v: process.env.VERCEL_ENV, m: process.env.PLATFORM_MFA_ENFORCEMENT };
    try {
      process.env.VERCEL_ENV = "production";
      delete process.env.PLATFORM_MFA_ENFORCEMENT;
      asUser(S);
      const r = await startSupport(T.tenantId, REASON);
      expect(r).toMatchObject({ ok: true });
      const open = await db.supportSession.findFirstOrThrow({ where: { superadminId: S, endedAt: null } });
      expect(open.tenantId).toBe(T.tenantId);
      expect(cookies().get(SUPPORT_COOKIE)).toBeDefined();
    } finally {
      if (prev.v === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev.v;
      if (prev.m === undefined) delete process.env.PLATFORM_MFA_ENFORCEMENT;
      else process.env.PLATFORM_MFA_ENFORCEMENT = prev.m;
    }
  });

  it("[BO-Z] C2: dos «Entrar como soporte» simultáneos del mismo superadmin → los dos responden, queda UNA abierta", async () => {
    asUser(S);
    const [a, b] = await Promise.all([startSupport(T.tenantId, REASON), startSupport(T2.tenantId, REASON)]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(await db.supportSession.count({ where: { superadminId: S, endedAt: null } })).toBe(1);
  });

  it("[BO-Z] C3: soporte no lee «Accesos de soporte» del consultorio", async () => {
    await enter(S);
    await expect(listSupportSessionsForTenant()).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
