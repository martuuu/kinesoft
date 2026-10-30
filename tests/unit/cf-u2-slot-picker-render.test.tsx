import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// CF-U2 (§28 decisiones 2 y 3): render real del selector y de la sección de fecha/hora del modal de turno, con
// `renderToStaticMarkup` en node (sin jsdom, como `tests/unit/render`). Se mockean solo las server actions (la red):
// los componentes y los helpers puros son los de prod.
vi.mock("@/lib/availability-actions", () => ({
  listAvailableSlots: vi.fn(async () => ({ ok: false, error: "x" })),
  classifyBookingInstant: vi.fn(async () => ({ ok: false, error: "x" })),
}));

import { AnyView, PractitionerGrid, StepHeader } from "@/components/agenda/booking-modal/slot-picker";
import { InstantStatusBox, ScheduleSection } from "@/components/agenda/booking-modal/schedule-section";
import type { AnySlots, InstantCheck, PractitionerSlots, StaffSlot } from "@/lib/availability-actions-types";

const slot = (time: string, over: Partial<StaffSlot> = {}): StaffSlot => ({
  iso: `2026-10-05T${String(Number(time.slice(0, 2)) + 3).padStart(2, "0")}:${time.slice(3)}:00.000Z`,
  time,
  available: true,
  reason: null,
  used: 0,
  cap: 1,
  patientConflict: null,
  ...over,
});

const grid = (over: Partial<PractitionerSlots> = {}): PractitionerSlots => ({
  mode: "practitioner",
  dayKey: "2026-10-05",
  practitionerId: "p1",
  serviceId: "svc",
  durationMin: 45,
  cap: 1,
  stepMin: 30,
  serviceEnabled: true,
  acceptsInsurer: true,
  isFallbackSchedule: false,
  dayLockState: { status: "open", reason: null, detail: null, blockIds: [] },
  slots: [slot("10:00", { available: false, reason: "otro-servicio" }), slot("10:30"), slot("11:00")],
  ...over,
});

const anyData = (steps: number[], over: Partial<AnySlots> = {}): AnySlots => ({
  mode: "any",
  dayKey: "2026-10-05",
  serviceId: "svc",
  stepMin: 15,
  practitioners: steps.map((s, i) => ({
    practitionerId: `p${i + 1}`,
    durationMin: 45,
    cap: 1,
    stepMin: s,
    firstSlot: slot("10:30"),
    availableCount: 2,
  })),
  firstFree: null,
  ...over,
});

const noop = () => {};
const anyProps = (data: AnySlots, value: string | null = null) => ({
  data,
  today: "2026-10-05",
  labelOf: (id: string) => ({ p1: "Lic. Ana", p2: "Lic. Beto" })[id] ?? "Profesional",
  value,
  insurerAsked: false,
  onPick: noop,
  onUseFirstFree: noop,
  expanded: null,
  onExpand: noop,
  expandedState: { status: "idle" } as const,
  onRetryExpanded: noop,
});

