import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SR-U5c — sala en el modal de turno nuevo. Render real (sin jsdom, como el
// resto de `tests/unit/render`); se mockean solo las server actions (red/DB) y
// los hooks de toast/confirm. El payload y el reenvío con `allowRoomConflict`
// se prueban con los helpers puros en `tests/unit/booking-modal-state.test.ts`
// (submit necesita eventos: acá no hay DOM).
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
// Mismo set que booking-drawer-secretaria.test.tsx: sin mock, `cache` de React no existe fuera de RSC.
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { TelemedicineSection } from "@/components/agenda/booking-modal/telemedicine-section";
import { BatchConflictPrompt, RoomBusyPrompt, focusRoomSelect } from "@/components/agenda/booking-modal/conflict-prompts";
import { capabilitiesFor } from "@/lib/capabilities";
import type { RoomOption } from "@/lib/rooms-types";

const ASSISTANT = [...capabilitiesFor("ASSISTANT")];

const ROOMS: RoomOption[] = [
  { id: "r-c1", locationId: "loc-centro", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
  { id: "r-c2", locationId: "loc-centro", name: "Consultorio 2", kind: "CONSULTORIO", capacity: 1 },
];

const props = {
  services: [{ id: "s1", name: "Kinesio", durationMin: 45, priceCents: 0, color: null }],
  practitioners: [{ id: "p1", name: "Ana Pérez" }],
  patients: [{ id: "pt1", name: "Juana Gómez" }],
  insurers: [],
  onClose: () => {},
  onSaved: () => {},
  defaultISO: "2026-10-05T12:00:00.000Z",
  capabilities: ASSISTANT,
};

/** `<option … selected>` de un value (React marca el elegido con `selected=""`). */
const selectedValue = (html: string, name: string) => {
  const sel = html.match(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "";
  return sel.match(/<option[^>]*value="([^"]*)"[^>]*selected=""/)?.[1] ?? null;
};

describe("[SR-U5c] modal sin salas: idéntico", () => {
  it("sin la prop o con [] el markup es el mismo y no hay select Sala", () => {
    const base = renderToStaticMarkup(<BookingModal {...props} />);
    const empty = renderToStaticMarkup(<BookingModal {...props} rooms={[]} />);
    const withDefault = renderToStaticMarkup(<BookingModal {...props} rooms={[]} defaultRoomId="r-c1" />);
    expect(empty).toBe(base);
    expect(withDefault).toBe(base);
    expect(base).not.toContain('name="roomId"');
    expect(base).not.toContain(">Sala<");
  });
});

describe("[SR-U5c] modal con salas", () => {
  it("aparece el select Sala con 'Según el horario del profesional', 'Sin sala' y las salas", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} rooms={ROOMS} />);
    expect(html).toContain('name="roomId"');
    expect(html).toContain(">Sala<");
    expect(html).toContain("Según el horario del profesional");
    expect(html).toContain(">Sin sala<");
    expect(html).toContain(">Consultorio 1<");
    expect(html).toContain(">Consultorio 2<");
    // Default: según el horario ("" = no viaja).
    expect(selectedValue(html, "roomId")).toBe("");
  });

  it("defaultRoomId desde la celda queda preseleccionado; null = Sin sala", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} rooms={ROOMS} defaultRoomId="r-c2" />);
    expect(selectedValue(html, "roomId")).toBe("r-c2");
    const none = renderToStaticMarkup(<BookingModal {...props} rooms={ROOMS} defaultRoomId={null} />);
    expect(selectedValue(none, "roomId")).toBe("none");
  });

  it("la opción por defecto nombra la sala de la franja (InstantCheck.defaultRoomId)", () => {
    const html = renderToStaticMarkup(
      <TelemedicineSection
        locationId=""
        onLocationChange={() => {}}
        isTelemedicine={false}
        onTelemedicineChange={() => {}}
        telemedicineUrl=""
        onTelemedicineUrlChange={() => {}}
        rooms={ROOMS}
        roomChoice=""
        onRoomChange={() => {}}
        defaultRoomId="r-c2"
      />
    );
    expect(html).toContain("Según el horario del profesional (Consultorio 2)");
  });

  it("solo ofrece las salas de roomOptions (las de la sede)", () => {
    const html = renderToStaticMarkup(
      <TelemedicineSection
        locationId="loc-norte"
        onLocationChange={() => {}}
        isTelemedicine={false}
        onTelemedicineChange={() => {}}
        telemedicineUrl=""
        onTelemedicineUrlChange={() => {}}
        rooms={ROOMS}
        // SRZ B6: con `roomOptions={[]}` (sede sin salas) el select ya no se
        // dibuja (ver los casos [SR-FX2b] B6); acá la sede tiene una sola sala.
        roomOptions={[ROOMS[1]]}
        roomChoice=""
      />
    );
    expect(html).toContain(">Sin sala<");
    expect(html).toContain(">Consultorio 2<");
    expect(html).not.toContain("Consultorio 1");
  });
  const section = (over: Partial<React.ComponentProps<typeof TelemedicineSection>> = {}) =>
    renderToStaticMarkup(
      <TelemedicineSection
        locationId="loc-norte"
        onLocationChange={() => {}}
        isTelemedicine={false}
        onTelemedicineChange={() => {}}
        telemedicineUrl=""
        onTelemedicineUrlChange={() => {}}
        rooms={ROOMS}
        roomOptions={[]}
        roomChoice=""
        {...over}
      />
    );

  it("[SR-FX2b] B6: sede elegida sin salas y «Según el horario» → sin select Sala (ruido)", () => {
    const html = section();
    expect(html).not.toContain('name="roomId"');
    expect(html).not.toContain(">Sala<");
  });

  it("[SR-FX2b] B6: con una elección explícita el select sigue (no se esconde un dato elegido)", () => {
    expect(section({ roomChoice: "none" })).toContain('name="roomId"');
    expect(section({ roomChoice: "r-c1" })).toContain('name="roomId"');
  });

  it("[SR-FX2b] B6: sin salas en el consultorio, nunca hay select aunque venga una elección", () => {
    expect(section({ rooms: [], roomChoice: "none" })).not.toContain('name="roomId"');
    expect(section({ rooms: null, roomOptions: null, roomChoice: "none" })).not.toContain('name="roomId"');
  });
});

