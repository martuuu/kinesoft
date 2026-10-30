import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// CF-U1b (§28, decisión 2: el staff «avisa y deja forzar»): el aviso «otro
// servicio» en los callers que ya manejaban los forzables (drawer: reprogramar,
// editar, sala, cambiar estado; vista Turnos; menú del dashboard) y en la card
// del plan (reprogramar sesión, que solo recibe el texto). Render real con
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
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
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
import { roomChangeOutcome } from "@/components/agenda/booking-drawer/room-row";
import { retryWithForce } from "@/components/agenda/booking-drawer/force-outcome";
import { RESCHEDULE_FORCE_LABEL, rescheduleForceFor } from "@/components/planes/plan-card";
import { forcePromptConfirm, nextForcePrompt, type ForceFlags } from "@/lib/booking-force-flags";
import { OTHER_SERVICE_ERROR, PRACTITIONER_CONFLICT_ERROR, isOtherServiceError } from "@/lib/bookings-constants";

const OTHER = {
  practitionerName: "Ana Pérez",
  serviceName: "Osteopatía",
  existingISO: "2026-11-03T13:00:00.000Z",
  nextFreeISO: "2026-11-03T14:00:00.000Z",
};
const HEADLINE = "Ana Pérez está atendiendo «Osteopatía» en ese horario.";
const otherResult = { ok: false as const, error: OTHER_SERVICE_ERROR(OTHER), otherService: OTHER };
const noop = () => {};

describe("[CF-U1b] drawer · aviso «otro servicio»", () => {
  const prompt = nextForcePrompt(otherResult)!;

  it("el resultado con otherService pide confirmación con el flag allowOtherService", () => {
    expect(prompt.kind).toBe("otherService");
    expect(prompt.flag).toBe("allowOtherService");
    // Sin nombre de servicio: copy genérico.
    const generic = nextForcePrompt({ otherService: { ...OTHER, serviceName: null } })!;
    expect(forcePromptConfirm(generic, "edit").title).toBe("Ana Pérez está atendiendo otro servicio en ese horario.");
  });

  it("reprogramar: banner con el detalle, «Usar próximo libre» en hora AR y «Cargar como sobreturno»", () => {
    const html = renderToStaticMarkup(
      <RescheduleForm
        value="2026-11-03T10:00"
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
    // 14:00Z = 11:00 AR (TZ=UTC no lo esconde: el banner pasa timeZone explícito).
    expect(html).toContain("11:00");
  });

  it("cambiar la sala: si vuelve otro servicio, confirma y reenvía allowOtherService (sin loop si ya se mandó)", () => {
    const o = roomChangeOutcome(otherResult, {});
    expect(o.kind).toBe("confirm");
    if (o.kind !== "confirm") return;
    expect(o.options.title).toBe(HEADLINE);
    expect(o.next).toEqual({ allowOtherService: true });
    expect(roomChangeOutcome(otherResult, { allowOtherService: true }).kind).toBe("error");
  });

  it("cambiar estado (drawer / vista Turnos / dashboard): «Reactivar como sobreturno» / «Cargar como sobreturno»", () => {
    expect(forcePromptConfirm(prompt, "reactivate")).toEqual({
      title: HEADLINE,
      message: "Si lo reactivás, queda como sobreturno.",
      confirmLabel: "Reactivar como sobreturno",
    });
    expect(forcePromptConfirm(prompt, "edit").confirmLabel).toBe("Cargar como sobreturno");
  });
});

describe("[CF-U1b] retryWithForce (vista Turnos del paciente)", () => {
  it("otro servicio pide confirmar y el reintento acumula allowOtherService con el resto de los flags", async () => {
    const calls: ForceFlags[] = [];
    const asked: string[] = [];
    const out = await retryWithForce(
      async (force) => {
        calls.push(force);
        if (!force.allowOverbooking) return { ok: false as const, error: "cupo", conflict: { practitionerName: "Ana Pérez", nextFreeISO: null } };
        if (!force.allowOtherService) return otherResult;
        return { ok: true as const };
      },
      async (o) => {
        asked.push(o.title);
        return true;
      },
      "reactivate"
    );
    expect(out.kind).toBe("ok");
    expect(calls).toEqual([{}, { allowOverbooking: true }, { allowOverbooking: true, allowOtherService: true }]);
    expect(asked[1]).toBe(HEADLINE);
  });
});

describe("[CF-U1b] card del plan · reprogramar sesión con otro servicio", () => {
  it("el rechazo genérico de rescheduleSession se mapea a allowOtherService", () => {
    const generic = OTHER_SERVICE_ERROR({});
    expect(isOtherServiceError(generic)).toBe(true);
    expect(rescheduleForceFor(generic)).toBe("allowOtherService");
    expect(rescheduleForceFor(OTHER_SERVICE_ERROR(OTHER))).toBe("allowOtherService");
    // El cupo del mismo servicio sigue en su flag.
    expect(rescheduleForceFor(PRACTITIONER_CONFLICT_ERROR)).toBe("allowOverbooking");
  });

  it("botón «Moverlo igual (queda como sobreturno)»", () => {
    expect(RESCHEDULE_FORCE_LABEL.allowOtherService).toBe("Moverlo igual (queda como sobreturno)");
  });
});
