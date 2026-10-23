/**
 * [WA-S8] T6 (§26.5, WA-D3/WA-D17) · consentimiento de WhatsApp desde el turnero, contra Postgres real y en los dos
 * roles (`kinesoft_app` con RLS y owner BYPASSRLS). `getPublicClinic` y `submitPublicBooking` REALES en el canal de
 * servicio (sin Actor, como en prod). Se mockea solo lo externo: el rate-limit, y se cuentan las sentencias del cliente
 * de Prisma (el cache de Next es pass-through: cada llamada lee la cuenta de nuevo y se puede contar).
 *
 *   - `whatsappNotices`: modo `off` = false y 0 sentencias extra (ni se mira la cuenta); prendido = true solo con una
 *     cuenta ACTIVE del consultorio en ese modo.
 *   - `waConsent: true` + cuenta ACTIVE + celular AR válido → GRANTED/TURNERO/versión con el E.164 del número TIPEADO
 *     en una ficha NUEVA; en una ficha existente por DNI, solo si su celular es el mismo número (ZF2): si no, nada se
 *     escribe y el flag dice «not_saved». La ficha existente nunca cambia su teléfono (H4).
 *   - «Avisa por WhatsApp» exige además un aviso automático prendido (ZF2, `lib/whatsapp/active-internal.ts`).
 *   - Sin cuenta ACTIVE o con un fijo → no se guarda y el flag lo dice (la UI no miente).
 *   - Replay de la misma key → mismo turno, el consentimiento no se reescribe.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { getPublicClinic, listPublicSlots, submitPublicBooking } from "@/lib/public-booking";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  addPatient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const recorded = () =>
  (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;
const metaId = () => String(Math.floor(1e11 + Math.random() * 9e11));
const digits8 = () => Math.floor(Math.random() * 1e8).toString().padStart(8, "0");

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR. */
function futureWeekday(): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}

