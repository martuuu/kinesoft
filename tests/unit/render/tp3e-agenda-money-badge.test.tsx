import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingCard, type BookingCardSizing } from "@/components/agenda/grid/booking-card";
import { ListView } from "@/components/agenda/views/list-view";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";

/**
 * [TP-3e] Plata online en la card de la agenda (§25.10 «Agenda», TP-UI-D4): solo «Seña» / «Pagado MP», mini-badge con
 * borde y sin relleno, el fondo sigue siendo el ESTADO (AGENTS §5), nombre accesible completo; sin `od`/`po` la card
 * queda con los mismos nodos; Lista y Semana también lo muestran. Render estático: se afirma el markup real.
 */

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T08:00:00-03:00`);
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
};

/** El cable de la agenda trae `od`/`po` como `onlineDepositCents`/`paidOnline` (C-TP10). */
const withMoney = (b: BookingDTO, m: { onlineDepositCents?: number; paidOnline?: boolean }) => ({ ...b, ...m }) as BookingDTO;
const DEPOSIT = withMoney(B, { onlineDepositCents: 600_000 });
const PAID = withMoney(B, { onlineDepositCents: 600_000, paidOnline: true });
const DEPOSIT_ARIA = `Seña pagada por Mercado Pago: ${formatARS(600_000)}`;

const card = (b: BookingDTO) => renderToStaticMarkup(<BookingCard b={b} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
/** El `<span>` del badge (atributos incluidos). */
const badgeTag = (html: string, key: string) => {
  const at = html.indexOf(`data-badge="${key}"`);
  expect(at, `sin data-badge="${key}"`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<span", at);
  return html.slice(open, html.indexOf("</span>", at) + 7);
};
/** El `style` del botón raíz (fondo y borde = estado). */
const rootStyle = (html: string) => /^<button[^>]*style="([^"]*)"/.exec(html)![1];
const bg = (style: string) => /(?:^|;)background:([^;]*)/.exec(style)?.[1];

describe("[TP-3e] BookingCard: «Seña» / «Pagado MP»", () => {
  it("sin od/po (o neutros): mismos nodos que antes de T5, sin badge de plata", () => {
    const before = card(B);
    expect(card(withMoney(B, { onlineDepositCents: 0, paidOnline: false }))).toBe(before);
    expect(before).not.toMatch(/data-badge="(sena|mp)"/);
    expect(before).not.toContain("Mercado Pago");
  });

  it("seña: badge «Seña» con nombre accesible completo (role=img + aria-label)", () => {
    const html = card(DEPOSIT);
    const tag = badgeTag(html, "sena");
    expect(tag).toContain('role="img"');
    expect(tag).toContain(`aria-label="${DEPOSIT_ARIA}"`);
    expect(tag).toMatch(/>Seña<\/span>$/);
  });

  it("pagado entero online: «Pagado MP» gana (no hay además «Seña»)", () => {
    const html = card(PAID);
    const tag = badgeTag(html, "mp");
    expect(tag).toContain('aria-label="Pagado por Mercado Pago"');
    expect(tag).toMatch(/>Pagado MP<\/span>$/);
    expect(html).not.toContain('data-badge="sena"');
  });

  it("borde sin relleno, y el fondo de la card sigue siendo el estado (igual con y sin badge)", () => {
    const tag = badgeTag(card(DEPOSIT), "sena");
    // Borde (toma `currentColor`), sin fondo ni color propio: el canal es el texto, no el color.
    expect(tag).toMatch(/border:1px solid[;"]/);
    expect(tag).not.toMatch(/background|[;"]color:/);
    for (const status of ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"] as const) {
      const plain = rootStyle(card({ ...B, status }));
      expect(rootStyle(card({ ...DEPOSIT, status }))).toBe(plain);
      expect(rootStyle(card({ ...PAID, status }))).toBe(plain);
    }
    // «Atendido» sigue verde por el estado, no por el badge.
    expect(bg(rootStyle(card({ ...DEPOSIT, status: "COMPLETED" })))).toBe("var(--success-bg)");
    expect(bg(rootStyle(card(DEPOSIT)))).not.toBe("var(--success-bg)");
  });
});

describe("[TP-3e] Lista y Semana muestran la seña", () => {
  const list = (bookings: BookingDTO[]) =>
    renderToStaticMarkup(<ListView bookings={bookings} onEdit={noop} highlight={null} now={NOW} />);
  const week = (bookings: BookingDTO[]) =>
    renderToStaticMarkup(
      <WeekGridView
        weekDays={WEEK}
        bookings={bookings}
        onEdit={noop}
        businessHours={{ start: 8, end: 13, slotMinutes: 60 }}
        showHeader
        showSaturday={false}
        showSunday={false}
        highlight={null}
        practitioners={null}
      />
    );

  it("Lista: el badge va solo en la fila con plata; sin plata, la Lista de siempre", () => {
    const plain = { ...B, id: "b2" };
    const before = list([B, plain]);
    expect(before).not.toMatch(/data-badge="(sena|mp)"/);
    const html = list([DEPOSIT, plain]);
    expect(html.match(/data-badge="sena"/g)).toHaveLength(1);
    expect(badgeTag(html, "sena")).toContain(`aria-label="${DEPOSIT_ARIA}"`);
    expect(list([PAID])).toContain('data-badge="mp"');
  });

  it("Semana: la línea compacta lleva el badge; sin plata, igual que antes", () => {
    const before = week([B]);
    expect(before).not.toMatch(/data-badge="(sena|mp)"/);
    const html = week([DEPOSIT]);
    expect(html).toMatch(/data-week-line/);
    expect(badgeTag(html, "sena")).toContain(`aria-label="${DEPOSIT_ARIA}"`);
    // El fondo de la línea es el del estado, con o sin badge.
    const lineStyle = (h: string) => /data-week-line[^>]*style="([^"]*)"/.exec(h)?.[1] ?? /<button[^>]*style="([^"]*)"[^>]*data-week-line/.exec(h)?.[1];
    expect(lineStyle(html)).toBe(lineStyle(before));
    expect(week([PAID])).toContain('data-badge="mp"');
  });
});
