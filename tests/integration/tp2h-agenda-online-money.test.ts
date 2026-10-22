/**
 * T5 · [TP-2h] `/agenda` lleva `onlineMoney` con 0 sentencias (plan §25.12; `listAgendaBookings` está a un techo,
 * §25.2 #5). Se mide el loader REAL de la página (`loadAgendaPage`) con el contador de queries de PF2-c, con los cobros
 * online apagados y prendidos (MP falso): mismas transacciones y mismas sentencias, y el flag sale del entorno y de las
 * capabilities del Actor.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { agendaOnlineMoneyFor, loadAgendaPage } from "@/lib/agenda-page-loader";
import { getActor } from "@/lib/session";
import { ownerClient, createEphemeralTenant, addPractitioner, addStaff, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const MONDAY = "2027-03-08";

describe.skipIf(!RUN)("[TP-2h] /agenda · onlineMoney con 0 sentencias", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string };
  let staffAdmin: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    staffAdmin = await addStaff(db, T, "ASSISTANT");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[TP-2h] apagado vs prendido: mismas tx y sentencias; el flag sigue al modo y a quien cobra", async () => {
    asUser(T.userId);
    const actor = await getActor();
    vi.stubEnv("MP_CONNECT_MODE", "off");
    const off = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("VERCEL", undefined as unknown as string);
    const on = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));

    expect(off.result.onlineMoney).toEqual({ enabled: false, canLink: false });
    expect(on.result.onlineMoney).toEqual({ enabled: true, canLink: true });
    expect(on.m.transactions).toBe(off.m.transactions);
    expect(on.m.statements).toBe(off.m.statements);
  });

  it("[TP-2h] Secretaria (billing.collect) y profesional (collectOwn) pueden generar links; sin MP no", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("VERCEL", undefined as unknown as string);
    for (const userId of [staffAdmin.userId, kine.userId]) {
      asUser(userId);
      const actor = await getActor();
      expect((await loadAgendaPage(actor, { monday: MONDAY, patientId: null })).onlineMoney).toEqual({ enabled: true, canLink: true });
    }
    // Puro: sin billing.* no hay link; collectOwn sin profesional propio tampoco; soporte nunca.
    expect(agendaOnlineMoneyFor(new Set(["agenda.viewAll"]), { support: null, practitionerId: "p" }, "live")).toEqual({ enabled: true, canLink: false });
    expect(agendaOnlineMoneyFor(new Set(["billing.collectOwn"]), { support: null, practitionerId: null }, "live").canLink).toBe(false);
    expect(
      agendaOnlineMoneyFor(new Set(["billing.collect"]), { support: { sessionId: "s", superadminEmail: "x@y.z" }, practitionerId: null }, "live").canLink
    ).toBe(false);
  });
});