describe.skipIf(!RUN)("[WA-S8] consentimiento de WhatsApp en el turnero", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let other: EphemeralTenant;
  let serviceId: string;
  let accountId: string;
  const DAY = futureWeekday();
  let slotIdx = 0;

  async function nextSlot(): Promise<string> {
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId, date: DAY });
    const free = slots.filter((s) => s.available);
    const s = free[slotIdx++ % free.length];
    if (!s) throw new Error("sin horarios libres en el día de prueba");
    return s.iso;
  }

  async function input(o: { documentId: string; phone: string; waConsent?: boolean; key?: string; slot?: string }) {
    const req: SubmitPublicBookingInput = {
      tenantSlug: T.slug,
      idempotencyKey: o.key ?? randomUUID(),
      practitionerId: T.practitionerId,
      serviceId,
      scheduledFor: o.slot ?? (await nextSlot()),
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: o.phone,
        documentId: o.documentId,
        dateOfBirth: "1990-05-10",
      },
      ...(o.waConsent === undefined ? {} : { waConsent: o.waConsent }),
    };
    return req;
  }

  const consentOf = (patientId: string) =>
    db.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: {
        phone: true,
        email: true,
        waConsent: true,
        waConsentAt: true,
        waConsentSource: true,
        waConsentByUserId: true,
        waConsentVersion: true,
        waPhoneE164: true,
      },
    });
  const patientOfBooking = async (bookingId: string) =>
    (await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { patientId: true } })).patientId!;
  const fakeMode = () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("VERCEL", undefined as unknown as string);
    vi.stubEnv("WHATSAPP_MODE", "fake");
  };
  const setStatus = (status: "ACTIVE" | "SETUP") =>
    db.whatsAppAccount.update({ where: { id: accountId }, data: { status, setupStep: status === "ACTIVE" ? "DONE" : "TOKEN" } });

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    other = await createEphemeralTenant(db);
    serviceId = await addService(db, T, { name: "Evaluación", durationMin: 30, priceCents: 0, maxConcurrent: 20 });
    // Cuenta ACTIVE de OTRO consultorio: nunca prende nada en T.
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
    const acc = await db.whatsAppAccount.create({
      data: {
        tenantId: T.tenantId,
        mode: "fake",
        wabaId: metaId(),
        phoneNumberId: metaId(),
        status: "SETUP",
        setupStep: "TOKEN",
        connectedByUserId: T.userId,
        connectedAt: new Date(),
      },
    });
    accountId = acc.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await T?.cleanup();
    await other?.cleanup();
    await db?.$disconnect();
  });

  it("[WA-S8] getPublicClinic: modo off → whatsappNotices false sin queries extra; prendido → true solo con ACTIVE propia", async () => {
    await setStatus("SETUP");
    vi.stubEnv("WHATSAPP_MODE", "off");
    const off = await measure(() => getPublicClinic(T.slug));
    expect(off.result?.whatsappNotices).toBe(false);
    expect(recorded().filter((e) => /WhatsAppAccount/.test(e.query))).toEqual([]);

    fakeMode();
    const setup = await measure(() => getPublicClinic(T.slug));
    expect(setup.result?.whatsappNotices).toBe(false); // SETUP no manda; la ACTIVE del otro consultorio no cuenta
    expect(setup.m.statements).toBe(off.m.statements + 1);

    await setStatus("ACTIVE");
    expect((await getPublicClinic(T.slug))?.whatsappNotices).toBe(true);
    // Otro modo (la cuenta es `fake`, el env `sandbox`): el outbox no mandaría → false.
    vi.stubEnv("WHATSAPP_MODE", "sandbox");
    expect((await getPublicClinic(T.slug))?.whatsappNotices).toBe(false);
  });

  it("[WA-S8] ficha nueva + celular válido → GRANTED/TURNERO con el E.164 del número tipeado", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const sub = digits8();
    const r = await submitPublicBooking(await input({ documentId: `5${digits8()}`, phone: `011 15 ${sub}`, waConsent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.whatsappConsent).toBe("saved");
    const c = await consentOf(await patientOfBooking(r.data.bookingId));
    expect(c).toMatchObject({
      waConsent: "GRANTED",
      waConsentSource: "TURNERO",
      waConsentVersion: WA_CONSENT_VERSION,
      waConsentByUserId: null,
      waPhoneE164: `+54911${sub}`,
    });
    expect(c.waConsentAt).toBeInstanceOf(Date);
  });

  it("[WA-S8] modo off o sin cuenta ACTIVE → no se guarda y el flag dice «unavailable»", async () => {
    vi.stubEnv("WHATSAPP_MODE", "off");
    await setStatus("ACTIVE");
    const offRes = await measure(async () =>
      submitPublicBooking(await input({ documentId: `6${digits8()}`, phone: `11${digits8()}`, waConsent: true }))
    );
    expect(recorded().filter((e) => /WhatsAppAccount/.test(e.query))).toEqual([]);
    const off = offRes.result;
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.data.whatsappConsent).toBe("unavailable");
    expect((await consentOf(await patientOfBooking(off.data.bookingId))).waConsent).toBeNull();

    fakeMode();
    await setStatus("SETUP");
    const setup = await submitPublicBooking(await input({ documentId: `6${digits8()}`, phone: `11${digits8()}`, waConsent: true }));
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.data.whatsappConsent).toBe("unavailable");
    const c = await consentOf(await patientOfBooking(setup.data.bookingId));
    expect(c.waConsent).toBeNull();
    expect(c.waPhoneE164).toBeNull();
  });

  it("[WA-S8] número fijo → la reserva entra, el consentimiento no se guarda y el flag dice «invalid_phone»", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const r = await submitPublicBooking(await input({ documentId: `7${digits8()}`, phone: `011 ${digits8()}`, waConsent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.whatsappConsent).toBe("invalid_phone");
    const c = await consentOf(await patientOfBooking(r.data.bookingId));
    expect(c.waConsent).toBeNull();
    expect(c.waPhoneE164).toBeNull();
  });

  it("[WA-S8] sin la casilla → nada se escribe, sin flag y sin mirar la cuenta", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const res = await measure(async () =>
      submitPublicBooking(await input({ documentId: `8${digits8()}`, phone: `11${digits8()}` }))
    );
    const r = res.result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).not.toHaveProperty("whatsappConsent");
    // La decisión del consentimiento no mira la cuenta; a lo sumo queda la del hook post-commit de WA-S2 (paso 3).
    expect(recorded().filter((e) => /WhatsAppAccount/.test(e.query)).length).toBeLessThanOrEqual(1);
    expect((await consentOf(await patientOfBooking(r.data.bookingId))).waConsent).toBeNull();
  });

  // ZF2 (hallazgo 2): antes el consentimiento se escribía con el número TIPEADO sobre cualquier ficha existente por DNI.
  // Un anónimo con el DNI de otro pisaba `waPhoneE164`/`waConsentAt` de esa ficha: el canal del paciente real quedaba
  // `phone_changed` (le cortaba los avisos) y el rastro del consentimiento quedaba a nombre de alguien que no era él.
  it("[ZF2] ficha existente por DNI con otro celular → NO se escribe el consentimiento; outcome «not_saved»", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const dni = `9${digits8()}`;
    const filePhone = `11${digits8()}`;
    const fileEmail = `ficha-${randomUUID().slice(0, 8)}@test.local`;
    const patientId = await addPatient(db, T, { documentId: dni, phone: filePhone, email: fileEmail });
    const sub = digits8();
    const r = await submitPublicBooking(await input({ documentId: dni, phone: `+54 9 11 ${sub}`, waConsent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await patientOfBooking(r.data.bookingId)).toBe(patientId);
    expect(r.data.whatsappConsent).toBe("not_saved");
    const c = await consentOf(patientId);
    expect(c.phone).toBe(filePhone); // H4: el contacto de la ficha no se pisa
    expect(c.email).toBe(fileEmail);
    expect(c).toMatchObject({ waConsent: null, waPhoneE164: null, waConsentAt: null });
  });

  it("[ZF2] ficha existente por DNI con el MISMO celular (otro formato) → consentimiento guardado", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const dni = `9${digits8()}`;
    const sub = digits8();
    const patientId = await addPatient(db, T, { documentId: dni, phone: `11${sub}` });
    const r = await submitPublicBooking(await input({ documentId: dni, phone: `+54 9 11 ${sub}`, waConsent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await patientOfBooking(r.data.bookingId)).toBe(patientId);
    expect(r.data.whatsappConsent).toBe("saved");
    expect(await consentOf(patientId)).toMatchObject({ waConsent: "GRANTED", waConsentSource: "TURNERO", waPhoneE164: `+54911${sub}` });
  });

  it("[ZF2] ficha con BAJA (REVOKED) y el mismo celular → sigue REVOKED y el outcome no es «saved»", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const dni = `9${digits8()}`;
    const sub = digits8();
    const patientId = await addPatient(db, T, { documentId: dni, phone: `11${sub}` });
    const at = new Date(Date.now() - 86_400_000);
    await db.patient.update({
      where: { id: patientId },
      data: { waConsent: "REVOKED", waConsentAt: at, waConsentSource: "WHATSAPP", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: `+54911${sub}` },
    });
    const r = await submitPublicBooking(await input({ documentId: dni, phone: `11 ${sub}`, waConsent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.whatsappConsent).toBe("not_saved");
    expect(await consentOf(patientId)).toMatchObject({ waConsent: "REVOKED", waConsentSource: "WHATSAPP", waConsentAt: at });
  });

  it("[ZF2] cuenta ACTIVE con los dos avisos automáticos apagados → whatsappNotices false y «unavailable»", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    await db.whatsAppAccount.update({ where: { id: accountId }, data: { autoBookingNotice: false, autoReminder: false } });
    try {
      expect((await getPublicClinic(T.slug))?.whatsappNotices).toBe(false);
      const r = await submitPublicBooking(await input({ documentId: `3${digits8()}`, phone: `11${digits8()}`, waConsent: true }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.whatsappConsent).toBe("unavailable");
      expect((await consentOf(await patientOfBooking(r.data.bookingId))).waConsent).toBeNull();
      // Con uno solo de los dos prendido, sí avisa (el recordatorio alcanza para prometer «te avisamos»).
      await db.whatsAppAccount.update({ where: { id: accountId }, data: { autoReminder: true } });
      expect((await getPublicClinic(T.slug))?.whatsappNotices).toBe(true);
    } finally {
      await db.whatsAppAccount.update({ where: { id: accountId }, data: { autoBookingNotice: true, autoReminder: true } });
    }
  });

  it("[WA-S8] replay de la misma key → mismo turno, el consentimiento no se reescribe", async () => {
    await setStatus("ACTIVE");
    fakeMode();
    const req = await input({ documentId: `4${digits8()}`, phone: `11${digits8()}`, waConsent: true });
    const first = await submitPublicBooking(req);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const patientId = await patientOfBooking(first.data.bookingId);
    const before = await consentOf(patientId);
    expect(before.waConsent).toBe("GRANTED");

    const again = await submitPublicBooking(req);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.bookingId).toBe(first.data.bookingId);
    expect(again.data.whatsappConsent).toBe("saved");
    const after = await consentOf(patientId);
    expect(after.waConsentAt?.getTime()).toBe(before.waConsentAt?.getTime());
    expect(await db.booking.count({ where: { tenantId: T.tenantId, idempotencyKey: `pub:${T.tenantId}:${req.idempotencyKey}` } })).toBe(1);
    expect(await db.patient.count({ where: { tenantId: T.tenantId, documentId: req.patient.documentId } })).toBe(1);
  });
});
