import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingCard, WaitingPulseContext, type BookingCardSizing } from "@/components/agenda/grid/booking-card";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import { WeekDayList } from "@/components/agenda/views/week-day-list";
import { ListView } from "@/components/agenda/views/list-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/**
 * [HF-2b] Latido «Llegó» (HF-2a, D-LL1) en el markup real de la agenda: el punto lima con su texto para el lector,
 * en la card (Día / Por profesional / Por sala), en la línea de la Semana, en la lista mobile de la Semana y en la
 * Lista. Las fechas con offset -03:00: corre en TZ=UTC y TZ=AR.
 */

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string, d = DAY) => new Date(`${d}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T10:12:00-03:00`);
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
  copagoCents: 0,
  updatedAt: iso("07:00"),
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
  isOverbooked: false,
};
const WAITING: BookingDTO = { ...B, arrivedAt: iso("10:00") };

const card = (b: BookingDTO, now = NOW) =>
  renderToStaticMarkup(<BookingCard b={b} onEdit={noop} highlight={null} compact sizing={SIZING} now={now} />);

describe("[HF-2b] BookingCard", () => {
  it("[HF-2b] BookingCard en sala hoy → data-waiting + aria «En sala de espera · 12 min»", () => {
    const html = card(WAITING);
    expect(html).toContain('data-waiting="waiting"');
    expect(html).toMatch(/class="k-live-dot k-wait-dot"[^>]*data-pulse="true"/);
    expect(html).toContain('aria-label="En sala de espera · 12 min"');
    expect(html).toMatch(/title="[^"]*En sala de espera · 12 min/);
    // La card es el contenedor del punto; el fondo (estado) y la opacidad (filtro) no cambian.
    expect(html).toContain("position:relative");
    const plain = card(B);
    const bg = (h: string) => h.match(/background:([^;]+);border:/)?.[1];
    expect(bg(html)).toBe(bg(plain));
    expect(html.match(/opacity:([^;"]+)/)?.[1]).toBe(plain.match(/opacity:([^;"]+)/)?.[1]);
    // No es el verde de «Hecho» / «En vivo».
    expect(html).not.toMatch(/success|st-completed/);
  });

  it("[HF-2b] espera larga (≥15′) → data-level long y minutos en negrita, sin ámbar", () => {
    const html = card(WAITING, new Date(`${DAY}T10:25:00-03:00`));
    expect(html).toContain('data-waiting="long"');
    expect(html).toContain('data-level="long"');
    expect(html).toContain(">En sala 25′<");
    expect(html).toMatch(/data-badge="en-sala"[^>]*font-weight:800/);
    expect(html).not.toMatch(/data-badge="en-sala"[^>]*(warn|late)/);
  });

  it("[HF-2b] sin espera (llamado, de otro día o sin llegada) → sin punto; markup de la card normal sin data-waiting", () => {
    expect(card(B)).not.toContain("k-wait-dot");
    expect(card(B)).not.toContain("data-waiting");
    expect(card({ ...WAITING, calledAt: iso("10:10") })).not.toContain("k-wait-dot");
    expect(card(WAITING, new Date("2026-10-06T10:12:00-03:00"))).not.toContain("k-wait-dot");
  });

  it("[HF-2b] fuera del tope de animados (contexto) → punto fijo", () => {
    const html = renderToStaticMarkup(
      <WaitingPulseContext.Provider value={new Set(["otro"])}>
        <BookingCard b={WAITING} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />
      </WaitingPulseContext.Provider>
    );
    expect(html).toMatch(/class="k-live-dot k-wait-dot"[^>]*data-pulse="false"/);
  });
});

describe("[HF-2b] Semana y Lista", () => {
  const hours = { start: 8 * 60, end: 20 * 60, slotMinutes: 60 };

  it("[HF-2b] WeekBookingLine y lista mobile con punto", () => {
    const grid = renderToStaticMarkup(
      <WeekGridView weekDays={WEEK} bookings={[WAITING]} onEdit={noop} businessHours={hours} showHeader showSaturday={false} showSunday={false} highlight={null} now={NOW} />
    );
    expect(grid).toMatch(/data-week-line[^>]*data-waiting="waiting"/);
    expect(grid).toMatch(/class="k-live-dot k-wait-dot"[^>]*data-size="sm"/);
    expect(grid).toContain('aria-label="En sala de espera · 12 min"');

    const list = renderToStaticMarkup(
      <WeekDayList weekDays={WEEK} showSaturday={false} showSunday={false} bookings={[WAITING]} onEdit={noop} highlight={null} practitionerById={null} roomById={null} now={NOW} />
    );
    expect(list).toMatch(/data-week-list-row[^>]*data-waiting="waiting"/);
    expect(list).toContain("k-wait-dot");
    expect(list).toContain("En sala 12′");

    // Llegada de ayer en la Semana: sin punto.
    const stale = renderToStaticMarkup(
      <WeekDayList weekDays={WEEK} showSaturday={false} showSunday={false} bookings={[WAITING]} onEdit={noop} highlight={null} practitionerById={null} roomById={null} now={new Date("2026-10-06T09:00:00-03:00")} />
    );
    expect(stale).not.toContain("k-wait-dot");
  });

  it("[HF-2b] Lista: texto «En sala 12′»", () => {
    const html = renderToStaticMarkup(<ListView bookings={[WAITING]} onEdit={noop} highlight={null} now={NOW} />);
    expect(html).toContain("En sala 12′");
    expect(html).toContain("data-waiting");
  });
});
