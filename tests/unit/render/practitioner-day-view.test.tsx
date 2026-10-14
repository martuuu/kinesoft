import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPractitionerColumns, type AgendaZoom } from "@/lib/agenda-layout";
import { PractitionerDayView, columnDayStatus, columnHighlightCount, type PractitionerDayBooking } from "@/components/agenda/views/practitioner-day-view";
import { PractitionerChips } from "@/components/agenda/practitioner-chips";
import { ModeToggle } from "@/components/agenda/mode-toggle";
import { denseOverflow, overflowButtonText, bookingOutOfPlan } from "@/components/agenda/grid/slot-cell";
import { TimelineView } from "@/components/agenda/views/timeline-view";
import { isOutOfPlan } from "@/lib/plan-display";
import type { AgendaHighlight } from "@/lib/agenda-highlight";

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
      highlight={null}
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

// ─── S19e (Planes, ES3): resaltado y plan en las vistas densas ──────────────

/** DTO expandido de la agenda (C9 con neutros, como lo deja `expandPlanFields`). */
const loose = (pid: string, hhmm: string, over: Partial<PractitionerDayBooking> = {}) =>
  bk(pid, hhmm, KINE, {
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
    isOverbooked: false,
    ...over,
  });
const ofPlan = (pid: string, hhmm: string, over: Partial<PractitionerDayBooking> = {}) =>
  loose(pid, hhmm, {
    programId: "prog-1",
    sessionId: `ses-${seq}`,
    plan: { discipline: "KINESIOLOGY", ordinal: 2, totalLive: 10, title: null },
    patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
    ...over,
  });
