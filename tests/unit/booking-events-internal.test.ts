/**
 * P2-C1 · `afterBookingsCommitted` (enmienda Realtime). Se mockea solo la
 * dependencia externa (`next/cache`); la función bajo test es la real.
 *
 * Contrato: revalida `bookingDays` y `dashboard` del tenant (lo mismo que
 * `invalidateBookingDerivedCaches`), `invalidateCaches:false` no revalida, y
 * nunca tira (el turno ya está escrito).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Registro a mano (no `vi.fn`): con vitest 2.1.9, un `vi.fn` que tira llamado
// a través del módulo mockeado hacía fallar el test aunque el código bajo test
// atrapara el error (medido en P2-C1; con un `vi.fn` local no pasa).
const revalidateTag = {
  calls: [] as string[],
  fail: false,
  reset() {
    this.calls = [];
    this.fail = false;
  },
};
vi.mock("next/cache", () => ({
  revalidateTag: (tag: string) => {
    revalidateTag.calls.push(tag);
    if (revalidateTag.fail) throw new Error("Invariant: incrementalCache missing");
  },
  revalidatePath: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { tags } from "@/lib/cache-tags";

const ref: BookingChangeRef = {
  bookingId: "b1",
  practitionerId: "p1",
  scheduledFor: new Date("2026-10-06T12:00:00Z"),
  prev: { practitionerId: "p0", scheduledFor: new Date("2026-10-05T12:00:00Z") },
  kind: "booking",
};

describe("afterBookingsCommitted", () => {
  beforeEach(() => revalidateTag.reset());

  it("revalida bookingDays y dashboard del tenant (y de ningún otro)", async () => {
    await afterBookingsCommitted("t1", [ref]);
    expect([...revalidateTag.calls].sort()).toEqual(
      [tags.bookingDays("t1"), tags.dashboard("t1")].sort()
    );
  });

  it("con refs vacío igual invalida (paridad con invalidateBookingDerivedCaches)", async () => {
    await afterBookingsCommitted("t1", []);
    expect(revalidateTag.calls).toHaveLength(2);
  });

  it("invalidateCaches:false no revalida", async () => {
    await afterBookingsCommitted("t1", [ref], { invalidateCaches: false });
    expect(revalidateTag.calls).toHaveLength(0);
  });

  it("nunca tira aunque la invalidación falle, y un tag que falla no se lleva al otro", async () => {
    revalidateTag.fail = true;
    await expect(afterBookingsCommitted("t1", [ref])).resolves.toBeUndefined();
    expect([...revalidateTag.calls].sort()).toEqual([tags.bookingDays("t1"), tags.dashboard("t1")].sort());
  });
});
