import { describe, it, expect } from "vitest";
import {
  localToARIso,
  toARDateKey,
  toARHour,
  toARDow,
  isoToARLocalInput,
} from "@/lib/datetime-ar";

// These helpers are the correctness spine of the agenda: every wall-clock
// value the user picks or sees flows through them. The tests pin the exact
// behaviour the timezone fixes rely on, so a regression fails the build.

describe("localToARIso", () => {
  it("tags a bare datetime-local string with AR's fixed -03:00 offset", () => {
    expect(localToARIso("2026-05-26T14:00")).toBe("2026-05-26T14:00:00-03:00");
  });
  it("keeps seconds when present", () => {
    expect(localToARIso("2026-05-26T14:00:30")).toBe("2026-05-26T14:00:30-03:00");
  });
  it("leaves an already-explicit offset / Z untouched", () => {
    expect(localToARIso("2026-05-26T14:00Z")).toBe("2026-05-26T14:00Z");
    expect(localToARIso("2026-05-26T14:00:00-03:00")).toBe("2026-05-26T14:00:00-03:00");
  });
  it("returns empty string for empty/null input", () => {
    expect(localToARIso("")).toBe("");
    expect(localToARIso(null)).toBe("");
    expect(localToARIso(undefined)).toBe("");
  });
  it("round-trips through Date to the intended AR wall-clock", () => {
    // 08:00 AR must persist as 11:00 UTC (not 08:00 UTC = 05:00 AR).
    const d = new Date(localToARIso("2026-05-26T08:00"));
    expect(d.toISOString()).toBe("2026-05-26T11:00:00.000Z");
  });
});

describe("toARDateKey / toARHour / toARDow", () => {
  it("buckets a late-night instant on the correct AR day, not the UTC day", () => {
    // 01:00 UTC on the 27th is 22:00 AR on the 26th.
    const inst = new Date("2026-05-27T01:00:00Z");
    expect(toARDateKey(inst)).toBe("2026-05-26");
    expect(toARHour(inst)).toBe(22);
  });
  it("gives the fractional AR hour", () => {
    expect(toARHour(new Date("2026-05-26T14:30:00-03:00"))).toBe(14.5);
  });
  it("reads day-of-week in AR (0=Sun..6=Sat) across the UTC boundary", () => {
    // 2026-05-24 is a Sunday. 02:00 UTC Monday the 25th is still 23:00 AR Sunday.
    expect(toARDow(new Date("2026-05-25T02:00:00Z"))).toBe(0);
    // Midday keeps the same day both sides.
    expect(toARDow(new Date("2026-05-26T15:00:00Z"))).toBe(2); // Tuesday
  });
});

describe("isoToARLocalInput", () => {
  it("renders a DB instant back as an AR datetime-local value", () => {
    expect(isoToARLocalInput("2026-05-26T11:00:00.000Z")).toBe("2026-05-26T08:00");
  });
  it("returns empty string for an invalid date", () => {
    expect(isoToARLocalInput("not-a-date")).toBe("");
  });
});