describe("[SR-U5c] prompts de sala", () => {
  const ref = { current: null };

  it("roomBusy: copy literal y 'Agendar igual' (sin sobreturno)", () => {
    const html = renderToStaticMarkup(
      <RoomBusyPrompt promptRef={ref} roomBusy={{ roomName: "Consultorio 2" }} pending={false} onForce={() => {}} onBack={() => {}} />
    );
    expect(html).toContain("Consultorio 2 ya está ocupado a esa hora.");
    expect(html).toContain("Agendar igual");
    expect(html).toContain("Elegir otra sala");
    expect(html).not.toContain("Cargar como sobreturno");
  });

  it("bloqueo de sala: muestra el motivo", () => {
    const html = renderToStaticMarkup(
      <RoomBusyPrompt
        promptRef={ref}
        roomBusy={{ roomName: "Consultorio 2", blocked: { reason: "Mantenimiento" } }}
        pending={false}
        onForce={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Consultorio 2 está bloqueado a esa hora (Mantenimiento).");
  });

  it("[SR-FX2b] B2: «Elegir otra sala» lleva el foco al select Sala del form", () => {
    const focus = vi.fn();
    const calls: string[] = [];
    const root = {
      querySelector: (sel: string) => {
        calls.push(sel);
        return sel === 'select[name="roomId"]' ? ({ focus } as unknown as HTMLSelectElement) : null;
      },
    };
    focusRoomSelect(root);
    expect(calls).toEqual(['select[name="roomId"]']);
    expect(focus).toHaveBeenCalledTimes(1);
    // Sin form montado (o sin select): no rompe.
    expect(() => focusRoomSelect(null)).not.toThrow();
    expect(() => focusRoomSelect({ querySelector: () => null })).not.toThrow();
  });

  const batch = (dates: Array<{ status: "libre" | "sobreturno" | "duplicado"; roomBusy?: boolean }>, free: number, conflicted: number) => ({
    plan: {
      dryRun: true,
      requested: dates.length,
      dates: dates.map((d, i) => ({
        iso: `2026-10-${String(6 + i * 7).padStart(2, "0")}T13:00:00.000Z`,
        status: d.status,
        outOfHours: false,
        blocked: false,
        ...(d.roomBusy === undefined ? {} : { roomBusy: d.roomBusy }),
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

  it("batch sin sala ocupada: sin casilla de sala (como antes)", () => {
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
    expect(html).not.toContain("sala ocupada");
    expect(html).toContain("Crear todas (2,");
    expect(html).toContain("Crear solo las libres (1)");
  });

  it("batch con sala ocupada: se lista, se ofrece forzar y, sin forzar, no cuenta", () => {
    const html = renderToStaticMarkup(
      <BatchConflictPrompt
        promptRef={ref}
        batchConflict={batch([{ status: "libre" }, { status: "libre", roomBusy: true }, { status: "libre" }], 3, 0)}
        pending={false}
        onCreateAll={() => {}}
        onCreateFreeOnly={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Sala ocupada");
    expect(html).toContain("1 con la sala ocupada (se omiten)");
    expect(html).toContain("Agendar igual la fecha con la sala ocupada");
    expect(html).toContain("Crear las 2 sesiones");
  });
});
