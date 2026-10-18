import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// T3e-2u2 (C-AS3): UI del tope por intervalo en el drawer (reprogramar, editar,
// sala, cambiar estado), la vista Turnos del paciente, el menú del dashboard, la
// card del plan (reprogramar sesión) y el preview de plan. Render real con
// `react-dom/server` (sin jsdom); se mockean SOLO las server actions, toast,
// confirm y navegación.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/patient-search", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/plans-lifecycle", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/plan-templates", () => proxy());

import { RescheduleForm } from "@/components/agenda/booking-drawer/reschedule-form";
import { EditDetailsForm } from "@/components/agenda/booking-drawer/edit-details-form";
import { roomChangeOutcome } from "@/components/agenda/booking-drawer/room-row";
import { MAX_FORCE_ATTEMPTS, retryWithForce, successInfoText } from "@/components/agenda/booking-drawer/force-outcome";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { RESCHEDULE_FORCE_LABEL, rescheduleForceFor } from "@/components/planes/plan-card";
import { PlanPreviewTable, previewTableCounts } from "@/components/planes/plan-preview-table";
import {
  FORCE_PROMPT_ORDER,
  forcePromptConfirm,
  nextForcePrompt,
  type ForceFlags,
  type ForceableResult,
} from "@/lib/booking-force-flags";
import { INTERVAL_CAP_ERROR, PRACTITIONER_CONFLICT_ERROR, isIntervalCapError } from "@/lib/bookings-constants";
import type { PlanPreview, PlanPreviewRow, PlanRowFlags } from "@/lib/plans-types";

const CAP = { practitionerName: "Ana Pérez", used: 2, cap: 2, fromTime: "10:00", toTime: "11:00", nextFreeISO: null };
const HEADLINE = "Ana Pérez ya tiene 2 turnos entre las 10:00 y las 11:00 (tope: 2).";
const capResult = { ok: false as const, error: "tope", intervalCap: CAP };

const noop = () => {};

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-06T13:00:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 1_200_000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    ...over,
  };
}

describe("[AS-2u2] drawer · reprogramar y editar con el tope por intervalo", () => {
  const prompt = nextForcePrompt(capResult)!;

  it("reprogramar: banner con el copy de C-AS3 y «Cargar como sobreturno»", () => {
    const html = renderToStaticMarkup(
      <RescheduleForm
        value="2026-10-06T10:00"
        onChange={noop}
        pending={false}
        conflict={prompt}
        onSubmit={noop}
        onUseNextFree={noop}
        onForce={noop}
        onDismissConflict={noop}
      />
    );
    expect(html).toContain(HEADLINE);
    expect(html).toContain("Cargar como sobreturno");
  });

  it("editar (duración): mismo banner y botón", () => {
    const html = renderToStaticMarkup(
      <EditDetailsForm
        booking={booking()}
        clinicalWritable={false}
        notesWritable={false}
        values={{ duration: 60, title: "", description: "", notes: "" }}
        pending={false}
        conflict={prompt}
        onPatientChange={noop}
        onChange={noop}
        onApplyAsPatientDiagnosis={noop}
        onSubmit={noop}
        onForce={noop}
        onDismissConflict={noop}
      />
    );
    expect(html).toContain(HEADLINE);
    expect(html).toContain("Cargar como sobreturno");
  });

  it("cambiar la sala: si vuelve el tope, confirma «Cargar como sobreturno» y reenvía allowIntervalCap", () => {
    const o = roomChangeOutcome(capResult, {});
    expect(o.kind).toBe("confirm");
    if (o.kind !== "confirm") return;
    expect(o.options.title).toBe(HEADLINE);
    expect(o.options.confirmLabel).toBe("Cargar como sobreturno");
    expect(o.next).toEqual({ allowIntervalCap: true });
    // Ya forzado y vuelve igual: error real, sin loop.
    expect(roomChangeOutcome(capResult, { allowIntervalCap: true }).kind).toBe("error");
  });

  it("cambiar estado (reactivar) desde el drawer y la vista Turnos: «Reactivar como sobreturno»", () => {
    const c = forcePromptConfirm(prompt, "reactivate");
    expect(c.title).toBe(HEADLINE);
    expect(c.confirmLabel).toBe("Reactivar como sobreturno");
    expect(c.message).toBe("Si lo reactivás, queda como sobreturno.");
  });

  it("menú del dashboard (cambia estado con action «edit»): «Cargar como sobreturno»", () => {
    const c = forcePromptConfirm(prompt, "edit");
    expect(c.confirmLabel).toBe("Cargar como sobreturno");
  });

  it("ok con el 2.º turno del intervalo: aviso informativo (sin confirmar) junto al notice del plan", () => {
    expect(successInfoText({})).toBeNull();
    expect(successInfoText({ intervalCapNotice: { practitionerName: "Ana", used: 1, time: "10:00" } })).toBe(
      "Ya hay 1 turno de Ana a las 10:00."
    );
    expect(
      successInfoText({ notice: "La sesión queda realizada.", intervalCapNotice: { practitionerName: "Ana", used: 2, time: "10:00" } })
    ).toBe("La sesión queda realizada. Ya hay 2 turnos de Ana a las 10:00.");
  });
});

