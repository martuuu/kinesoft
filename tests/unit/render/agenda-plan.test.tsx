import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BookingCard,
  bookingPlanMarks,
  planLooseSplit,
  planLooseSplitText,
  type BookingCardSizing,
} from "@/components/agenda/grid/booking-card";
import { ListView } from "@/components/agenda/views/list-view";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import { ReceptionRow } from "@/components/agenda/reception/reception-row";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { PlanLegend } from "@/components/agenda/plan-legend";
import { countPlanScope } from "@/lib/agenda-filters";

/**
 * [P3-S19a] Chip de plan (V1-D18) y "Fuera de plan" (V2) en las tarjetas de
 * Día/Por profesional (BookingCard), Lista, Semana y Recepción.
 *
 * Los DTO de la agenda llegan EXPANDIDOS (`expandPlanFields`): un suelto trae
 * `programId: null` y `[]`; sin el módulo `planes` todo viene neutro. Un DTO
 * sin C9 (proyección completa) trae `undefined` y no se adivina.
 */

const DAY = "2026-10-05"; // lunes
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T08:00:00-03:00`);
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const SIZING: BookingCardSizing = { flexBasis: 200 };
const noop = () => {};

/** Campos C9 neutros, como los deja `expandPlanFields` para un suelto sin plan. */
const NEUTRAL = {
  isOverbooked: false,
  programId: null,
  sessionId: null,
  pricedByPlan: false,
  plan: null,
  serviceDiscipline: "KINESIOLOGY" as const,
  patientActiveLinkedPlanDisciplines: [],
} satisfies Partial<BookingDTO>;

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: iso(h),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s-kine",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "p1",
    patientId: "pat",
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 0,
    updatedAt: iso("07:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    arrivedAt: null,
    attendingAt: null,
    ...NEUTRAL,
    ...over,
  };
}

/** Turno de plan Kine 3/10 con título (que nunca se tiene que ver). */
const PLAN = dto("plan", "09:00", {
  programId: "prog-1",
  sessionId: "ses-3",
  pricedByPlan: true,
  plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "Lumbalgia crónica" },
  patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
});
/** Suelto de Kine de un paciente con plan Kine vinculado activo → "Fuera de plan". */
const OUT = dto("out", "10:00", { patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"] });
/** Suelto de un paciente sin plan (o consultorio General): nada. */
const LOOSE = dto("loose", "11:00");

describe("[P3-S19a] bookingPlanMarks", () => {
  it("turno de plan → chip con disciplina/ordinal/total, nunca el título", () => {
    const m = bookingPlanMarks(PLAN);
    expect(m).toEqual({ chip: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10 }, outOfPlan: false });
    expect(JSON.stringify(m)).not.toContain("Lumbalgia");
  });

  it("suelto de la misma disciplina que un plan vinculado activo → Fuera de plan", () => {
    expect(bookingPlanMarks(OUT)).toEqual({ chip: null, outOfPlan: true });
  });

  it("suelto con plan de OTRA disciplina → nada", () => {
    expect(bookingPlanMarks(dto("x", "10:00", { patientActiveLinkedPlanDisciplines: ["OSTEOPATHY"] })).outOfPlan).toBe(false);
  });

  it("cancelado o sin paciente → nada", () => {
    expect(bookingPlanMarks({ ...OUT, status: "CANCELLED" }).outOfPlan).toBe(false);
    expect(bookingPlanMarks({ ...OUT, patientId: null }).outOfPlan).toBe(false);
  });

  it("General / neutro (sin módulo planes) → nada", () => {
    expect(bookingPlanMarks(LOOSE)).toEqual({ chip: null, outOfPlan: false });
  });

  it("sin C9 (proyección completa: undefined) → no adivina", () => {
    const full = dto("full", "10:00", {
      programId: undefined,
      plan: undefined,
      serviceDiscipline: undefined,
      patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
    });
    expect(bookingPlanMarks(full)).toEqual({ chip: null, outOfPlan: false });
  });
});

describe("[P3-S19a] BookingCard (Día y Por profesional)", () => {
  it("chip 'Kine · 3/10' con aria de sesión; el título del plan no sale", () => {
    const html = renderToStaticMarkup(<BookingCard b={PLAN} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(html).toContain(">Kine · 3/10<");
    expect(html).toContain('aria-label="Sesión 3 de 10 · Kinesiología"');
    expect(html).not.toContain("Lumbalgia");
    expect(html).not.toContain("Fuera de plan");
    // Chip ≠ pill de ocupación "2/3" de la celda por profesional.
    expect(html).not.toContain("data-occupancy");
    expect(html).toContain('data-discipline="KINESIOLOGY"');
  });

  it("la Secretaria (clinicalHidden) también ve el chip, sin título", () => {
    const html = renderToStaticMarkup(
      <BookingCard b={{ ...PLAN, clinicalHidden: true, plan: { ...PLAN.plan!, title: null } }} onEdit={noop} highlight={null} compact={false} sizing={SIZING} now={NOW} />
    );
    expect(html).toContain(">Kine · 3/10<");
  });

  it("legacy sin disciplina → 'Plan · 2/8'", () => {
    const b = dto("leg", "09:00", { programId: "p", plan: { discipline: null, ordinal: 2, totalLive: 8, title: null } });
    const html = renderToStaticMarkup(<BookingCard b={b} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(html).toContain(">Plan · 2/8<");
  });

  it("'Fuera de plan' en texto solo para el suelto con plan vinculado", () => {
    const out = renderToStaticMarkup(<BookingCard b={OUT} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(out).toContain(">Fuera de plan<");
    expect(out).toContain('data-badge="fuera-de-plan"');
    const loose = renderToStaticMarkup(<BookingCard b={LOOSE} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(loose).not.toContain("Fuera de plan");
    expect(loose).not.toContain("data-discipline");
  });

  it("el tooltip de la card suma la sesión y el aviso (canal de texto)", () => {
    const html = renderToStaticMarkup(<BookingCard b={PLAN} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(html).toContain("Sesión 3 de 10 · Kinesiología");
    const out = renderToStaticMarkup(<BookingCard b={OUT} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
    expect(out).toMatch(/title="[^"]*fuera de plan/);
  });
});

describe("[P3-S19a] ListView", () => {
  it("chip y 'Fuera de plan' por fila; sin nada en el suelto neutro", () => {
    const html = renderToStaticMarkup(<ListView bookings={[PLAN, OUT, LOOSE]} onEdit={noop} highlight={null} now={NOW} />);
    expect(html).toContain(">Kine · 3/10<");
    expect(html.match(/>Fuera de plan</g)).toHaveLength(1);
    expect(html).not.toContain("Lumbalgia");
  });

  it("código muerto: el subtítulo ya no cae a patientCondition (la liviana la trae null; PHI del plan 'take 1')", () => {
    const b = dto("c", "09:00", { patientCondition: "Condición del plan viejo" });
    const html = renderToStaticMarkup(<ListView bookings={[b]} onEdit={noop} highlight={null} now={NOW} />);
    expect(html).not.toContain("Condición del plan viejo");
  });
});

describe("[P3-S19a] Semana: conteo partido plan/suelto", () => {
  it("planLooseSplit cuenta por programId y no inventa sin C9", () => {
    expect(planLooseSplit([PLAN, OUT, LOOSE])).toEqual({ plan: 1, loose: 2 });
    expect(planLooseSplit([OUT, LOOSE])).toBeNull(); // sin turnos de plan no se parte
    expect(planLooseSplit([{ ...LOOSE, programId: undefined }])).toBeNull();
    expect(planLooseSplitText({ plan: 2, loose: 1 })).toBe("2 de plan · 1 suelto");
    expect(planLooseSplitText({ plan: 1, loose: 3 })).toBe("1 de plan · 3 sueltos");
    expect(planLooseSplitText({ plan: 2, loose: 0 })).toBe("2 de plan");
  });

  it("[P3-F3a] los cancelados no cuentan (igual que la leyenda, `countPlanScope`)", () => {
    const cancelledPlan = { ...PLAN, id: "plan-x", status: "CANCELLED" as const };
    const cancelledLoose = { ...LOOSE, id: "loose-x", status: "CANCELLED" as const };
    expect(planLooseSplit([PLAN, cancelledPlan, LOOSE, cancelledLoose])).toEqual({ plan: 1, loose: 1 });
    expect(countPlanScope([PLAN, cancelledPlan, LOOSE, cancelledLoose])).toEqual({ plan: 1, loose: 1 });
    // Solo cancelados de plan: no hay nada que partir.
    expect(planLooseSplit([cancelledPlan, LOOSE])).toBeNull();
  });

  const hours = { start: 8, end: 13, slotMinutes: 60 };
  it("la celda con turnos de plan muestra el conteo partido", () => {
    const html = renderToStaticMarkup(
      <WeekGridView
        weekDays={WEEK}
        bookings={[
          PLAN,
          dto("plan2", "09:00", { programId: "prog-1", plan: { discipline: "KINESIOLOGY", ordinal: 4, totalLive: 10, title: null } }),
          dto("l2", "09:00"),
          // [P3-F3a] un cancelado de plan en la misma celda no suma al conteo.
          dto("plan3", "09:00", { status: "CANCELLED", programId: "prog-1", plan: { discipline: "KINESIOLOGY", ordinal: 5, totalLive: 10, title: null } }),
        ]}
        onEdit={noop}
        businessHours={hours}
        showHeader
        showSaturday={false}
        showSunday={false}
        highlight={null}
      />
    );
    expect(html).toContain(">2 de plan · 1 suelto<");
    expect(html).not.toContain("Lumbalgia");
  });

  it("sin turnos de plan (General): la celda queda como siempre", () => {
    const html = renderToStaticMarkup(
      <WeekGridView weekDays={WEEK} bookings={[OUT, LOOSE]} onEdit={noop} businessHours={hours} showHeader showSaturday={false} showSunday={false} highlight={null} />
    );
    expect(html).not.toContain("de plan");
    expect(html).not.toContain("data-plan-split");
  });
});

describe("[P3-S19a] Recepción", () => {
  const row = (b: BookingDTO) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <ReceptionRow
            entry={{ row: b, state: "por-llegar", highlight: false, waitingMinutes: null, lateMinutes: null, actions: [] }}
            actions={[]}
            practitioner={null}
            now={NOW}
            canOperate={false}
            pending={false}
            onAction={noop}
            onOpen={noop}
          />
        </tbody>
      </table>
    );

  it("chip del plan junto al paciente, sin título", () => {
    const html = row(PLAN);
    expect(html).toContain(">Kine · 3/10<");
    expect(html).not.toContain("Lumbalgia");
  });

  it("'Fuera de plan' solo en el suelto con plan vinculado", () => {
    expect(row(OUT)).toContain(">Fuera de plan<");
    expect(row(LOOSE)).not.toContain("Fuera de plan");
    expect(row(LOOSE)).not.toContain("data-discipline");
  });
});

describe("[P3-F3a] PlanLegend a11y", () => {
  it("el conteo va en el aria-label del botón, no en un <span> sin role", () => {
    const html = renderToStaticMarkup(<PlanLegend highlight={null} onToggle={noop} counts={{ plan: 5, loose: 1 }} />);
    expect(html).toMatch(/<button[^>]*data-plan-scope="plan"[^>]*aria-label="De plan, 5 turnos"/);
    expect(html).toMatch(/<button[^>]*data-plan-scope="loose"[^>]*aria-label="Sueltos, 1 turno"/);
    expect(html).not.toMatch(/<span[^>]*aria-label=/);
    // Sin conteo, el botón se nombra por su texto.
    const bare = renderToStaticMarkup(<PlanLegend highlight={null} onToggle={noop} />);
    expect(bare).not.toContain("aria-label=\"De plan");
  });
});
