/**
 * [WA-S7] T6 (§26.5, WA-D21/D22) · la agenda contra Postgres real, en los dos roles (`kinesoft_app` con RLS y owner
 * BYPASSRLS). Corre `listAgendaBookings` y `loadAgendaPage` REALES (solo se mockea la sesión de Supabase y se cuentan
 * las sentencias del cliente de Prisma):
 *   - `patientReply` sale de las columnas de M15 SOLO si `patientReplyFor` = `scheduledFor` (respuesta a otro horario →
 *     null) y la última respuesta gana; la respuesta se escribe por SQL sin tocar `updatedAt`, como el webhook (WA-D22);
 *   - el cable lleva `rp` solo en los turnos con respuesta;
 *   - el flag `whatsapp` de la página: modo `off` = 0 sentencias extra (ni siquiera se mira la cuenta); prendido = una
 *     sentencia y true solo con una cuenta ACTIVE del tenant en ese modo (la de otro consultorio no cuenta).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { listAgendaBookings } from "@/lib/bookings";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { decodeAgendaWire } from "@/lib/agenda-wire";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const MONDAY = "2027-03-08";
const DAY = "2027-03-09";
const at = (hhmm: string) => new Date(localToARIso(`${DAY}T${hhmm}:00`));
const recorded = () =>
  (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;
const metaId = () => String(Math.floor(1e11 + Math.random() * 9e11));

describe.skipIf(!RUN)("[WA-S7] respuesta del paciente y flag de WhatsApp en la agenda", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let other: EphemeralTenant;
  const ids: Record<string, string> = {};

  /** Lo que hace el webhook (C-WA9 «Confirmo»/«No puedo ir»): UPDATE SQL que NO mueve `updatedAt` (WA-D22). */
  const reply = (id: string, col: "patientConfirmedAt" | "patientCancelRequestedAt", when: Date, replyFor: Date) =>
    db.$executeRawUnsafe(
      `UPDATE "Booking" SET "${col}" = $1, "patientReplyFor" = $2 WHERE id = $3`,
      when,
      replyFor,
      id
    );

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    other = await createEphemeralTenant(db);
    const patient = await addPatient(db, T);
    const mk = async (key: string, hhmm: string) => {
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          patientId: patient,
          scheduledFor: at(hhmm),
          durationMin: 30,
          status: "CONFIRMED",
          idempotencyKey: randomUUID(),
        },
      });
      ids[key] = b.id;
    };
    await mk("sin", "09:00");
    await mk("confirmo", "10:00");
    await mk("cancela", "11:00");
    await mk("movido", "12:00");
    await mk("cambio", "13:00");
    await reply(ids.confirmo, "patientConfirmedAt", at("08:00"), at("10:00"));
    await reply(ids.cancela, "patientCancelRequestedAt", at("08:00"), at("11:00"));
    // Respondió por las 11:30 y después se movió a las 12:00: la respuesta es de otro horario.
    await reply(ids.movido, "patientConfirmedAt", at("08:00"), at("11:30"));
    // Confirmó y después pidió cancelar: gana la más nueva.
    await reply(ids.cambio, "patientConfirmedAt", at("07:00"), at("13:00"));
    await reply(ids.cambio, "patientCancelRequestedAt", at("08:00"), at("13:00"));
    // Cuenta ACTIVE de OTRO consultorio: nunca prende el flag de T.
    await db.whatsAppAccount.create({
      data: {
        tenantId: other.tenantId,
        mode: "fake",
        wabaId: metaId(),
        phoneNumberId: metaId(),
        status: "ACTIVE",
        setupStep: "DONE",
        connectedByUserId: other.userId,
        connectedAt: new Date(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await T?.cleanup();
    await other?.cleanup();
    await db?.$disconnect();
  });

  it("[WA-S7] listAgendaBookings: una sola señal; respuesta a otro horario → null; la última gana", async () => {
    asUser(T.userId);
    const rows = await listAgendaBookings({ from: at("00:00"), to: at("23:59") });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(ids.sin)?.patientReply).toBeNull();
    expect(by.get(ids.confirmo)?.patientReply).toBe("confirmed");
    expect(by.get(ids.cancela)?.patientReply).toBe("cancel_requested");
    expect(by.get(ids.movido)?.patientReply).toBeNull();
    expect(by.get(ids.cambio)?.patientReply).toBe("cancel_requested");
    // Los timestamps no viajan: solo la señal.
    for (const r of rows) {
      expect(r).not.toHaveProperty("patientConfirmedAt");
      expect(r).not.toHaveProperty("patientCancelRequestedAt");
      expect(r).not.toHaveProperty("patientReplyFor");
    }
  });

  it("[WA-S7] modo off: whatsapp false sin ninguna query extra; `rp` solo en los turnos con respuesta", async () => {
    asUser(T.userId);
    const actor = await getActor();
    vi.stubEnv("WHATSAPP_MODE", "off");
    const { result: data } = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));
    expect(data.whatsapp).toBe(false);
    expect(recorded().filter((e) => /WhatsAppAccount/.test(e.query))).toEqual([]);

    const withRp = Object.fromEntries(data.bookings.filter((w) => "rp" in w).map((w) => [w.i, w.rp]));
    expect(withRp).toEqual({ [ids.confirmo]: "c", [ids.cancela]: "x", [ids.cambio]: "x" });
    const back = decodeAgendaWire(data.bookings, { services: data.services, locations: data.locations, insurers: data.insurers });
    expect(back.find((b) => b.id === ids.confirmo)?.patientReply).toBe("confirmed");
    expect("patientReply" in back.find((b) => b.id === ids.movido)!).toBe(false);
  });

  it("[WA-S7] modo prendido: una sentencia más; true solo con cuenta ACTIVE propia en ese modo", async () => {
    asUser(T.userId);
    const actor = await getActor();
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("VERCEL", undefined as unknown as string);
    vi.stubEnv("WHATSAPP_MODE", "off");
    const off = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));

    vi.stubEnv("WHATSAPP_MODE", "fake");
    const noAccount = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));
    expect(noAccount.result.whatsapp).toBe(false); // la cuenta del otro consultorio no cuenta
    expect(noAccount.m.statements).toBe(off.m.statements + 1);
    expect(noAccount.m.transactions).toBe(off.m.transactions);

    const acc = await db.whatsAppAccount.create({
      data: {
        tenantId: T.tenantId,
        mode: "fake",
        wabaId: metaId(),
        phoneNumberId: metaId(),
        status: "SETUP",
        connectedByUserId: T.userId,
        connectedAt: new Date(),
      },
    });
    // SETUP no manda.
    expect((await loadAgendaPage(actor, { monday: MONDAY, patientId: null })).whatsapp).toBe(false);
    await db.whatsAppAccount.update({ where: { id: acc.id }, data: { status: "ACTIVE", setupStep: "DONE" } });
    expect((await loadAgendaPage(actor, { monday: MONDAY, patientId: null })).whatsapp).toBe(true);
    // Otro modo (la cuenta es `fake`, el env `sandbox`): el outbox no mandaría → false.
    vi.stubEnv("WHATSAPP_MODE", "sandbox");
    expect((await loadAgendaPage(actor, { monday: MONDAY, patientId: null })).whatsapp).toBe(false);
  });
});
