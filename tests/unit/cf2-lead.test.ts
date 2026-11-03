/**
 * [CF2-TK] CF2 (§29, D-CF2-8 y D-CF2-10; M21) — lado puro de la anticipación por profesional y del contacto dentro de
 * la anticipación.
 *
 *   • D-CF2-8: anticipación del turnero = PractitionerService > PROFESIONAL > consultorio > 60', con 0 como valor en cada
 *     nivel. `effectivePublicMinLead` suma el profesional como tercer argumento opcional: las llamadas de dos argumentos
 *     (`[CF-K2]`) dan lo mismo que antes.
 *   • `resolvePublicOffer` (y con ella la ventana, la lista, «cualquier profesional» y el submit) lee la del profesional
 *     de `input.practitionerMinLead` cuando el PS no tiene la suya.
 *   • D-CF2-10: `publicLeadWindowHasFree` = ¿hay algún horario LIBRE (mismo motor: cupo, otro servicio, tope por
 *     intervalo, bloqueos, sede) entre ahora + 30' y ahora + min(anticipación, 48 h)? Solo booleano.
 *   • `buildLeadContact`: links wa.me / tel: y un texto que nunca lleva horarios.
 *
 * Corre igual en TZ=UTC y AR (los días salen de `lib/datetime-ar.ts`); el borde de las 23:30 AR es el caso que en UTC
 * ya es «mañana».
 */
import { describe, expect, it } from "vitest";
import { localToARIso } from "@/lib/datetime-ar";
import { effectivePublicMinLead } from "@/lib/availability/agenda-rules";
import {
  LEAD_CONTACT_MIN_AHEAD_MINUTES,
  LEAD_CONTACT_SCAN_MAX_MINUTES,
  publicDaySlots,
  publicLeadWindowHasFree,
  publicSlotWindow,
  resolvePublicOffer,
} from "@/lib/public-booking-slots";
import {
  LEAD_CONTACT_CONSENT_COPY,
  LEAD_CONTACT_CONSENT_VERSION,
  buildLeadContact,
  leadContactMessage,
} from "@/lib/public-lead-contact";
import type { PublicSlotWindow } from "@/lib/public-booking-types";
import type {
  AvailabilityBooking,
  AvailabilityInput,
  PractitionerAgendaRules,
  PractitionerServiceRule,
  ScheduleTemplateRange,
} from "@/lib/availability";

const P1 = "prac-1";
const P2 = "prac-2";
const S = "svc-kine";
const OTHER = "svc-eval";
const LOC = "loc-a";
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";

const tpl = (dow: number): ScheduleTemplateRange => ({
  dow: dow as ScheduleTemplateRange["dow"],
  startMin: 9 * 60,
  endMin: 12 * 60,
  locationId: LOC,
  validFrom: null,
  validUntil: null,
});

const rules = (patch: Partial<PractitionerAgendaRules> = {}): PractitionerAgendaRules => ({
  exclusiveService: false,
  agendaStepMin: 15,
  publicStepMin: null,
  ...patch,
});

function psRule(patch: Partial<PractitionerServiceRule> = {}): PractitionerServiceRule {
  return {
    practitionerId: P1,
    serviceId: S,
    enabled: true,
    visibility: "PUBLIC",
    durationMin: null,
    minLeadMinutes: null,
    maxLeadDays: null,
    concurrencyOverride: false,
    maxConcurrent: null,
    ...patch,
  };
}

/** P1 y P2 atienden 09:00-12:00 en `dows` (default todos); dos servicios de 60' del consultorio → slots 09, 10, 11. */
function input(patch: Partial<AvailabilityInput> = {}, dows: number[] = [0, 1, 2, 3, 4, 5, 6]): AvailabilityInput {
  return {
    tenantId: "t1",
    from: MON,
    to: "2026-12-31",
    primaryLocationId: LOC,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [P1, P2].map((practitionerId) => ({ practitionerId, isFallback: false, ranges: dows.map(tpl) })),
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [
      { id: S, durationMin: 60, maxConcurrent: null, practitionerId: null },
      { id: OTHER, durationMin: 60, maxConcurrent: null, practitionerId: null },
    ],
    practitionerPayers: [],
    ...patch,
  };
}

let seq = 0;
function booked(serviceId: string, day: string, hhmm: string): AvailabilityBooking {
  return {
    id: `b-${seq++}`,
    practitionerId: P1,
    serviceId,
    locationId: LOC,
    scheduledFor: at(day, hhmm),
    durationMin: 60,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    patientId: `pat-${seq}`,
    idempotencyKey: `k-${seq}`,
  };
}

