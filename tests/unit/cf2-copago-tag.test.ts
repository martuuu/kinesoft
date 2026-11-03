/**
 * [CF2-AD] Cobro visible en la agenda y /sala (plan §29 D-CF2-3; brief CF2 A.2): `copagoTag` (`lib/copago-tag.ts`,
 * puro), `withCopagoPaid` (`lib/booking-collect.ts`) y lo que suma `lib/reception-desk-state.ts` (`DeskKpis.llamados`,
 * `open=<id>` en «Ver turno en la agenda», D-CF2-4). Símbolos reales, nada que mockear.
 *
 * TZ irrelevante: `copagoTag` no mira el reloj ni la hora del turno (solo si `arrivedAt` existe), así que el mismo
 * caso da lo mismo con `TZ=UTC` y con `TZ=America/Argentina/Buenos_Aires`; [CF2-AD9] lo fija con un turno de las
 * 23:30 AR (otro día en UTC).
 */
import { describe, expect, it, vi } from "vitest";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
// `desk-pay-modal` importa la server action del cobro: se mockea la red (la action), no la función bajo test.
vi.mock("@/lib/bookings", () => ({ setBookingCopagoPaid: vi.fn() }));
import { applyCopagoPaid } from "@/components/sala/desk/desk-pay-modal";
import { copagoCollectViewFor, withCopagoPaid } from "@/lib/booking-collect";
import { copagoTag } from "@/lib/copago-tag";
import { formatARS } from "@/lib/format";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/payment-method";
import {
  cashEntries,
  deskEntries,
  deskKpis,
  deskMenuItems,
  deskOwedCents,
  deskViewer,
  matchesDeskFilter,
  owesCopago,
} from "@/lib/reception-desk-state";
import { copagoOwedCents, porCobrarLabel } from "@/lib/copago-owed";
import { receptionOwedSummary } from "@/components/agenda/reception/reception-collect";

const DAY = "2026-10-15";
const at = (h: string, day = DAY) => new Date(`${day}T${h}:00-03:00`).toISOString();
const NOW = new Date("2026-10-15T13:42:00Z"); // 10:42 AR

function dto(id: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: at("09:00"),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "p1",
    patientId: `pat-${id}`,
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 600_000,
    updatedAt: at("08:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    arrivedAt: null,
    attendingAt: null,
    calledAt: null,
    canOperate: true,
    paymentStatus: "UNPAID",
    ...over,
  };
}

const OWED_ARIA = (cents: number) => `Por cobrar: ${formatARS(cents)}`;

