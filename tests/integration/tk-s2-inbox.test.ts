/**
 * PV (§27) · TK-S2 · Tickets en /plataforma (server). Símbolos REALES de `lib/platform-inbox.ts` contra Postgres en los
 * dos roles (`test:integration` = `kinesoft_app` con RLS; `:owner` = BYPASSRLS, como prod hoy). Se reemplazan solo la
 * sesión de Supabase y `next/*` (integration-setup) y el despacho del mail.
 *
 * Decisión de Martin (literal, 27-oct): «que todos los contactos de formularios y consultas a soporte vayan a la parte
 * de /plataforma de Superadmin, y se abran como "tickets" para resolver desde ahi. Yo me comunico luego con cada
 * cliente». Etapa (M19): Nuevo = OPEN sin `platformTakenAt`; En curso = OPEN tomado; Resuelto = CLOSED.
 *
 *   [TK-13] tomar: idempotente (dos clics, otro superadmin, dos a la vez → un solo cambio y un solo registro), solo OPEN.
 *   [TK-14] notas internas: solo inserción y solo desde Plataforma; el consultorio no las ve con ningún camino
 *           (`kinesoft_app` con su GUC, `runWithRls`, su propio detalle). El registro no lleva el texto.
 *   [TK-15] filtros por etapa y por origen; el origen NULL legado (fila del código viejo entre M19 y el deploy) cae en
 *           el default de su kind; los params viejos (`status`, `kind`) siguen.
 *   [TK-16] resolver → reabrir vuelve a «En curso» (se conserva quién lo tomó); responder toma si estaba libre.
 *   [TK-17] quien no es superadmin rebota en los exports nuevos sin escribir (el guard estático en
 *           `tests/unit/platform-admin-guard.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PrismaClient, type SupportTicketSource } from "@prisma/client";
import {
  addInboxNote,
  getInboxThread,
  listInbox,
  replyInboxThread,
  setInboxThreadStatus,
  takeInboxThread,
} from "@/lib/platform-inbox";
import { createSupportThread, getSupportThread } from "@/lib/support-threads";
import { TICKET_NOTE_MAX, type TicketInboxRow } from "@/lib/support-threads-types";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { runWithRls } from "@/lib/rls";
import { asApp, inTx } from "@/tests/helpers/migration-sql";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const INBOX = "soporte-inbox-tks2@test.local";
const SECRET = "Zqxtks2NotaInterna";

// ¿La conexión de la APP (DATABASE_URL) saltea RLS? Igual que rls-isolation / m19-support-tickets.
async function appRoleBypassesRls(): Promise<boolean> {
  const app = new PrismaClient();
  try {
    const rows = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    return rows[0]?.bypass ?? true;
  } finally {
    await app.$disconnect();
  }
}
const BYPASS = RUN ? await appRoleBypassesRls() : true;
if (RUN && BYPASS) {
  console.warn("[tk-s2-inbox] SKIP [TK-14] por runWithRls: la conexión de la app tiene BYPASSRLS (modo owner).");
}

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[TK-S2] Tickets en /plataforma", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let S: string; // superadmin «Martín Soporte»
  let S2: string; // otro superadmin
  const threadIds: string[] = [];
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    await db.tenant.update({
      where: { id: A.tenantId },
      data: { name: `Consultorio TKS2 ${uniqueSuffix()}`, phone: "+54 11 4444-5555", whatsapp: "+5491155556666" },
    });
    await db.userProfile.update({ where: { id: A.userId }, data: { fullName: "Ana Titular" } });
    S = `test-user-${uniqueSuffix()}`;
    S2 = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: S, email: `${S}@test.local`, fullName: "Martín Soporte", isPlatformAdmin: true } });
    await db.userProfile.create({ data: { id: S2, email: `${S2}@test.local`, fullName: "Bea Soporte", isPlatformAdmin: true } });
  });

  afterAll(async () => {
    if (prevInbox === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
    else process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    __setEmailTransportForTests(null);
    if (db) {
      const ids = [...threadIds];
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" IN (${S}, ${S2}) OR "entityId" = ANY(${ids}::text[])`,
      ]);
      await db.emailLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { tenantId: A?.tenantId }] } });
      // M19: la nota tiene FK RESTRICT hacia el hilo → primero las notas.
      await db.supportTicketNote.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportThread.deleteMany({ where: { id: { in: ids }, kind: "LEAD" } });
    }
    await A?.cleanup();
    if (db) {
      await db.userProfile.deleteMany({ where: { id: { in: [S, S2] } } });
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

  /** Hilo del consultorio por el flujo real (Configuración → Soporte). */
  async function tenantThread(subject = `Ticket ${uniqueSuffix()}`): Promise<string> {
    asUser(A.userId);
    const r = await createSupportThread({ subject, body: "Necesito ayuda con la agenda" });
    asUser(S);
    if (!r.ok) throw new Error(r.error);
    threadIds.push(r.data.threadId);
    return r.data.threadId;
  }

  /** Hilo con columnas explícitas (origen NULL = fila del código viejo entre M19 y el deploy). */
  async function rawThread(kind: "TENANT" | "LEAD", source: SupportTicketSource | null): Promise<string> {
    const t = await db.supportThread.create({
      data:
        kind === "TENANT"
          ? { kind, tenantId: A.tenantId, subject: `Raw ${uniqueSuffix()}`, createdById: A.userId, source }
          : {
              kind,
              subject: `Raw lead ${uniqueSuffix()}`,
              leadName: "Laura Lead",
              leadEmail: `lead-${uniqueSuffix()}@test.local`,
              leadPhone: "+54 9 11 2222-3333",
              leadClinicName: "Kinesio Sur",
              leadPlanInterest: "CONSULTORIO",
              source,
            },
      select: { id: true },
    });
    threadIds.push(t.id);
    return t.id;
  }

  /** Todas las páginas de la bandeja (la página es de 30: no asumimos que lo nuestro cae en la primera). */
  async function allRows(q: Record<string, unknown>): Promise<TicketInboxRow[]> {
    const out: TicketInboxRow[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const page = await listInbox({ ...q, cursor });
      out.push(...page.rows);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  async function events(threadId: string, action: string) {
    return db.platformAuditEvent.findMany({ where: { entityId: threadId, action }, orderBy: { createdAt: "asc" } });
  }

  // ── [TK-13] ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TK-13] tomar idempotente y auditado", async () => {
    const id = await tenantThread();
    expect((await getInboxThread(id))?.stage).toBe("NEW");

    expect(await takeInboxThread({ threadId: id })).toEqual({ ok: true, data: { changed: true } });
    const t1 = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect(t1.platformTakenById).toBe(S);
    expect(t1.platformTakenAt).not.toBeNull();
    expect(t1.status).toBe("OPEN");

    // Segundo clic y otro superadmin: no pisan quién lo tomó ni cuándo, y no registran nada.
    expect(await takeInboxThread({ threadId: id })).toEqual({ ok: true, data: { changed: false } });
    asUser(S2);
    expect(await takeInboxThread({ threadId: id })).toEqual({ ok: true, data: { changed: false } });
    asUser(S);
    const t2 = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t2.platformTakenById, t2.platformTakenAt?.getTime()]).toEqual([S, t1.platformTakenAt?.getTime()]);

    const ev = await events(id, "platform.support.take");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorId: S, entity: "SupportThread", tenantId: A.tenantId });
    expect(JSON.stringify(ev[0].payload)).not.toContain(t1.subject);
    // Hilo de consultorio: SOLO en el registro de Plataforma (ZF1a, ZA B2: el log del consultorio sale en su export).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "platform.support.take", entityId: id } })).toBe(0);

    // La bandeja y el detalle lo muestran «En curso» y por quién (nombre, nunca el email).
    const row = (await allRows({ stage: "IN_PROGRESS" })).find((r) => r.id === id);
    expect(row).toMatchObject({ stage: "IN_PROGRESS", takenByName: "Martín Soporte", source: "TENANT_SUPPORT" });
    asUser(S2);
    const d = await getInboxThread(id);
    expect(d).toMatchObject({ stage: "IN_PROGRESS", takenByName: "Martín Soporte", takenAt: t1.platformTakenAt?.toISOString() });

    // Dos a la vez (doble clic que llega junto): uno solo gana, un solo registro.
    asUser(S);
    const id2 = await tenantThread();
    const both = await Promise.all([takeInboxThread({ threadId: id2 }), takeInboxThread({ threadId: id2 })]);
    expect(both.map((r) => r.ok && r.data.changed).sort()).toEqual([false, true]);
    expect(await events(id2, "platform.support.take")).toHaveLength(1);

    // Lead: registro global (sin consultorio).
    const lead = await rawThread("LEAD", "PRICING");
    expect(await takeInboxThread({ threadId: lead })).toEqual({ ok: true, data: { changed: true } });
    expect((await events(lead, "platform.support.take")).map((e) => e.tenantId)).toEqual([null]);
  });

  it("[TK-13] solo se toma un ticket abierto; inexistente o con claves de más, error sin escribir", async () => {
    const id = await tenantThread();
    await setInboxThreadStatus({ threadId: id, status: "CLOSED" });
    expect(await takeInboxThread({ threadId: id })).toMatchObject({ ok: false });
    expect(await takeInboxThread({ threadId: "no-existe" })).toMatchObject({ ok: false });
    expect(await takeInboxThread({ threadId: id, takenById: S2 })).toMatchObject({ ok: false });
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t.platformTakenAt, t.platformTakenById]).toEqual([null, null]);
    expect(await events(id, "platform.support.take")).toHaveLength(0);
  });

  // ── [TK-14] ─────────────────────────────────────────────────────────────────────────────────────────────────────

  // ZA B2: el export del Titular lleva su `AuditEvent` (lib/tenant-export-internal.ts). Si «Tomar» y la nota interna
  // dejaban ahí `{noteId, length}`, el consultorio veía que Plataforma anotó algo sobre su ticket (y cuánto escribió):
  // la nota es solo de Plataforma. El rastro queda en `PlatformAuditEvent` con el consultorio como referencia.
  it("[ZF1a] tomar y anotar quedan SOLO en el registro de Plataforma (con tenantId), no en el AuditEvent del consultorio", async () => {
    const id = await tenantThread();
    expect(await takeInboxThread({ threadId: id })).toEqual({ ok: true, data: { changed: true } });
    expect((await addInboxNote({ threadId: id, body: `Nota ${SECRET}` })).ok).toBe(true);

    for (const action of ["platform.support.take", "platform.support.note"]) {
      const ev = await events(id, action);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorId: S, entity: "SupportThread", entityId: id, tenantId: A.tenantId });
      expect(JSON.stringify(ev[0].payload)).not.toContain(SECRET);
    }
    expect((await events(id, "platform.support.note"))[0].payload).toMatchObject({ length: `Nota ${SECRET}`.length });
    expect(
      await db.auditEvent.count({
        where: { tenantId: A.tenantId, entityId: id, action: { in: ["platform.support.take", "platform.support.note"] } },
      })
    ).toBe(0);
  });

  it("[TK-14] la nota solo se ve desde Plataforma", async () => {
    const id = await tenantThread();
    const body = `Lo llamé por WhatsApp el 30/10, quedó en mandar los datos ${SECRET}`;
    const r = await addInboxNote({ threadId: id, body: `   ${body}\n` });
    expect(r).toEqual({ ok: true, data: { noteId: expect.any(String) } });
    const rows = await db.supportTicketNote.findMany({ where: { threadId: id } });
    expect(rows.map((n) => [n.body, n.authorUserId])).toEqual([[body, S]]);

    // Registro: sin el texto, SOLO en Plataforma (ZF1a, ZA B2: nada en el log del consultorio, que sale en su export).
    const ev = await events(id, "platform.support.note");
    expect(ev).toHaveLength(1);
    expect(ev[0].tenantId).toBe(A.tenantId);
    expect(JSON.stringify(ev[0].payload)).not.toContain(SECRET);
    const tev = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "platform.support.note", entityId: id } });
    expect(tev).toHaveLength(0);

    // Plataforma la ve; `mine` según quién mira. Anotar no toma el ticket.
    const d = await getInboxThread(id);
    expect(d?.notes).toEqual([
      { id: rows[0].id, authorName: "Martín Soporte", body, createdAt: rows[0].createdAt.toISOString(), mine: true },
    ]);
    expect(d?.stage).toBe("NEW");
    asUser(S2);
    expect((await getInboxThread(id))?.notes.map((n) => n.mine)).toEqual([false]);
    asUser(S);

    // El consultorio no: su detalle de Configuración → Soporte no la trae…
    asUser(A.userId);
    const mine = await getSupportThread(id);
    asUser(S);
    expect(mine.ok).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(SECRET);
    // …y la base tampoco se la da a `kinesoft_app` con su GUC (SERVICE_ONLY: cero policies). Corre en los 2 roles.
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportTicketNote" WHERE "threadId" = ${id}`).toEqual([{ n: 0 }]);
    });
  });

  it.skipIf(BYPASS)("[TK-14] por runWithRls del consultorio (cliente de la app): 0 notas", async () => {
    const id = await tenantThread();
    expect((await addInboxNote({ threadId: id, body: `Nota ${SECRET}` })).ok).toBe(true);
    expect(await runWithRls(A.tenantId, (tx) => tx.supportTicketNote.findMany({ where: { threadId: id } }))).toEqual([]);
    expect(await db.supportTicketNote.count({ where: { threadId: id } })).toBe(1);
  });

  it("[TK-14] nota: vacía, larga o con claves de más se rechaza sin escribir; en un lead y en un resuelto, sí", async () => {
    const id = await tenantThread();
    expect(await addInboxNote({ threadId: id, body: "   " })).toMatchObject({ ok: false });
    expect(await addInboxNote({ threadId: id, body: "x".repeat(TICKET_NOTE_MAX + 1) })).toMatchObject({ ok: false });
    expect(await addInboxNote({ threadId: id, body: "hola", authorUserId: S2 })).toMatchObject({ ok: false });
    expect(await addInboxNote({ threadId: "no-existe", body: "hola" })).toMatchObject({ ok: false });
    expect(await db.supportTicketNote.count({ where: { threadId: id } })).toBe(0);
    expect(await events(id, "platform.support.note")).toHaveLength(0);

    expect((await addInboxNote({ threadId: id, body: "x".repeat(TICKET_NOTE_MAX) })).ok).toBe(true);
    await setInboxThreadStatus({ threadId: id, status: "CLOSED" });
    expect((await addInboxNote({ threadId: id, body: "Quedó resuelto por teléfono" })).ok).toBe(true);
    expect(await db.supportTicketNote.count({ where: { threadId: id } })).toBe(2);

    const lead = await rawThread("LEAD", "LANDING");
    expect((await addInboxNote({ threadId: lead, body: `Le escribí ${SECRET}` })).ok).toBe(true);
    const ev = await events(lead, "platform.support.note");
    expect(ev.map((e) => e.tenantId)).toEqual([null]);
    expect(JSON.stringify(ev[0].payload)).not.toContain(SECRET);
  });

  it("[TK-14] tarjeta de contacto: lead con sus datos; consultorio con quien lo abrió y los datos del consultorio", async () => {
    const lead = await rawThread("LEAD", "PRICING");
    const ld = await getInboxThread(lead);
    expect(ld).toMatchObject({ source: "PRICING", stage: "NEW", takenAt: null, takenByName: null, notes: [] });
    expect(ld?.contact).toEqual({
      name: "Laura Lead",
      email: expect.stringMatching(/^lead-.*@test\.local$/),
      phone: "+54 9 11 2222-3333",
      clinicName: "Kinesio Sur",
      planInterest: "CONSULTORIO",
      tenant: null,
      userId: null,
    });

    const id = await tenantThread();
    const td = await getInboxThread(id);
    const tn = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect(td?.contact).toEqual({
      name: "Ana Titular",
      email: `${A.userId}@test.local`,
      phone: null,
      clinicName: tn.name,
      planInterest: null,
      tenant: { id: A.tenantId, name: tn.name, slug: tn.slug, phone: "+54 11 4444-5555", whatsapp: "+5491155556666" },
      userId: A.userId,
    });
    // Compatibilidad con la vista de PL-2d (hasta TK-U1): `tenant` sigue siendo {id, name, slug}.
    expect(td?.tenant).toEqual({ id: A.tenantId, name: tn.name, slug: tn.slug });
  });

  // ── [TK-15] ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TK-15] filtros etapa/origen (incluye NULL legado)", async () => {
    const tNull = await rawThread("TENANT", null);
    const tPlan = await rawThread("TENANT", "PLAN_CHANGE");
    const lNull = await rawThread("LEAD", null);
    const lPrice = await rawThread("LEAD", "PRICING");
    const tTaken = await rawThread("TENANT", "TENANT_SUPPORT");
    const tClosed = await rawThread("TENANT", "TENANT_SUPPORT");
    expect((await takeInboxThread({ threadId: tTaken })).ok).toBe(true);
    expect((await setInboxThreadStatus({ threadId: tClosed, status: "CLOSED" })).ok).toBe(true);
    const mine = new Set([tNull, tPlan, lNull, lPrice, tTaken, tClosed]);
    const ids = async (q: Record<string, unknown>) =>
      (await allRows(q))
        .filter((r) => mine.has(r.id))
        .map((r) => r.id)
        .sort();
    const sorted = (...x: string[]) => [...x].sort();

    // Origen: el NULL legado se lee con el default de su kind, en la fila y en el filtro.
    const all = (await allRows({ stage: "all" })).filter((r) => mine.has(r.id));
    const byId = new Map(all.map((r) => [r.id, r]));
    expect(byId.get(tNull)?.source).toBe("TENANT_SUPPORT");
    expect(byId.get(lNull)?.source).toBe("LANDING");
    expect(byId.get(lPrice)?.source).toBe("PRICING");
    expect(await ids({ stage: "all", source: "TENANT_SUPPORT" })).toEqual(sorted(tNull, tTaken, tClosed));
    expect(await ids({ stage: "all", source: "LANDING" })).toEqual([lNull]);
    expect(await ids({ stage: "all", source: "PRICING" })).toEqual([lPrice]);
    expect(await ids({ stage: "all", source: "PLAN_CHANGE" })).toEqual([tPlan]);

    // Etapa.
    expect(byId.get(tTaken)).toMatchObject({ stage: "IN_PROGRESS", takenByName: "Martín Soporte" });
    expect(byId.get(tClosed)).toMatchObject({ stage: "CLOSED", status: "CLOSED", takenByName: null });
    expect(byId.get(tNull)).toMatchObject({ stage: "NEW", takenByName: null });
    expect(await ids({ stage: "NEW" })).toEqual(sorted(tNull, tPlan, lNull, lPrice));
    expect(await ids({ stage: "IN_PROGRESS" })).toEqual([tTaken]);
    expect(await ids({ stage: "CLOSED" })).toEqual([tClosed]);
    expect(await ids({ stage: "open" })).toEqual(sorted(tNull, tPlan, lNull, lPrice, tTaken));
    expect(await ids({ stage: "NEW", source: "TENANT_SUPPORT" })).toEqual([tNull]);

    // Params viejos (PL-2d): siguen mapeando, y se combinan con los nuevos.
    expect(await ids({})).toEqual(sorted(...mine));
    expect(await ids({ status: "OPEN" })).toEqual(sorted(tNull, tPlan, lNull, lPrice, tTaken));
    expect(await ids({ status: "CLOSED" })).toEqual([tClosed]);
    expect(await ids({ kind: "LEAD" })).toEqual(sorted(lNull, lPrice));
    expect(await ids({ kind: "TENANT", stage: "NEW" })).toEqual(sorted(tNull, tPlan));
    // Origen que no es del catálogo: se ignora ese filtro (no rompe la bandeja).
    expect(await ids({ stage: "all", source: "BASURA" })).toEqual(sorted(...mine));
  });

  // ── [TK-16] ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TK-16] resolver → reabrir → «En curso» (se conserva quién lo tomó)", async () => {
    const id = await tenantThread();
    expect((await takeInboxThread({ threadId: id })).ok).toBe(true);
    const taken = await db.supportThread.findUniqueOrThrow({ where: { id } });

    expect(await setInboxThreadStatus({ threadId: id, status: "CLOSED" })).toEqual({ ok: true, data: { changed: true } });
    const closed = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([closed.status, closed.platformTakenById, closed.platformTakenAt?.getTime()]).toEqual([
      "CLOSED",
      S,
      taken.platformTakenAt?.getTime(),
    ]);
    expect((await getInboxThread(id))?.stage).toBe("CLOSED");

    expect(await setInboxThreadStatus({ threadId: id, status: "OPEN" })).toEqual({ ok: true, data: { changed: true } });
    const d = await getInboxThread(id);
    expect(d).toMatchObject({ status: "OPEN", stage: "IN_PROGRESS", takenByName: "Martín Soporte" });
    expect(d?.takenAt).toBe(taken.platformTakenAt?.toISOString());
  });

  it("[TK-16] responder toma si estaba libre (mismo registro de respuesta); si ya era de otro, no lo pisa", async () => {
    const id = await tenantThread();
    await setInboxThreadStatus({ threadId: id, status: "CLOSED" });
    expect((await replyInboxThread({ threadId: id, body: "Ya lo revisamos" })).ok).toBe(true);
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t.status, t.platformTakenById]).toEqual(["OPEN", S]);
    expect(t.platformTakenAt).not.toBeNull();
    expect((await getInboxThread(id))?.stage).toBe("IN_PROGRESS");
    const ev = await events(id, "platform.support.reply");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ kind: "TENANT", reopened: true, took: true });
    // Responder ya registra que lo tomó: no hay un evento «take» aparte.
    expect(await events(id, "platform.support.take")).toHaveLength(0);

    // Otro superadmin responde: el ticket sigue siendo de quien lo tomó.
    asUser(S2);
    expect((await replyInboxThread({ threadId: id, body: "Sumo un dato" })).ok).toBe(true);
    asUser(S);
    const t2 = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t2.platformTakenById, t2.platformTakenAt?.getTime()]).toEqual([S, t.platformTakenAt?.getTime()]);
    expect((await events(id, "platform.support.reply")).map((e) => (e.payload as { took: boolean }).took)).toEqual([true, false]);
  });

  // ── [TK-17] ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TK-17] no superadmin rechazado en los exports nuevos, sin escribir", async () => {
    const id = await tenantThread();
    asUser(A.userId);
    const calls: Array<() => Promise<unknown>> = [
      () => takeInboxThread({ threadId: id }),
      () => addInboxNote({ threadId: id, body: "Forjada" }),
      () => listInbox({ stage: "NEW", source: "TENANT_SUPPORT" }),
      () => getInboxThread(id),
    ];
    for (const c of calls) await expect(c()).rejects.toThrow();
    asUser(S);
    const t = await db.supportThread.findUniqueOrThrow({ where: { id } });
    expect([t.platformTakenAt, t.platformTakenById, t.platformReadAt]).toEqual([null, null, null]);
    expect(await db.supportTicketNote.count({ where: { threadId: id } })).toBe(0);
  });
});
