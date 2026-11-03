/**
 * [CF2-RC] Cobro en el modo Recepción de la agenda (plan §29 D-CF2-3, brief CF2 A.2 «Recepción»): columna «Cobro» con
 * el tag del copago (`MoneyBadge` + `copagoTag`), botón «Cobrar» en los que llegaron o fueron atendidos y deben (solo
 * para quien puede cobrar esa fila: la Secretaria todas, el profesional las suyas, regla `canCollectCopago`), chip
 * «Por cobrar · N · $X» que filtra, y el guardado/stale del `CollectModal` (`receptionCollectHandlers`).
 *
 * Render estático del componente real (el repo no tiene DOM en vitest): los clics no se simulan, por eso lo que pasa
 * al guardar o con stale se prueba en `receptionCollectHandlers`, que es exactamente lo que la vista le pasa al modal.
 * Fechas con offset AR explícito: el resultado no depende de la TZ del host.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { ReceptionView } from "@/components/agenda/reception/reception-view";
import {
  receptionCanCollect,
  receptionCollectHandlers,
  receptionOwedSummary,
  receptionOwes,
} from "@/components/agenda/reception/reception-collect";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { canCollectCopago, type Capability } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T10:00:00-03:00`);
function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 500_000, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, calledAt: null, paymentStatus: "UNPAID", ...over };
}
const rows = [
  // Debe: atendido, sin cobro.
  dto("hecho", "08:30", { status: "COMPLETED" }),
  // Debe: llegó (en sala), con seña de $ 2.000 por Mercado Pago → faltan $ 3.000.
  dto("sala", "09:50", { arrivedAt: iso("09:45"), onlineDepositCents: 200_000 }),
  // Debe, pero es del otro profesional.
  dto("otro", "09:00", { status: "COMPLETED", practitionerId: "p2" }),
  // Ya pagado en efectivo.
  dto("pagado", "08:00", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" }),
  // Todavía no llegó: no se marca «Por cobrar» (todos los turnos del día lo dirían).
  dto("futuro", "10:30"),
  // Cancelado: nunca debe.
  dto("cancel", "11:00", { status: "CANCELLED" }),
];
const pr = [{ id: "p1", name: "Ana Pérez", initials: "AP" }, { id: "p2", name: "Bruno Sosa", initials: "BS" }];
const noop = () => {};
const SECRETARIA = { all: true, practitionerId: null };
const PRO_P1 = { all: false, practitionerId: "p1" };

function render(collect?: { all: boolean; practitionerId: string | null } | null, bookings = rows) {
  return renderToStaticMarkup(
    <ReceptionView dayKey={DAY} bookings={bookings} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} collect={collect} />
  );
}
/** El `<tr>` de la tabla de escritorio (la primera copia; la de secciones del celular repite las filas). */
function rowOf(html: string, id: string): string {
  const name = `Abrir el turno de Paciente ${id},`;
  const at = html.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<tr", at);
  return html.slice(start, html.indexOf("</tr>", at));
}

describe("[CF2-RC] Recepción: columna «Cobro»", () => {
  it("[CF2-RC1] sin la prop (o null) el markup es el de hoy: sin columna, sin chip, sin «Cobrar»", () => {
    const sin = render(undefined);
    expect(render(null)).toBe(sin);
    expect(sin).not.toContain(">Cobro<");
    expect(sin).not.toContain('data-label="Cobro"');
    expect(sin).not.toContain("Por cobrar");
    expect(sin).not.toContain(">Cobrar<");
  });

  it("[CF2-RC2] con la prop: encabezado «Cobro» y el tag del copago en cada fila (Pagado · Efectivo / Por cobrar)", () => {
    const html = render(SECRETARIA);
    expect(html).toContain(">Cobro<");
    expect(rowOf(html, "pagado")).toContain("Pagado · Efectivo");
    expect(rowOf(html, "hecho")).toContain('data-badge="copago-owed"');
    expect(rowOf(html, "hecho")).toContain(`aria-label="Por cobrar: ${formatARS(500_000)}"`);
    // La seña ya pagada se descuenta (regla `deskOwedCents`).
    expect(rowOf(html, "sala")).toContain(`aria-label="Por cobrar: ${formatARS(300_000)}"`);
    // Antes de llegar no hay tag; la celda dice «—» por CSS (`:empty`), sin texto inventado.
    expect(rowOf(html, "futuro")).not.toContain("copago-");
    expect(rowOf(html, "cancel")).not.toContain("copago-");
  });
});