/** Lunes 07:00 AR, anticipación del profesional 24 h: ventana [07:30, mar 07:00) → los libres de 09/10/11 del lunes. */
const NOW = at(MON, "07:00");
const lead = (minutes: number | null, patch: Partial<AvailabilityInput> = {}, dows?: number[]) =>
  input({ practitionerMinLead: { [P1]: minutes }, ...patch }, dows);
const hasFree = (i: AvailabilityInput, now: Date = NOW, locationId?: string | null) =>
  publicLeadWindowHasFree(i, { practitionerId: P1, serviceId: S, locationId, now });

describe("[CF2-TK1] effectivePublicMinLead: PS > profesional > consultorio > 60 (0 es un valor en cada nivel)", () => {
  it("[CF2-TK1] el profesional entra entre el PS y el consultorio", () => {
    expect(effectivePublicMinLead(null, null, null)).toBe(60);
    expect(effectivePublicMinLead(undefined, undefined, undefined)).toBe(60);
    expect(effectivePublicMinLead(null, null, 240)).toBe(240);
    expect(effectivePublicMinLead(null, 1440, 240)).toBe(240);
    expect(effectivePublicMinLead(120, 1440, 240)).toBe(120);
    expect(effectivePublicMinLead(null, 1440, null)).toBe(1440);
  });

  it("[CF2-TK1] 0 en cada nivel es «sin anticipación», no «vacío»", () => {
    expect(effectivePublicMinLead(0, 1440, 240)).toBe(0);
    expect(effectivePublicMinLead(null, 1440, 0)).toBe(0);
    expect(effectivePublicMinLead(null, 0, 240)).toBe(240);
    expect(effectivePublicMinLead(null, 0, null)).toBe(0);
    expect(effectivePublicMinLead(240, 0, 0)).toBe(240);
  });

  it("[CF2-TK1] un valor inválido del profesional hereda (no rompe la grilla)", () => {
    expect(effectivePublicMinLead(null, 1440, -5)).toBe(1440);
    expect(effectivePublicMinLead(null, null, 1.5)).toBe(60);
    expect(effectivePublicMinLead(null, null, Number.NaN)).toBe(60);
  });

  it("[CF2-TK1] dos argumentos = la precedencia de CF de siempre", () => {
    expect(effectivePublicMinLead(null, 1440)).toBe(1440);
    expect(effectivePublicMinLead(0, 1440)).toBe(0);
    expect(effectivePublicMinLead(null, null)).toBe(60);
  });
});

describe("[CF2-TK2] la oferta y la ventana usan la anticipación del profesional", () => {
  it("[CF2-TK2] resolvePublicOffer: PS null → la del profesional; PS con la suya → la del PS; ausente → consultorio", () => {
    const i = input({ practitionerMinLead: { [P1]: 2880, [P2]: null }, publicMinLeadMinutes: 120 });
    expect(resolvePublicOffer(i, P1, S)?.minLeadMinutes).toBe(2880);
    expect(resolvePublicOffer(i, P2, S)?.minLeadMinutes).toBe(120);
    const withPs = { ...i, practitionerServices: [psRule({ minLeadMinutes: 30 })] };
    expect(resolvePublicOffer(withPs, P1, S)?.minLeadMinutes).toBe(30);
    const psZero = { ...i, practitionerServices: [psRule({ minLeadMinutes: 0 })] };
    expect(resolvePublicOffer(psZero, P1, S)?.minLeadMinutes).toBe(0);
    // Sin mapa (inputs puros de antes de CF2): la de antes.
    expect(resolvePublicOffer(input({ publicMinLeadMinutes: 120 }), P1, S)?.minLeadMinutes).toBe(120);
  });

  it("[CF2-TK2] ventana: con 48 h del profesional el primer hábil es el miércoles; el otro profesional, hoy", () => {
    const i = input({ practitionerMinLead: { [P1]: 2880 } });
    const w1 = publicSlotWindow(i, { practitionerId: P1, serviceId: S, fromDay: MON, lastDay: "2026-11-30", now: NOW });
    expect(w1.minLeadMinutes).toBe(2880);
    expect(w1.days[0]?.date).toBe(WED);
    const w2 = publicSlotWindow(i, { practitionerId: P2, serviceId: S, fromDay: MON, lastDay: "2026-11-30", now: NOW });
    expect(w2.minLeadMinutes).toBe(60);
    expect(w2.days[0]?.date).toBe(MON);
    // Lo que no se ofrece tampoco se acepta: el martes 09:00 de P1 sale «no disponible» en la grilla del submit.
    const tue = publicDaySlots(i, { practitionerId: P1, serviceId: S, dayKey: TUE, now: NOW });
    expect(tue.length).toBeGreaterThan(0);
    expect(tue.every((s) => !s.available)).toBe(true);
  });
});

