/**
 * [P3-S20] Seguimiento (C13): bucket "Sin turno" con "Agendar", "Sin
 * evolución" → "Cargar evolución", banner de alta (D22) y "Sesión n de N" por
 * ORDINAL (M13), nunca por `index`.
 *
 * Render estático (`renderToStaticMarkup`, sin jsdom): se mockean solo las
 * server actions (red) y `next/navigation`; los componentes son los reales.
 * Fechas en UTC con el offset AR explícito: da lo mismo con TZ=UTC y TZ=AR.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
// El modal "Agendar" es lazy (`next/dynamic`, gate de bundle P3.Z): sin el
// runtime de Next no se resuelve el import, así que el stub expone las props
// con las que se lo montaría. Se mockea el framework, no el modal.
vi.mock("next/dynamic", () => ({
  default: () => (p: { open?: boolean; sessionLabel?: string }) =>
    React.createElement("div", { "data-lazy-schedule-open": String(!!p.open), "data-label": p.sessionLabel ?? "" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/sessions", () => ({
  addSessionExercise: async () => ({ ok: true, data: undefined }),
  completeSessionFromSeguimiento: async () => ({ ok: true, data: { alreadyCompleted: false, programCompleted: false } }),
  loadSessionEvolution: async () => ({ ok: true, data: { loaded: true } }),
  removeSessionExercise: async () => ({ ok: true, data: undefined }),
  reorderSessionExercises: async () => ({ ok: true, data: undefined }),
  updateSessionExercise: async () => ({ ok: true, data: undefined }),
  updateSessionMeta: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/plans-adopt", () => ({
  previewGeneratePlanBookings: async () => ({ ok: false, error: "x" }),
  generatePlanBookings: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/exercises", () => ({ listExercises: async () => [] }));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { SeguimientoLanding } from "@/components/seguimiento/seguimiento-landing";
import { SessionDetail, urlWithoutAgendarParam, type SessionDTO } from "@/components/seguimiento/session-detail";
import {
  dischargeCopy,
  isSessionWithoutEvolution,
  landingLenses,
  scheduleOutcome,
  sessionCounterLabel,
  sessionHeading,
  sessionHref,
  sortByOrdinal,
} from "@/components/seguimiento/seguimiento-model";
import type { OpenSessionBuckets, OpenSessionRow } from "@/lib/sessions-types";
import type { PlanPreview } from "@/lib/plans-types";

const html = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );

const row = (over: Partial<OpenSessionRow> & { id: string }): OpenSessionRow => ({
  index: 7,
  scheduledFor: new Date("2026-10-06T12:00:00.000Z"),
  completedAt: null,
  patientId: "pat1",
  patientName: "Ana Pérez",
  programTitle: "Lumbalgia",
  totalSessions: 12,
  exerciseCount: 0,
  doneCount: 0,
  ordinal: 3,
  totalLive: 10,
  ...over,
});

const EMPTY = { rows: [], total: 0 };
const buckets = (over: Partial<OpenSessionBuckets> = {}): OpenSessionBuckets => ({
  overdue: EMPTY,
  today: EMPTY,
  upcoming: EMPTY,
  recent: EMPTY,
  ...over,
});

// ─── Modelo puro ─────────────────────────────────────────────────────────────

describe("[P3-S20] modelo de Seguimiento", () => {
  it("'Sesión n de N' sale del ordinal y totalLive; sin ordinal = archivada", () => {
    expect(sessionCounterLabel(3, 10)).toBe("Sesión 3 de 10");
    expect(sessionCounterLabel(null, 10)).toBe("Sesión archivada");
    expect(sessionCounterLabel(undefined, undefined)).toBe("Sesión archivada");
  });

  it("una sesión a medida suma su Session.title", () => {
    expect(sessionHeading({ ordinal: 4, totalLive: 10, title: "Evaluación final" })).toBe(
      "Sesión 4 de 10 · Evaluación final"
    );
    expect(sessionHeading({ ordinal: 4, totalLive: 10, title: "  " })).toBe("Sesión 4 de 10");
    expect(sessionHeading({ ordinal: 4, totalLive: 10, title: null })).toBe("Sesión 4 de 10");
  });

  it("copy de alta literal C13", () => {
    expect(dischargeCopy(10)).toBe("Completó las 10 sesiones. ¿Le das el alta?");
    expect(dischargeCopy(1)).toBe("Completó la sesión. ¿Le das el alta?");
  });

  it("sin evolución = realizada, sin meta y con todos los ejercicios PENDING", () => {
    const base = { completedAt: new Date(), notes: null, rpe: null, paInPre: null, paInPost: null, exercises: [] };
    expect(isSessionWithoutEvolution(base)).toBe(true);
    expect(isSessionWithoutEvolution({ ...base, completedAt: null })).toBe(false);
    expect(isSessionWithoutEvolution({ ...base, notes: "bien" })).toBe(false);
    expect(isSessionWithoutEvolution({ ...base, paInPost: 0 })).toBe(false);
    expect(isSessionWithoutEvolution({ ...base, exercises: [{ status: "PENDING" }] })).toBe(true);
    expect(isSessionWithoutEvolution({ ...base, exercises: [{ status: "DONE" }] })).toBe(false);
  });

  it("el riel se ordena por fecha con empate por index (= ordinal), no por index", () => {
    const s = sortByOrdinal([
      { id: "a", index: 1, scheduledFor: new Date("2026-10-09T12:00:00Z") },
      { id: "b", index: 5, scheduledFor: new Date("2026-10-06T12:00:00Z") },
      { id: "c", index: 3, scheduledFor: new Date("2026-10-06T12:00:00Z") },
    ]);
    expect(s.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("los lentes marcan ids de sin turno / sin evolución", () => {
    const l = landingLenses({
      sinTurno: { rows: [row({ id: "s1" })], total: 1 },
      realizadasSinEvolucion: { rows: [row({ id: "s2" })], total: 1 },
    });
    expect(l.sinTurno.has("s1")).toBe(true);
    expect(l.sinEvolucion.has("s2")).toBe(true);
    expect(landingLenses({}).sinTurno.size).toBe(0);
  });

  it("href del detalle con y sin ?agendar=1", () => {
    expect(sessionHref("ses1")).toBe("/seguimiento/ses1");
    expect(sessionHref("ses1", { agendar: true })).toBe("/seguimiento/ses1?agendar=1");
  });

  it("resultado de generatePlanBookings → estado del modal", () => {
    const preview = { rows: [], stateToken: "t" } as unknown as PlanPreview;
    expect(scheduleOutcome({ ok: true, data: { createdBookings: 1, adoptedBookings: 0 } })).toEqual({
      kind: "done",
      message: "Turno agendado.",
    });
    expect(scheduleOutcome({ ok: true, data: { createdBookings: 1, adoptedBookings: 0 }, notice: "cobro previo" })).toMatchObject({
      notice: "cobro previo",
    });
    expect(scheduleOutcome({ ok: false, kind: "stale-preview", preview })).toMatchObject({ kind: "stale", preview });
    expect(scheduleOutcome({ ok: false, kind: "stale", error: "x" })).toMatchObject({ kind: "stale", preview: null });
    expect(scheduleOutcome({ ok: false, error: "No tenés permiso." })).toEqual({ kind: "error", message: "No tenés permiso." });
  });
});

// ─── Landing ─────────────────────────────────────────────────────────────────

describe("[P3-S20] landing de Seguimiento", () => {
  it("muestra el ordinal, nunca el index crudo", () => {
    const out = html(<SeguimientoLanding buckets={buckets({ today: { rows: [row({ id: "s1" })], total: 1 } })} plansEnabled />);
    expect(out).toContain("Sesión 3 de 10");
    expect(out).not.toContain("Sesión 7");
    expect(out).not.toContain("7 / 12");
  });

  it("bucket 'Sin turno' con 'Agendar' que abre el detalle con ?agendar=1", () => {
    const s = row({ id: "sinT1" });
    const out = html(
      <SeguimientoLanding
        buckets={buckets({ upcoming: { rows: [s], total: 1 }, sinTurno: { rows: [s], total: 1 } })}
        plansEnabled
      />
    );
    expect(out).toContain(">Sin turno<");
    expect(out).toContain('href="/seguimiento/sinT1?agendar=1"');
    expect(out).toContain(">Agendar<");
  });

  it("sin el módulo planes no se ofrece 'Agendar'", () => {
    const s = row({ id: "sinT1" });
    const out = html(<SeguimientoLanding buckets={buckets({ sinTurno: { rows: [s], total: 1 } })} plansEnabled={false} />);
    expect(out).not.toContain("?agendar=1");
    expect(out).not.toContain(">Agendar<");
  });

  it("'Sin evolución': tag en Realizadas y 'Cargar evolución'", () => {
    const s = row({ id: "ev1", completedAt: new Date("2026-10-05T13:00:00.000Z") });
    const out = html(
      <SeguimientoLanding
        buckets={buckets({ recent: { rows: [s], total: 1 }, realizadasSinEvolucion: { rows: [s], total: 1 } })}
        plansEnabled
      />
    );
    expect(out).toContain(">Sin evolución<");
    expect(out).toContain(">Cargar evolución<");
    // La realizada sin evolución no dice "Hecho".
    expect(out).not.toContain("Hecho");
  });

  it("banner de alta (D22) con link a la tab Planes del plan", () => {
    const out = html(
      <SeguimientoLanding
        buckets={buckets({
          suggestDischarge: {
            rows: [
              {
                programId: "prog1",
                patientId: "pat1",
                patientName: "Ana Pérez",
                programTitle: "Lumbalgia",
                discipline: "KINESIOLOGY",
                totalLive: 10,
                lastCompletedAt: new Date("2026-10-05T13:00:00.000Z"),
              },
            ],
            total: 1,
          },
        })}
        plansEnabled
      />
    );
    expect(out).toContain("Completó las 10 sesiones. ¿Le das el alta?");
    expect(out).toMatch(/href="\/pacientes\/pat1\?tab=planes(&amp;|&)programa=prog1"/);
  });

  it("buckets nuevos vacíos o ausentes no agregan secciones", () => {
    const out = html(<SeguimientoLanding buckets={buckets()} plansEnabled />);
    expect(out).not.toContain(">Sin turno<");
    expect(out).not.toContain(">Sin evolución<");
    expect(out).not.toContain("¿Le das el alta?");
  });
});

// ─── Detalle ─────────────────────────────────────────────────────────────────

function detail(over: Record<string, unknown> = {}, program: Record<string, unknown> = {}): SessionDTO {
  return {
    id: "ses3",
    programId: "prog1",
    practitionerId: "pr1",
    index: 7,
    scheduledFor: new Date("2026-10-06T12:00:00.000Z"),
    completedAt: null,
    notes: null,
    rpe: null,
    paInPre: null,
    paInPost: null,
    title: null,
    priceCents: null,
    archivedAt: null,
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ordinal: 3,
    totalLive: 10,
    exercises: [],
    program: {
      id: "prog1",
      patientId: "pat1",
      title: "Lumbalgia",
      discipline: "KINESIOLOGY",
      totalSessions: 12,
      patient: { id: "pat1", firstName: "Ana", lastName: "Pérez" },
      case: null,
      sessions: [
        { id: "ses3", index: 7, scheduledFor: new Date("2026-10-06T12:00:00.000Z"), completedAt: null, paInPre: null, paInPost: null },
      ],
      ...program,
    },
    ...over,
  } as unknown as SessionDTO;
}

describe("[P3-S20] detalle de sesión", () => {
  it("encabezado con 'Sesión n de N' (ordinal) y el título de la sesión a medida", () => {
    const out = html(<SessionDetail session={detail({ title: "Evaluación final" })} scheduledLabel="mar 06/10 09:00" />);
    expect(out).toContain("Sesión 3 de 10 · Evaluación final");
    expect(out).not.toContain("Sesión 7");
  });

  it("'Agendar' solo si la página dice que se puede (sin turno + plans.schedule)", () => {
    expect(html(<SessionDetail session={detail()} scheduledLabel="x" canSchedule />)).toContain(">Agendar<");
    expect(html(<SessionDetail session={detail()} scheduledLabel="x" />)).not.toContain(">Agendar<");
  });

  it("?agendar=1 abre el modal de agendar", () => {
    const out = html(<SessionDetail session={detail()} scheduledLabel="x" canSchedule autoOpenSchedule />);
    expect(out).toContain('data-lazy-schedule-open="true"');
    // Control: sin el param se monta cerrado.
    expect(html(<SessionDetail session={detail()} scheduledLabel="x" canSchedule />)).toContain('data-lazy-schedule-open="false"');
  });

  // P3.Z (F3b): el param quedaba en la URL → recargar, volver atrás o compartir
  // el link reabría el modal. Al montar se reemplaza la URL sin el param
  // (`history.replaceState`); el cálculo de la URL nueva es puro y va acá.
  it("[P3-Z-F3b] la URL sin ?agendar=1 conserva el resto (o null si no hay nada que limpiar)", () => {
    expect(urlWithoutAgendarParam("https://app.test/seguimiento/s1?agendar=1")).toBe("/seguimiento/s1");
    expect(urlWithoutAgendarParam("https://app.test/seguimiento/s1?x=2&agendar=1#n")).toBe("/seguimiento/s1?x=2#n");
    expect(urlWithoutAgendarParam("https://app.test/seguimiento/s1?x=2")).toBeNull();
    expect(urlWithoutAgendarParam("https://app.test/seguimiento/s1")).toBeNull();
  });

  it("realizada sin evolución → tag 'Sin evolución' y botón 'Cargar evolución'", () => {
    const out = html(
      <SessionDetail session={detail({ completedAt: new Date("2026-10-06T13:00:00.000Z") })} scheduledLabel="x" canSchedule />
    );
    expect(out).toContain(">Sin evolución<");
    expect(out).toContain("Cargar evolución");
    expect(out).not.toContain("Guardar anotaciones");
    // Realizada: no se agenda ni se cierra.
    expect(out).not.toContain(">Agendar<");
    expect(out).not.toContain("Cerrar sesión");
  });

  it("realizada con evolución → sin 'Cargar evolución'", () => {
    const out = html(
      <SessionDetail
        session={detail({ completedAt: new Date("2026-10-06T13:00:00.000Z"), notes: "Respondió bien" })}
        scheduledLabel="x"
      />
    );
    expect(out).not.toContain("Cargar evolución");
    expect(out).not.toContain(">Sin evolución<");
  });
});
