/**
 * [WA-P1] C-WA2 · lógica pura de WhatsApp (`lib/whatsapp/logic.ts`) y paridad de `lib/whatsapp/types.ts` con M15.
 *
 * Se corre con TZ=UTC (Vercel) y TZ=AR: la ventana de «mañana» y los horarios se calculan con `lib/datetime-ar.ts`,
 * nunca con el reloj del host.
 */
import { describe, expect, it } from "vitest";
import {
  WhatsAppAccountStatus,
  WhatsAppConsentSource,
  WhatsAppConsentStatus,
  WhatsAppInboundKind,
  WhatsAppMessageKind,
  WhatsAppMessageStatus,
  WhatsAppMessageTrigger,
  WhatsAppSetupStep,
  WhatsAppTemplateKey,
  WhatsAppTemplateStatus,
} from "@prisma/client";
import {
  WA_ACCOUNT_STATUSES,
  WA_CONSENT_SOURCES,
  WA_CONSENT_STATUSES,
  WA_CONSENT_VERSION,
  WA_INBOUND_KINDS,
  WA_MESSAGE_KINDS,
  WA_MESSAGE_STATUSES,
  WA_MESSAGE_TRIGGERS,
  WA_SETUP_STEPS,
  WA_SKIP_REASONS,
  WA_TEMPLATE_KEYS,
  WA_TEMPLATE_STATUSES,
  type WaAccountStatus,
  type WaConsentSource,
  type WaConsentStatus,
  type WaInboundKind,
  type WaMessageKind,
  type WaMessageStatus,
  type WaMessageTrigger,
  type WaSetupStep,
  type WaTemplateKey,
  type WaTemplateStatus,
} from "@/lib/whatsapp/types";
import {
  IDEM_KEY_RE,
  buttonPayload,
  classifyGraphError,
  classifyRef,
  eligibility,
  groupSeries,
  idemKey,
  nextMessageStatus,
  parseButtonPayload,
  parseInboundText,
  patientChannel,
  retryDelayMs,
  tomorrowWindowAR,
} from "@/lib/whatsapp/logic";

// Paridad de TIPOS (tsc): cada unión ≡ su enum de Prisma.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _parity: [
  Same<WaAccountStatus, WhatsAppAccountStatus>,
  Same<WaSetupStep, WhatsAppSetupStep>,
  Same<WaTemplateKey, WhatsAppTemplateKey>,
  Same<WaTemplateStatus, WhatsAppTemplateStatus>,
  Same<WaMessageKind, WhatsAppMessageKind>,
  Same<WaMessageTrigger, WhatsAppMessageTrigger>,
  Same<WaMessageStatus, WhatsAppMessageStatus>,
  Same<WaInboundKind, WhatsAppInboundKind>,
  Same<WaConsentStatus, WhatsAppConsentStatus>,
  Same<WaConsentSource, WhatsAppConsentSource>,
] = [true, true, true, true, true, true, true, true, true, true];
void _parity;

const H = 3_600_000;
const M = 60_000;
// Jueves 22-oct-2026 15:00 AR = 18:00 UTC.
const NOW = new Date("2026-10-22T18:00:00.000Z");
const CONNECTED = new Date("2026-10-01T12:00:00.000Z");
const PHONE = "011 15 2345-6789";
const E164 = "+5491123456789";