describe("[CF2-AD] copagoTag", () => {
  it("[CF2-AD1] paid: PAID a mano → «Pagado · <medio>» para cada medio; sin medio → «Pagado · Sin informar»", () => {
    for (const m of PAYMENT_METHODS) {
      const t = copagoTag(dto("x", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: m }));
      expect(t).toEqual(["paid", `Pagado · ${PAYMENT_METHOD_LABEL[m]}`, `Pagado · ${PAYMENT_METHOD_LABEL[m]}`]);
    }
    expect(copagoTag(dto("x", { paymentStatus: "PAID", copagoPaymentMethod: null }))?.[1]).toBe("Pagado · Sin informar");
    // Pagado aunque el turno no haya ocurrido todavía (cobro por adelantado) o esté cancelado (cobro previo de un plan).
    expect(copagoTag(dto("x", { status: "CANCELLED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" }))?.[0]).toBe("paid");
  });

  it("[CF2-AD2] pagado entero online (`paidOnline`) → null: lo dice «Pagado MP» del badge online (precedencia)", () => {
    expect(copagoTag(dto("x", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }))).toBeNull();
  });

  it("[CF2-AD3] owed: «Por cobrar» si llegó o fue atendido y falta plata (copago − seña); el aria lleva el monto", () => {
    expect(copagoTag(dto("x", { status: "COMPLETED" }))).toEqual(["owed", "Por cobrar", OWED_ARIA(600_000)]);
    expect(copagoTag(dto("x", { arrivedAt: at("08:55") }))).toEqual(["owed", "Por cobrar", OWED_ARIA(600_000)]);
    // Con seña: lo que FALTA (regla `deskOwedCents`).
    expect(copagoTag(dto("x", { status: "COMPLETED", onlineDepositCents: 200_000 }))).toEqual(["owed", "Por cobrar", OWED_ARIA(400_000)]);
  });

  it("[CF2-AD4] owed no aparece: por llegar, cancelado, ausente, sin copago, seña que cubre todo, sin paymentStatus", () => {
    expect(copagoTag(dto("x"))).toBeNull(); // no llegó
    expect(copagoTag(dto("x", { status: "CANCELLED", arrivedAt: at("08:55") }))).toBeNull();
    expect(copagoTag(dto("x", { status: "NO_SHOW" }))).toBeNull();
    expect(copagoTag(dto("x", { status: "COMPLETED", copagoCents: 0 }))).toBeNull();
    expect(copagoTag(dto("x", { status: "COMPLETED", onlineDepositCents: 600_000 }))).toBeNull();
    // Proyección sin el cobro: no se adivina (como `copagoCollectViewFor`).
    expect(copagoTag(dto("x", { status: "COMPLETED", paymentStatus: undefined }))).toBeNull();
    // Reintegrado: no se debe ni está pagado.
    expect(copagoTag(dto("x", { status: "COMPLETED", paymentStatus: "REFUNDED", copagoPaymentMethod: "MERCADO_PAGO" }))).toBeNull();
  });

  it("[CF2-AD5] held: AUTHORIZED → retenido por Mercado Pago (no se cobra a mano)", () => {
    expect(copagoTag(dto("x", { status: "COMPLETED", paymentStatus: "AUTHORIZED" }))).toEqual(["held", "Retenido", "Pago retenido por Mercado Pago"]);
  });

  it("[CF2-AD6] paridad con `copagoCollectViewFor`: el nombre accesible de paid/held = el rótulo del drawer y Facturación", () => {
    const cases: Partial<BookingDTO>[] = [
      ...PAYMENT_METHODS.map((m) => ({ paymentStatus: "PAID" as const, copagoPaymentMethod: m })),
      { paymentStatus: "PAID", copagoPaymentMethod: null },
      // Webhook legado: reserva pública PAID sin medio.
      { paymentStatus: "PAID", copagoPaymentMethod: null, publicReservation: true },
      { paymentStatus: "AUTHORIZED" },
    ];
    for (const over of cases) {
      const b = dto("x", { status: "COMPLETED", ...over });
      // Un cobro a mano siempre lleva quién cobró (M12); `paidOnline` false ⇔ no fue el webhook de T5.
      const view = copagoCollectViewFor({ ...b, copagoCollectedById: "u1" }, true);
      expect(copagoTag(b)?.[2], JSON.stringify(over)).toBe(view.label);
    }
    // «Por cobrar» = el rótulo de la vista cuando hay algo que cobrar.
    const owed = dto("x", { status: "COMPLETED" });
    expect(copagoTag(owed)?.[1]).toBe(copagoCollectViewFor(owed, true).label);
  });

  // [CF2-ZF1-1] (ZB-1): «Por cobrar» tenía tres criterios (el tag: llegó o atendido; el contador y el drawer de /sala:
  // solo atendidos). Ahora es UNO (`copagoOwedCents`, `lib/copago-owed.ts`): las filas que llegaron y no terminaron
  // («i», «j», «k») tienen que dar lo mismo en el tag, en `owesCopago`, en el filtro y en `cashEntries`.
  it("[CF2-AD7] [CF2-ZF1-1] paridad con /sala: owed ⇔ `owesCopago` ⇔ `cashEntries` ⇔ filtro, también para quien llegó y no terminó", () => {
    const VIEWER = deskViewer(null, ["agenda.reception", "agenda.operateAll", "billing.collect"]);
    const rows = [
      dto("a", { status: "COMPLETED" }),
      dto("b", { status: "COMPLETED", onlineDepositCents: 250_000 }),
      dto("c", { status: "COMPLETED", onlineDepositCents: 600_000 }),
      dto("d", { status: "COMPLETED", copagoCents: 0 }),
      dto("e", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" }),
      dto("f", { status: "COMPLETED", paymentStatus: "AUTHORIZED" }),
      dto("g", { status: "COMPLETED", paymentStatus: "FAILED" }),
      dto("h", { status: "COMPLETED", onlineDepositCents: -5 }),
      // Llegó y no terminó (en sala, llamado, en atención): el tag dice «Por cobrar» y ahora el contador también.
      dto("i", { arrivedAt: at("08:55") }),
      dto("j", { arrivedAt: at("08:55"), calledAt: at("09:01"), onlineDepositCents: 100_000 }),
      dto("k", { arrivedAt: at("08:55"), attendingAt: at("09:02") }),
      // Llegó pero ya pagó, o se canceló/ausente después de llegar: no debe.
      dto("l", { arrivedAt: at("08:55"), paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER" }),
      dto("m", { arrivedAt: at("08:55"), status: "CANCELLED" }),
      dto("n", { arrivedAt: at("08:55"), status: "NO_SHOW" }),
      // No llegó: no debe todavía.
      dto("o", { scheduledFor: at("11:30") }),
    ];
    const es = deskEntries(rows, NOW, VIEWER);
    for (const e of es) {
      const t = copagoTag(e.row);
      expect(t?.[0] === "owed", e.row.id).toBe(owesCopago(e));
      expect(matchesDeskFilter(e, "por-cobrar"), e.row.id).toBe(owesCopago(e));
      if (t?.[0] === "owed") expect(t[2]).toBe(OWED_ARIA(deskOwedCents(e.row)));
      if (t?.[0] === "owed") expect(copagoOwedCents(e.row)).toBe(deskOwedCents(e.row));
      else expect(copagoOwedCents(e.row), e.row.id).toBe(0);
    }
    const owedIds = es.filter((e) => copagoTag(e.row)?.[0] === "owed").map((e) => e.row.id).sort();
    expect(owedIds).toEqual(["a", "b", "g", "h", "i", "j", "k"]);
    const cash = cashEntries(es, VIEWER);
    expect(cash.entries.map((e) => e.row.id).sort()).toEqual(owedIds);
    expect(cash.totalCents).toBe(es.reduce((s, e) => s + copagoOwedCents(e.row), 0));
  });

  it("[CF2-ZF1-1b] Recepción de la agenda = /sala: el chip (`receptionOwedSummary`) cuenta y suma lo mismo que `cashEntries`", () => {
    const rows = [
      dto("a", { status: "COMPLETED" }),
      dto("b", { status: "COMPLETED", practitionerId: "p2", onlineDepositCents: 250_000 }),
      dto("c", { arrivedAt: at("08:55") }),
      dto("d", { arrivedAt: at("08:55"), practitionerId: "p2", attendingAt: at("09:00") }),
      dto("e", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" }),
      dto("f", { scheduledFor: at("11:30") }),
      dto("g", { status: "NO_SHOW" }),
    ];
    const pairs: [Parameters<typeof deskViewer>, { all: boolean; practitionerId: string | null }][] = [
      [[null, ["agenda.reception", "agenda.operateAll", "billing.collect"]], { all: true, practitionerId: null }],
      [["p1", ["agenda.reception", "billing.collectOwn"]], { all: false, practitionerId: "p1" }],
    ];
    for (const [desk, rc] of pairs) {
      const viewer = deskViewer(...desk);
      const cash = cashEntries(deskEntries(rows, NOW, viewer), viewer);
      expect(receptionOwedSummary(rc, rows), JSON.stringify(rc)).toEqual({ count: cash.entries.length, cents: cash.totalCents });
    }
    expect(receptionOwedSummary({ all: true, practitionerId: null }, rows)).toEqual({ count: 4, cents: 600_000 + 350_000 + 600_000 + 600_000 });
  });

  it("[CF2-ZF1-1c] rótulo único «Por cobrar · N · $X» (también en 0); la paridad con /sala la fija [CF2-ZF1-4]", () => {
    expect(porCobrarLabel(3, 1_500_000)).toBe(`Por cobrar · 3 · ${formatARS(1_500_000)}`);
    expect(porCobrarLabel(0, 0)).toBe("Por cobrar · 0");
  });

  it("[CF2-AD8] no muta el turno y es estable (misma entrada → misma tupla)", () => {
    const b = dto("x", { status: "COMPLETED" });
    const before = JSON.stringify(b);
    expect(copagoTag(b)).toEqual(copagoTag(b));
    expect(JSON.stringify(b)).toBe(before);
  });

  it("[CF2-AD9] TZ irrelevante: un turno de las 23:30 AR (otro día en UTC) da lo mismo", () => {
    const late = dto("late", { scheduledFor: at("23:30"), arrivedAt: at("23:25") });
    expect(late.scheduledFor.slice(0, 10)).toBe("2026-10-16");
    expect(copagoTag(late)).toEqual(["owed", "Por cobrar", OWED_ARIA(600_000)]);
  });
});

describe("[CF2-AD] withCopagoPaid", () => {
  it("[CF2-AD10] con medio → PAID + medio + updatedAt nuevo (ISO); no muta la entrada", () => {
    const b = dto("x", { status: "COMPLETED" });
    const next = withCopagoPaid(b, { updatedAt: "2026-10-15T13:45:00.000Z", method: "TRANSFER" });
    expect(next).toEqual({ ...b, paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER", updatedAt: "2026-10-15T13:45:00.000Z" });
    expect(b.paymentStatus).toBe("UNPAID");
    expect(withCopagoPaid(b, { updatedAt: new Date("2026-10-15T13:45:00Z"), method: "CASH" }).updatedAt).toBe("2026-10-15T13:45:00.000Z");
    // Después del cobro, la agenda muestra «Pagado · Transferencia» sin esperar al realtime.
    expect(copagoTag(next)?.[1]).toBe("Pagado · Transferencia");
  });

  it("[CF2-AD11] sin medio (deshacer, `method: null`) → UNPAID y sin medio, como escribe `toggleBilling`", () => {
    const b = dto("x", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" });
    const next = withCopagoPaid(b, { updatedAt: "2026-10-15T13:50:00.000Z", method: null });
    expect(next).toMatchObject({ paymentStatus: "UNPAID", copagoPaymentMethod: null, updatedAt: "2026-10-15T13:50:00.000Z" });
    expect(copagoTag(next)?.[0]).toBe("owed");
  });

  it("[CF2-AD12] paridad con `applyCopagoPaid` de /sala al cobrar", () => {
    const b = dto("x", { status: "COMPLETED" });
    for (const m of PAYMENT_METHODS) {
      expect(withCopagoPaid(b, { updatedAt: "2026-10-15T13:45:00.000Z", method: m })).toEqual(applyCopagoPaid(b, "2026-10-15T13:45:00.000Z", m));
    }
  });
});

describe("[CF2-AD] reception-desk-state", () => {
  const VIEWER = deskViewer(null, ["agenda.reception", "agenda.operateAll"]);

  it("[CF2-AD13] DeskKpis.llamados: los llamados (siguen contando dentro de «En sala»); cancelados fuera", () => {
    const rows = [
      dto("enSala", { scheduledFor: at("10:30"), arrivedAt: at("10:25") }),
      dto("llamado1", { scheduledFor: at("10:15"), arrivedAt: at("10:05"), calledAt: at("10:40") }),
      dto("llamado2", { scheduledFor: at("10:20"), arrivedAt: at("10:10"), calledAt: at("10:41") }),
      dto("canc", { status: "CANCELLED", scheduledFor: at("10:20"), arrivedAt: at("10:10"), calledAt: at("10:41") }),
    ];
    const k = deskKpis(deskEntries(rows, NOW, VIEWER));
    expect(k.llamados).toBe(2);
    expect(k.enSala).toBe(3);
    expect(k.total).toBe(3);
    expect(deskKpis([]).llamados).toBe(0);
  });

  it("[CF2-AD14] «Ver turno en la agenda» abre ESE turno: `open=<id>` además del día y el profesional (D-CF2-4)", () => {
    const [e] = deskEntries([dto("b-42", { scheduledFor: at("10:50") })], NOW, VIEWER);
    const link = deskMenuItems(e, VIEWER, DAY).find((i) => i.kind === "agenda");
    expect(link).toEqual({ kind: "agenda", href: "/agenda?date=2026-10-15&view=timeline&pros=p1&open=b-42", label: "Ver turno en la agenda" });
    const q = new URL(`https://x${(link as { href: string }).href}`).searchParams;
    expect(q.get("open")).toBe("b-42");
    expect(q.get("view")).toBe("timeline");
  });
});
