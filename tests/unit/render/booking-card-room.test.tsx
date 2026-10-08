import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingCard, type BookingCardSizing } from "@/components/agenda/grid/booking-card";
import { ListView } from "@/components/agenda/views/list-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/**
 * [SR-U5a] La sala en la tarjeta y en la Lista: texto (canal no cromático),
 * solo si el caller la pasa (`showRoomOnCards`). Sin ella, el markup es
 * byte a byte el de siempre.
 */

const DAY = "2026-10-05";
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
  copagoCents: 0,
  updatedAt: iso("07:00"),
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
  isOverbooked: false,
  roomId: "room_c2",
};

const card = (room?: { name: string } | null) =>
  renderToStaticMarkup(<BookingCard b={B} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} room={room} />);

describe("[SR-U5a] BookingCard con sala", () => {
  it("sin room (o null): markup idéntico al de antes, sin rastro de sala", () => {
    const before = renderToStaticMarkup(<BookingCard b={B} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(card(null)).toBe(before);
    expect(card(undefined)).toBe(before);
    expect(before).not.toContain("data-room");
    expect(before).not.toContain("Consultorio");
  });

  it("con room: '· Consultorio 2' a la vista, 'en Consultorio 2' para el lector y en el tooltip", () => {
    const html = card({ name: "Consultorio 2" });
    expect(html).toContain("data-room");
    expect(html).toContain('<span aria-hidden="true">· </span>');
    expect(html).toMatch(/>en <\/span>Consultorio 2<\/span>/);
    expect(html).toMatch(/title="[^"]*· en Consultorio 2/);
  });

  it("sin color nuevo: el span de la sala no trae color ni fondo propio", () => {
    const html = card({ name: "Consultorio 2" });
    const span = html.slice(html.indexOf("<span data-room"), html.indexOf(">", html.indexOf("<span data-room")));
    expect(span).not.toMatch(/color|background/);
  });
});

describe("[SR-U5a] ListView con sala", () => {
  const list = (roomById?: Record<string, { name: string }> | null) =>
    renderToStaticMarkup(<ListView bookings={[B, { ...B, id: "b2", roomId: null }]} onEdit={noop} highlight={null} now={NOW} roomById={roomById} />);

  it("sin roomById: la Lista de siempre", () => {
    const before = renderToStaticMarkup(<ListView bookings={[B, { ...B, id: "b2", roomId: null }]} onEdit={noop} highlight={null} now={NOW} />);
    expect(list(undefined)).toBe(before);
    expect(list(null)).toBe(before);
    expect(before).not.toContain("data-room");
  });

  it("con roomById: la sala como texto solo en el turno que la tiene", () => {
    const html = list({ room_c2: { name: "Consultorio 2" } });
    expect(html.split("data-room").length - 1).toBe(1);
    expect(html).toMatch(/>Sala: <\/span>Consultorio 2/);
  });
});
