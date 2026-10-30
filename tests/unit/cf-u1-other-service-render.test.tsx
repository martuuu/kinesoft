import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// CF-U1 (§28, CF-D4): render real del aviso «otro servicio» del alta y de la marca en el resumen del lote. Sin jsdom
// (como `tests/unit/render`); se mockean solo las server actions y los hooks de toast/confirm.
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
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());

import * as prompts from "@/components/agenda/booking-modal/conflict-prompts";
import { BatchConflictPrompt } from "@/components/agenda/booking-modal/conflict-prompts";

const ref = { current: null };
const OS = {
  practitionerName: "Ana Pérez",
  serviceName: "Kinesiología",
  existingISO: "2027-03-09T13:00:00.000Z",
  nextFreeISO: "2027-03-09T14:30:00.000Z",
};

describe("[CF-U1] aviso «otro servicio» (alta de un turno)", () => {
  const El = (prompts as Record<string, unknown>).OtherServicePrompt as (p: Record<string, unknown>) => JSX.Element;
  const render = (otherService: typeof OS | (Omit<typeof OS, "serviceName" | "nextFreeISO"> & { serviceName: null; nextFreeISO: null })) =>
    renderToStaticMarkup(
      <El promptRef={ref} otherService={otherService} pending={false} onForce={() => {}} onBack={() => {}} />
    );

  it("[CF-U1] con nombre de servicio: titular, detalle en hora AR, próximo libre y las dos acciones", () => {
    const html = render(OS);
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("Ana Pérez está atendiendo «Kinesiología» en ese horario.");
    expect(html).toContain("Ese turno de Kinesiología empieza a las 10:00.");
    expect(html).toContain("Próximo horario libre: 11:30");
    expect(html).toContain("Cargar como sobreturno");
    expect(html).toContain("Elegir otro horario");
    // El foco va a la salida segura (como el de sala): un Enter de más no carga el sobreturno.
    expect(html).toMatch(/data-prompt-primary="true"[^>]*>Elegir otro horario/);
  });

  it("[CF-U1] sin nombre de servicio ni próximo libre: copy genérico y sin la línea", () => {
    const html = render({ ...OS, serviceName: null, nextFreeISO: null });
    expect(html).toContain("Ana Pérez está atendiendo otro servicio en ese horario.");
    expect(html).toContain("Ese turno de otro servicio empieza a las 10:00.");
    expect(html).not.toContain("Próximo horario libre");
  });
});

describe("[CF-U1] resumen del lote con fechas que pisan otro servicio", () => {
  it("[CF-U1] la fecha plegada en sobreturno dice «Atiende otro servicio» y no «cupo completo»", () => {
    const html = renderToStaticMarkup(
      <BatchConflictPrompt
        promptRef={ref}
        batchConflict={{
          plan: {
            dryRun: true,
            requested: 2,
            dates: [
              { iso: "2026-10-06T13:00:00.000Z", status: "libre", outOfHours: false, blocked: false },
              { iso: "2026-10-13T13:00:00.000Z", status: "sobreturno", outOfHours: false, blocked: false, otherServiceBusy: true },
            ],
            free: 1,
            conflicted: 1,
            duplicates: 0,
            created: 0,
            sobreturnos: 0,
            omitted: 0,
          },
          payload: {} as never,
        } as never}
        pending={false}
        onCreateAll={() => {}}
        onCreateFreeOnly={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Atiende otro servicio");
    expect(html).not.toContain("El cupo de ese horario está completo");
    // El forzado sigue siendo el de sobreturno.
    expect(html).toContain("Crear todas");
  });
});