/** Suelto de un paciente con plan Kine vinculado activo → "Fuera de plan". */
const outOfPlan = (pid: string, hhmm: string, over: Partial<PractitionerDayBooking> = {}) =>
  loose(pid, hhmm, { patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"], ...over });

const PLAN: AgendaHighlight = { kind: "plan" };

function renderDense(list: PractitionerDayBooking[], highlight: AgendaHighlight | null, density: "comfortable" | "compact" = "comfortable") {
  const layout = buildPractitionerColumns(practitioners.slice(0, 2), list, { dayKey: DAY, zoom: 30, ranges, capOf, now: NOW });
  const html = renderToStaticMarkup(
    <PractitionerDayView
      dayKey={DAY}
      layout={layout}
      practitioners={[]}
      zoom={30}
      density={density}
      now={NOW}
      onSlotClick={() => {}}
      onBookingClick={() => {}}
      highlight={highlight}
    />
  );
  return { layout, html };
}

describe("S19e · denseOverflow / overflowButtonText (puros)", () => {
  it("sin resaltado: no reordena; cuenta los 'Fuera de plan' ocultos", () => {
    const list = [loose("p1", "10:00"), loose("p1", "10:00"), outOfPlan("p1", "10:00"), ofPlan("p1", "10:00")];
    const o = denseOverflow(list, 2, false, null);
    expect(o.shown.map((b) => b.id)).toEqual([list[0].id, list[1].id]);
    expect(o).toMatchObject({ hidden: 2, hiddenMatches: 0, hiddenOutOfPlan: 1 });
    expect(overflowButtonText(o, false, "a las 10:00")).toEqual({
      text: "+2 más · 1 fuera de plan",
      ariaLabel: "Ver 2 turnos más a las 10:00 (1 fuera de plan)",
    });
  });

  it("con resaltado: lo que coincide va primero (partición estable) y se cuenta lo oculto", () => {
    const list = [loose("p1", "10:00"), ofPlan("p1", "10:00"), loose("p1", "10:00"), ofPlan("p1", "10:00"), ofPlan("p1", "10:00")];
    const o = denseOverflow(list, 2, false, PLAN);
    expect(o.shown.map((b) => b.id)).toEqual([list[1].id, list[3].id]);
    expect(o).toMatchObject({ hidden: 3, hiddenMatches: 1, hiddenOutOfPlan: 0 });
    expect(overflowButtonText(o, true, "x").text).toBe("+3 más · 1 resaltado");
    // Expandido: todo, en el mismo orden (coincidencias primero)
    const all = denseOverflow(list, 2, true, PLAN);
    expect(all.shown.map((b) => b.id)).toEqual([1, 3, 4, 0, 2].map((i) => list[i].id));
    expect(all.hidden).toBe(0);
  });

  it("resaltado 'suelto' y de servicio usan la misma regla que las cards", () => {
    const list = [ofPlan("p1", "10:00"), loose("p1", "10:00")];
    expect(denseOverflow(list, 1, false, { kind: "loose" }).shown[0].id).toBe(list[1].id);
    expect(denseOverflow(list, 1, false, { kind: "service", serviceId: "otro" }).hiddenMatches).toBe(0);
  });

  it("bookingOutOfPlan = isOutOfPlan con hasPatient = patientId != null (coherente con S19a)", () => {
    const cases = [
      outOfPlan("p1", "10:00"),
      outOfPlan("p1", "10:00", { patientId: null }),
      outOfPlan("p1", "10:00", { status: "CANCELLED" }),
      ofPlan("p1", "10:00"),
      loose("p1", "10:00"),
      bk("p1", "10:00", KINE), // sin C9 (proyección completa) → no adivina
    ];
    expect(cases.map(bookingOutOfPlan)).toEqual([true, false, false, false, false, false]);
    for (const b of cases) expect(bookingOutOfPlan(b)).toBe(isOutOfPlan({ ...b, hasPatient: b.patientId !== null }));
  });
});

describe("S19e · Por profesional con plan", () => {
  it("el turno de plan no queda detrás del '+N más' al resaltar 'Plan'; header cuenta resaltados; celda sin coincidencias atenuada", () => {
    const list = [
      ...Array.from({ length: 5 }, () => loose("p1", "10:00")),
      ofPlan("p1", "10:00", { patientName: "Paciente Plan", durationMin: 30 }),
      loose("p2", "09:00", { serviceId: OSTEO }),
    ];
    const sin = renderDense(list, null);
    expect(sin.html).not.toContain("Paciente Plan"); // 6 en la celda, límite 4
    expect(sin.html).toContain("+2 más</button>");
    expect(sin.html).not.toContain("data-highlight-count");
    expect(sin.html).not.toContain("data-highlight=");

    const con = renderDense(list, PLAN);
    expect(con.html).toContain("Paciente Plan");
    expect(con.html).toContain("+2 más</button>"); // lo oculto no coincide: sin sufijo
    expect(con.html).toMatch(/data-highlight-count="1"[^>]*>· 1 resaltado/);
    expect(con.html).toMatch(/data-highlight-count="0"[^>]*>· 0 resaltados/);
    expect(con.html).toMatch(/data-practitioner="p1" data-time="10:00" data-highlight="match"/);
    expect(con.html).toMatch(/data-practitioner="p2" data-time="09:00" data-highlight="dimmed"/);
    expect(con.layout.columns.map((c) => columnHighlightCount(c, PLAN))).toEqual([1, 0]);
    expect(columnHighlightCount(con.layout.columns[0], null)).toBeNull();
  });

  it("la ocupación '1/∞' sigue siendo una pill aparte (aria-hidden, sin role=img) aunque haya plan", () => {
    const { html } = renderDense([ofPlan("p1", "10:00")], PLAN);
    expect(html).toMatch(/<span class="k-mono" data-occupancy="1\/∞"/);
    expect(html).not.toMatch(/role="img"[^>]*data-occupancy/);
  });

  it("'+N más' avisa los 'Fuera de plan' ocultos (aria completo)", () => {
    const list = [...Array.from({ length: 3 }, () => loose("p1", "10:00")), outOfPlan("p1", "10:00"), outOfPlan("p1", "10:00")];
    const { html } = renderDense(list, null, "compact");
    expect(html).toContain('aria-label="Ver 2 turnos más de Lic. Ana Pérez a las 10:00 (2 fuera de plan)"');
    expect(html).toContain('data-overflow-out-of-plan="2"');
    expect(html).toContain("+2 más · 2 fuera de plan");
  });

  it("sin módulo planes (C9 neutro): nada de plan en la celda ni en el header", () => {
    const list = Array.from({ length: 6 }, () => loose("p1", "10:00"));
    const { html } = renderDense(list, null);
    expect(html).not.toMatch(/fuera de plan|resaltado|data-overflow-/i);
  });
});

describe("S19e · vista Día con plan", () => {
  const hours = { start: 8, end: 19, slotMinutes: 30 };
  const renderDay = (list: PractitionerDayBooking[], highlight: AgendaHighlight | null) =>
    renderToStaticMarkup(
      <TimelineView bookings={list} dayKey={DAY} onCreate={() => {}} onEdit={() => {}} density="comfortable" businessHours={hours} highlight={highlight} />
    );

  it("12 en la franja (límite 10): el de plan sube con 'Plan'; '+N más' cuenta resaltados y fuera de plan", () => {
    const list = [
      ...Array.from({ length: 10 }, () => loose("p1", "10:00")),
      outOfPlan("p1", "10:00"),
      ofPlan("p1", "10:00", { patientName: "Paciente Plan", durationMin: 30 }),
    ];
    const sin = renderDay(list, null);
    expect(sin).not.toContain("Paciente Plan");
    expect(sin).toContain("+2 más · 1 fuera de plan");
    expect(sin).toContain('aria-label="Ver 2 turnos más a las 10:00 (1 fuera de plan)"');

    const con = renderDay(list, PLAN);
    expect(con).toContain("Paciente Plan");
    expect(con).toContain("+2 más · 1 fuera de plan"); // la resaltada ya está a la vista

    const suelto = renderDay([...list.slice(0, 9), ofPlan("p1", "10:00"), ofPlan("p1", "10:00"), loose("p1", "10:00", { patientName: "Suelto Último", durationMin: 30 })], { kind: "loose" });
    expect(suelto).toContain("Suelto Último");
    expect(suelto).toContain("+2 más</button>");
  });

  it("sin resaltado ni C9: '+N más' como siempre", () => {
    const list = Array.from({ length: 11 }, () => bk("p1", "10:00", KINE));
    expect(renderDay(list, null)).toContain("+1 más</button>");
  });
});

describe("[IAM-4b] «Día por profesional» con turnos de quien no tiene columna", () => {
  it("el turno viejo de la Secretaria se dibuja en la columna «Otros (sin agenda)»", () => {
    const orphan = bk("secretaria", "10:00", KINE, { patientName: "Paciente Huérfano" });
    const layout = buildPractitionerColumns(practitioners.slice(0, 2), [orphan], {
      dayKey: DAY,
      zoom: 30,
      ranges,
      capOf,
      now: NOW,
      othersColumn: true,
    });
    const html = renderToStaticMarkup(
      <PractitionerDayView
        dayKey={DAY}
        layout={layout}
        practitioners={practitioners.slice(0, 2)}
        zoom={30}
        density="comfortable"
        now={NOW}
        onSlotClick={() => {}}
        onBookingClick={() => {}}
        highlight={null}
      />
    );
    expect(html).toContain("Otros (sin agenda)");
    expect(html).toContain("Paciente Huérfano");
  });
});