describe("[CF2-TK3] publicLeadWindowHasFree: libre entre ahora + 30' y ahora + min(anticipación, 48 h)", () => {
  it("[CF2-TK3] constantes del contrato", () => {
    expect(LEAD_CONTACT_SCAN_MAX_MINUTES).toBe(2880);
    expect(LEAD_CONTACT_MIN_AHEAD_MINUTES).toBe(30);
  });

  it("[CF2-TK3] hay libres dentro de la anticipación → true", () => {
    expect(hasFree(lead(1440))).toBe(true);
  });

  it("[CF2-TK3] anticipación 0 o ≤ 30' → false (el turnero ya ofrece todo lo que el piso dejaría)", () => {
    expect(hasFree(lead(0))).toBe(false);
    expect(hasFree(lead(30), at(MON, "08:30"))).toBe(false);
    expect(hasFree(lead(31), at(MON, "08:30"))).toBe(true); // [09:00, 09:01): el 09:00 entra (piso inclusive)
  });

  it("[CF2-TK3] el PS en 0 manda sobre el profesional: sin anticipación efectiva no hay contacto", () => {
    expect(hasFree(lead(1440, { practitionerServices: [psRule({ minLeadMinutes: 0 })] }))).toBe(false);
  });

  it("[CF2-TK3] piso 30': un libre a menos de 30' no cuenta", () => {
    // 08:40 + 60' → [09:10, 09:40): el 09:00 está a 20' (debajo del piso) y el 10:00 ya se reserva online.
    expect(hasFree(lead(60), at(MON, "08:40"))).toBe(false);
    // 08:31 + 120' → [09:01, 10:31): el 10:00 cuenta.
    expect(hasFree(lead(120), at(MON, "08:31"))).toBe(true);
  });

  it("[CF2-TK3] tope 48 h: un libre dentro de la anticipación pero más allá de 48 h no cuenta", () => {
    const now = at(MON, "13:00"); // + 48 h = miércoles 13:00
    expect(hasFree(lead(4320, {}, [4]), now)).toBe(false); // jueves 09:00 = 68 h
    expect(hasFree(lead(4320, {}, [3]), now)).toBe(true); // miércoles 09:00 = 44 h
  });

  it("[CF2-TK3] cupo lleno → false; con un lugar → true", () => {
    const capped = { services: [{ id: S, durationMin: 60, maxConcurrent: 1, practitionerId: null }] };
    const full = [booked(S, MON, "09:00"), booked(S, MON, "10:00"), booked(S, MON, "11:00")];
    expect(hasFree(lead(1440, { ...capped, bookings: full }))).toBe(false);
    expect(hasFree(lead(1440, { ...capped, bookings: full.slice(0, 2) }))).toBe(true);
  });

  it("[CF2-TK3] otro servicio: con servicio exclusivo los turnos de otro servicio ocupan; sin exclusividad, no", () => {
    const other = [booked(OTHER, MON, "09:00"), booked(OTHER, MON, "10:00"), booked(OTHER, MON, "11:00")];
    expect(hasFree(lead(1440, { bookings: other, agendaRules: { [P1]: rules({ exclusiveService: true }) } }))).toBe(false);
    expect(hasFree(lead(1440, { bookings: other, agendaRules: { [P1]: rules({ exclusiveService: false }) } }))).toBe(true);
  });

  it("[CF2-TK3] tope por intervalo (cruza servicios) → false", () => {
    const other = [booked(OTHER, MON, "09:00"), booked(OTHER, MON, "10:00"), booked(OTHER, MON, "11:00")];
    expect(hasFree(lead(1440, { bookings: other, intervalCaps: { [P1]: { count: 1, intervalMin: 60 } } }))).toBe(false);
    expect(hasFree(lead(1440, { bookings: other, intervalCaps: { [P1]: { count: 2, intervalMin: 60 } } }))).toBe(true);
  });

  it("[CF2-TK3] bloqueo del profesional sobre la mañana → false", () => {
    const blocks = [
      {
        id: "blk",
        practitionerId: P1,
        locationId: null,
        startsAt: at(MON, "08:00"),
        endsAt: at(MON, "12:00"),
        allDay: false,
        reason: null,
        groupId: null,
      },
    ];
    expect(hasFree(lead(1440, { blocks }))).toBe(false);
  });

  it("[CF2-TK3] sede: otra sede → false; la de la franja → true", () => {
    expect(hasFree(lead(1440), NOW, "loc-b")).toBe(false);
    expect(hasFree(lead(1440), NOW, LOC)).toBe(true);
  });

  it("[CF2-TK3] servicio no ofrecido o profesional sin franjas → false", () => {
    const i = lead(1440);
    expect(publicLeadWindowHasFree(i, { practitionerId: P1, serviceId: "svc-x", now: NOW })).toBe(false);
    expect(publicLeadWindowHasFree(i, { practitionerId: "prac-x", serviceId: S, now: NOW })).toBe(false);
    const hidden = { ...i, practitionerServices: [psRule({ visibility: "PRIVATE" })] };
    expect(hasFree(hidden)).toBe(false);
  });

  it("[CF2-TK3] borde 23:30 AR (en UTC ya es el día siguiente): mira el día AR de mañana, fin abierto", () => {
    const late = at(MON, "23:30");
    expect(hasFree(lead(600), late)).toBe(true); // [mar 00:00, mar 09:30): el 09:00 del martes
    expect(hasFree(lead(570), late)).toBe(false); // [mar 00:00, mar 09:00): el 09:00 ya se reserva online
    // Coherencia con el turnero: con 600' el martes 09:00 NO se ofrece online (por eso el contacto).
    const tue = publicDaySlots(lead(600), { practitionerId: P1, serviceId: S, dayKey: TUE, now: late });
    expect(tue.find((s) => s.time === "09:00")?.available).toBe(false);
    expect(tue.find((s) => s.time === "10:00")?.available).toBe(true);
  });

  it("[CF2-TK3] solo booleano: no expone horarios", () => {
    expect(typeof hasFree(lead(1440))).toBe("boolean");
  });

  it("[CF2-TK3] sin el mapa del profesional (o en null) = la del consultorio", () => {
    expect(hasFree(input({ publicMinLeadMinutes: 1440 }))).toBe(true);
    expect(hasFree(input({ publicMinLeadMinutes: 0, practitionerMinLead: { [P1]: null } }))).toBe(false);
    expect(hasFree(input({ publicMinLeadMinutes: 1440 }), at(THU, "12:30"))).toBe(true);
  });
});

