/**
 * PL-2d · /plataforma → Mensajes (C-PL11, plan §20.5.7). Símbolos REALES de `lib/platform-inbox.ts` (y de
 * `lib/support-threads.ts` / `lib/leads.ts` para armar el ida y vuelta) contra Postgres en los dos roles. Se
 * reemplazan solo la sesión de Supabase y `next/*` (integration-setup) y el despacho del mail.
 *
 * Se fija:
 *  - barrera: quien no es superadmin rebota en cada export sin escribir;
 *  - bandeja: hilos de consultorio y leads, filtros por estado y tipo, no leídos y su contador, orden por último
 *    movimiento; abrir el hilo lo marca leído; nombres sin email;
 *  - responder a un consultorio: mensaje PLATFORM, mail al creador SIN el texto, registro de Plataforma, el consultorio
 *    lo ve como «Equipo de KineSoft» y sin leer; responder un hilo cerrado lo reabre;
 *  - responder a un lead: mail al lead CON la respuesta y Reply-To a la bandeja;
 *  - cerrar/reabrir idempotente; cerrado, el consultorio no puede responder.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { countInboxUnread, getInboxThread, listInbox, replyInboxThread, setInboxThreadStatus } from "@/lib/platform-inbox";
import { createSupportThread, getSupportThread, listSupportThreads, replySupportThread } from "@/lib/support-threads";
import { submitLead } from "@/lib/leads";
import { SUPPORT_TEAM_NAME, SUPPORT_THREAD_CLOSED } from "@/lib/support-threads-types";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const INBOX = "soporte-inbox-pl2d@test.local";
const PHI = "Zqxpl2dInbox";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[PL-2d] Bandeja de Plataforma", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let S: string; // superadmin sin consultorio
  const leadEmails: string[] = [];
  const threadIds: string[] = [];
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: A.tenantId }, data: { name: `Consultorio Inbox ${uniqueSuffix()}` } });
    await db.userProfile.update({ where: { id: A.userId }, data: { fullName: "Ana Titular" } });
    S = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: S, email: `${S}@test.local`, fullName: "Martín Soporte", isPlatformAdmin: true } });
  });

  afterAll(async () => {
    if (prevInbox === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
    else process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    __setEmailTransportForTests(null);
    if (db) {
      const leads = await db.supportThread.findMany({ where: { kind: "LEAD", leadEmail: { in: leadEmails } }, select: { id: true } });
      const ids = [...threadIds, ...leads.map((l) => l.id)];
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ${S} OR "entityId" = ANY(${ids}::text[])`,
      ]);
      await db.emailLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { tenantId: A?.tenantId }] } });
      await db.supportMessage.deleteMany({ where: { threadId: { in: leads.map((l) => l.id) } } });
      await db.supportThread.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
    }
    await A?.cleanup();
    if (db) {
      await db.userProfile.deleteMany({ where: { id: S } });
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    process.env.PLATFORM_INBOX_EMAIL = INBOX;
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    asUser(S);
  });
  afterEach(() => __setEmailTransportForTests(null));

  async function tenantThread(subject = `Hilo ${uniqueSuffix()}`, body = "Necesito ayuda"): Promise<string> {
    asUser(A.userId);
    const r = await createSupportThread({ subject, body });
    asUser(S);
    if (!r.ok) throw new Error(r.error);
    threadIds.push(r.data.threadId);
    return r.data.threadId;
  }

  async function leadThread(): Promise<{ id: string; email: string }> {
    const email = `lead-${uniqueSuffix()}@test.local`;
    leadEmails.push(email);
    __rateLimitInternals.reset();
    const r = await submitLead({
      name: "Laura Lead",
      email,
      clinicName: "Kinesio Sur",
      planInterest: "CONSULTORIO",
      message: "Quiero saber precios",
      website: "",
      startedAt: Date.now() - 10_000,
    });
    if (!r.ok) throw new Error(r.error);
    const t = await db.supportThread.findFirstOrThrow({ where: { kind: "LEAD", leadEmail: email } });
    return { id: t.id, email };
  }

  it("quien no es superadmin rebota en cada export, sin escribir", async () => {
    const id = await tenantThread();
    asUser(A.userId);
    const calls: Array<() => Promise<unknown>> = [
      () => listInbox({}),
      () => countInboxUnread(),
      () => getInboxThread(id),
      () => replyInboxThread({ threadId: id, body: "Hola" }),
      () => setInboxThreadStatus({ threadId: id, status: "CLOSED" }),
    ];
    for (const c of calls) await expect(c()).rejects.toThrow();
    expect(await db.supportMessage.count({ where: { threadId: id } })).toBe(1);
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t.status, t.platformReadAt]).toEqual(["OPEN", null]);
  });

  it("lista hilos de consultorio y leads, con filtros, no leídos y contador; abrir marca leído", async () => {
    const tid = await tenantThread();
    const lead = await leadThread();
    const unreadBefore = await countInboxUnread();
    expect(unreadBefore).toBeGreaterThanOrEqual(2);

    const all = await listInbox({});
    const tRow = all.rows.find((r) => r.id === tid);
    const lRow = all.rows.find((r) => r.id === lead.id);
    expect(tRow).toMatchObject({ kind: "TENANT", status: "OPEN", unread: true, messageCount: 1, tenantId: A.tenantId });
    expect(tRow?.fromLabel).toMatch(/^Consultorio Inbox /);
    expect(lRow).toMatchObject({ kind: "LEAD", unread: true, fromLabel: "Laura Lead · Kinesio Sur", tenantId: null });

    const onlyLeads = await listInbox({ kind: "LEAD" });
    expect(onlyLeads.rows.every((r) => r.kind === "LEAD")).toBe(true);
    expect(onlyLeads.rows.some((r) => r.id === lead.id)).toBe(true);
    const closed = await listInbox({ status: "CLOSED" });
    expect(closed.rows.some((r) => r.id === tid)).toBe(false);

    const detail = await getInboxThread(tid);
    expect(detail).toMatchObject({ kind: "TENANT", tenant: { id: A.tenantId }, lead: null });
    expect(detail?.messages.map((m) => [m.authorKind, m.authorName])).toEqual([["TENANT", "Ana Titular"]]);
    expect((await db.supportThread.findUniqueOrThrow({ where: { id: tid } })).platformReadAt).not.toBeNull();
    expect((await listInbox({})).rows.find((r) => r.id === tid)?.unread).toBe(false);
    expect(await countInboxUnread()).toBeLessThan(unreadBefore);

    const ld = await getInboxThread(lead.id);
    expect(ld?.lead).toMatchObject({ name: "Laura Lead", email: lead.email, clinicName: "Kinesio Sur", planInterest: "CONSULTORIO" });
    expect(ld?.messages.map((m) => [m.authorKind, m.authorName])).toEqual([["LEAD", "Laura Lead"]]);

    expect(await getInboxThread("no-existe")).toBeNull();
  });

  it("orden por último movimiento: un hilo viejo con respuesta nueva del consultorio sube y vuelve a no leído", async () => {
    const old = await tenantThread();
    await getInboxThread(old);
    await tenantThread();
    await new Promise((r) => setTimeout(r, 15));
    asUser(A.userId);
    expect((await replySupportThread({ threadId: old, body: "¿Novedades?" })).ok).toBe(true);
    asUser(S);
    const page = await listInbox({});
    expect(page.rows[0]?.id).toBe(old);
    expect(page.rows[0]?.unread).toBe(true);
  });

  it("responder a un consultorio: mensaje PLATFORM, mail al creador sin el texto, registro y el consultorio lo ve", async () => {
    const id = await tenantThread(`Turnos ${uniqueSuffix()}`, `Paciente ${PHI} no aparece`);
    mail.sent.length = 0;
    const r = await replyInboxThread({ threadId: id, body: `Revisamos lo de ${PHI}: ya está.` });
    expect(r).toEqual({ ok: true, data: { messageId: expect.any(String), mail: "sent" } });

    const msgs = await db.supportMessage.findMany({ where: { threadId: id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => [m.authorKind, m.tenantId, m.authorUserId])).toEqual([
      ["TENANT", A.tenantId, A.userId],
      ["PLATFORM", A.tenantId, S],
    ]);
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m).toMatchObject({ kind: "support_reply_tenant", to: `${A.userId}@test.local`, tenantId: A.tenantId, entityId: id });
    for (const part of [m.html, m.text, m.subject]) expect(part).not.toContain(PHI);
    expect(m.html).toContain(`/configuracion?tab=soporte&amp;hilo=${id}`);

    const ev = await db.platformAuditEvent.findMany({ where: { entityId: id, actorId: S } });
    expect(ev.map((e) => e.action)).toEqual(["platform.support.reply"]);
    expect(JSON.stringify(ev[0].payload)).not.toContain(PHI);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "platform.support.reply", entityId: id } })).toBe(1);

    asUser(A.userId);
    const list = await listSupportThreads();
    expect(list.ok && list.data.find((t) => t.id === id)?.unread).toBe(true);
    const d = await getSupportThread(id);
    expect(d.ok && d.data.messages[1]).toMatchObject({ authorKind: "PLATFORM", authorName: SUPPORT_TEAM_NAME, mine: false });
  });

  it("responder un hilo cerrado lo reabre", async () => {
    const id = await tenantThread();
    expect(await setInboxThreadStatus({ threadId: id, status: "CLOSED" })).toEqual({ ok: true, data: { changed: true } });
    expect((await replyInboxThread({ threadId: id, body: "Lo reabrimos" })).ok).toBe(true);
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t.status, t.closedAt]).toEqual(["OPEN", null]);
  });

  it("responder a un lead: mail al lead CON la respuesta y Reply-To a la bandeja", async () => {
    const lead = await leadThread();
    mail.sent.length = 0;
    const r = await replyInboxThread({ threadId: lead.id, body: "El plan Consultorio sale $X por mes." });
    expect(r).toMatchObject({ ok: true, data: { mail: "sent" } });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ kind: "lead_reply", to: lead.email, replyTo: INBOX, tenantId: null });
    expect(mail.sent[0].text).toContain("El plan Consultorio sale $X por mes.");
    const msgs = await db.supportMessage.findMany({ where: { threadId: lead.id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => [m.authorKind, m.tenantId])).toEqual([
      ["LEAD", null],
      ["PLATFORM", null],
    ]);
    expect(await db.platformAuditEvent.count({ where: { entityId: lead.id, action: "platform.support.reply", tenantId: null } })).toBe(1);
  });

  it("cerrar y reabrir: idempotente, con registro; cerrado, el consultorio no responde", async () => {
    const id = await tenantThread();
    expect(await setInboxThreadStatus({ threadId: id, status: "CLOSED" })).toEqual({ ok: true, data: { changed: true } });
    expect(await setInboxThreadStatus({ threadId: id, status: "CLOSED" })).toEqual({ ok: true, data: { changed: false } });
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect(t.status).toBe("CLOSED");
    expect(t.closedAt).not.toBeNull();
    asUser(A.userId);
    expect(await replySupportThread({ threadId: id, body: "Hola" })).toEqual({ ok: false, error: SUPPORT_THREAD_CLOSED });
    asUser(S);
    expect(await setInboxThreadStatus({ threadId: id, status: "OPEN" })).toEqual({ ok: true, data: { changed: true } });
    const ev = await db.platformAuditEvent.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } });
    expect(ev.map((e) => e.action)).toEqual(["platform.support.close", "platform.support.reopen"]);
    expect(await setInboxThreadStatus({ threadId: "no-existe", status: "OPEN" })).toMatchObject({ ok: false });
  });

  it("zod: respuesta vacía o con claves de más se rechaza sin escribir", async () => {
    const id = await tenantThread();
    expect(await replyInboxThread({ threadId: id, body: "   " })).toMatchObject({ ok: false });
    expect(await replyInboxThread({ threadId: id, body: "x", authorKind: "TENANT" })).toMatchObject({ ok: false });
    expect(await db.supportMessage.count({ where: { threadId: id } })).toBe(1);
  });
});
