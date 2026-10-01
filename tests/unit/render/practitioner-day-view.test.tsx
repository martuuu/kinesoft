import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPractitionerColumns, type AgendaZoom } from "@/lib/agenda-layout";
import { PractitionerDayView, columnDayStatus, type PractitionerDayBooking } from "@/components/agenda/views/practitioner-day-view";
import { PractitionerChips } from "@/components/agenda/practitioner-chips";
import { ModeToggle } from "@/components/agenda/mode-toggle";

const DAY = "2026-10-05"; // lunes
const ar = (hhmm: string) => `${DAY}T${hhmm}:00-03:00`;
const iso = (hhmm: string) => new Date(ar(hhmm)).toISOString();
const NOW = new Date(ar("14:32"));

const KINE = "svc-kine"; // cupo null
const OSTEO = "svc-osteo"; // cupo 1
const GRUPO = "svc-grupo"; // cupo 3
const CAPS: Record<string, number | null> = { [KINE]: null, [OSTEO]: 1, [GRUPO]: 3 };
const capOf = (_p: string, s: string) => CAPS[s] ?? null;

const practitioners = [
  { id: "p1", name: "Lic. Ana Pérez" },
  { id: "p2", name: "Bruno de la Fuente" },
  { id: "p3", name: "Carla Gómez" },
  { id: "p4", name: "Diego Ruiz" },
  { id: "p5", name: "Elena Martínez" },
  { id: "p6", name: "Federico Sosa" },
];