describe("[CF2-TK4] buildLeadContact: wa.me, tel: y el texto sin horarios", () => {
  const contact = buildLeadContact({ name: "Ana Pérez", e164: "+5491155550000", tenantName: "Consultorio Sur & Co" });
  const textOf = (waUrl: string) => decodeURIComponent(waUrl.split("?text=")[1] ?? "");

  it("[CF2-TK4] links con destinatario y texto fijo", () => {
    expect(Object.keys(contact).sort()).toEqual(["name", "telUrl", "waUrl"]);
    expect(contact.name).toBe("Ana Pérez");
    expect(contact.waUrl.startsWith("https://wa.me/5491155550000?text=")).toBe(true);
    expect(contact.telUrl).toBe("tel:+5491155550000");
    expect(textOf(contact.waUrl)).toBe(
      "Hola Ana Pérez, te escribo desde el turnero online de Consultorio Sur & Co. ¿Tenés algún turno disponible antes?"
    );
    expect(leadContactMessage({ name: "Ana Pérez", tenantName: "Consultorio Sur & Co" })).toBe(textOf(contact.waUrl));
    // El `&` del consultorio no corta el parámetro.
    expect(contact.waUrl).not.toContain("& Co");
  });

  it("[CF2-TK4] el texto nunca lleva horarios ni fechas", () => {
    const text = textOf(contact.waUrl);
    expect(text).not.toMatch(/\d{1,2}[:.]\d{2}/);
    expect(text).not.toMatch(/\bhs\b|\d{1,2}\/\d{1,2}/);
  });

  it("[CF2-TK4] el número se sanea a dígitos: nada raro llega al href", () => {
    const c = buildLeadContact({ name: "Ana", e164: " +54 9 11 5555-0000 ", tenantName: "X" });
    expect(c.telUrl).toBe("tel:+5491155550000");
    expect(c.waUrl.startsWith("https://wa.me/5491155550000?text=")).toBe(true);
  });

  it("[CF2-TK4] versión de consentimiento dentro del CHECK de M21 (1..32) y copy con voseo", () => {
    expect(LEAD_CONTACT_CONSENT_VERSION.length).toBeGreaterThanOrEqual(1);
    expect(LEAD_CONTACT_CONSENT_VERSION.length).toBeLessThanOrEqual(32);
    expect(LEAD_CONTACT_CONSENT_COPY).toMatch(/turnero/);
    expect(LEAD_CONTACT_CONSENT_COPY).toMatch(/desactiv/i);
  });

  it("[CF2-TK4] encaja en PublicSlotWindow.leadContact (clave opcional)", () => {
    const w: PublicSlotWindow = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null, leadContact: contact };
    const without: PublicSlotWindow = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null };
    expect("leadContact" in without).toBe(false);
    expect(w.leadContact?.telUrl).toBe("tel:+5491155550000");
  });
});