describe("[AS-2u2] retryWithForce (vista Turnos del paciente)", () => {
  it("el tope pide confirmar y la segunda llamada lleva allowIntervalCap", async () => {
    const calls: ForceFlags[] = [];
    const asked: string[] = [];
    const out = await retryWithForce(
      async (force) => {
        calls.push(force);
        return force.allowIntervalCap ? { ok: true as const, data: { updatedAt: "x" } } : capResult;
      },
      async (o) => {
        asked.push(o.confirmLabel);
        return true;
      },
      "reactivate"
    );
    expect(out.kind).toBe("ok");
    expect(calls).toEqual([{}, { allowIntervalCap: true }]);
    expect(asked).toEqual(["Reactivar como sobreturno"]);
  });

  it("cancelar el confirm no re-llama", async () => {
    let n = 0;
    const out = await retryWithForce(async () => (n++, capResult), async () => false, "reactivate");
    expect(out).toEqual({ kind: "cancelled" });
    expect(n).toBe(1);
  });

  it("encadena los seis avisos (antes el loop fijo de 5 intentos salía sin la última llamada)", async () => {
    expect(MAX_FORCE_ATTEMPTS).toBe(FORCE_PROMPT_ORDER.length + 1);
    const all: ForceableResult = {
      blocked: { practitionerName: "Ana", reason: null, nextFreeISO: null },
      outOfHours: { practitionerName: "Ana", nextFreeISO: null },
      conflict: { practitionerName: "Ana", nextFreeISO: null },
      intervalCap: CAP,
      patientOverlap: { existingISO: "2026-10-06T13:00:00.000Z" },
      roomBusy: { roomName: "Box 1", nextFreeISO: null },
    };
    let last: ForceFlags = {};
    const out = await retryWithForce(
      async (force) => {
        last = force;
        return nextForcePrompt(all, force) ? { ok: false as const, error: "x", ...all } : { ok: true as const };
      },
      async () => true,
      "reactivate"
    );
    expect(out.kind).toBe("ok");
    expect(last.allowIntervalCap).toBe(true);
    expect(last.allowRoomConflict).toBe(true);
  });

  it("un rechazo no forzable vuelve como error con el texto del server", async () => {
    const out = await retryWithForce(async () => ({ ok: false as const, error: "Cambió en otra pestaña" }), async () => true, "edit");
    expect(out).toEqual({ kind: "error", error: "Cambió en otra pestaña" });
  });
});

describe("[AS-2u2] card del plan · reprogramar sesión con el tope", () => {
  const msg = INTERVAL_CAP_ERROR({ practitionerName: "Ana Pérez", used: 2, cap: 2, fromTime: "10:00", toTime: "11:00" });

  it("el texto del tope se mapea a allowIntervalCap (y el de cupo sigue en allowOverbooking)", () => {
    expect(isIntervalCapError(msg)).toBe(true);
    expect(rescheduleForceFor(msg)).toBe("allowIntervalCap");
    expect(rescheduleForceFor(INTERVAL_CAP_ERROR({ used: 1, cap: 1, fromTime: "09:00", toTime: "09:30" }))).toBe(
      "allowIntervalCap"
    );
    expect(rescheduleForceFor(PRACTITIONER_CONFLICT_ERROR)).toBe("allowOverbooking");
  });

  it("botón «Moverlo igual (queda como sobreturno)»", () => {
    expect(RESCHEDULE_FORCE_LABEL.allowIntervalCap).toBe("Moverlo igual (queda como sobreturno)");
  });
});

describe("[AS-2u2] preview de plan · aviso no bloqueante del tope", () => {
  const flags = (over: Partial<PlanRowFlags> = {}): PlanRowFlags => ({
    blocked: false,
    outOfHours: false,
    capacityFull: false,
    patientOverlapIds: [],
    past: false,
    ...over,
  });
  const row = (index: number, over: Partial<PlanRowFlags> = {}): PlanPreviewRow => ({
    index,
    at: "2026-10-06T12:00:00.000Z",
    dayKey: "2026-10-06",
    flags: flags(over),
    defaultResolution: "create",
    allowedResolutions: ["create", "move", "none"],
    priceCents: null,
  });
  const preview = (rows: PlanPreviewRow[]): PlanPreview => ({
    rows,
    stateToken: "t",
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
  });
  const render = (p: PlanPreview) =>
    renderToStaticMarkup(
      <PlanPreviewTable preview={p} resolutions={{}} onResolutionChange={noop} schedule={null} pricing={null} />
    );

  it("la fila con overIntervalCap lleva el aviso y el resumen lo cuenta; la resolución no cambia", () => {
    const p = preview([row(1, { overIntervalCap: true }), row(2), row(3, { overIntervalCap: true })]);
    const html = render(p);
    expect(html.match(/Supera el tope de turnos del profesional/g)?.length).toBe(2);
    expect(html).toContain("2 sesiones superan el tope de turnos del profesional.");
    const c = previewTableCounts(p, {});
    expect(c.overIntervalCap).toBe(2);
    // No bloquea: se siguen creando las tres.
    expect(c.created).toBe(3);
  });

  it("sin la flag no hay aviso", () => {
    const html = render(preview([row(1), row(2, { overIntervalCap: false })]));
    expect(html).not.toContain("tope de turnos");
  });
});
