import { describe, it, expect } from "vitest";
import { overlapBlocks, patientDayStatus } from "@/lib/booking-capacity";

describe("overlapBlocks (per-service concurrency capacity)", () => {
  it("unlimited (null/undefined) never blocks — overlaps allowed freely", () => {
    expect(overlapBlocks(0, null)).toBe(false);
    expect(overlapBlocks(5, null)).toBe(false);
    expect(overlapBlocks(99, undefined)).toBe(false);
  });

  it("capacity 1 (osteopatía) blocks as soon as one already overlaps", () => {
    expect(overlapBlocks(0, 1)).toBe(false); // first turno fits
    expect(overlapBlocks(1, 1)).toBe(true); // second overlapping is blocked
    expect(overlapBlocks(3, 1)).toBe(true);
  });

  it("capacity N blocks only once N already overlap", () => {
    expect(overlapBlocks(0, 3)).toBe(false);
    expect(overlapBlocks(2, 3)).toBe(false); // 3rd fits (2 existing)
    expect(overlapBlocks(3, 3)).toBe(true); // 4th blocked
    expect(overlapBlocks(6, 3)).toBe(true);
  });

  it("capacity 0 blocks everything (degenerate but well-defined)", () => {
    expect(overlapBlocks(0, 0)).toBe(true);
  });
});

describe("patientDayStatus (per-patient same-day guard)", () => {
  const d = (iso: string) => new Date(iso);
  // New turno: 2026-08-03 10:00–11:00 AR (13:00–14:00 UTC).
  const newStart = d("2026-08-03T13:00:00.000Z");
  const newEnd = d("2026-08-03T14:00:00.000Z");

  it("returns null when the patient has no other turno that day", () => {
    expect(patientDayStatus([], newStart, newEnd)).toBeNull();
  });

  it("returns 'same-day' for a non-overlapping turno earlier the same day", () => {
    // 08:00–09:00 AR — same day, no overlap.
    const existing = [{ scheduledFor: d("2026-08-03T11:00:00.000Z"), durationMin: 60 }];
    expect(patientDayStatus(existing, newStart, newEnd)).toBe("same-day");
  });

  it("returns 'overlap' when the new turno starts inside an existing one", () => {
    // 09:30–10:30 AR overlaps 10:00–11:00.
    const existing = [{ scheduledFor: d("2026-08-03T12:30:00.000Z"), durationMin: 60 }];
    expect(patientDayStatus(existing, newStart, newEnd)).toBe("overlap");
  });

  it("returns 'overlap' for an exact same-slot duplicate (the regression that overwrote silently)", () => {
    const existing = [{ scheduledFor: newStart, durationMin: 60 }];
    expect(patientDayStatus(existing, newStart, newEnd)).toBe("overlap");
  });

  it("treats a back-to-back turno (touches but doesn't overlap) as 'same-day', not 'overlap'", () => {
    // 11:00–12:00 AR starts exactly when the new one ends → no overlap.
    const existing = [{ scheduledFor: newEnd, durationMin: 60 }];
    expect(patientDayStatus(existing, newStart, newEnd)).toBe("same-day");
  });

  it("prioritizes 'overlap' when one of several same-day turnos overlaps", () => {
    const existing = [
      { scheduledFor: d("2026-08-03T11:00:00.000Z"), durationMin: 60 }, // 08:00, no overlap
      { scheduledFor: d("2026-08-03T13:30:00.000Z"), durationMin: 30 }, // 10:30, overlaps
    ];
    expect(patientDayStatus(existing, newStart, newEnd)).toBe("overlap");
  });
});