describe("[WA-P1] paridad con los enums de M15", () => {
  it("[WA-P1] cada lista espeja su enum en orden y sin repetidos", () => {
    const pairs: Array<[readonly string[], Record<string, string>]> = [
      [WA_ACCOUNT_STATUSES, WhatsAppAccountStatus],
      [WA_SETUP_STEPS, WhatsAppSetupStep],
      [WA_TEMPLATE_KEYS, WhatsAppTemplateKey],
      [WA_TEMPLATE_STATUSES, WhatsAppTemplateStatus],
      [WA_MESSAGE_KINDS, WhatsAppMessageKind],
      [WA_MESSAGE_TRIGGERS, WhatsAppMessageTrigger],
      [WA_MESSAGE_STATUSES, WhatsAppMessageStatus],
      [WA_INBOUND_KINDS, WhatsAppInboundKind],
      [WA_CONSENT_STATUSES, WhatsAppConsentStatus],
      [WA_CONSENT_SOURCES, WhatsAppConsentSource],
    ];
    for (const [mine, prisma] of pairs) {
      expect([...mine]).toEqual(Object.values(prisma));
      expect(new Set(mine).size).toBe(mine.length);
    }
  });

  it("[WA-P1] la versión de consentimiento y los motivos cumplen los CHECK de M15", () => {
    expect(WA_CONSENT_VERSION).toBe("wa-2026-10-v1");
    expect(WA_CONSENT_VERSION).toMatch(/^[a-z0-9.-]{1,32}$/);
    for (const r of WA_SKIP_REASONS) expect(r).toMatch(/^[a-z_]{1,40}$/);
  });
});

describe("[WA-P1] classifyRef", () => {
  const ref = (scheduledFor: Date, prev?: { scheduledFor: Date; practitionerId?: string; roomId?: string | null }) => ({
    bookingId: "b1",
    practitionerId: "p1",
    scheduledFor,
    prev: prev ? { practitionerId: prev.practitionerId ?? "p1", scheduledFor: prev.scheduledFor, roomId: prev.roomId } : null,
  });
  const T = new Date("2026-10-25T13:00:00.000Z");

  it("[WA-P1] alta reciente → created", () => {
    expect(classifyRef(ref(T), { createdAt: new Date(NOW.getTime() - 5 * M), scheduledFor: T }, NOW, CONNECTED)).toBe(
      "created"
    );
  });

  it("[WA-P1] creado y movido en 2 h → CREATED (el aviso sale con la hora nueva)", () => {
    const moved = new Date("2026-10-26T14:00:00.000Z");
    const b = { createdAt: new Date(NOW.getTime() - 90 * M), scheduledFor: moved };
    expect(classifyRef(ref(moved, { scheduledFor: T }), b, NOW, CONNECTED)).toBe("created");
  });

  it("[WA-P1] creado antes de conectar la cuenta no es «created» (no se avisan turnos viejos al conectar)", () => {
    const connectedNow = new Date(NOW.getTime() - 10 * M);
    const b = { createdAt: new Date(NOW.getTime() - 30 * M), scheduledFor: T };
    expect(classifyRef(ref(T), b, NOW, connectedNow)).toBeNull();
  });

  it("[WA-P1] turno viejo con otro horario → moved; sin cambio de horario → null", () => {
    const old = { createdAt: new Date(NOW.getTime() - 3 * H), scheduledFor: T };
    expect(classifyRef(ref(T, { scheduledFor: new Date(T.getTime() - H) }), old, NOW, CONNECTED)).toBe("moved");
    expect(classifyRef(ref(T), old, NOW, CONNECTED)).toBeNull();
  });

  it("[WA-P1] cambio de sala o de profesional solo NO es movimiento", () => {
    const old = { createdAt: new Date(NOW.getTime() - 3 * H), scheduledFor: T };
    expect(classifyRef(ref(T, { scheduledFor: T, practitionerId: "p2" }), old, NOW, CONNECTED)).toBeNull();
    expect(classifyRef(ref(T, { scheduledFor: T, roomId: "r9" }), old, NOW, CONNECTED)).toBeNull();
  });

  it("[WA-P1] refs de Recepción o de llamado → null", () => {
    const b = { createdAt: new Date(NOW.getTime() - 5 * M), scheduledFor: T };
    expect(classifyRef({ ...ref(T), kind: "reception" as const }, b, NOW, CONNECTED)).toBeNull();
    expect(classifyRef({ ...ref(T), kind: "called" as const }, b, NOW, CONNECTED)).toBeNull();
  });
});