describe("[CF-U2] selector: encabezado, chip «otro servicio» y fuera de grilla", () => {
  it("[CF-U2] encabezado con el paso que rige (30 / 45) y «según cada profesional» con pasos distintos", () => {
    expect(renderToStaticMarkup(<StepHeader data={grid({ stepMin: 30 })} />)).toContain("Horarios cada 30 min");
    expect(renderToStaticMarkup(<StepHeader data={grid({ stepMin: 45 })} />)).toContain("Horarios cada 45 min");
    expect(renderToStaticMarkup(<StepHeader data={anyData([30, 45])} />)).toContain("Horarios según cada profesional");
  });

  it("[CF-U2] el chip «otro-servicio» es elegible, lleva su nota corta (texto completo en aria/title) y la leyenda la nombra", () => {
    const html = renderToStaticMarkup(<PractitionerGrid data={grid()} value={null} onPick={noop} insurerAsked={false} />);
    const chip = html.match(/<button[^>]*aria-label="10:00[^"]*"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(chip).toContain("Atiende otro servicio: se carga como sobreturno si confirmás");
    expect(chip).not.toContain('aria-disabled="true"');
    expect(chip).toContain('title="Atiende otro servicio: se carga como sobreturno si confirmás"');
    expect(chip).toContain(">otro serv.</span>");
    expect(chip).not.toContain(">Atiende otro servicio</span>");
    expect(html).toContain("Atiende otro servicio (sobreturno)");
    // ZB B13: el chip «otro servicio» no prende «Cupo completo (sobreturno)» si ningún chip tiene el cupo lleno.
    expect(html).not.toContain("Cupo completo (sobreturno)");
  });

  it("[CF-U2] elegido fuera de la grilla (10:15 con paso 30): se avisa y no rompe la grilla", () => {
    const html = renderToStaticMarkup(
      <PractitionerGrid data={grid()} value={slot("10:15").iso} onPick={noop} insurerAsked={false} />
    );
    expect(html).toContain("Elegiste las 10:15, fuera de la grilla de cada 30 min: se valida al confirmar.");
    expect(html).not.toContain('aria-checked="true"');
    const inGrid = renderToStaticMarkup(
      <PractitionerGrid data={grid()} value={slot("10:30").iso} onPick={noop} insurerAsked={false} />
    );
    expect(inGrid).not.toContain("fuera de la grilla");
    expect(inGrid).toContain('aria-checked="true"');
  });

  it("[CF-U2] cualquiera: el primer libre 10:15 (CF-D6) se muestra con «Usar» aunque no esté en la grilla; paso por fila", () => {
    const ff = slot("10:15");
    const html = renderToStaticMarkup(
      <AnyView {...anyProps(anyData([30, 45], { firstFree: { practitionerId: "p1", iso: ff.iso, durationMin: 45, cap: 1 } }))} />
    );
    expect(html).toContain("Primer turno libre: Lic. Ana · Hoy · 10:15");
    expect(html).toContain(">Usar</button>");
    expect(html).toContain("· cada 30 min");
    expect(html).toContain("· cada 45 min");
    // Mismo paso para todos: el encabezado ya lo dice, las filas no lo repiten.
    expect(renderToStaticMarkup(<AnyView {...anyProps(anyData([30, 30]))} />)).not.toContain("· cada ");
  });
});

describe("[CF-U2] hora manual más visible y aviso en vivo", () => {
  it("[CF-U2] con selector: botón «¿Otro horario? Cargalo a mano» que apunta a la entrada manual; sin selector, no", () => {
    const html = renderToStaticMarkup(
      <ScheduleSection
        defaultISO="2026-10-05T13:00:00.000Z"
        durationMin={45}
        onDurationMinChange={noop}
        slotPicker={<div>picker</div>}
      />
    );
    const btn = html.match(/<button[^>]*>¿Otro horario\? Cargalo a mano<\/button>/)?.[0] ?? "";
    expect(btn).toContain('type="button"');
    expect(btn).toContain("k-btn-sm"); // 44 px en mobile (`.k-btn-sm` bajo 768)
    const controls = btn.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain(">Fecha y hora<");
    expect(html).not.toContain("o cargá a mano");
    const plain = renderToStaticMarkup(
      <ScheduleSection defaultISO="2026-10-05T13:00:00.000Z" durationMin={45} onDurationMinChange={noop} />
    );
    expect(plain).not.toContain("Cargalo a mano");
    expect(plain).toContain("Fecha y hora");
  });

  it("[CF-U2] aviso en vivo «otro-servicio» con el nombre del profesional", () => {
    const c: InstantCheck = {
      class: "otro-servicio",
      outOfHours: false,
      blocked: false,
      blockIds: [],
      blockReasons: [],
      used: 0,
      cap: 1,
      durationMin: 45,
      serviceEnabled: true,
      otherServiceBusy: true,
      otherServiceId: "svcB",
    };
    const html = renderToStaticMarkup(<InstantStatusBox check={c} iso="2026-10-05T13:00:00.000Z" practitionerName="Ana Pérez" />);
    expect(html).toContain("Atiende otro servicio");
    expect(html).toContain("En ese horario Ana Pérez atiende otro servicio. Se carga como sobreturno si confirmás.");
  });
});
