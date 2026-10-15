/**
 * PL-2d · Mensajes a soporte del lado CONSULTORIO (C-PL11, plan §20.5.7). Símbolos REALES de `lib/support-threads.ts`
 * contra Postgres en los dos roles (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS como prod). Se
 * reemplazan solo la sesión de Supabase y `next/*` (integration-setup) y el despacho del mail
 * (`__setEmailTransportForTests`: el sink a EmailLog sigue corriendo).
 *
 * Se fija:
 *  - quién escribe: Titular, Admin con «Configuración», cualquiera con «Planes y pagos»; la Secretaria sin permisos no;
 *  - aislamiento: otro consultorio no lista, no abre, no responde ni marca un hilo ajeno (y no ve los leads);
 *  - la app no forja una respuesta de Plataforma (ni por la action, ni por SQL con RLS) ni cierra un hilo;
 *  - mail a `PLATFORM_INBOX_EMAIL` sin el texto del mensaje (puede traer un dato de paciente pegado);
 *  - no leídos por usuario; hilo cerrado no se responde;
 *  - rate limit 10/h por usuario;
 *  - en solo lectura (deuda/prueba vencida) se puede escribir; con soporte no.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import {
  createSupportThread,
  getSupportThread,
  listSupportThreads,
  markSupportThreadRead,
  replySupportThread,
} from "@/lib/support-threads";
import {
  SUPPORT_NO_PERMISSION,
  SUPPORT_SESSION_COPY,
  SUPPORT_TEAM_NAME,
  SUPPORT_THREAD_CLOSED,
  SUPPORT_THREAD_NOT_FOUND,
} from "@/lib/support-threads-types";
import { runWithRls } from "@/lib/rls";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { ownerClient, createEphemeralTenant, addPractitioner, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const INBOX = "soporte-pl2d@test.local";
const PHI = "Zqxpl2dPaciente";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[PL-2d] Mensajes a soporte (consultorio)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let secretaria: string;
  let facturacion: string; // Secretaria con «Planes y pagos»
  let bypass: boolean;
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;
  const prevEnf = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
    bypass = await appRoleBypassesRls();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    secretaria = (await addPractitioner(db, A, "ASSISTANT")).userId;
    facturacion = (await addPractitioner(db, A, "ASSISTANT")).userId;
    await db.membership.updateMany({ where: { tenantId: A.tenantId, userId: facturacion }, data: { grantBilling: true } });
  });

  afterAll(async () => {
    if (prevInbox === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
    else process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    if (prevEnf === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnf;
    __setEmailTransportForTests(null);
    if (db) {
      await db.emailLog.deleteMany({ where: { tenantId: { in: [A?.tenantId, B?.tenantId].filter(Boolean) as string[] } } });
    }
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    process.env.PLATFORM_INBOX_EMAIL = INBOX;
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    asUser(A.userId);
  });

  afterEach(() => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    cookies().delete(SUPPORT_COOKIE);
  });

  async function newThread(subject = `Consulta ${uniqueSuffix()}`): Promise<string> {
    const r = await createSupportThread({ subject, body: "Hola, ¿cómo cargo una obra social?" });
    if (!r.ok) throw new Error(r.error);
    return r.data.threadId;
  }

  it("el Titular crea un hilo: fila TENANT, primer mensaje TENANT, marca de leído y mail a Plataforma SIN el texto", async () => {
    const subject = `Cobro duplicado ${uniqueSuffix()}`;
    const r = await createSupportThread({ subject, body: `Me cobraron dos veces. Paciente ${PHI} DNI 12345678` });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    if (!r.ok) return;
    const t = await db.supportThread.findUniqueOrThrow({ where: { id: r.data.threadId } });
    expect(t).toMatchObject({ kind: "TENANT", tenantId: A.tenantId, subject, status: "OPEN", createdById: A.userId, platformReadAt: null });
    const msgs = await db.supportMessage.findMany({ where: { threadId: t.id } });
    expect(msgs.map((m) => [m.authorKind, m.tenantId, m.authorUserId])).toEqual([["TENANT", A.tenantId, A.userId]]);
    expect(await db.supportThreadRead.count({ where: { threadId: t.id, userId: A.userId } })).toBe(1);

    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m).toMatchObject({ kind: "support_message_platform", to: INBOX, tenantId: A.tenantId, entityId: t.id });
    expect(m.subject).toContain(subject);
    expect(m.html).toContain(`/plataforma/mensajes/${t.id}`);
    for (const part of [m.html, m.text, m.subject]) {
      expect(part).not.toContain(PHI);
      expect(part).not.toContain("12345678");
    }
    expect(m.text).toContain("No incluyas datos de pacientes");
  });

  it("sin PLATFORM_INBOX_EMAIL el mensaje queda igual (sin mail)", async () => {
    delete process.env.PLATFORM_INBOX_EMAIL;
    const id = await newThread();
    expect(await db.supportThread.count({ where: { id } })).toBe(1);
    expect(mail.sent).toEqual([]);
  });

  it("zod: asunto y texto obligatorios y con tope; claves de más (p. ej. authorKind) se rechazan", async () => {
    expect(await createSupportThread({ subject: " ", body: "x" })).toMatchObject({ ok: false, error: "Poné un asunto." });
    expect(await createSupportThread({ subject: "x".repeat(201), body: "x" })).toMatchObject({ ok: false });
    expect(await createSupportThread({ subject: "Hola", body: "x".repeat(5001) })).toMatchObject({ ok: false });
    const id = await newThread();
    const forged = await replySupportThread({ threadId: id, body: "Soy Plataforma", authorKind: "PLATFORM" } as never);
    expect(forged.ok).toBe(false);
    expect(await db.supportMessage.count({ where: { threadId: id, authorKind: "PLATFORM" } })).toBe(0);
  });

  it("permisos: la Secretaria sin delegaciones no; con «Planes y pagos» sí", async () => {
    asUser(secretaria);
    expect(await createSupportThread({ subject: "Hola", body: "x" })).toEqual({ ok: false, error: SUPPORT_NO_PERMISSION });
    expect(await listSupportThreads()).toEqual({ ok: false, error: SUPPORT_NO_PERMISSION });
    asUser(facturacion);
    const r = await createSupportThread({ subject: `Factura ${uniqueSuffix()}`, body: "¿Me mandan la factura?" });
    expect(r.ok).toBe(true);
  });

  it("aislamiento: otro consultorio no lista, no abre, no responde ni marca un hilo ajeno", async () => {
    const id = await newThread();
    asUser(B.userId);
    const list = await listSupportThreads();
    expect(list.ok && list.data.some((t) => t.id === id)).toBe(false);
    expect(await getSupportThread(id)).toEqual({ ok: false, error: SUPPORT_THREAD_NOT_FOUND });
    expect(await replySupportThread({ threadId: id, body: "intruso" })).toEqual({ ok: false, error: SUPPORT_THREAD_NOT_FOUND });
    expect(await markSupportThreadRead(id)).toEqual({ ok: false, error: SUPPORT_THREAD_NOT_FOUND });
    expect(await db.supportMessage.count({ where: { threadId: id } })).toBe(1);
    expect(await db.supportThreadRead.count({ where: { threadId: id, userId: B.userId } })).toBe(0);
  });

  it("la app no ve leads ni puede insertar un mensaje PLATFORM ni cerrar el hilo por SQL (RLS de M8)", async () => {
    const id = await newThread();
    const lead = await db.supportThread.create({
      data: { kind: "LEAD", subject: "Lead pl2d", leadName: "Lead", leadEmail: `lead-${uniqueSuffix()}@test.local` },
    });
    try {
      const list = await listSupportThreads();
      expect(list.ok && list.data.some((t) => t.id === lead.id)).toBe(false);
      expect(await getSupportThread(lead.id)).toEqual({ ok: false, error: SUPPORT_THREAD_NOT_FOUND });
      if (!bypass) {
        // Rol kinesoft_app: aunque un bug armara el insert, la policy lo frena.
        await expect(
          runWithRls(A.tenantId, (tx) =>
            tx.supportMessage.create({ data: { threadId: id, tenantId: A.tenantId, authorKind: "PLATFORM", authorUserId: A.userId, body: "forjado" } })
          )
        ).rejects.toThrow();
        const upd = await runWithRls(A.tenantId, (tx) => tx.supportThread.updateMany({ where: { id }, data: { status: "CLOSED" } }));
        expect(upd.count).toBe(0);
        const seen = await runWithRls(A.tenantId, (tx) => tx.supportThread.findMany({ where: { id: lead.id } }));
        expect(seen).toEqual([]);
      }
      expect(await db.supportMessage.count({ where: { threadId: id, authorKind: "PLATFORM" } })).toBe(0);
      expect((await db.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
    } finally {
      await db.supportThread.delete({ where: { id: lead.id } });
    }
  });

  it("no leídos por usuario: la respuesta de Plataforma se marca nueva hasta que cada usuario abre el hilo", async () => {
    const id = await newThread();
    await db.supportMessage.create({
      data: { threadId: id, tenantId: A.tenantId, authorKind: "PLATFORM", authorUserId: "super", body: "Te respondemos", createdAt: new Date(Date.now() + 1000) },
    });
    const before = await listSupportThreads();
    const row = before.ok ? before.data.find((t) => t.id === id) : undefined;
    expect(row).toMatchObject({ unread: true, lastAuthorKind: "PLATFORM", messageCount: 2 });

    const detail = await getSupportThread(id);
    expect(detail.ok && detail.data.messages.map((m) => [m.authorKind, m.authorName, m.mine])).toEqual([
      ["TENANT", expect.any(String), true],
      ["PLATFORM", SUPPORT_TEAM_NAME, false],
    ]);
    // Nunca el email como nombre (decisión 19).
    expect(detail.ok && detail.data.messages[0].authorName).not.toContain("@");

    // markRead con «ahora» posterior a la respuesta (createdAt +1 s): se espera ese segundo.
    await new Promise((r) => setTimeout(r, 1100));
    expect(await markSupportThreadRead(id)).toEqual({ ok: true, data: undefined });
    const after = await listSupportThreads();
    expect(after.ok && after.data.find((t) => t.id === id)?.unread).toBe(false);

    // Otro usuario con permiso todavía lo ve sin leer.
    asUser(facturacion);
    const other = await listSupportThreads();
    expect(other.ok && other.data.find((t) => t.id === id)?.unread).toBe(true);
  });

  it("un hilo cerrado no se responde desde el consultorio", async () => {
    const id = await newThread();
    await db.supportThread.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
    expect(await replySupportThread({ threadId: id, body: "¿Siguen ahí?" })).toEqual({ ok: false, error: SUPPORT_THREAD_CLOSED });
    expect(await db.supportMessage.count({ where: { threadId: id } })).toBe(1);
  });

  it("responder agrega un mensaje TENANT y avisa a Plataforma (respuesta, sin texto)", async () => {
    const id = await newThread();
    mail.sent.length = 0;
    const r = await replySupportThread({ threadId: id, body: `Les paso el dato: ${PHI}` });
    expect(r.ok).toBe(true);
    expect(await db.supportMessage.count({ where: { threadId: id, authorKind: "TENANT" } })).toBe(2);
    expect(mail.sent.map((m) => m.kind)).toEqual(["support_message_platform"]);
    expect(mail.sent[0].subject).toMatch(/^Respuesta de /);
    expect(mail.sent[0].html).not.toContain(PHI);
  });

  it("rate limit: 10 escrituras por hora por usuario (crear y responder comparten cupo)", async () => {
    const id = await newThread();
    for (let i = 0; i < 9; i++) {
      const r = await replySupportThread({ threadId: id, body: `msg ${i}` });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const r = await createSupportThread({ subject: "Uno más", body: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Demasiados intentos/);
    // Otro usuario tiene su propio cupo.
    asUser(facturacion);
    expect((await createSupportThread({ subject: `Otro ${uniqueSuffix()}`, body: "x" })).ok).toBe(true);
  });

  it("en solo lectura (suscripción cancelada + enforce) se puede crear, responder y marcar leído", async () => {
    const id = await newThread();
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    try {
      const c = await createSupportThread({ subject: `Pago ${uniqueSuffix()}`, body: "Quiero pagar" });
      expect(c, JSON.stringify(c)).toMatchObject({ ok: true });
      const rep = await replySupportThread({ threadId: id, body: "Sigo acá" });
      expect(rep, JSON.stringify(rep)).toMatchObject({ ok: true });
      expect(await markSupportThreadRead(id)).toEqual({ ok: true, data: undefined });
      expect((await listSupportThreads()).ok).toBe(true);
    } finally {
      delete process.env.TENANT_ACCESS_ENFORCEMENT;
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "ACTIVE" } });
    }
  });

  describe("con soporte", () => {
    let H: EphemeralTenant;
    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    });
    afterAll(async () => {
      if (db) await db.supportSession.deleteMany({ where: { superadminId: H?.userId } });
      await H?.cleanup();
    });

    it("el superadmin «como soporte» no lee ni escribe mensajes del consultorio", async () => {
      const id = await newThread();
      cookies().delete(SUPPORT_COOKIE);
      asUser(H.userId);
      const s = await startSupport(A.tenantId, "Ayuda con un mensaje de soporte");
      if (!s.ok) throw new Error(s.error);
      const before = await db.supportThread.count({ where: { tenantId: A.tenantId } });
      expect(await createSupportThread({ subject: "Soy soporte", body: "x" })).toEqual({ ok: false, error: SUPPORT_SESSION_COPY });
      expect(await replySupportThread({ threadId: id, body: "x" })).toEqual({ ok: false, error: SUPPORT_SESSION_COPY });
      expect(await markSupportThreadRead(id)).toEqual({ ok: false, error: SUPPORT_SESSION_COPY });
      expect(await listSupportThreads()).toEqual({ ok: false, error: SUPPORT_SESSION_COPY });
      expect(await db.supportThread.count({ where: { tenantId: A.tenantId } })).toBe(before);
      expect(await db.supportMessage.count({ where: { threadId: id } })).toBe(1);
    });
  });
});
