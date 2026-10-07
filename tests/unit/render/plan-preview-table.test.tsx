import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PLAN_PREVIEW_STALE_COPY,
  PlanPreviewTable,
  effectiveRowResolution,
  planPreviewSummaryLine,
  planRowDateLabel,
  planRowStatus,
  planPreviewOrdinalOf,
  previewTableCounts,
  resolutionOptions,
} from "@/components/planes/plan-preview-table";
import { formatARS } from "@/lib/format";
import type { PlanPreview, PlanPreviewRow, PlanRowFlags, PlanScheduleV1 } from "@/lib/plans-types";

/**
 * [P3-S18p] "Revisá los turnos" (C13): estados, resoluciones por fila, "Ya
 * pagada", stale y resumen. Se testean los builders puros y el markup de
 * `renderToStaticMarkup` (sin jsdom). El componente no llama actions.
 *
 * Fechas: los ISO van en UTC con el offset AR explícito (09:00 AR = 12:00Z),
 * así el test da lo mismo con TZ=UTC y TZ=AR.
 */

const flags = (over: Partial<PlanRowFlags> = {}): PlanRowFlags => ({
  blocked: false,
  outOfHours: false,
  capacityFull: false,
  patientOverlapIds: [],
  past: false,
  ...over,
});

const row = (over: Partial<PlanPreviewRow> & { index: number }): PlanPreviewRow => ({
  at: "2026-10-06T12:00:00.000Z", // mar 06/10 09:00 AR
  dayKey: "2026-10-06",
  flags: flags(),
  defaultResolution: "create",
  allowedResolutions: ["create", "move", "none"],
  priceCents: 1200000,
  ...over,
});

const SCHEDULE: PlanScheduleV1 = {
  v: 1,
  frequency: "weekly",
  slots: [
    { dow: 1, startMin: 540 },
    { dow: 4, startMin: 540 },
  ],
} as PlanScheduleV1;

function preview(rows: PlanPreviewRow[], extra: Partial<PlanPreview> = {}): PlanPreview {
  return {
    rows,
    stateToken: "abc",
    summary: {
      sessions: rows.length,
      bookings: 0,
      create: 0,
      move: 0,
      force: 0,
      adopt: 0,
      none: 0,
      markDone: 0,
      overbooked: 0,
      firstDayKey: null,
      lastDayKey: null,
    },
    otherActivePlans: [],
    ...extra,
  };
}

const noop = () => {};

describe("planRowStatus · estados C13 (precedencia del motor)", () => {
  it("cada flag da su copy literal", () => {
    expect(planRowStatus(row({ index: 1 })).label).toBe("Libre");
    expect(planRowStatus(row({ index: 1, flags: flags({ capacityFull: true }) })).label).toBe("Sobreturno");
    expect(planRowStatus(row({ index: 1, flags: flags({ outOfHours: true }) })).label).toBe("Fuera de horario");
    expect(planRowStatus(row({ index: 1, flags: flags({ blocked: true }) })).label).toBe("Bloqueado");
    expect(planRowStatus(row({ index: 1, flags: flags({ patientOverlapIds: ["b1"] }) })).label).toBe(
      "Se superpone con otro turno del paciente"
    );
    expect(planRowStatus(row({ index: 1, flags: flags({ past: true }) })).label).toBe("Ya pasó");
    expect(
      planRowStatus(row({ index: 1, flags: flags({ duplicate: { bookingId: "b", updatedAt: "x", adoptable: true } }) }))
        .label
    ).toBe("Ya tiene un turno a esa hora");
  });

  it("bloqueado con motivo (si el preview lo trae): 'Bloqueado: <motivo>'", () => {
    const r = { ...row({ index: 1, flags: flags({ blocked: true }) }), blockReason: "Feriado" };
    expect(planRowStatus(r).label).toBe("Bloqueado: Feriado");
  });

  it("precedencia: duplicado > pasado > bloqueado > fuera de horario > superposición > cupo", () => {
    const all = flags({
      blocked: true,
      outOfHours: true,
      capacityFull: true,
      patientOverlapIds: ["x"],
      past: true,
      duplicate: { bookingId: "b", updatedAt: "u", adoptable: false },
    });
    expect(planRowStatus(row({ index: 1, flags: all })).kind).toBe("duplicate");
    expect(planRowStatus(row({ index: 1, flags: { ...all, duplicate: undefined } })).kind).toBe("past");
    expect(planRowStatus(row({ index: 1, flags: { ...all, duplicate: undefined, past: false } })).kind).toBe("blocked");
    expect(
      planRowStatus(row({ index: 1, flags: { ...all, duplicate: undefined, past: false, blocked: false } })).kind
    ).toBe("out-of-hours");
    expect(
      planRowStatus(
        row({ index: 1, flags: { ...all, duplicate: undefined, past: false, blocked: false, outOfHours: false } })
      ).kind
    ).toBe("overlap");
  });

  it("fecha y hora en AR aunque el host esté en UTC", () => {
    expect(planRowDateLabel("2026-10-06T12:00:00.000Z")).toEqual({ day: "mar 06/10", time: "09:00" });
    // 01:30Z del 10/10 = 22:30 AR del vie 09/10 (borde de día)
    expect(planRowDateLabel("2026-10-10T01:30:00.000Z")).toEqual({ day: "vie 09/10", time: "22:30" });
  });
});

