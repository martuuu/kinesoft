import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/time-blocks", () => ({ previewDayLock: async () => null, applyDayLock: async () => null, removeDayLock: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
import { renderToStaticMarkup } from "react-dom/server";
import { DayLockButton } from "@/components/agenda/day-lock/day-lock-button";
import {
  DayLockAffectedList,
  DayLockDialog,
  DayLockRoomPicker,
  dayLockTitle,
} from "@/components/agenda/day-lock/day-lock-dialog";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

describe("render B4.4", () => {
  it("button states", () => {
    const html = ["open", "partial", "locked"].map((s) =>
      renderToStaticMarkup(<DayLockButton state={s as "open"} reason={s === "locked" ? "Feriado" : null} onClick={() => {}} />)
    ).join("\n") + renderToStaticMarkup(<DayLockButton compact state={{ status: "locked", reason: "sin-franjas", detail: null, blockIds: [] }} onClick={() => {}} disabled />);
    expect(html).toContain('data-lock-status="locked"');
    expect(html).toContain("Día bloqueado: Feriado");
    expect(html).toContain("No hay atención ese día");
  });
  it("dialog form with existing blocks", () => {
    const html = renderToStaticMarkup(
      <ConfirmProvider>
        <DayLockDialog
          open
          dayKey="2027-03-09"
          practitioners={[{ id: "p1", name: "Ana" }, { id: "p2", name: "Beto" }]}
          initialPractitionerIds={null}
          locations={[{ id: "l1", name: "Centro" }, { id: "l2", name: "Norte" }]}
          canBlockAll
          ownPractitionerId="p1"
          existingBlocks={[{ id: "b1", practitionerId: null, startsAt: "2027-03-09T03:00:00.000Z", endsAt: "2027-03-10T03:00:00.000Z", allDay: true, reason: "Feriado" }]}
          onClose={() => {}}
          onDone={() => {}}
        />
      </ConfirmProvider>
    );
    expect(html).toContain("Bloquear el día");
    expect(html).toContain("martes");
    expect(html).toContain("Todo el día · Todo el equipo · Feriado");
    expect(html).toContain("Todas las sedes");
    expect(html).toContain("Capacitación");
  });

  // ── SR-BU (§17.5 "Bloquear sala") ──────────────────────────────────────────
  const rooms = [
    { id: "r1", locationId: "l1", name: "Consultorio 2", kind: "CONSULTORIO" as const, capacity: 1 },
    { id: "r2", locationId: "l2", name: "Gimnasio", kind: "GIMNASIO" as const, capacity: 3 },
  ];
  const dialog = (extra: Partial<React.ComponentProps<typeof DayLockDialog>>) =>
    renderToStaticMarkup(
      <ConfirmProvider>
        <DayLockDialog
          open
          dayKey="2027-03-09"
          practitioners={[{ id: "p1", name: "Ana" }]}
          initialPractitionerIds={null}
          canBlockAll
          ownPractitionerId="p1"
          onClose={() => {}}
          onDone={() => {}}
          {...extra}
        />
      </ConfirmProvider>
    );
  it("[SR-BU] sin salas no aparece 'Una sala'; con salas sí (y solo con agenda.manageBlocks)", () => {
    expect(dialog({})).not.toContain("Una sala");
    expect(dialog({ rooms: [] })).not.toContain("Una sala");
    expect(dialog({ rooms })).toContain("Una sala");
    expect(dialog({ rooms, canBlockAll: false })).not.toContain("Una sala");
  });
  it("[SR-BU] select de salas: placeholder, salas por sede y la nota de alcance", () => {
    const html = renderToStaticMarkup(
      <DayLockRoomPicker
        rooms={rooms}
        locations={[{ id: "l1", name: "Centro" }, { id: "l2", name: "Norte" }]}
        value={null}
        onChange={() => {}}
        error="Elegí la sala."
      />
    );
    expect(html).toContain("Elegí la sala");
    expect(html).toContain('<optgroup label="Centro">');
    expect(html).toContain("Consultorio 2");
    expect(html).toContain("Gimnasio");
    expect(html).toContain("Bloqueás solo la sala: los profesionales siguen con su horario.");
    expect(html).toContain('aria-invalid="true"');
    // Una sola sede: sin optgroup.
    const one = renderToStaticMarkup(<DayLockRoomPicker rooms={[rooms[0]]} value="r1" onChange={() => {}} />);
    expect(one).not.toContain("optgroup");
  });
  it("[SR-FX2b] B7: el error «Elegí la sala.» queda asociado al select (aria-describedby), sin perder la nota", () => {
    const html = renderToStaticMarkup(
      <DayLockRoomPicker rooms={rooms} value={null} onChange={() => {}} error="Elegí la sala." />
    );
    const describedby = html.match(/<select[^>]*id="day-lock-room"[^>]*aria-describedby="([^"]*)"/)?.[1] ?? "";
    expect(describedby.split(" ")).toEqual(["day-lock-room-error", "day-lock-room-note"]);
    expect(html).toMatch(/<div id="day-lock-room-error"[^>]*>Elegí la sala\.<\/div>/);
    // Sin error: solo la nota, y no hay id colgando.
    const ok = renderToStaticMarkup(<DayLockRoomPicker rooms={rooms} value="r1" onChange={() => {}} />);
    expect(ok).toContain('aria-describedby="day-lock-room-note"');
    expect(ok).not.toContain("day-lock-room-error");
  });
  it("[SR-BU] preview de sala: título propio y chip Plan en los turnos de plan", () => {
    expect(dayLockTitle("affected", true)).toBe("Hay turnos en esa sala");
    expect(dayLockTitle("affected", false)).toBe("Hay turnos en ese horario");
    expect(dayLockTitle("done", true)).toBe("Sala bloqueada");
    expect(dayLockTitle("form", true)).toBe("Bloquear el día");
    const html = renderToStaticMarkup(
      <DayLockAffectedList
        affected={[
          { id: "b1", practitionerId: "p1", scheduledFor: "2027-03-09T13:00:00.000Z", durationMin: 45, patientName: "Juana", status: "CONFIRMED", hasPayment: false, inPlan: true },
        ]}
        practitioners={[{ id: "p1", name: "Ana" }]}
        planesEnabled
      />
    );
    expect(html).toContain('data-testid="day-lock-plan-chip"');
  });
  it("[SR-BU] un bloqueo de sala existente se rotula con la sala, no 'Todo el equipo'", () => {
    const html = dialog({
      rooms,
      existingBlocks: [
        { id: "rb", practitionerId: null, roomId: "r1", startsAt: "2027-03-09T03:00:00.000Z", endsAt: "2027-03-10T03:00:00.000Z", allDay: true, reason: "Mantenimiento" },
      ],
    });
    expect(html).toContain("Todo el día · Consultorio 2 · Mantenimiento");
    expect(html).not.toContain("Todo el equipo · Mantenimiento");
  });
});
