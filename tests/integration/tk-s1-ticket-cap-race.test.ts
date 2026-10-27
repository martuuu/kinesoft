/**
 * PV ZF1a (ZA B5) · tope diario de tickets de sesión bajo concurrencia.
 *
 * El bug: `submitSessionTicket` contaba los tickets de las últimas 24 h y recién después insertaba, sin lock. Ocho
 * envíos que llegan juntos (doble clic repetido, un script con la cookie) leían todos «4 < 5» y escribían todos: el
 * tope de la base, que existe justamente para cuando el limitador en memoria no ve los otros isolates, no frenaba nada.
 *
 * El limitador por hora se reemplaza por uno que siempre deja pasar: es el escenario que el tope de la base cubre
 * (otro isolate, limitador reiniciado) y, con el limitador real, el sexto se cortaría ahí y el test daría verde aunque
 * la base no serializara. Todo lo demás es el símbolo real contra Postgres (sesión mockeada por integration-setup).
 */
import { vi } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { submitSessionTicket } from "@/lib/tickets";
import { SESSION_TICKET_LIMIT, TICKET_ERROR_COPY } from "@/lib/tickets-types";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const PARALLEL = 8;

const sent: SendEmailInput[] = [];
const transport = async (i: SendEmailInput): Promise<SendEmailResult> => {
  sent.push(i);
  return { ok: true, transport: "resend", providerId: `re_${sent.length}` };
};

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe.skipIf(!RUN)("[ZF1a] tope diario de tickets de sesión (B5)", () => {
  let db: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = ownerClient();
  });

  afterAll(async () => {
    if (!db) return;
    const threads = await db.supportThread.findMany({ where: { createdById: { in: users } }, select: { id: true } });
    const ids = threads.map((t) => t.id);
    if (ids.length) {
      await db.emailLog.deleteMany({ where: { entityId: { in: ids } } });
      await db.supportTicketNote.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportThreadRead.deleteMany({ where: { threadId: { in: ids } } });
      await db.supportThread.deleteMany({ where: { id: { in: ids } } });
    }
    if (users.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
      await db.userProfile.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });

  beforeEach(() => {
    sent.length = 0;
    __setEmailTransportForTests(transport);
    asAnonymous();
  });
  afterEach(() => __setEmailTransportForTests(null));

  it("[ZF1a] 8 submitSessionTicket en paralelo del mismo usuario → exactamente 5 tickets", async () => {
    // Usuario con sesión y sin consultorio (alta a medio hacer): sus tickets son LEAD ONBOARDING con `createdById`.
    const u = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: u, email: `${u}@test.local`, fullName: `Carrera ${u}` } });
    users.push(u);
    asUser(u);

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => submitSessionTicket(null, fd({ message: `En paralelo ${i}` })))
    );
    const ok = results.filter((r) => r?.ok).length;
    const capped = results.filter((r) => r && !r.ok && r.error === TICKET_ERROR_COPY.dailyCap).length;
    expect([ok, capped]).toEqual([SESSION_TICKET_LIMIT.limit, PARALLEL - SESSION_TICKET_LIMIT.limit]);
    expect(await db.supportThread.count({ where: { createdById: u } })).toBe(SESSION_TICKET_LIMIT.limit);
    // Un mensaje por hilo: el que se cortó no dejó un hilo vacío ni un mensaje suelto.
    expect(await db.supportMessage.count({ where: { thread: { createdById: u } } })).toBe(SESSION_TICKET_LIMIT.limit);
  });
});