let seq = 0;
function bk(pid: string, hhmm: string, serviceId: string, over: Partial<PractitionerDayBooking> = {}): PractitionerDayBooking {
  seq += 1;
  return {
    id: `b${seq}`,
    scheduledFor: iso(hhmm),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId,
    serviceName: serviceId,
    serviceColor: "#3d74b5",
    practitionerId: pid,
    patientId: `pt${seq}`,
    patientName: `Paciente ${seq}`,
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 100000,
    updatedAt: iso("07:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    ...over,
  };
}

const bookings: PractitionerDayBooking[] = [
  // p1 gimnasio: 5 a las 10:00 (∞) → "5/∞", "+1 más"
  ...Array.from({ length: 5 }, () => bk("p1", "10:00", KINE)),
  bk("p1", "16:00", KINE, { status: "CANCELLED" }),
  // p2 osteo cupo 1: 9:00 lleno; 11:00 dos → sobreturno
  bk("p2", "09:00", OSTEO, { durationMin: 30 }),
  bk("p2", "11:00", OSTEO, { durationMin: 30 }),
  bk("p2", "11:00", OSTEO, { durationMin: 30, isOverbooked: true }),
  // p3 grupo cupo 3: 2 a las 15:00
  bk("p3", "15:00", GRUPO, { durationMin: 60 }),
  bk("p3", "15:00", GRUPO, { durationMin: 60 }),
  // p4 bloqueado todo el día pero con un turno forzado
  bk("p4", "12:00", OSTEO),
  // p5 un turno largo (continúa)
  bk("p5", "09:00", KINE, { durationMin: 90 }),
];

const ranges = {
  p1: [{ startMin: 8 * 60, endMin: 19 * 60 }],
  p2: [{ startMin: 8 * 60, endMin: 13 * 60 }],
  p3: [{ startMin: 14 * 60, endMin: 19 * 60 }],
  p4: [{ startMin: 8 * 60, endMin: 19 * 60 }],
  p5: [
    { startMin: 8 * 60, endMin: 12 * 60 },
    { startMin: 14 * 60, endMin: 19 * 60 },
  ],
  // p6: sin franjas → todo fuera de horario
};
const blocks = [
  { id: "blk-4", practitionerId: "p4", startsAt: ar("00:00"), endsAt: `2026-10-06T00:00:00-03:00`, allDay: true, reason: "Congreso" },
  { id: "blk-5", practitionerId: "p5", startsAt: ar("16:00"), endsAt: ar("17:00"), reason: "Trámite" },
];

function render(zoom: AgendaZoom, density: "comfortable" | "compact", withLock = true) {
  const layout = buildPractitionerColumns(practitioners, bookings, { dayKey: DAY, zoom, ranges, blocks, capOf, now: NOW });
  const html = renderToStaticMarkup(
    <PractitionerDayView
      dayKey={DAY}
      layout={layout}
      practitioners={[{ id: "p1", name: "Ana", subtitle: "Kinesiología" }]}
      zoom={zoom}
      density={density}
      now={NOW}
      onSlotClick={() => {}}
      onBookingClick={() => {}}
      highlightServiceId={null}
      lockStateByPractitioner={{ p6: { status: "locked", reason: "sin-franjas", detail: null, blockIds: [] } }}
      onDayLockClick={withLock ? () => {} : undefined}
    />
  );
  return { layout, html };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("B4.2 PractitionerDayView — render 6 profesionales × día completo", () => {
  it("zoom 30 cómodo: estructura, estados y etiquetas", () => {
    const { layout, html } = render(30, "comfortable");
    const rows = layout.rows.length;
    expect(layout.window).toEqual({ startMin: 480, endMin: 1140 });
    expect(rows).toBe(22);
    expect(count(html, 'role="grid"')).toBe(1);
    expect(count(html, 'role="columnheader"')).toBe(7);
    expect(count(html, 'role="rowheader"')).toBe(rows);
    expect(count(html, 'role="gridcell"')).toBe(rows * 6);
    expect(html).toContain(`aria-rowcount="${rows + 1}"`);
    expect(html).toContain('aria-colcount="7"');
    // Roving tabindex: una sola celda tabulable
    expect(count(html, 'data-cell="')).toBe(rows * 6);
    expect(count(html, 'tabindex="0"')).toBe(1);
    // Iniciales (canal no cromático)
    for (const ini of ["AP", "BF", "CG", "DR", "EM", "FS"]) expect(html).toContain(`data-initials="${ini}"`);
    // Estado del día por columna
    expect(html).toMatch(/data-practitioner="p1" data-day-status="open"/);
    expect(html).toMatch(/data-practitioner="p4" data-day-status="locked"/);
    expect(html).toMatch(/data-practitioner="p5" data-day-status="partial"/);
    expect(html).toMatch(/data-practitioner="p6" data-day-status="off"/);
    expect(html).toContain("Día bloqueado para Diego Ruiz (Congreso). Desbloquear");
    expect(html).toContain("Día parcial para Elena Martínez (Trámite). Bloquear el día");
    // Conteo de turnos (cancelado no cuenta)
    expect(html).toMatch(/data-count="5"[^>]*>5 turnos/);
    expect(html).toMatch(/data-count="3"[^>]*>3 turnos/);
    // Ocupación y estados de celda
    expect(html).toContain('data-occupancy="5/∞"');
    expect(html).toContain('data-occupancy="1/1"');
    expect(html).toContain('data-occupancy="2/3"');
    expect(html).toContain('data-occupancy="2/1"');
    expect(count(html, 'data-badge="sobreturno"')).toBeGreaterThanOrEqual(1);
    for (const st of ["libre", "parcial", "lleno", "sobreturno", "fuera-de-horario", "bloqueado"]) {
      expect(html, st).toContain(`data-state="${st}"`);
    }
    // Bloqueado: rayado + motivo una sola vez por tramo, tooltip, sin alta
    expect(html).toContain('data-unavailable="bloqueado"');
    expect(html).toContain('title="Bloqueado · Congreso"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("10:00, Diego Ruiz: bloqueado: Congreso");
    expect(count(html, "Trámite</span>")).toBe(1);
    // Fuera de horario
    expect(html).toContain('data-unavailable="fuera-de-horario"');
    // Alta rápida con profesional + hora
    expect(html).toContain('aria-label="Nuevo turno con Lic. Ana Pérez a las 08:00 (libre)"');
    expect(html).toContain('aria-label="Nuevo turno con Lic. Ana Pérez a las 10:00 (5 turnos, sin tope de cupo)"');
    expect(html).toContain('aria-label="Nuevo turno con Bruno de la Fuente a las 09:00 (lleno, 1 de 1)"');
    expect(html).toContain('aria-label="Nuevo turno con Carla Gómez a las 15:00 (2 de 3 lugares ocupados)"');
    // +N más (límite 4 en cómodo)
    expect(html).toContain("+1 más");
    // Turno largo continúa
    expect(html).toContain("continúa Paciente");
    // Línea de ahora
    expect(html).toContain('data-now-line="14:32"');
    expect(html).toContain('aria-label="14:30 (ahora)"');
    // Subtítulo opcional
    expect(html).toContain("Kinesiología");
  });

  it("zoom 15 compacto y zoom 60 renderizan sin errores", () => {
    const a = render(15, "compact");
    expect(a.layout.rows.length).toBe(44);
    expect(count(a.html, 'role="gridcell"')).toBe(44 * 6);
    expect(a.html).toContain("+2 más"); // límite 3 en compacto
    const b = render(60, "comfortable", false);
    expect(b.layout.rows.length).toBe(11);
    // Sin onDayLockClick: estado de solo lectura
    expect(b.html).not.toContain("Bloquear el día");
    expect(b.html).toContain('aria-label="Día: Bloqueado · Congreso"');
  });

  it("columnDayStatus derivado sin motor", () => {
    const { layout } = render(30, "comfortable");
    const byId = Object.fromEntries(layout.columns.map((c) => [c.practitionerId, columnDayStatus(c).status]));
    expect(byId).toEqual({ p1: "open", p2: "open", p3: "open", p4: "locked", p5: "partial", p6: "off" });
  });

  it("sin columnas → mensaje", () => {
    const layout = buildPractitionerColumns([], [], { dayKey: DAY, zoom: 30, ranges: {}, capOf, now: NOW });
    const html = renderToStaticMarkup(
      <PractitionerDayView dayKey={DAY} layout={layout} practitioners={[]} zoom={30} density="compact" now={NOW} onSlotClick={() => {}} onBookingClick={() => {}} />
    );
    expect(html).toContain("No hay profesionales para mostrar");
  });

  it("chips y toggle", () => {
    const chips = practitioners.map((p, i) => ({ id: p.id, name: p.name, initials: ["AP", "BF", "CG", "DR", "EM", "FS"][i], count: i }));
    const html = renderToStaticMarkup(
      <PractitionerChips practitioners={chips} selectedIds={["p2", "p3"]} onChange={() => {}} favoriteIds={["p2"]} onToggleFavorite={() => {}} />
    );
    expect(html).toContain('aria-label="Todos los profesionales, 15 turnos"');
    expect(html).toContain('aria-label="Mis favoritos, 1 turno"');
    expect(count(html, 'aria-pressed="true"')).toBe(3); // p2, p3, estrella de p2
    expect(html).toContain('aria-label="Quitar a Bruno de la Fuente de favoritos"');
    expect(html).toContain('aria-label="Marcar a Ana Pérez como favorito"'.replace("Ana Pérez", "Lic. Ana Pérez"));
    const t = renderToStaticMarkup(<ModeToggle mode="practitioner" onChange={() => {}} />);
    expect(t).toContain('role="radiogroup"');
    expect(t).toMatch(/aria-checked="true"[^>]*data-mode="practitioner"|data-mode="practitioner"[^>]*aria-checked="true"/);
  });
});
