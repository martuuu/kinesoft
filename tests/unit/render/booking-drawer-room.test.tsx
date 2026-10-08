import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SR-U5b: fila "Sala" del drawer del turno. Render real sin jsdom (como el resto
// de `tests/unit/render`); se mockean solo las server actions (red/DB), toast,
// confirm y la navegación. El flujo de "Asignar igual" se prueba con los
// helpers puros que usa el drawer (`roomChangeOutcome`, `roomUpdatePayload`).
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

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import {
  RoomRow,
  drawerRoomModel,
  roomChangeOutcome,
  roomDraftToId,
  roomUpdatePayload,
  shouldReturnRoomFocus,
  NO_ROOM_VALUE,
} from "@/components/agenda/booking-drawer/room-row";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import type { RoomOption } from "@/lib/rooms-types";
import { capabilitiesFor } from "@/lib/capabilities";

const PRACTITIONER = [...capabilitiesFor("PRACTITIONER")];

const ROOMS: RoomOption[] = [
  { id: "r1", locationId: "loc-centro", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
  { id: "r2", locationId: "loc-centro", name: "Consultorio 2", kind: "CONSULTORIO", capacity: 1 },
  { id: "r9", locationId: "loc-norte", name: "Gimnasio Norte", kind: "GIMNASIO", capacity: 4 },
];

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-05T12:00:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    canOperate: true,
    clinicalWritable: true,
    locationId: "loc-centro",
    locationName: "Centro",
    ...over,
  };
}

const renderDrawer = (b: DrawerBooking, rooms?: RoomOption[], primaryLocationId?: string | null) =>
  renderToStaticMarkup(
    <BookingDrawer
      booking={b}
      onClose={() => {}}
      onSaved={() => {}}
      capabilities={PRACTITIONER}
      rooms={rooms}
      primaryLocationId={primaryLocationId}
    />
  );

describe("[SR-U5b] drawer: sin salas queda como antes", () => {
  it("sin catálogo, con catálogo vacío o sin salas en la sede del turno: ni la fila ni «Cambiar la sala»", () => {
    const before = renderDrawer(booking());
    expect(before).not.toContain(">Sala<");
    expect(before).not.toContain("Cambiar la sala");
    expect(renderDrawer(booking(), [])).toBe(before);
    expect(renderDrawer(booking({ locationId: "loc-sur" }), ROOMS)).toBe(renderDrawer(booking({ locationId: "loc-sur" })));
    // `roomId: null` explícito (proyección liviana expandida) tampoco cambia nada.
    expect(renderDrawer(booking({ roomId: null }), [])).toBe(before);
  });
});

describe("[SR-U5b] drawer: fila Sala", () => {
  it("con salas en la sede: la fila con el nombre y «Cambiar», debajo de la sede", () => {
    const html = renderDrawer(booking({ roomId: "r2" }), ROOMS);
    expect(html).toContain(">Sala<");
    expect(html).toContain("Consultorio 2");
    expect(html).toContain('aria-label="Cambiar la sala"');
    expect(html.indexOf(">Sede<")).toBeLessThan(html.indexOf(">Sala<"));
  });

  it("turno sin sala en una sede con salas: «Sin sala»", () => {
    const html = renderDrawer(booking({ roomId: null }), ROOMS);
    expect(html).toContain("Sin sala");
    expect(html).toContain('aria-label="Cambiar la sala"');
  });

  it("sin permiso de operar: la sala se ve, «Cambiar» no", () => {
    const html = renderDrawer(booking({ roomId: "r2", canOperate: false, patientAccess: "basic" }), ROOMS);
    expect(html).toContain("Consultorio 2");
    expect(html).not.toContain("Cambiar la sala");
  });

  it("turno cancelado: «Cambiar» deshabilitado (como Reprogramar / Editar)", () => {
    const html = renderDrawer(booking({ roomId: "r2", status: "CANCELLED" }), ROOMS);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Cambiar la sala"/);
  });

  it("turno con sala archivada (fuera del catálogo): la fila aparece y lo dice", () => {
    const html = renderDrawer(booking({ roomId: "r-vieja", locationId: "loc-sur" }), ROOMS);
    expect(html).toContain("Sala archivada");
  });
});

