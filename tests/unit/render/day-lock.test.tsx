import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/time-blocks", () => ({ previewDayLock: async () => null, applyDayLock: async () => null, removeDayLock: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
import { renderToStaticMarkup } from "react-dom/server";
import { DayLockButton } from "@/components/agenda/day-lock/day-lock-button";
import { DayLockDialog } from "@/components/agenda/day-lock/day-lock-dialog";
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
});