describe("[CF2-RC] botón «Cobrar» según permiso", () => {
  it("[CF2-RC3] la Secretaria (billing.collect) cobra todas las que deben, de cualquier profesional", () => {
    const html = render(SECRETARIA);
    for (const id of ["hecho", "sala", "otro"]) expect(rowOf(html, id)).toContain(">Cobrar<");
    for (const id of ["pagado", "futuro", "cancel"]) expect(rowOf(html, id)).not.toContain(">Cobrar<");
    expect(rowOf(html, "sala")).toContain(`aria-label="Cobrar ${formatARS(300_000)}: Paciente sala, 09:50"`);
  });

  it("[CF2-RC4] el profesional (billing.collectOwn) solo ve tag y botón en las suyas", () => {
    const html = render(PRO_P1);
    expect(rowOf(html, "hecho")).toContain(">Cobrar<");
    expect(rowOf(html, "sala")).toContain(">Cobrar<");
    const otro = rowOf(html, "otro");
    expect(otro).not.toContain(">Cobrar<");
    expect(otro).not.toContain("copago-");
    expect(otro).toContain('data-label="Cobro"');
  });

  it("[CF2-RC4b] receptionCanCollect es `canCollectCopago` (actor sin profesional nunca cobra «lo suyo»)", () => {
    const cases: [{ all: boolean; practitionerId: string | null }, string | null][] = [
      [SECRETARIA, "p1"],
      [SECRETARIA, null],
      [PRO_P1, "p1"],
      [PRO_P1, "p2"],
      [{ all: false, practitionerId: null }, null],
    ];
    for (const [c, pid] of cases) {
      const caps = new Set<Capability>([c.all ? "billing.collect" : "billing.collectOwn"]);
      expect(receptionCanCollect(c, { practitionerId: pid as string })).toBe(canCollectCopago(caps, c.practitionerId, pid));
    }
    expect(receptionCanCollect(null, { practitionerId: "p1" })).toBe(false);
    expect(receptionOwes(PRO_P1, rows[2]!)).toBe(false);
    expect(receptionOwes(SECRETARIA, rows[2]!)).toBe(true);
  });
});

describe("[CF2-RC] chip «Por cobrar · N · $X»", () => {
  it("[CF2-RC5] cuenta y suma lo que falta (con la seña descontada) de las filas que el viewer cobra", () => {
    expect(receptionOwedSummary(SECRETARIA, rows)).toEqual({ count: 3, cents: 500_000 + 300_000 + 500_000 });
    expect(receptionOwedSummary(PRO_P1, rows)).toEqual({ count: 2, cents: 800_000 });
    const html = render(SECRETARIA);
    expect(html).toContain('data-chip="por-cobrar"');
    expect(html).toContain(`3 · ${formatARS(1_300_000)}`);
    expect(render(PRO_P1)).toContain(`2 · ${formatARS(800_000)}`);
  });

  it("[CF2-RC5b] [CF2-ZF1-4c] sin deudas el chip queda visible y deshabilitado («Por cobrar · 0», como /sala: la barra no salta)", () => {
    const html = render(SECRETARIA, rows.filter((r) => r.paymentStatus === "PAID" || r.status !== "COMPLETED").filter((r) => !r.arrivedAt));
    expect(html).toMatch(/<button[^>]*data-chip="por-cobrar"[^>]*disabled=""[^>]*>Por cobrar · 0<\/button>/);
    expect(html).toContain(">Cobro<");
  });
});

describe("[CF2-RC] guardado y stale del CollectModal", () => {
  it("[CF2-RC6] al guardar: onChanged con la fila pagada (`withCopagoPaid`), sin stale", () => {
    const onChanged = vi.fn();
    const warn = vi.fn();
    const b = rows[0]!;
    receptionCollectHandlers(b, onChanged, warn).onSaved({ updatedAt: iso("10:01"), method: "TRANSFER" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    const [next, opts] = onChanged.mock.calls[0]!;
    expect(next).toMatchObject({ id: b.id, paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER", updatedAt: iso("10:01") });
    expect(opts).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("[CF2-RC7] stale: toast warning «El turno cambió en otra sesión» + onChanged(fila vieja, { stale: true })", () => {
    const onChanged = vi.fn();
    const warn = vi.fn();
    const b = rows[1]!;
    receptionCollectHandlers(b, onChanged, warn).onStale();
    expect(warn).toHaveBeenCalledWith("El turno cambió en otra sesión", {
      description: "Actualizamos la lista con lo último de Paciente sala. Revisalo y reintentá.",
    });
    expect(onChanged).toHaveBeenCalledWith(b, { stale: true });
  });
});
