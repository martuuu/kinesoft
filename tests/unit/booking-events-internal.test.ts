/**
 * P2-C1 · `afterBookingsCommitted` (enmienda Realtime). Se mockea solo la
 * dependencia externa (`next/cache`); la función bajo test es la real.
 *
 * Contrato: revalida `bookingDays` y `dashboard` del tenant (lo mismo que
 * `invalidateBookingDerivedCaches`), `invalidateCaches:false` no revalida, y
 * nunca tira (el turno ya está escrito).
 *
 * SV04a: además publica en el canal realtime DESPUÉS de invalidar, también con
 * `invalidateCaches:false` (Recepción «llegó» lo llama así y antes no emitía:
 * early return de `:61`). El publish se observa con un publisher fake
 * instalado con `__setRealtimePublisherForTests` (el módulo real, sin red).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import {
  afterAvailabilityCommitted,
  afterBookingsCommitted,
  type BookingChangeRef,
} from "@/lib/booking-events-internal";
import { tags } from "@/lib/cache-tags";
import { __setRealtimePublisherForTests } from "@/lib/realtime-publisher-internal";
import { realtimeFake, realtimePublisherFake } from "@/tests/helpers/realtime-fake";

// Cuántos revalidateTag había cuando se publicó: fija el orden invalidar → publicar.
const tagsAtPublish: number[] = [];
const orderedFake = {
  publishBookingChanges: (t: string, r: ReadonlyArray<BookingChangeRef>) => {
    tagsAtPublish.push(revalidateTag.calls.length);
    return realtimePublisherFake.publishBookingChanges(t, r);
  },
  publishAvailability: (t: string, s: { practitionerId: string | null; day: string | null }) => {
    tagsAtPublish.push(revalidateTag.calls.length);
    return realtimePublisherFake.publishAvailability(t, s);
  },
};

const ref: BookingChangeRef = {
  bookingId: "b1",
  practitionerId: "p1",
  scheduledFor: new Date("2026-10-06T12:00:00Z"),
  prev: { practitionerId: "p0", scheduledFor: new Date("2026-10-05T12:00:00Z") },
  kind: "booking",
};

describe("afterBookingsCommitted", () => {
  beforeEach(() => {
    revalidateTag.reset();
    realtimeFake.reset();
    tagsAtPublish.length = 0;
    __setRealtimePublisherForTests(orderedFake);
  });
  afterEach(() => __setRealtimePublisherForTests(null));

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

  it("[SV04a] con invalidateCaches:false igual publica", async () => {
    await afterBookingsCommitted("t1", [ref], { invalidateCaches: false });
    expect(revalidateTag.calls).toHaveLength(0);
    expect(realtimeFake.calls).toEqual([{ tenantId: "t1", refs: [ref] }]);
  });

  it("publica después de revalidar, una vez, con los refs exactos", async () => {
    const ref2: BookingChangeRef = {
      bookingId: "b2",
      practitionerId: "p2",
      scheduledFor: new Date("2026-10-06T13:00:00Z"),
      roomId: "r1",
      kind: "reception",
    };
    await afterBookingsCommitted("t1", [ref, ref2]);
    expect(realtimeFake.calls).toEqual([{ tenantId: "t1", refs: [ref, ref2] }]);
    expect(tagsAtPublish).toEqual([2]);
  });

  it("un publish que tira no impide revalidar ni hace tirar al hook", async () => {
    __setRealtimePublisherForTests({
      publishBookingChanges: () => {
        throw new Error("boom");
      },
      publishAvailability: () => {
        throw new Error("boom");
      },
    });
    await expect(afterBookingsCommitted("t1", [ref])).resolves.toBeUndefined();
    expect(revalidateTag.calls).toHaveLength(2);
    // Rechazo asíncrono también.
    __setRealtimePublisherForTests({
      publishBookingChanges: () => Promise.reject(new Error("boom")),
      publishAvailability: () => Promise.reject(new Error("boom")),
    });
    await expect(afterBookingsCommitted("t1", [ref])).resolves.toBeUndefined();
    await expect(
      afterAvailabilityCommitted("t1", { practitionerId: null, day: "2026-10-06" })
    ).resolves.toBeUndefined();
  });

  it("refs vacío no publica (SV-D12) pero invalida igual", async () => {
    await afterBookingsCommitted("t1", []);
    expect(realtimeFake.calls).toHaveLength(0);
    expect(revalidateTag.calls).toHaveLength(2);
  });
});

describe("afterAvailabilityCommitted", () => {
  beforeEach(() => {
    revalidateTag.reset();
    realtimeFake.reset();
    tagsAtPublish.length = 0;
    __setRealtimePublisherForTests(orderedFake);
  });
  afterEach(() => __setRealtimePublisherForTests(null));

  it("revalida bookingDays y publica 1 mensaje availability con el scope", async () => {
    await afterAvailabilityCommitted("t1", { practitionerId: "p1", day: "2026-10-06" });
    expect(revalidateTag.calls).toEqual([tags.bookingDays("t1")]);
    expect(realtimeFake.calls).toEqual([
      { tenantId: "t1", availability: { practitionerId: "p1", day: "2026-10-06" } },
    ]);
    expect(tagsAtPublish).toEqual([1]);
  });

  it("[FX1b] day null (varios días) → 1 revalidate y 1 publish con day null", async () => {
    await afterAvailabilityCommitted("t1", { practitionerId: null, day: null });
    expect(revalidateTag.calls).toEqual([tags.bookingDays("t1")]);
    expect(realtimeFake.calls).toEqual([{ tenantId: "t1", availability: { practitionerId: null, day: null } }]);
  });

  it("nunca tira aunque la invalidación falle, y publica igual", async () => {
    revalidateTag.fail = true;
    await expect(
      afterAvailabilityCommitted("t1", { practitionerId: null, day: "2026-10-06" })
    ).resolves.toBeUndefined();
    expect(realtimeFake.calls).toHaveLength(1);
  });
});
