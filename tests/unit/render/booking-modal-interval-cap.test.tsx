import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// T3e-2u1 — tope de turnos por intervalo (C-AS3) en el modal de turno nuevo. Render real (sin jsdom, como el resto de
// `tests/unit/render`); se mockean solo las server actions y los hooks de toast/confirm. El reenvío con
// `allowIntervalCap` se prueba con los helpers puros en `tests/unit/booking-modal-state.test.ts`.
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

import { BatchConflictPrompt, IntervalCapPrompt } from "@/components/agenda/booking-modal/conflict-prompts";
import { InstantStatusBox } from "@/components/agenda/booking-modal/schedule-section";

const ref = { current: null };
const CAP = { practitionerName: "Ana Pérez", used: 2, cap: 2, fromTime: "10:00", toTime: "10:15" };

describe("[AS-2u1] prompt del tope (alta simple)", () => {
  it("[AS-2u1] headline de C-AS3, «Cargar como sobreturno» y próximo libre si hay", () => {
    const El = IntervalCapPrompt;
    const html = renderToStaticMarkup(
      <El
        promptRef={ref}
        intervalCap={{ ...CAP, nextFreeISO: "2026-10-05T13:30:00.000Z" }}
        pending={false}
        onForce={() => {}}
        onUseSuggestedSlot={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Ana Pérez ya tiene 2 turnos entre las 10:00 y las 10:15 (tope: 2).");
    expect(html).toContain("Cargar como sobreturno");
    expect(html).toContain("Usar próximo libre");
    expect(html).toContain("10:30");
    const none = renderToStaticMarkup(
      <El promptRef={ref} intervalCap={{ ...CAP, nextFreeISO: null }} pending={false} onForce={() => {}} onUseSuggestedSlot={() => {}} onBack={() => {}} />
    );
    expect(none).not.toContain("Usar próximo libre");
  });
});

describe("[AS-2u1] lote con fechas topeadas", () => {
  const batch = (dates: Array<{ status: "libre" | "sobreturno"; intervalCapped?: boolean }>, free: number, conflicted: number) => ({
    plan: {
      dryRun: true,
      requested: dates.length,
      dates: dates.map((d, i) => ({
        iso: `2026-10-${String(6 + i * 7).padStart(2, "0")}T13:00:00.000Z`,
        status: d.status,
        outOfHours: false,
        blocked: false,
        ...(d.intervalCapped ? { intervalCapped: true } : {}),
      })),
      free,
      conflicted,
      duplicates: 0,
      created: 0,
      sobreturnos: 0,
      omitted: 0,
    },
    payload: {} as never,
  });

  it("[AS-2u1] sin fechas topeadas: sin casilla del tope (como antes)", () => {
    const html = renderToStaticMarkup(
      <BatchConflictPrompt
        promptRef={ref}
        batchConflict={batch([{ status: "libre" }, { status: "sobreturno" }], 1, 1)}
        pending={false}
        onCreateAll={() => {}}
        onCreateFreeOnly={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).not.toContain("superan el tope");
    expect(html).not.toContain("Agendar igual esas fechas");
  });

  it("[AS-2u1] fechas topeadas: «{n} fechas llegan al tope», casilla y, sin marcar, no cuentan", () => {
    const html = renderToStaticMarkup(
      <BatchConflictPrompt
        promptRef={ref}
        batchConflict={batch(
          [{ status: "libre" }, { status: "libre", intervalCapped: true }, { status: "libre", intervalCapped: true }],
          3,
          0
        )}
        pending={false}
        onCreateAll={() => {}}
        onCreateFreeOnly={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("2 fechas llegan al tope");
    expect(html).toContain("Agendar igual esas fechas");
    expect(html).toContain("Tope completo");
    expect(html).toContain("Crear la sesión");
  });
});

describe("[AS-2u1] aviso en vivo del 2.º turno al elegir horario", () => {
  const check = {
    class: "libre" as const,
    outOfHours: false,
    blocked: false,
    blockIds: [],
    blockReasons: [],
    used: 0,
    cap: 3,
    durationMin: 45,
    serviceEnabled: true,
    intervalCapped: false,
    intervalCapUse: { used: 1, cap: { count: 2, intervalMin: 15 as const } },
  };

  it("[AS-2u1] con ≥1 turno bajo el tope: «Ya hay 1 turno de Ana Pérez a las 10:00.» sin cambiar el tono", () => {
    const html = renderToStaticMarkup(
      <InstantStatusBox check={check} iso="2026-10-05T13:05:00.000Z" practitionerName="Ana Pérez" />
    );
    expect(html).toContain("Libre");
    expect(html).toContain("Ya hay 1 turno de Ana Pérez a las 10:00.");
    expect(html).toContain("var(--success-bg)");
  });

  it("[AS-2u1] topeado: «Tope completo (2/2)» y sin el aviso del 2.º", () => {
    const html = renderToStaticMarkup(
      <InstantStatusBox
        check={{ ...check, class: "tope-intervalo", intervalCapped: true, intervalCapUse: { used: 2, cap: { count: 2, intervalMin: 15 } } }}
        iso="2026-10-05T13:05:00.000Z"
        practitionerName="Ana Pérez"
      />
    );
    expect(html).toContain("Tope completo (2/2)");
    expect(html).not.toContain("Ya hay");
  });
});