describe("[SR-U5b] drawerRoomModel: las salas de la sede del turno", () => {
  it("filtra por la sede explícita del turno", () => {
    const m = drawerRoomModel(booking(), ROOMS, "loc-norte");
    expect(m.options.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(m.visible).toBe(true);
    expect(m.label).toBe("Sin sala");
  });

  it("locationId null = la sede principal", () => {
    const m = drawerRoomModel(booking({ locationId: null }), ROOMS, "loc-norte");
    expect(m.options.map((r) => r.id)).toEqual(["r9"]);
  });

  it("locationId null sin principal conocida: la sede de su sala; si no hay, ninguna opción (no adivina)", () => {
    expect(drawerRoomModel(booking({ locationId: null, roomId: "r9" }), ROOMS, null).options.map((r) => r.id)).toEqual([
      "r9",
    ]);
    const m = drawerRoomModel(booking({ locationId: null, roomId: null }), ROOMS, undefined);
    expect(m.options).toEqual([]);
    expect(m.visible).toBe(false);
  });

  it("sin salas en la sede pero el turno tiene una: visible", () => {
    const m = drawerRoomModel(booking({ locationId: "loc-sur", roomId: "r-vieja" }), ROOMS, null);
    expect(m).toEqual({ visible: true, currentId: "r-vieja", label: "Sala archivada", options: [] });
  });
});

describe("[SR-U5b] RoomRow abierto: el select", () => {
  const row = (over: Partial<Parameters<typeof RoomRow>[0]> = {}) =>
    renderToStaticMarkup(
      <RoomRow
        model={drawerRoomModel(booking({ roomId: "r1" }), ROOMS, null)}
        canOperate
        cancelled={false}
        pending={false}
        editing
        draft="r1"
        onOpen={() => {}}
        onCancel={() => {}}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        {...over}
      />
    );

  it("«Sin sala» + las salas de la sede del turno, nunca las de otra sede", () => {
    const html = row();
    expect(html).toContain('aria-label="Sala del turno"');
    expect(html).toContain('<option value="">Sin sala</option>');
    expect(html).toContain('<option value="r1" selected="">Consultorio 1</option>');
    expect(html).toContain('<option value="r2">Consultorio 2</option>');
    expect(html).not.toContain("Gimnasio Norte");
    expect(html).not.toContain('aria-label="Cambiar la sala"');
  });

  it("Guardar deshabilitado mientras el select tenga la sala actual", () => {
    expect(row()).toMatch(/<button type="submit" disabled=""/);
    expect(row({ draft: "r2" })).not.toMatch(/<button type="submit" disabled=""/);
  });

  it("la sala actual archivada sigue en el select (si no, el select mentiría)", () => {
    const html = row({
      model: drawerRoomModel(booking({ roomId: "r-vieja" }), ROOMS, null),
      draft: "r-vieja",
    });
    expect(html).toContain('<option value="r-vieja" selected="">Sala archivada</option>');
  });

  it("borrador → payload: «Sin sala» viaja como null", () => {
    expect(roomDraftToId(NO_ROOM_VALUE)).toBeNull();
    expect(roomDraftToId("r2")).toBe("r2");
  });

  it("[SR-FX2b] B2: al abrir, el foco va al select de sala (autoFocus); «Cambiar» no se lo roba", () => {
    expect(row()).toMatch(/<select[^>]*aria-label="Sala del turno"[^>]*autofocus=""/);
    const closed = row({ editing: false });
    expect(closed).toContain('aria-label="Cambiar la sala"');
    expect(closed).not.toContain("autofocus");
  });

  it("[SR-FX2b] B2: al cerrar el form (Cancelar/Guardar) el foco vuelve a «Cambiar», no al abrir ni al montar", () => {
    expect(shouldReturnRoomFocus(true, false)).toBe(true);
    expect(shouldReturnRoomFocus(false, true)).toBe(false);
    expect(shouldReturnRoomFocus(false, false)).toBe(false);
    expect(shouldReturnRoomFocus(true, true)).toBe(false);
  });
});

describe("[SR-U5b] roomChangeOutcome: qué hace el drawer con la respuesta", () => {
  it("ok → listo (toast «Sala cambiada»)", () => {
    expect(roomChangeOutcome({ ok: true })).toEqual({ kind: "ok" });
  });

  it("roomBusy → confirm «Consultorio 2 está ocupado a esa hora. ¿Lo asignás igual?» [Asignar igual] [Elegir otra]", () => {
    const o = roomChangeOutcome({
      ok: false,
      error: "Consultorio 2 ya está ocupado a esa hora. Elegí otra sala o asignalo igual.",
      roomBusy: { roomName: "Consultorio 2", nextFreeISO: null, blocked: null },
    });
    expect(o.kind).toBe("confirm");
    if (o.kind !== "confirm") return;
    expect(o.options).toEqual({
      title: "Consultorio 2 está ocupado a esa hora.",
      message: "¿Lo asignás igual?",
      confirmLabel: "Asignar igual",
      cancelLabel: "Elegir otra",
    });
    expect(o.next).toEqual({ allowRoomConflict: true });
    // SR-D2: forzar la sala no es sobreturno.
    expect(JSON.stringify(o.options)).not.toMatch(/sobreturno/i);
    expect(o.next).not.toHaveProperty("allowOverbooking");
  });

  it("sala bloqueada con motivo → el titular lo dice", () => {
    const o = roomChangeOutcome({
      ok: false,
      error: "x",
      roomBusy: { roomName: "Consultorio 2", nextFreeISO: null, blocked: { reason: "Mantenimiento" } },
    });
    expect(o.kind === "confirm" && o.options.title).toBe("Consultorio 2 está bloqueado a esa hora (Mantenimiento).");
    expect(o.kind === "confirm" && o.options.confirmLabel).toBe("Asignar igual");
  });

  it("al confirmar, el reintento lleva allowRoomConflict y solo la sala", () => {
    const o = roomChangeOutcome({
      ok: false,
      error: "x",
      roomBusy: { roomName: "Consultorio 2", nextFreeISO: null },
    });
    if (o.kind !== "confirm") throw new Error("esperaba confirm");
    expect(roomUpdatePayload(booking(), "r2", o.next)).toEqual({
      id: "b1",
      roomId: "r2",
      allowRoomConflict: true,
      expectedUpdatedAt: "2026-10-05T11:00:00.000Z",
    });
    // Primer intento: sin flags, y "Sin sala" como null.
    expect(roomUpdatePayload(booking(), null)).toEqual({
      id: "b1",
      roomId: null,
      expectedUpdatedAt: "2026-10-05T11:00:00.000Z",
    });
  });

  it("roomBusy que vuelve con el flag ya mandado = error real (sin loop)", () => {
    const o = roomChangeOutcome(
      { ok: false, error: "Consultorio 2 ya está ocupado…", roomBusy: { roomName: "Consultorio 2", nextFreeISO: null } },
      { allowRoomConflict: true }
    );
    expect(o).toEqual({ kind: "error", error: "Consultorio 2 ya está ocupado…" });
  });

  it("error común (stale, bad-room) → error con el copy del server", () => {
    expect(roomChangeOutcome({ ok: false, error: "Esa sala no está disponible en esa sede." })).toEqual({
      kind: "error",
      error: "Esa sala no está disponible en esa sede.",
    });
  });
});
