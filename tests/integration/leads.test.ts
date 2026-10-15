/**
 * PL-2d · Formulario de contacto público → lead en la bandeja de Plataforma (C-PL11, plan §20.5.7; PL-D15). Símbolos
 * REALES de `lib/leads.ts` contra Postgres en los dos roles. Se reemplazan solo `next/headers` (integration-setup:
 * sin x-forwarded-for, todas las llamadas caen en la misma IP «unknown») y el despacho del mail.
 *
 * Se fija:
 *  - honeypot lleno o enviado en < 3 s → OK sin fila ni mail (al bot no se le avisa);
 *  - lead válido → hilo LEAD (sin consultorio) + mensaje LEAD + UN mail, a la bandeja (sin respuesta automática al lead);
 *  - rate limit: 5/h por IP, 3/día por email (y el respaldo en la base cuando el limitador se reinicia);
 *  - zod con mensajes legibles; `submitLeadForm` (useFormState) lee el FormData;
 *  - la app de un consultorio no ve el lead.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { submitLead, submitLeadForm } from "@/lib/leads";
import { listSupportThreads } from "@/lib/support-threads";
import { LEAD_EMAIL_CAP_COPY, leadBotVerdict } from "@/lib/support-threads-types";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const INBOX = "soporte-leads-pl2d@test.local";
const MARK = `pl2dlead${Date.now().toString(36)}`;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[PL-2d] Leads de la web pública", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;
  let n = 0;
  const email = () => `${MARK}-${++n}@test.local`;
  const valid = (over: Record<string, unknown> = {}) => ({
    name: "Pablo Pérez",
    email: email(),
    phone: "11 5555-5555",
    clinicName: "Kine Norte",
    planInterest: "CLINICA",
    message: "Somos 6 profesionales. ¿Cuánto sale?\nGracias.",
    website: "",
    startedAt: Date.now() - 8_000,
    ...over,
  });
  const leadRows = () => db.supportThread.findMany({ where: { kind: "LEAD", leadEmail: { startsWith: MARK } }, include: { messages: true } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    if (prevInbox === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
    else process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    __setEmailTransportForTests(null);
    if (db) {
      const rows = await db.supportThread.findMany({ where: { kind: "LEAD", leadEmail: { startsWith: MARK } }, select: { id: true } });
      const ids = rows.map((r) => r.id);
      await db.emailLog.deleteMany({ where: { entityId: { in: ids } } });
      await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportThread.deleteMany({ where: { id: { in: ids } } });
    }
    await A?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    process.env.PLATFORM_INBOX_EMAIL = INBOX;
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    asAnonymous();
  });
  afterEach(() => __setEmailTransportForTests(null));

  it("lógica pura del filtro de bots", () => {
    const now = 1_000_000;
    expect(leadBotVerdict({ website: "http://spam", startedAt: now - 60_000, now })).toBe("bot");
    expect(leadBotVerdict({ website: "", startedAt: now - 1_000, now })).toBe("bot");
    expect(leadBotVerdict({ website: "", startedAt: now - 3_000, now })).toBe("ok");
    // [PL-Z] a4#2: sin `startedAt` = bot (el form de la web siempre lo manda; sin él, es un POST directo).
    expect(leadBotVerdict({ website: null, startedAt: undefined, now })).toBe("bot");
    expect(leadBotVerdict({ website: "", startedAt: null, now })).toBe("bot");
    expect(leadBotVerdict({ website: "", startedAt: Number.NaN, now })).toBe("bot");
    expect(leadBotVerdict({ website: "", startedAt: now + 5_000, now })).toBe("ok");
  });

  it("lead válido: hilo LEAD sin consultorio + mensaje LEAD + un solo mail, a la bandeja (sin respuesta automática)", async () => {
    const input = valid();
    expect(await submitLead(input)).toEqual({ ok: true, data: { received: true } });
    const rows = (await leadRows()).filter((r) => r.leadEmail === input.email);
    expect(rows).toHaveLength(1);
    const t = rows[0];
    expect(t).toMatchObject({
      kind: "LEAD",
      tenantId: null,
      status: "OPEN",
      leadName: "Pablo Pérez",
      leadPhone: "11 5555-5555",
      leadClinicName: "Kine Norte",
      leadPlanInterest: "CLINICA",
      subject: "Consulta de Pablo Pérez · Kine Norte",
    });
    expect(t.messages.map((m) => [m.authorKind, m.tenantId, m.authorUserId, m.body])).toEqual([
      ["LEAD", null, null, "Somos 6 profesionales. ¿Cuánto sale?\nGracias."],
    ]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ kind: "lead_received", to: INBOX, tenantId: null, entityId: t.id });
    expect(mail.sent[0].text).toContain("Somos 6 profesionales");
    expect(mail.sent[0].text).toContain("Clínica");
    expect(mail.sent.some((m) => m.to === input.email)).toBe(false);
  });

  it("el email se guarda normalizado y los opcionales vacíos quedan NULL", async () => {
    const e = email();
    const r = await submitLead(valid({ email: `  ${e.toUpperCase()} `, phone: "", clinicName: "  ", planInterest: "" }));
    expect(r.ok).toBe(true);
    const t = (await leadRows()).find((x) => x.leadEmail === e);
    expect(t).toMatchObject({ leadPhone: null, leadClinicName: null, leadPlanInterest: null, subject: "Consulta de Pablo Pérez" });
  });

  it("honeypot lleno → OK sin fila ni mail", async () => {
    const input = valid({ website: "https://seo-spam.example" });
    expect(await submitLead(input)).toEqual({ ok: true, data: { received: true } });
    expect((await leadRows()).some((r) => r.leadEmail === input.email)).toBe(false);
    expect(mail.sent).toEqual([]);
  });

  it("enviado en menos de 3 s → OK sin fila ni mail", async () => {
    const input = valid({ startedAt: Date.now() - 500 });
    expect(await submitLead(input)).toEqual({ ok: true, data: { received: true } });
    expect((await leadRows()).some((r) => r.leadEmail === input.email)).toBe(false);
    expect(mail.sent).toEqual([]);
  });

  it("zod: email inválido y mensaje vacío devuelven el copy; nada se escribe", async () => {
    const before = (await leadRows()).length;
    const r1 = await submitLead(valid({ email: "no-es-mail" }));
    expect(r1).toMatchObject({ ok: false, error: "Revisá el email." });
    const r2 = await submitLead(valid({ message: "   " }));
    expect(r2).toMatchObject({ ok: false, error: "Contanos qué necesitás." });
    const r3 = await submitLead(valid({ message: "x".repeat(5001) }));
    expect(r3.ok).toBe(false);
    const r4 = await submitLead(valid({ planInterest: "GRATIS" }));
    expect(r4.ok).toBe(false);
    expect((await leadRows()).length).toBe(before);
    expect(mail.sent).toEqual([]);
  });

  it("rate limit por IP: 5 por hora", async () => {
    for (let i = 0; i < 5; i++) expect((await submitLead(valid())).ok).toBe(true);
    const r = await submitLead(valid());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Demasiados intentos/);
  });

  it("[PL-Z] a4#1: el limitador en memoria no tiene bucket global (una IP cortada no le gasta el cupo a todos)", async () => {
    const e = email();
    expect((await submitLead(valid({ email: e }))).ok).toBe(true);
    // Solo IP + email. Con `lead:global` en `rateLimitAll`, cada intento de una IP ya cortada lo seguía sumando.
    expect(__rateLimitInternals.size()).toBe(2);
  });

  it("[PL-Z] a4#2: sin startedAt → OK sin fila ni mail", async () => {
    const before = (await leadRows()).length;
    const { startedAt: _drop, ...noStart } = valid();
    expect(await submitLead(noStart as never)).toEqual({ ok: true, data: { received: true } });
    expect((await leadRows()).length).toBe(before);
    expect(mail.sent).toEqual([]);
  });

  it("rate limit por email: 3 por día, también con el limitador reiniciado (respaldo en la base)", async () => {
    const e = email();
    for (let i = 0; i < 3; i++) {
      __rateLimitInternals.reset(); // que no corte la IP
      expect((await submitLead(valid({ email: e }))).ok).toBe(true);
    }
    const limited = await submitLead(valid({ email: e }));
    expect(limited.ok).toBe(false);
    __rateLimitInternals.reset(); // otro isolate / limitador vacío: la base corta igual
    expect(await submitLead(valid({ email: e }))).toEqual({ ok: false, error: LEAD_EMAIL_CAP_COPY });
    expect((await leadRows()).filter((r) => r.leadEmail === e)).toHaveLength(3);
  });

  it("submitLeadForm (useFormState) lee el FormData", async () => {
    const e = email();
    const fd = new FormData();
    fd.set("name", "Form Sin JS");
    fd.set("email", e);
    fd.set("message", "Hola desde el form");
    fd.set("website", "");
    fd.set("startedAt", String(Date.now() - 5_000));
    fd.set("planInterest", "");
    expect(await submitLeadForm(null, fd)).toEqual({ ok: true, data: { received: true } });
    expect((await leadRows()).find((r) => r.leadEmail === e)).toMatchObject({ leadName: "Form Sin JS" });

    const bot = new FormData();
    bot.set("name", "Bot");
    bot.set("email", email());
    bot.set("message", "spam");
    bot.set("website", "x");
    expect(await submitLeadForm(null, bot)).toEqual({ ok: true, data: { received: true } });
  });

  it("el consultorio no ve los leads", async () => {
    const input = valid();
    expect((await submitLead(input)).ok).toBe(true);
    const lead = (await leadRows()).find((r) => r.leadEmail === input.email)!;
    asUser(A.userId);
    const list = await listSupportThreads();
    expect(list.ok && list.data.some((t) => t.id === lead.id)).toBe(false);
  });
});