describe("resolutionOptions · resoluciones por fila", () => {
  it("libre: Crear / Mover (solo con sugerencia) / Dejar sin turno", () => {
    const opts = resolutionOptions(row({ index: 2, suggestion: "2026-10-09T13:30:00.000Z" }));
    expect(opts.map((o) => o.label)).toEqual(["Crear", "Mover a vie 09/10 · 10:30", "Dejar sin turno"]);
    expect(opts[1].resolution).toEqual({ index: 2, kind: "move", at: "2026-10-09T13:30:00.000Z" });
  });

  it("sin sugerencia no ofrece mover (no hay destino)", () => {
    expect(resolutionOptions(row({ index: 2 })).map((o) => o.value)).toEqual(["create", "none"]);
  });

  it("cupo lleno: 'Crear como sobreturno' con force.capacity", () => {
    const r = row({
      index: 3,
      flags: flags({ capacityFull: true }),
      defaultResolution: "none",
      allowedResolutions: ["move", "force", "none"],
    });
    const force = resolutionOptions(r).find((o) => o.value === "force");
    expect(force?.label).toBe("Crear como sobreturno");
    expect(force?.resolution).toEqual({ index: 3, kind: "force", force: { capacity: true } });
  });

  it("fuera de horario + superposición: 'Crear igual' cubre todas las flags forzables", () => {
    const r = row({
      index: 4,
      flags: flags({ outOfHours: true, patientOverlapIds: ["b9"] }),
      allowedResolutions: ["move", "force", "none"],
    });
    const force = resolutionOptions(r).find((o) => o.value === "force");
    expect(force?.label).toBe("Crear igual");
    expect(force?.resolution.force).toEqual({ outOfHours: true, patientOverlap: true });
  });

  it("bloqueado no se fuerza (aunque viniera 'force' en las permitidas)", () => {
    const r = row({
      index: 5,
      flags: flags({ blocked: true, outOfHours: true }),
      allowedResolutions: ["move", "force", "none"],
    });
    expect(resolutionOptions(r).map((o) => o.value)).not.toContain("force");
  });

  it("duplicado adoptable: 'Usar el turno existente' con bookingId + expectedUpdatedAt del preview", () => {
    const r = row({
      index: 6,
      flags: flags({ duplicate: { bookingId: "bk1", updatedAt: "2026-10-01T10:00:00.000Z", adoptable: true } }),
      defaultResolution: "adopt",
      allowedResolutions: ["adopt", "move", "none"],
    });
    const adopt = resolutionOptions(r).find((o) => o.value === "adopt");
    expect(adopt?.label).toBe("Usar el turno existente");
    expect(adopt?.resolution).toEqual({
      index: 6,
      kind: "adopt",
      bookingId: "bk1",
      expectedUpdatedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(effectiveRowResolution(r, {})).toEqual(adopt?.resolution);
  });

  it("pasada: 'Marcar como realizada' y 'Dejar sin turno'", () => {
    const r = row({
      index: 7,
      flags: flags({ past: true }),
      defaultResolution: "none",
      allowedResolutions: ["none", "mark-done", "move"],
    });
    const labels = resolutionOptions(r).map((o) => o.label);
    expect(labels).toContain("Marcar como realizada");
    expect(labels).toContain("Dejar sin turno");
  });

  it("quien solo agenda (scheduleOnlyPreview) no ve adoptar ni marcar realizada", () => {
    // `scheduleOnlyPreview` del server ya filtra `allowedResolutions`: la tabla
    // no inventa opciones que el preview no trae.
    const r = row({
      index: 8,
      flags: flags({ past: true, duplicate: { bookingId: "bk", updatedAt: "u", adoptable: true } }),
      defaultResolution: "none",
      allowedResolutions: ["none", "move"],
    });
    const values = resolutionOptions(r).map((o) => o.value);
    expect(values).not.toContain("adopt");
    expect(values).not.toContain("mark-done");
  });

  it("la elegida manda sobre la de defecto; la de defecto 'move' usa la sugerencia", () => {
    const r = row({ index: 9, defaultResolution: "move", suggestion: "2026-10-07T12:00:00.000Z" });
    expect(effectiveRowResolution(r, {})).toEqual({ index: 9, kind: "move", at: "2026-10-07T12:00:00.000Z" });
    expect(effectiveRowResolution(r, { 9: { index: 9, kind: "none" } })).toEqual({ index: 9, kind: "none" });
  });
});

describe("resumen", () => {
  const rows = [
    row({ index: 1 }),
    row({ index: 2, at: "2026-10-09T12:00:00.000Z", dayKey: "2026-10-09" }),
    row({
      index: 3,
      at: "2026-10-13T12:00:00.000Z",
      dayKey: "2026-10-13",
      flags: flags({ capacityFull: true }),
      defaultResolution: "move",
      allowedResolutions: ["move", "force", "none"],
      suggestion: "2026-10-13T13:30:00.000Z",
    }),
    row({
      index: 4,
      at: "2026-11-13T12:00:00.000Z",
      dayKey: "2026-11-13",
      flags: flags({ blocked: true }),
      defaultResolution: "none",
      allowedResolutions: ["move", "none"],
    }),
  ];

  it("cuenta por resolución efectiva (las elegidas mandan)", () => {
    const c = previewTableCounts(preview(rows), {});
    expect(c).toMatchObject({ sessions: 4, created: 2, moved: 1, none: 1, bookings: 3, firstDayKey: "2026-10-06" });
    expect(c.lastDayKey).toBe("2026-11-13");
    const c2 = previewTableCounts(preview(rows), { 1: { index: 1, kind: "none" } });
    expect(c2).toMatchObject({ created: 1, none: 2, bookings: 2 });
  });

  it("línea C13: sesiones · nuevos · movido · sin turno · horario · fechas · precio", () => {
    const line = planPreviewSummaryLine(previewTableCounts(preview(rows), {}), SCHEDULE, {
      mode: "PACKAGE",
      totalPriceCents: 12000000,
    });
    expect(line).toBe(
      `4 sesiones · 2 turnos nuevos · 1 movido · 1 sin turno · lun y jue 09:00 · 06/10 → 13/11 · Paquete ${formatARS(12000000)}`
    );
  });

  it("sin precio: 'Sin precio · sigue la cobertura'; por sesión: 'Por sesión $X'", () => {
    const c = previewTableCounts(preview([row({ index: 1 })]), {});
    expect(planPreviewSummaryLine(c, null, null)).toBe(
      "1 sesión · 1 turno nuevo · 06/10 → 06/10 · Sin precio · sigue la cobertura"
    );
    expect(planPreviewSummaryLine(c, null, { mode: "PER_SESSION", pricePerSessionCents: 500000 })).toContain(
      `Por sesión ${formatARS(500000)}`
    );
  });

  it("avisos de autorización de la OS solo si vienen las flags", () => {
    const withAuth = [
      row({ index: 1, flags: flags({ overAuthorization: false, afterAuthorizationExpiry: false }) }),
      row({ index: 2, flags: flags({ overAuthorization: true, afterAuthorizationExpiry: true }) }),
    ];
    const c = previewTableCounts(preview(withAuth), {});
    expect(c.overAuthorization).toBe(1);
    expect(c.afterExpiry).toBe(1);
    const html = renderToStaticMarkup(
      <PlanPreviewTable
        preview={preview(withAuth)}
        resolutions={{}}
        onResolutionChange={noop}
        schedule={null}
        pricing={null}
      />
    );
    expect(html).toContain("1 sesión supera las autorizadas por la obra social");
    expect(html).toContain("1 sesión cae después del vencimiento de la autorización");

    const sinAuth = renderToStaticMarkup(
      <PlanPreviewTable preview={preview(rows)} resolutions={{}} onResolutionChange={noop} schedule={null} pricing={null} />
    );
    expect(sinAuth).not.toContain("autoriza");
  });
});

describe("PlanPreviewTable (markup)", () => {
  it("encabezado C13, una fila por sesión, chip no cromático + texto, precio con formatARS", () => {
    const html = renderToStaticMarkup(
      <PlanPreviewTable
        preview={preview([row({ index: 1 }), row({ index: 2, flags: flags({ capacityFull: true }), allowedResolutions: ["move", "force", "none"], defaultResolution: "none" })])}
        resolutions={{}}
        onResolutionChange={noop}
        schedule={SCHEDULE}
        pricing={{ mode: "PER_SESSION", pricePerSessionCents: 1200000 }}
      />
    );
    for (const h of [">#<", ">Día<", ">Hora<", ">Estado<", ">Resolución<", ">Precio<"]) expect(html).toContain(h);
    expect(html.match(/data-plan-row=/g)?.length).toBe(2);
    expect(html).toContain("mar 06/10");
    expect(html).toContain(">09:00<");
    expect(html).toContain("Libre");
    expect(html).toContain("Sobreturno");
    expect(html).toContain('data-status="capacity"');
    expect(html).toContain(formatARS(1200000));
    // el select de la fila 2 tiene "Crear como sobreturno" y arranca en "Dejar sin turno"
    expect(html).toContain("Crear como sobreturno");
    expect(html).toMatch(/<option value="none" selected="">Dejar sin turno<\/option>/);
    expect(html).toContain('aria-label="Qué hacer con la sesión 2"');
    // scroll propio en mobile
    expect(html).toContain("overflow-x:auto");
  });

  it("'Ya pagada en el turno del dd/mm' (fecha AR)", () => {
    const html = renderToStaticMarkup(
      <PlanPreviewTable
        preview={preview([row({ index: 1, flags: flags({ priorPaid: { bookingId: "p", at: "2026-10-02T01:00:00.000Z" } }) })])}
        resolutions={{}}
        onResolutionChange={noop}
        schedule={null}
        pricing={null}
      />
    );
    // 01:00Z del 02/10 = 22:00 AR del 01/10
    expect(html).toContain("Ya pagada en el turno del 01/10");
  });

  it("stale: banner C13 y filas marcadas", () => {
    const html = renderToStaticMarkup(
      <PlanPreviewTable
        preview={preview([row({ index: 1 }), row({ index: 2 })])}
        resolutions={{}}
        onResolutionChange={noop}
        staleIndexes={new Set([2])}
        schedule={null}
        pricing={null}
      />
    );
    expect(PLAN_PREVIEW_STALE_COPY).toBe(
      "La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo."
    );
    expect(html).toContain(PLAN_PREVIEW_STALE_COPY);
    expect(html.match(/data-stale="true"/g)?.length).toBe(1);
    expect(html).toContain("Revisá esta fila");

    const clean = renderToStaticMarkup(
      <PlanPreviewTable preview={preview([row({ index: 1 })])} resolutions={{}} onResolutionChange={noop} schedule={null} pricing={null} />
    );
    expect(clean).not.toContain(PLAN_PREVIEW_STALE_COPY);
  });

  it("otro plan activo: copy C13 sin título", () => {
    const html = renderToStaticMarkup(
      <PlanPreviewTable
        preview={preview([row({ index: 1 })], {
          otherActivePlans: [{ programId: "p1", discipline: "KINESIOLOGY", ordinal: 3, total: 10 }],
        })}
        resolutions={{}}
        onResolutionChange={noop}
        schedule={null}
        pricing={null}
      />
    );
    expect(html).toContain("Este paciente ya tiene el plan Kine (3/10) activo.");
  });

  it("disabled deshabilita los selects; la tabla no llama al callback al renderizar", () => {
    const spy = vi.fn();
    const html = renderToStaticMarkup(
      <PlanPreviewTable preview={preview([row({ index: 1 })])} resolutions={{}} onResolutionChange={spy} schedule={null} pricing={null} disabled />
    );
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * [P3-Z F2 #1] La columna "#" y el aria muestran el ORDINAL (M13), no el
 * `index` fijo: con una sesión archivada, "Generar pendientes" mostraba 4…10
 * en un plan que la card cuenta como 3…9.
 */
describe("PlanPreviewTable · ordinal (M13)", () => {
  const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00.000Z`;
  // Plan de 10: la 1 y la 2 hechas, la 3 archivada, 4…10 pendientes.
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i + 1}`,
    index: i + 1,
    scheduledFor: day(i + 1),
    archivedAt: i + 1 === 3 ? "2026-10-02T12:00:00.000Z" : null,
  }));
  const pending = sessions.filter((s) => s.index >= 4).map((s) => row({ index: s.index, sessionId: s.id, at: s.scheduledFor, dayKey: s.scheduledFor.slice(0, 10) }));

  it("generar pendientes con la 3 archivada: muestra 3…9 (columna y aria)", () => {
    const pv = preview(pending);
    const ordinalOf = planPreviewOrdinalOf(pv, { sessions });
    expect(pending.map((r) => ordinalOf(r))).toEqual([3, 4, 5, 6, 7, 8, 9]);
    const html = renderToStaticMarkup(
      <PlanPreviewTable preview={pv} resolutions={{}} onResolutionChange={noop} schedule={null} pricing={null} ordinalOf={ordinalOf} />
    );
    expect(html).toContain('aria-label="Qué hacer con la sesión 3"');
    expect(html).toContain('aria-label="Qué hacer con la sesión 9"');
    expect(html).not.toContain('aria-label="Qué hacer con la sesión 10"');
    expect(html).toMatch(/data-plan-row="4"[^>]*><td[^>]*>3<\/td>/);
  });

  it("agregar al final sin el detalle: totalLive + posición", () => {
    const pv = preview([row({ index: 11, at: day(20) }), row({ index: 12, at: day(22) })]);
    const ordinalOf = planPreviewOrdinalOf(pv, { totalLive: 9 });
    expect(pv.rows.map((r) => ordinalOf(r))).toEqual([10, 11]);
  });

  it("sesión a medida con el detalle: el ordinal sale por fecha entre las vivas", () => {
    const pv = preview([row({ index: 11, at: "2026-10-05T15:00:00.000Z" })]); // entre la 5 y la 6
    expect(planPreviewOrdinalOf(pv, { sessions })(pv.rows[0])).toBe(5);
  });

  it("sin ordinalOf (alta) sigue row.index", () => {
    const html = renderToStaticMarkup(
      <PlanPreviewTable preview={preview([row({ index: 1 }), row({ index: 2 })])} resolutions={{}} onResolutionChange={noop} schedule={null} pricing={null} />
    );
    expect(html).toContain('aria-label="Qué hacer con la sesión 2"');
  });
});