describe("[WA-P1] eligibility (WA-D4)", () => {
  const base = {
    status: "CONFIRMED",
    patientId: "pat1",
    scheduledFor: new Date(NOW.getTime() + 24 * H),
    patient: { phone: PHONE, waConsent: "GRANTED" as const, waPhoneE164: E164 },
  };

  it("[WA-P1] CONFIRMED + paciente + GRANTED + mismo celular + ≥60′ → ok con el E.164", () => {
    expect(eligibility(base, NOW)).toEqual({ ok: true, e164: E164 });
    expect(eligibility({ ...base, scheduledFor: new Date(NOW.getTime() + 60 * M) }, NOW).ok).toBe(true);
  });

  it("[WA-P1] <60′ → too_soon (y un turno pasado también)", () => {
    expect(eligibility({ ...base, scheduledFor: new Date(NOW.getTime() + 59 * M) }, NOW)).toEqual({
      ok: false,
      reason: "too_soon",
    });
    expect(eligibility({ ...base, scheduledFor: new Date(NOW.getTime() - H) }, NOW)).toEqual({
      ok: false,
      reason: "too_soon",
    });
  });

  it("[WA-P1] guest (sin paciente) → no_patient; PENDING público → not_confirmed", () => {
    expect(eligibility({ ...base, patientId: null, patient: null }, NOW)).toEqual({ ok: false, reason: "no_patient" });
    expect(eligibility({ ...base, status: "PENDING" }, NOW)).toEqual({ ok: false, reason: "not_confirmed" });
    expect(eligibility({ ...base, status: "CANCELLED" }, NOW)).toEqual({ ok: false, reason: "not_confirmed" });
  });

  it("[WA-P1] consentimiento: sin preguntar, revocado, celular cambiado o inválido", () => {
    const p = base.patient;
    expect(eligibility({ ...base, patient: { ...p, waConsent: null, waPhoneE164: null } }, NOW)).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(eligibility({ ...base, patient: { ...p, waConsent: "REVOKED" } }, NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(eligibility({ ...base, patient: { ...p, phone: "0351 155 123456" } }, NOW)).toEqual({
      ok: false,
      reason: "phone_changed",
    });
    expect(eligibility({ ...base, patient: { ...p, phone: "011 4321-5678" } }, NOW)).toEqual({
      ok: false,
      reason: "invalid_phone",
    });
  });

  it("[WA-P1] el mismo celular escrito distinto sigue siendo el consentido", () => {
    expect(eligibility({ ...base, patient: { ...base.patient, phone: "+54 9 11 2345 6789" } }, NOW).ok).toBe(true);
  });
});

describe("[WA-P1] patientChannel", () => {
  const patient = { phone: PHONE, waConsent: "GRANTED" as const, waPhoneE164: E164 };
  it("[WA-P1] ready solo con cuenta, consentimiento vigente y plantilla aprobada", () => {
    expect(patientChannel({ accountActive: true, templateApproved: true, patient })).toEqual({ state: "ready" });
    expect(patientChannel({ accountActive: false, templateApproved: true, patient })).toEqual({
      state: "blocked",
      reason: "no_account",
    });
    expect(patientChannel({ accountActive: true, templateApproved: false, patient })).toEqual({
      state: "blocked",
      reason: "template_pending",
    });
    expect(
      patientChannel({ accountActive: true, templateApproved: true, patient: { ...patient, waConsent: "REVOKED" } })
    ).toEqual({ state: "blocked", reason: "revoked" });
  });
});

describe("[WA-P1] groupSeries", () => {
  const b = (id: string, h: number, seriesId: string | null = null, programId: string | null = null) => ({
    bookingId: id,
    seriesId,
    programId,
    scheduledFor: new Date(NOW.getTime() + h * H),
  });

  it("[WA-P1] serie → un mensaje (el primer turno manda la fecha y el conteo)", () => {
    const groups = groupSeries([b("a", 72, "s1"), b("b", 24, "s1"), b("c", 48, "s1"), b("d", 30)]);
    expect(groups).toHaveLength(2);
    const serie = groups.find((g) => g.seriesKey === "s1")!;
    expect(serie.bookings.map((x) => x.bookingId)).toEqual(["b", "c", "a"]);
    expect(serie.first.bookingId).toBe("b");
    const single = groups.find((g) => g.seriesKey === null)!;
    expect(single.bookings.map((x) => x.bookingId)).toEqual(["d"]);
  });

  it("[WA-P1] sin serie, los del mismo plan van juntos; un grupo de uno es individual", () => {
    const groups = groupSeries([b("a", 24, null, "prog1"), b("b", 48, null, "prog1"), b("c", 30, "s9")]);
    expect(groups.map((g) => [g.seriesKey, g.bookings.length])).toEqual([
      ["p.prog1", 2],
      [null, 1],
    ]);
  });
});

describe("[WA-P1] idemKey", () => {
  const at = new Date("2026-10-25T13:00:00.000Z");
  const epoch = Math.floor(at.getTime() / 1000);
  it("[WA-P1] formatos y CHECK de M15", () => {
    const keys = [
      idemKey({ t: "bc", bookingId: "ck1abc" }),
      idemKey({ t: "bm", bookingId: "ck1abc", scheduledFor: at }),
      idemKey({ t: "bs", seriesKey: "s-1", scheduledFor: at }),
      idemKey({ t: "br", bookingId: "ck1abc", scheduledFor: at }),
      idemKey({ t: "doc", documentId: "doc1", key: "sha.1" }),
    ];
    expect(keys).toEqual([
      "bc:ck1abc",
      `bm:ck1abc:${epoch}`,
      `bs:s-1:${epoch}`,
      `br:ck1abc:${epoch}`,
      "doc:doc1:sha.1",
    ]);
    for (const k of keys) expect(k).toMatch(IDEM_KEY_RE);
    expect(String(IDEM_KEY_RE)).toBe(String(/^[a-z]{1,8}:[A-Za-z0-9:._-]{1,180}$/));
  });
  it("[WA-P1] un id con caracteres fuera del CHECK tira (bug del caller, no un 23514 en la base)", () => {
    expect(() => idemKey({ t: "bc", bookingId: "a b" })).toThrow();
    expect(() => idemKey({ t: "doc", documentId: "d", key: "x/y" })).toThrow();
  });
});

describe("[WA-P1] nextMessageStatus (monótono)", () => {
  it("[WA-P1] avanza sent → delivered → read y nunca vuelve de READ", () => {
    expect(nextMessageStatus("SENT", "DELIVERED")).toBe("DELIVERED");
    expect(nextMessageStatus("DELIVERED", "READ")).toBe("READ");
    expect(nextMessageStatus("SENT", "READ")).toBe("READ");
    expect(nextMessageStatus("READ", "DELIVERED")).toBe("READ");
    expect(nextMessageStatus("READ", "SENT")).toBe("READ");
    expect(nextMessageStatus("READ", "FAILED")).toBe("READ");
    expect(nextMessageStatus("DELIVERED", "SENT")).toBe("DELIVERED");
  });
  it("[WA-P1] FAILED solo antes de entregado; los terminales no cambian", () => {
    expect(nextMessageStatus("SENT", "FAILED")).toBe("FAILED");
    expect(nextMessageStatus("DELIVERED", "FAILED")).toBe("DELIVERED");
    expect(nextMessageStatus("FAILED", "DELIVERED")).toBe("FAILED");
    expect(nextMessageStatus("CANCELLED", "SENT")).toBe("CANCELLED");
    expect(nextMessageStatus("QUEUED", "CANCELLED")).toBe("CANCELLED");
    expect(nextMessageStatus("SENT", "CANCELLED")).toBe("SENT");
  });
});

describe("[WA-P1] classifyGraphError", () => {
  it("[WA-P1] códigos de Meta → clase y errorCode con el formato del CHECK", () => {
    const cases: Array<[Parameters<typeof classifyGraphError>[0], string, string]> = [
      [{ code: 131026 }, "recipient", "recipient:131026"],
      [{ code: 131042 }, "payment", "payment:131042"],
      [{ code: 130429 }, "retry", "retry:130429"],
      [{ code: 190 }, "auth", "auth:190"],
      [{ code: 132001 }, "template", "template:132001"],
      [{ code: 132015 }, "template", "template:132015"],
      [{ code: 131031 }, "account", "account:131031"],
      [{ timeout: true }, "retry", "timeout"],
      [{ network: true }, "retry", "network"],
      [{ httpStatus: 503 }, "retry", "http:503"],
    ];
    for (const [input, cls, code] of cases) {
      const r = classifyGraphError(input);
      expect([input, r.errorClass, r.errorCode]).toEqual([input, cls, code]);
      expect(r.errorCode).toMatch(/^[a-z_]{1,40}(:[0-9]{1,7})?$/);
    }
  });
});

describe("[WA-P1] retryDelayMs", () => {
  it("[WA-P1] 1′, 5′, 30′, 2 h y corta", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([M, 5 * M, 30 * M, 2 * H]);
    expect(retryDelayMs(5)).toBeNull();
    expect(retryDelayMs(12)).toBeNull();
  });
});

describe("[WA-P1] parseInboundText", () => {
  it("[WA-P1] BAJA / «Baja.» / STOP → OPT_OUT; ALTA → OPT_IN; resto TEXT", () => {
    for (const s of ["BAJA", "Baja.", " baja ", "STOP", "stop!", "Bája"]) expect(parseInboundText(s)).toBe("OPT_OUT");
    for (const s of ["ALTA", "alta.", "Alta"]) expect(parseInboundText(s)).toBe("OPT_IN");
    for (const s of ["Hola, quiero cambiar el turno", "", "bajar", "no me des de baja ni de alta"])
      expect(parseInboundText(s)).toBe("TEXT");
  });
});

describe("[WA-P1] buttonPayload", () => {
  it("[WA-P1] formato wa1.c|x.<messageId> y vuelta", () => {
    expect(buttonPayload("confirm", "cm1abc")).toBe("wa1.c.cm1abc");
    expect(buttonPayload("cancel", "cm1abc")).toBe("wa1.x.cm1abc");
    expect(parseButtonPayload("wa1.c.cm1abc")).toEqual({ kind: "confirm", messageId: "cm1abc" });
    expect(parseButtonPayload("wa1.x.cm1abc")).toEqual({ kind: "cancel", messageId: "cm1abc" });
    for (const bad of ["wa2.c.x", "wa1.z.x", "wa1.c.", "Confirmo", "wa1.c.a b", null, undefined])
      expect(parseButtonPayload(bad)).toBeNull();
  });
});

describe("[WA-P1] tomorrowWindowAR", () => {
  it("[WA-P1] mañana AR = [00:00, 24:00) -03:00, con el host en cualquier TZ", () => {
    expect(tomorrowWindowAR(NOW)).toEqual({
      dateKey: "2026-10-23",
      from: new Date("2026-10-23T03:00:00.000Z"),
      to: new Date("2026-10-24T03:00:00.000Z"),
    });
  });
  it("[WA-P1] 22:30 AR (01:30 UTC del día siguiente) sigue siendo «hoy» en AR", () => {
    const late = new Date("2026-10-23T01:30:00.000Z");
    expect(tomorrowWindowAR(late).dateKey).toBe("2026-10-23");
  });
  it("[WA-P1] cruza fin de mes y de año", () => {
    expect(tomorrowWindowAR(new Date("2026-12-31T15:00:00.000Z")).dateKey).toBe("2027-01-01");
    expect(tomorrowWindowAR(new Date("2026-10-31T15:00:00.000Z")).dateKey).toBe("2026-11-01");
  });
});
