/**
 * PV · TK-S1 (§27, A · TK) · intake de tickets: leads con origen, ticket con la identidad de la SESIÓN (usuarios
 * bloqueados o sin consultorio) y hilo del consultorio con origen. Símbolos REALES de `lib/leads.ts`,
 * `lib/tickets.ts` y `lib/support-threads.ts` contra Postgres en los dos roles (`test:integration` = kinesoft_app con
 * RLS; `:owner` = BYPASSRLS como prod). Se reemplazan solo la sesión de Supabase y `next/*` (integration-setup) y el
 * despacho del mail (`__setEmailTransportForTests`: el sink a EmailLog sigue corriendo).
 *
 * Decisión de Martin (27-oct, literal): «que todos los contactos de formularios y consultas a soporte vayan a la parte
 * de /plataforma de Superadmin, y se abran como "tickets" para resolver desde ahi».
 *
 * Se fija:
 *  - el origen del lead se guarda; uno inválido o viejo cae a LANDING sin error para la persona;
 *  - el ticket existe aunque el mail falle (el mail va después del commit y `sendEmail` nunca tira);
 *  - el destino del ticket de sesión sale de la sesión (consultorio bloqueado del que es Titular/Admin, usuario
 *    deshabilitado, alta sin consultorio), nunca del form; los datos de contacto también;
 *  - topes: 5 por hora (limitador) y 5 cada 24 h en la base;
 *  - `createSupportThread` acepta solo los orígenes del consultorio.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { submitLead, submitLeadForm } from "@/lib/leads";
import { submitSessionTicket } from "@/lib/tickets";
import { createSupportThread } from "@/lib/support-threads";
import { SESSION_TICKET_LIMIT, TICKET_ERROR_COPY } from "@/lib/tickets-types";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const INBOX = "soporte-tks1@test.local";
const MARK = `tks1${Date.now().toString(36)}`;

const mail = {
  sent: [] as SendEmailInput[],
  fail: false,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    if (mail.fail) throw new Error("transporte caído (test)");
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe.skipIf(!RUN)("[TK-S1] intake de tickets", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;
  const prevEnf = process.env.TENANT_ACCESS_ENFORCEMENT;
  let n = 0;
  const email = () => `${MARK}-${++n}@test.local`;
  const validLead = (over: Record<string, unknown> = {}) => ({
    name: "Paula Gómez",
    email: email(),
    message: "¿Cuánto sale para 3 profesionales?",
    website: "",
    startedAt: Date.now() - 8_000,
    ...over,
  });

  async function tenant(opts: Parameters<typeof createEphemeralTenant>[1] = {}): Promise<EphemeralTenant> {
    const t = await createEphemeralTenant(db, opts);
    tenants.push(t);
    return t;
  }

  /** Usuario con sesión y SIN ninguna membresía (alta a medio hacer). */
  async function loneUser(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Alta ${id}` } });
    users.push(id);
    return id;
  }

  /** Hilos que abrió un usuario (los de sesión llevan `createdById`, sean TENANT o LEAD). */
  const threadsBy = (userId: string) =>
    db.supportThread.findMany({ where: { createdById: userId }, include: { messages: true }, orderBy: { createdAt: "asc" } });

  async function deleteThreads(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await db.emailLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.supportTicketNote.deleteMany({ where: { threadId: { in: ids } } });
    await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } });
    await db.supportThreadRead.deleteMany({ where: { threadId: { in: ids } } });
    await db.supportThread.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    db = ownerClient();
  });

  afterAll(async () => {
    if (prevInbox === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
    else process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    if (prevEnf === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnf;
    __setEmailTransportForTests(null);
    if (db) {
      const ownIds = [...users, ...tenants.map((t) => t.userId)];
      const leads = await db.supportThread.findMany({
        where: { kind: "LEAD", OR: [{ leadEmail: { startsWith: MARK } }, { createdById: { in: ownIds } }] },
        select: { id: true },
      });
      await deleteThreads(leads.map((r) => r.id));
      await db.emailLog.deleteMany({ where: { tenantId: { in: tenants.map((t) => t.tenantId) } } });
    }
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    process.env.PLATFORM_INBOX_EMAIL = INBOX;
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default `banner`: un SUSPENDED igual bloquea (BO1-A)
    mail.sent.length = 0;
    mail.fail = false;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    cookies().delete("kine_tenant");
    asAnonymous();
  });

  afterEach(() => __setEmailTransportForTests(null));

  // ── Leads con origen ───────────────────────────────────────────────────────────────────────────────────────────

  it("[TK-4] lead PRICING persiste; source inválido → LANDING", async () => {
    const priced = validLead({ source: "PRICING" });
    expect(await submitLead(priced)).toEqual({ ok: true, data: { received: true } });
    const p = await db.supportThread.findFirstOrThrow({ where: { leadEmail: priced.email } });
    expect(p).toMatchObject({ kind: "LEAD", tenantId: null, source: "PRICING", subject: "Precio · Consulta de Paula Gómez" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ kind: "lead_received", to: INBOX, entityId: p.id });
    expect(mail.sent[0].subject).toContain("Web · precios");

    // Por el form (useFormState): `source` oculto. Uno que no existe, uno del consultorio o vacío → LANDING sin error.
    for (const bad of ["NO_EXISTE", "TENANT_SUPPORT", "", "pricing"]) {
      __rateLimitInternals.reset();
      const e = email();
      const r = await submitLeadForm(
        null,
        fd({ name: "Form", email: e, message: "Hola", website: "", startedAt: String(Date.now() - 5_000), source: bad })
      );
      expect(r).toEqual({ ok: true, data: { received: true } });
      expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: e } })).toMatchObject({
        source: "LANDING",
        subject: "Consulta de Form",
      });
    }

    // Sin `source` (form viejo cacheado) → LANDING; Plan Libre y Alta asistida con su prefijo.
    __rateLimitInternals.reset();
    const old = validLead();
    expect((await submitLead(old)).ok).toBe(true);
    expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: old.email } })).toMatchObject({ source: "LANDING" });
    const libre = validLead({ source: "PLAN_LIBRE", clinicName: "Kine Sur" });
    expect((await submitLead(libre)).ok).toBe(true);
    expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: libre.email } })).toMatchObject({
      source: "PLAN_LIBRE",
      subject: "Plan Libre · Consulta de Paula Gómez · Kine Sur",
    });
    __rateLimitInternals.reset();
    const alta = validLead({ source: "SIGNUP_ASSISTED" });
    expect((await submitLead(alta)).ok).toBe(true);
    expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: alta.email } })).toMatchObject({
      source: "SIGNUP_ASSISTED",
      subject: "Alta asistida · Consulta de Paula Gómez",
    });
  });

  // ZA B1: ACCOUNT_DISABLED y ONBOARDING son orígenes de SESIÓN (los pone `submitSessionTicket` con la identidad
  // verificada). Si el form público los aceptaba, cualquiera abría un «Cuenta desactivada · <nombre>» con el email de
  // otra persona y el soporte lo trataba como un pedido de la dueña de la cuenta (ingeniería social).
  it("[ZF1a] el form público no puede abrir un ticket con origen de sesión: ACCOUNT_DISABLED u ONBOARDING → LANDING", async () => {
    for (const sessionOnly of ["ACCOUNT_DISABLED", "ONBOARDING"]) {
      __rateLimitInternals.reset();
      const viaJs = validLead({ source: sessionOnly });
      expect(await submitLead(viaJs)).toEqual({ ok: true, data: { received: true } });
      expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: viaJs.email } })).toMatchObject({
        kind: "LEAD",
        createdById: null,
        source: "LANDING",
        subject: "Consulta de Paula Gómez",
      });
      __rateLimitInternals.reset();
      const e = email();
      const r = await submitLeadForm(
        null,
        fd({ name: "Form", email: e, message: "Hola", website: "", startedAt: String(Date.now() - 5_000), source: sessionOnly })
      );
      expect(r).toEqual({ ok: true, data: { received: true } });
      expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: e } })).toMatchObject({ source: "LANDING" });
    }
    // Los orígenes públicos siguen pasando (PRIVACY incluido: un pedido ARCO puede venir de alguien sin cuenta).
    __rateLimitInternals.reset();
    const arco = validLead({ source: "PRIVACY" });
    expect((await submitLead(arco)).ok).toBe(true);
    expect(await db.supportThread.findFirstOrThrow({ where: { leadEmail: arco.email } })).toMatchObject({ source: "PRIVACY" });
  });

  it("[TK-5] transporte falla → el hilo existe y la action da ok", async () => {
    mail.fail = true;
    const lead = validLead({ source: "PRICING" });
    expect(await submitLead(lead)).toEqual({ ok: true, data: { received: true } });
    const t = await db.supportThread.findFirstOrThrow({ where: { leadEmail: lead.email }, include: { messages: true } });
    expect(t.messages).toHaveLength(1);

    // Mismo contrato en el ticket de sesión (Titular de un consultorio suspendido).
    const S = await tenant({ status: "SUSPENDED" });
    asUser(S.userId);
    const r = await submitSessionTicket(null, fd({ motivo: "suspendido", message: "¿Cómo lo reactivo?" }));
    expect(r).toEqual({ ok: true, data: { received: true, email: `${S.userId}@test.local` } });
    const rows = await threadsBy(S.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toHaveLength(1);
    expect(mail.sent).toEqual([]);
  });

  // ── Ticket con la identidad de la sesión ───────────────────────────────────────────────────────────────────────

  it("[TK-6] OWNER suspendido → TENANT en su consultorio bloqueado con createdById", async () => {
    const S = await tenant({ status: "SUSPENDED" });
    asUser(S.userId);
    const r = await submitSessionTicket(
      null,
      fd({ motivo: "suspendido", message: "Quiero pagar lo que debo.", phone: "11 4444-4444", email: "otro@evil.test" })
    );
    expect(r).toEqual({ ok: true, data: { received: true, email: `${S.userId}@test.local` } });
    const rows = await threadsBy(S.userId);
    expect(rows).toHaveLength(1);
    const t = rows[0];
    expect(t).toMatchObject({
      kind: "TENANT",
      tenantId: S.tenantId,
      createdById: S.userId,
      source: "TENANT_SUSPENDED",
      status: "OPEN",
      leadEmail: null,
      leadName: null,
    });
    expect(t.subject.startsWith("Consultorio suspendido · ")).toBe(true);
    expect(t.messages.map((m) => [m.authorKind, m.tenantId, m.authorUserId])).toEqual([["TENANT", S.tenantId, S.userId]]);
    // El teléfono no tiene columna en un hilo TENANT (CHECK de M8): va en el cuerpo para que Martin lo vea.
    expect(t.messages[0].body).toContain("Quiero pagar lo que debo.");
    expect(t.messages[0].body).toContain("11 4444-4444");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ kind: "support_message_platform", to: INBOX, tenantId: S.tenantId, entityId: t.id });
    expect(mail.sent[0].subject).toContain("Consultorio suspendido");
    // Sin el texto (puede traer datos de pacientes): solo asunto y link.
    expect(mail.sent[0].text).not.toContain("Quiero pagar");

    // Dado de baja + Administrador/a: también entra como TENANT_SUSPENDED en ESE consultorio.
    const C = await tenant({ status: "CLOSED" });
    const admin = await addStaff(db, C, "ADMIN", { grantSettings: true });
    users.push(admin.userId);
    asUser(admin.userId);
    __rateLimitInternals.reset();
    expect((await submitSessionTicket(null, fd({ message: "Nos dieron de baja por error." })))?.ok).toBe(true);
    expect(await threadsBy(admin.userId)).toMatchObject([{ kind: "TENANT", tenantId: C.tenantId, source: "TENANT_SUSPENDED" }]);
  });

  it("[TK-7] no-admin suspendido → rechazo «Avisale al titular…»", async () => {
    const S = await tenant({ status: "SUSPENDED" });
    const kine = await addPractitioner(db, S, "PRACTITIONER");
    asUser(kine.userId);
    const r = await submitSessionTicket(null, fd({ motivo: "suspendido", message: "Hola" }));
    expect(r).toEqual({ ok: false, error: TICKET_ERROR_COPY.notAdmin });
    expect(TICKET_ERROR_COPY.notAdmin.startsWith("Avisale al titular")).toBe(true);
    expect(await threadsBy(kine.userId)).toEqual([]);
    expect(mail.sent).toEqual([]);

    // El `tenantId` del form no abre un consultorio ajeno: solo uno bloqueado donde sea Titular/Admin.
    const other = await tenant({ status: "SUSPENDED" });
    asUser(S.userId);
    __rateLimitInternals.reset();
    const forged = await submitSessionTicket(null, fd({ message: "Hola", tenantId: other.tenantId }));
    expect(forged).toEqual({ ok: false, error: TICKET_ERROR_COPY.notAdmin });
    expect(await db.supportThread.count({ where: { tenantId: other.tenantId } })).toBe(0);
    // El propio, explícito, sí.
    __rateLimitInternals.reset();
    expect((await submitSessionTicket(null, fd({ message: "Hola", tenantId: S.tenantId })))?.ok).toBe(true);
    expect(await threadsBy(S.userId)).toMatchObject([{ tenantId: S.tenantId, source: "TENANT_SUSPENDED" }]);
  });

  it("[TK-8] deshabilitado → LEAD con el email de la sesión (el del form se ignora)", async () => {
    const A = await tenant({ disabled: true });
    asUser(A.userId);
    const r = await submitSessionTicket(
      null,
      fd({ motivo: "cuenta", message: "No puedo entrar.", phone: "11 3333-3333", email: "atacante@evil.test", name: "Otro" })
    );
    expect(r).toEqual({ ok: true, data: { received: true, email: `${A.userId}@test.local` } });
    const rows = await threadsBy(A.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "LEAD",
      tenantId: null,
      createdById: A.userId,
      source: "ACCOUNT_DISABLED",
      leadEmail: `${A.userId}@test.local`,
      leadName: expect.stringMatching(/^Test /),
      leadPhone: "11 3333-3333",
    });
    expect(rows[0].subject.startsWith("Cuenta desactivada · ")).toBe(true);
    expect(rows[0].messages.map((m) => [m.authorKind, m.tenantId, m.authorUserId, m.body])).toEqual([
      ["LEAD", null, null, "No puedo entrar."],
    ]);
    expect(await db.supportThread.count({ where: { leadEmail: "atacante@evil.test" } })).toBe(0);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ kind: "lead_received", to: INBOX, tenantId: null, entityId: rows[0].id });
    expect(mail.sent[0].subject).toContain("Cuenta desactivada");
    // Es un usuario con sesión (puede ser un profesional): el mail no lleva el texto.
    expect(mail.sent[0].text).not.toContain("No puedo entrar.");
  });

  it("[TK-S1] onboarding sin consultorio → LEAD ONBOARDING con los datos de la sesión", async () => {
    const u = await loneUser();
    asUser(u);
    const r = await submitSessionTicket(null, fd({ motivo: "onboarding", message: "Me trabé en el paso de horarios." }));
    expect(r).toEqual({ ok: true, data: { received: true, email: `${u}@test.local` } });
    expect(await threadsBy(u)).toMatchObject([
      { kind: "LEAD", tenantId: null, source: "ONBOARDING", leadEmail: `${u}@test.local`, leadName: `Alta ${u}` },
    ]);
  });

  it("[TK-9] sin sesión → error", async () => {
    asAnonymous();
    const before = await db.supportThread.count();
    expect(await submitSessionTicket(null, fd({ message: "Hola" }))).toEqual({ ok: false, error: TICKET_ERROR_COPY.noSession });
    expect(await db.supportThread.count()).toBe(before);
    expect(mail.sent).toEqual([]);
  });

  it("[TK-10] con consultorio usable → «Escribinos desde Configuración → Soporte»", async () => {
    const A = await tenant();
    asUser(A.userId);
    const r = await submitSessionTicket(null, fd({ motivo: "suspendido", message: "Hola" }));
    expect(r).toEqual({ ok: false, error: TICKET_ERROR_COPY.usableTenant });
    expect(TICKET_ERROR_COPY.usableTenant).toBe("Escribinos desde Configuración → Soporte.");
    expect(await threadsBy(A.userId)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it("[TK-11] tope diario", async () => {
    const u = await loneUser();
    asUser(u);
    // Limitador por hora: el sexto en la misma hora se corta con el copy del tope.
    for (let i = 0; i < SESSION_TICKET_LIMIT.limit; i++) {
      expect((await submitSessionTicket(null, fd({ message: `Mensaje ${i}` })))?.ok).toBe(true);
    }
    expect(await submitSessionTicket(null, fd({ message: "Uno más" }))).toEqual({ ok: false, error: TICKET_ERROR_COPY.dailyCap });
    // Limitador vacío (otro isolate, o pasó la hora): la base corta igual a los 5 de las últimas 24 h.
    __rateLimitInternals.reset();
    expect(await submitSessionTicket(null, fd({ message: "Otro isolate" }))).toEqual({ ok: false, error: TICKET_ERROR_COPY.dailyCap });
    expect(await threadsBy(u)).toHaveLength(SESSION_TICKET_LIMIT.limit);
    // Con 24 h encima, vuelve a poder.
    await db.supportThread.updateMany({
      where: { createdById: u },
      data: { createdAt: new Date(Date.now() - SESSION_TICKET_LIMIT.windowMs - 60_000) },
    });
    __rateLimitInternals.reset();
    expect((await submitSessionTicket(null, fd({ message: "Al otro día" })))?.ok).toBe(true);
  });

  it("[TK-S1] zod: mensaje vacío o largo y teléfono de más de 40 → error legible, nada se escribe", async () => {
    const u = await loneUser();
    asUser(u);
    expect(await submitSessionTicket(null, fd({ message: "   " }))).toMatchObject({ ok: false });
    expect(await submitSessionTicket(null, fd({ message: "x".repeat(5001) }))).toMatchObject({ ok: false });
    expect(await submitSessionTicket(null, fd({ message: "Hola", phone: "1".repeat(41) }))).toMatchObject({ ok: false });
    expect(await threadsBy(u)).toEqual([]);
  });

  // ── Hilo del consultorio con origen ────────────────────────────────────────────────────────────────────────────

  it("[TK-12] createSupportThread con PLAN_CHANGE ok; LANDING rechazado", async () => {
    const A = await tenant();
    asUser(A.userId);
    const r = await createSupportThread({ subject: "Quiero pasar a Clínica", body: "Somos 5 ahora.", source: "PLAN_CHANGE" });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.data.threadId : "";
    expect(await db.supportThread.findUniqueOrThrow({ where: { id } })).toMatchObject({
      kind: "TENANT",
      tenantId: A.tenantId,
      source: "PLAN_CHANGE",
      subject: "Quiero pasar a Clínica",
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toContain("Elegir plan");

    const before = await db.supportThread.count({ where: { tenantId: A.tenantId } });
    const bad = await createSupportThread({ subject: "x", body: "y", source: "LANDING" as never });
    expect(bad.ok).toBe(false);
    const forged = await createSupportThread({ subject: "x", body: "y", source: "TENANT_SUSPENDED" as never });
    expect(forged.ok).toBe(false);
    expect(await db.supportThread.count({ where: { tenantId: A.tenantId } })).toBe(before);

    // Sin origen → TENANT_SUPPORT (Configuración → Soporte de siempre); PRIVACY también vale.
    const plain = await createSupportThread({ subject: "Duda", body: "¿Cómo cargo una obra social?" });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(await db.supportThread.findUniqueOrThrow({ where: { id: plain.data.threadId } })).toMatchObject({ source: "TENANT_SUPPORT" });
    }
    const priv = await createSupportThread({ subject: "Mis datos", body: "Quiero una copia.", source: "PRIVACY" });
    expect(priv.ok).toBe(true);
    if (priv.ok) {
      expect(await db.supportThread.findUniqueOrThrow({ where: { id: priv.data.threadId } })).toMatchObject({ source: "PRIVACY" });
    }
  });
});
