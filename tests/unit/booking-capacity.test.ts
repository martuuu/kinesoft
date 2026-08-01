import { describe, it, expect } from "vitest";
import { overlapBlocks } from "@/lib/booking-capacity";

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
