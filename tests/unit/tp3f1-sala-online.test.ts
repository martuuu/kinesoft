/**
 * [TP-3f] Sala (§25.8 «Predicados de plata y vistas» → mostrador; §25.10 «Sala»): `owesCopago` / `cashEntries` cobran
 * lo que FALTA (copago − seña pagada por Mercado Pago, `Booking.onlineDepositCents`), lo pagado online no se cobra y el
 * menú ⋯ de la fila ofrece «Enviar link de pago». Lógica pura de `lib/reception-desk-state.ts`; horas AR explícitas y
 * `now` fijo: corre igual con TZ=UTC y TZ=AR. Se testean los símbolos reales; no hay nada que mockear.
 */
import { describe, expect, it } from "vitest";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { copagoRemainingCents } from "@/lib/booking-collect";
import { formatARS } from "@/lib/format";
import {
  cashEntries,
  deskEntries,
  deskMenuItems,
  deskOwedCents,
  deskPrimary,
  deskViewer,
  matchesDeskFilter,
  owesCopago,
  type DeskEntry,
} from "@/lib/reception-desk-state";

const DAY = "2026-10-15";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date("2026-10-15T13:42:00Z"); // 10:42 AR

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: at(h),
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
    copagoCents: 0,
    updatedAt: at("08:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    isOverbooked: false,
    arrivedAt: null,
    attendingAt: null,
    calledAt: null,
    roomId: null,
    canOperate: true,
    paymentStatus: "UNPAID",
    ...over,
  };
}

const CAPS_SECRETARIA = ["agenda.reception", "agenda.operateAll", "billing.collect"];
/** La Secretaria con cobros online prendidos (la page pasa `onlineLinks` con `MP_CONNECT_MODE` ≠ off). */
const SECRETARIA = deskViewer(null, CAPS_SECRETARIA, true);
/** La misma Secretaria con cobros online apagados: «Enviar link de pago» no existe (lo que no funciona se quita). */
const SECRETARIA_OFF = deskViewer(null, CAPS_SECRETARIA);
const KINE_COBRA = deskViewer("p1", ["agenda.reception", "clinical.read", "billing.collectOwn"], true);
const NO_COBRA = deskViewer(null, ["agenda.reception", "agenda.operateAll"], true);

const done = (id: string, over: Partial<BookingDTO> = {}) =>
  dto(id, "09:00", { status: "COMPLETED", copagoCents: 2_000_000, ...over });
const entryOf = (es: DeskEntry[], id: string) => es.find((e) => e.row.id === id)!;

