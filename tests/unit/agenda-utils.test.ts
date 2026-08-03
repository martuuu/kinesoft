import { describe, it, expect } from "vitest";
import {
  layoutBookings,
  osLabel,
  billingLine,
  type BookingDTO,
} from "@/components/agenda/agenda-utils";

// Minimal BookingDTO factory — only scheduledFor/durationMin matter to the
// layout algorithm; the rest are filled with harmless defaults.
function mk(id: string, scheduledFor: string, durationMin: number): BookingDTO {
  return {
    id,
    scheduledFor,
    durationMin,
    status: "CONFIRMED",
    serviceId: "svc1",
    serviceName: "Consulta",
    serviceColor: null,
    practitionerId: "p1",
    patientId: "pat1",
    patientName: "Test",
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 5000,
    updatedAt: scheduledFor,
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
  };
}

describe("layoutBookings", () => {
  it("returns [] for no bookings", () => {
    expect(layoutBookings([])).toEqual([]);
  });

  it("puts non-overlapping turnos in their own single-column groups", () => {
    const out = layoutBookings([
      mk("a", "2026-05-26T13:00:00.000Z", 60), // 13-14
      mk("d", "2026-05-26T14:00:00.000Z", 30), // 14-14:30 (touches, not overlaps)
    ]);
    const a = out.find((x) => x.id === "a")!;
    const d = out.find((x) => x.id === "d")!;
    expect(a.cols).toBe(1);
    expect(d.cols).toBe(1);
    expect(a.groupKey).not.toBe(d.groupKey);
  });

  it("shares columns among overlapping turnos, transitively via the sweep", () => {
    // A 13:00-14:00, B 13:30-14:30 (overlaps A), C 14:15-14:45 (overlaps B, not A).
    // The sweep chains them into ONE group of 3 columns.
    const out = layoutBookings([
      mk("a", "2026-05-26T13:00:00.000Z", 60),
      mk("b", "2026-05-26T13:30:00.000Z", 60),
      mk("c", "2026-05-26T14:15:00.000Z", 30),
    ]);
    expect(out.every((x) => x.cols === 3)).toBe(true);
    expect(new Set(out.map((x) => x.groupKey)).size).toBe(1);
    // Columns are distinct 0,1,2 within the group.
    expect(new Set(out.map((x) => x.col))).toEqual(new Set([0, 1, 2]));
  });
});

describe("osLabel", () => {
  it("hides the Particular / uninsured label (never prints 'Particular')", () => {
    expect(osLabel("Particular")).toBe("");
    expect(osLabel("particular")).toBe("");
    expect(osLabel("")).toBe("");
  });
  it("shows a real obra social name", () => {
    expect(osLabel("OSDE")).toBe("OSDE");
  });
});

describe("billingLine", () => {
  it("drops the OS segment for a particular patient", () => {
    const line = billingLine({ serviceName: "Consulta", obraSocial: "Particular", copagoCents: 5000 });
    expect(line).not.toContain("Particular");
    expect(line).toContain("Consulta");
  });
  it("includes the obra social when insured", () => {
    const line = billingLine({ serviceName: "Consulta", obraSocial: "OSDE", copagoCents: 3000 });
    expect(line).toContain("OSDE");
    expect(line).toContain("Consulta");
  });
});
