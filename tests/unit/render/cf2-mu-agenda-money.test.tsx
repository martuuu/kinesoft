/**
 * [CF2-MU] Tag de cobro del copago en las tarjetas de la agenda (brief CF2 A.2, D-CF2-3): la card (Día / Por
 * profesional / Por sala), la línea de la Semana (compacta: glifo + texto en el `aria-label`) y la Lista (junto al
 * monto) pintan el `MoneyBadge` de `components/agenda/grid/money-badge.tsx`, que `booking-card` re-exporta. Quién ve el
 * copago lo dice `MoneyViewerContext` (la Secretaria todo, el profesional lo suyo); sin provider, el markup de antes de
 * CF2 (solo «Seña» / «Pagado MP»). Render estático del componente real. Fechas con offset -03:00: TZ irrelevante.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { fmtMoney, type BookingDTO } from "@/components/agenda/agenda-utils";
import { BookingCard, MoneyBadge as CardMoneyBadge, type BookingCardSizing } from "@/components/agenda/grid/booking-card";
import { MoneyBadge } from "@/components/agenda/grid/money-badge";
import { MoneyViewerContext } from "@/components/agenda/grid/money-viewer-context";
import { ListView } from "@/components/agenda/views/list-view";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import styles from "@/components/agenda/views/views.module.css";
import { formatARS } from "@/lib/format";

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T11:00:00-03:00`);
const SIZING: BookingCardSizing = { flexBasis: 200 };
const noop = () => {};

const B: BookingDTO = {
  id: "b1",
  scheduledFor: iso("10:00"),
  durationMin: 45,
  status: "CONFIRMED",
  serviceId: "s-kine",
  serviceName: "Kinesiología",
  serviceColor: "#3d74b5",
  practitionerId: "p1",
  patientId: "pat",
  patientName: "Juana Gómez",
  patientCondition: null,
  obraSocial: "Particular",
  copagoCents: 2_000_000,
  updatedAt: iso("07:00"),
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
  isOverbooked: false,
  paymentStatus: "UNPAID",
};
const b = (over: Partial<BookingDTO>): BookingDTO => ({ ...B, ...over });
const OWED = b({ status: "COMPLETED" });
const PAID_CASH = b({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" });
const PAID_MP = b({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true, onlineDepositCents: 600_000 });
const OWED_ARIA = `Por cobrar: ${formatARS(2_000_000)}`;

const ALL = () => true;
const OWN = (pid: string) => pid === "p1";
const wrap = (node: ReactNode, viewer?: (pid: string) => boolean) =>
  renderToStaticMarkup(viewer ? <MoneyViewerContext.Provider value={viewer}>{node}</MoneyViewerContext.Provider> : node);

const card = (x: BookingDTO, viewer?: (pid: string) => boolean) =>
  wrap(<BookingCard b={x} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />, viewer);
const list = (xs: BookingDTO[], viewer?: (pid: string) => boolean) =>
  wrap(<ListView bookings={xs} onEdit={noop} highlight={null} now={NOW} />, viewer);
const week = (xs: BookingDTO[], viewer?: (pid: string) => boolean) =>
  wrap(
    <WeekGridView
      weekDays={WEEK}
      bookings={xs}
      onEdit={noop}
      businessHours={{ start: 8, end: 13, slotMinutes: 60 }}
      showSaturday={false}
      showSunday={false}
      highlight={null}
      practitioners={null}
    />,
    viewer
  );

/** El `<span>` del badge (atributos y contenido). */
const badgeTag = (html: string, key: string) => {
  const at = html.indexOf(`data-badge="${key}"`);
  expect(at, `sin data-badge="${key}"`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<span", at);
  // El badge «Pagado» lleva el check (un <svg> sin <span> adentro): el primer </span> después es el suyo.
  return html.slice(open, html.indexOf("</span>", at) + 7);
};
/** Tramo del markup de la Lista desde la celda `from` hasta la celda `to` (o el final). */
const between = (html: string, from: string, to?: string) => {
  const at = html.indexOf(from);
  expect(at, `sin celda ${from}`).toBeGreaterThan(-1);
  return html.slice(at, to ? html.indexOf(to, at) : undefined);
};

describe("[CF2-MU] booking-card re-exporta el MoneyBadge nuevo", () => {
  it("[CF2-MU1] `MoneyBadge` de booking-card ES el de money-badge (un solo componente, no una copia)", () => {
    expect(CardMoneyBadge).toBe(MoneyBadge);
  });

  it("[CF2-MU2] sin provider la card no cambia con los campos de cobro (golden: el markup de antes de CF2)", () => {
    const plain = card({ ...B, paymentStatus: undefined, status: "COMPLETED" });
    expect(card(OWED)).toBe(plain);
    expect(card(PAID_CASH)).toBe(card({ ...PAID_CASH, paymentStatus: undefined, copagoPaymentMethod: undefined }));
    expect(card(OWED)).not.toMatch(/data-badge="copago-/);
  });

  it("[CF2-MU3] con provider: la card dice «Por cobrar» (punteado) o «Pagado · Efectivo» (sólido + check), texto entero", () => {
    const owed = badgeTag(card(OWED, ALL), "copago-owed");
    expect(owed).toContain(`aria-label="${OWED_ARIA}"`);
    expect(owed).toContain("border:1px dashed");
    expect(owed).toMatch(/>Por cobrar<\/span>$/);
    const paid = badgeTag(card(PAID_CASH, ALL), "copago-paid");
    expect(paid).toContain('aria-label="Pagado · Efectivo"');
    expect(paid).toContain("border:1px solid");
    expect(paid).toContain("<svg");
    expect(paid).toMatch(/Pagado · Efectivo<\/span>$/);
    // Precedencia: pagado entero online → «Pagado MP», no el copago.
    const mp = card(PAID_MP, ALL);
    expect(mp).toContain('data-badge="mp"');
    expect(mp).not.toMatch(/data-badge="copago-/);
  });

  it("[CF2-MU4] el profesional ve solo lo suyo: un turno de otro profesional no muestra el copago", () => {
    expect(card(OWED, OWN)).toContain('data-badge="copago-owed"');
    expect(card({ ...OWED, practitionerId: "p2" }, OWN)).not.toMatch(/data-badge="copago-/);
    expect(card({ ...OWED, practitionerId: "p2" }, OWN)).toBe(card({ ...OWED, practitionerId: "p2" }));
  });
});

describe("[CF2-MU] Semana", () => {
  it("[CF2-MU5] la línea de 22 px usa el badge compacto: glifo visible, texto entero en el aria-label", () => {
    const owed = week([OWED], ALL);
    expect(owed).toMatch(/data-week-line/);
    const t = badgeTag(owed, "copago-owed");
    expect(t).toContain(`aria-label="${OWED_ARIA}"`);
    expect(t).toMatch(/>\$<\/span>$/);
    expect(owed).not.toContain(">Por cobrar<");
    const paid = badgeTag(week([PAID_CASH], ALL), "copago-paid");
    expect(paid).toContain('aria-label="Pagado · Efectivo"');
    expect(paid).not.toContain(">Pagado · Efectivo<");
    // Sin provider, la Semana de siempre.
    expect(week([OWED])).toBe(week([{ ...OWED, paymentStatus: undefined }]));
  });
});

describe("[CF2-MU] Lista", () => {
  it("[CF2-MU6] el tag de copago va junto al monto (celda Copago), no en la de Estado, con el texto entero", () => {
    const html = list([OWED], ALL);
    const copago = between(html, styles.cellCopago, styles.cellDuration);
    expect(copago).toContain(fmtMoney(OWED.copagoCents));
    expect(copago).toContain('data-badge="copago-owed"');
    expect(copago).toContain(">Por cobrar<");
    expect(between(html, styles.cellStatus)).not.toContain('data-badge="copago-');
    expect(between(list([PAID_CASH], ALL), styles.cellCopago, styles.cellDuration)).toContain("Pagado · Efectivo");
    // Un solo badge por fila (precedencia «Pagado MP» → copago → «Seña»).
    expect(list([PAID_MP], ALL).match(/data-badge="(mp|sena|copago-[a-z]+)"/g)).toEqual(['data-badge="mp"']);
  });

  it("[CF2-MU7] sin provider o sin permiso sobre ese profesional, la Lista no muestra el copago", () => {
    expect(list([OWED])).not.toMatch(/data-badge="copago-/);
    expect(list([{ ...OWED, practitionerId: "p2" }], OWN)).not.toMatch(/data-badge="copago-/);
    expect(list([OWED], OWN)).toContain('data-badge="copago-owed"');
  });
});