describe("[TP-3f] lo que falta = copago − seña pagada por Mercado Pago", () => {
  it("[TP-3f] deskOwedCents: resta la seña, piso 0 y una seña corrupta no suma (paridad con copagoRemainingCents)", () => {
    const cases: Array<[number, number | undefined]> = [
      [2_000_000, undefined],
      [2_000_000, 0],
      [2_000_000, 600_000],
      [2_000_000, 2_000_000],
      [600_000, 2_000_000], // el copago bajó después de la seña: no hay saldo a favor que cobrar acá
      [2_000_000, -500],
      [2_000_000, 1.5],
      [0, 600_000],
    ];
    for (const [copago, od] of cases) {
      const row = dto("x", "09:00", { copagoCents: copago, onlineDepositCents: od });
      const want = copagoRemainingCents({ resolvedCopagoCents: copago, onlineDepositCents: od ?? 0 });
      expect(deskOwedCents(row), `${copago}/${od}`).toBe(want);
    }
    expect(deskOwedCents(dto("x", "09:00", { copagoCents: 2_000_000, onlineDepositCents: 600_000 }))).toBe(1_400_000);
  });

  it("[TP-3f] owesCopago: con seña debe lo que falta; seña que cubre todo o pagado online → no debe", () => {
    const es = deskEntries(
      [
        done("seña", { onlineDepositCents: 600_000 }),
        done("cubre", { onlineDepositCents: 2_000_000 }),
        done("online", { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }),
        done("nada"),
      ],
      NOW,
      SECRETARIA
    );
    expect(owesCopago(entryOf(es, "seña"))).toBe(true);
    expect(owesCopago(entryOf(es, "cubre"))).toBe(false);
    expect(owesCopago(entryOf(es, "online"))).toBe(false);
    expect(owesCopago(entryOf(es, "nada"))).toBe(true);
    expect(matchesDeskFilter(entryOf(es, "cubre"), "por-cobrar")).toBe(false);
  });

  it("[TP-3f] cashEntries: el total de «Por cobrar» suma lo que falta (sin la seña) y omite lo pagado online", () => {
    const es = deskEntries(
      [
        done("seña", { onlineDepositCents: 600_000 }),
        done("online", { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }),
        done("nada", { copagoCents: 500_000 }),
      ],
      NOW,
      SECRETARIA
    );
    const cash = cashEntries(es, SECRETARIA);
    expect(cash.entries.map((e) => e.row.id).sort()).toEqual(["nada", "seña"]);
    expect(cash.totalCents).toBe(1_400_000 + 500_000);
    expect(cashEntries(es).totalCents).toBe(1_400_000 + 500_000);
  });

  it("[TP-3f] «Cobrar» primaria solo si falta algo; «Cobrar ahora» dice lo que falta", () => {
    const es = deskEntries([done("cubre", { onlineDepositCents: 2_000_000 }), done("seña", { onlineDepositCents: 600_000 })], NOW, SECRETARIA);
    expect(deskPrimary(entryOf(es, "cubre"), SECRETARIA)).toBeNull();
    expect(deskPrimary(entryOf(es, "seña"), SECRETARIA)).toEqual({ kind: "collect", label: "Cobrar" });

    const early = deskEntries(
      [
        dto("debe", "10:50", { copagoCents: 2_000_000, onlineDepositCents: 600_000 }),
        dto("cubre", "10:50", { copagoCents: 2_000_000, onlineDepositCents: 2_000_000 }),
      ],
      NOW,
      SECRETARIA
    );
    expect(deskMenuItems(entryOf(early, "debe"), SECRETARIA, DAY).find((i) => i.kind === "collect")).toEqual({
      kind: "collect",
      label: `Cobrar ahora (${formatARS(1_400_000)})`,
    });
    expect(deskMenuItems(entryOf(early, "cubre"), SECRETARIA, DAY).some((i) => i.kind === "collect")).toBe(false);
  });
});

describe("[TP-3f] «Enviar link de pago» en el menú ⋯ de la fila", () => {
  const rows = [
    done("atendido", { onlineDepositCents: 600_000 }),
    dto("porLlegar", "10:50", { copagoCents: 2_000_000 }),
    done("ajeno", { practitionerId: "p2" }),
    done("online", { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }),
    done("retenido", { paymentStatus: "AUTHORIZED" }),
    done("cubre", { onlineDepositCents: 2_000_000 }),
    done("gratis", { copagoCents: 0 }),
    dto("ausente", "09:30", { status: "NO_SHOW", copagoCents: 2_000_000 }),
    done("sinPaciente", { patientId: null }),
  ];
  const has = (viewer: ReturnType<typeof deskViewer>, id: string) =>
    deskMenuItems(entryOf(deskEntries(rows, NOW, viewer), id), viewer, DAY).some((i) => i.kind === "payment-link");

  it("[TP-3f] quien cobra la fila la ve si falta plata; va justo antes de «Ver turno en la agenda»", () => {
    expect(has(SECRETARIA, "atendido")).toBe(true);
    expect(has(SECRETARIA, "porLlegar")).toBe(true);
    expect(has(SECRETARIA, "ajeno")).toBe(true);
    const kinds = deskMenuItems(entryOf(deskEntries(rows, NOW, SECRETARIA), "porLlegar"), SECRETARIA, DAY).map((i) => i.kind);
    expect(kinds.slice(-2)).toEqual(["payment-link", "agenda"]);
  });

  it("[TP-3f] no aparece: pagado online, retenido, cubierto por la seña, sin copago, ausente, sin paciente", () => {
    for (const id of ["online", "retenido", "cubre", "gratis", "ausente", "sinPaciente"]) expect(has(SECRETARIA, id), id).toBe(false);
  });

  it("[TP-3f] mismo permiso que el server (`canCollectCopago`): el profesional solo en lo suyo; sin cobro, nunca", () => {
    expect(has(KINE_COBRA, "atendido")).toBe(true);
    expect(has(KINE_COBRA, "ajeno")).toBe(false);
    expect(has(NO_COBRA, "atendido")).toBe(false);
  });

  it("[TP-3f] con los cobros online apagados no se ofrece (deskViewer sin `onlineLinks`)", () => {
    expect(SECRETARIA_OFF.onlineLinks).toBe(false);
    expect(SECRETARIA.onlineLinks).toBe(true);
    expect(has(SECRETARIA_OFF, "atendido")).toBe(false);
  });
});
