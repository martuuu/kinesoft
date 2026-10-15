import { describe, it, expect } from "vitest";
import { formatARS, formatDateAR, parseARS } from "@/lib/format";

// Currency + date formatting are shown to the user in many places; the tests
// pin the contract (cents→pesos, null→"", AR timezone) without asserting the
// exact ICU glyphs/whitespace, which vary across Node versions.

const strip = (s: string) => s.replace(/ /g, " ");

describe("formatARS", () => {
  it("formats cents as integer pesos with the AR thousands separator", () => {
    const out = strip(formatARS(150000)); // $1.500,00 → no decimals
    expect(out).toContain("$");
    expect(out).toContain("1.500");
    expect(out).not.toContain(",00");
  });
  it("treats 0 as a real amount, not empty", () => {
    expect(strip(formatARS(0))).toContain("0");
  });
  it("returns empty string for null/undefined/NaN", () => {
    expect(formatARS(null)).toBe("");
    expect(formatARS(undefined)).toBe("");
    expect(formatARS(NaN)).toBe("");
  });
  it("honours fromCents:false to format a raw peso value", () => {
    expect(strip(formatARS(1500, { fromCents: false }))).toContain("1.500");
  });
});

describe("parseARS", () => {
  it("parses AR-formatted money strings into integer cents", () => {
    expect(parseARS("1.500,50")).toBe(150050);
    expect(parseARS("1500")).toBe(150000);
    expect(parseARS("1.500")).toBe(150000);
    expect(parseARS("12,5")).toBe(1250);
    expect(parseARS("$ 2.000")).toBe(200000);
  });
  it("returns null for empty/garbage input", () => {
    expect(parseARS("")).toBeNull();
    expect(parseARS("abc")).toBeNull();
    expect(parseARS(null)).toBeNull();
    expect(parseARS(undefined)).toBeNull();
  });
  it("treats a number input as pesos already", () => {
    expect(parseARS(1500)).toBe(150000);
    expect(parseARS(0)).toBe(0);
    expect(parseARS(NaN)).toBeNull();
  });
});

describe("formatDateAR", () => {
  it("returns empty string for null/invalid", () => {
    expect(formatDateAR(null)).toBe("");
    expect(formatDateAR("not-a-date")).toBe("");
  });
  it("formats a late-night UTC instant on the correct AR day", () => {
    // 01:00 UTC on the 27th is the 26th in AR.
    const out = formatDateAR("2026-05-27T01:00:00Z", "short");
    expect(out).toContain("26");
    expect(out).not.toContain("27");
  });
  it("[BO3-F] medianoche AR sale «00:30», no «24:30» (hourCycle h23, no hour12:false)", () => {
    // 03:30Z = 00:30 AR. Con `hour12:false` el ICU de Node imprimía «24:30».
    expect(formatDateAR("2026-10-14T03:30:00Z", "time")).toBe("00:30");
    expect(formatDateAR("2026-10-14T17:05:00Z", "time")).toBe("14:05");
    expect(formatDateAR("2026-10-14T03:30:00Z", "longDateTime")).toContain("00:30");
    expect(formatDateAR("2026-10-14T03:30:00Z", "longDateTime")).not.toContain("24:");
  });
  it("[EV1-E2] compact en 24h: medianoche AR «00:30», ni «12:30 a. m.» ni «24:30»", () => {
    // 03:30Z = 00:30 AR del 14. Antes el preset no tenía hourCycle y es-AR caía en 12h.
    const out = formatDateAR("2026-10-14T03:30:00Z", "compact");
    expect(out).toBe("14/10/26, 00:30");
    expect(out).not.toMatch(/a\.\s?m\.|p\.\s?m\.|24:30|12:30/);
    expect(formatDateAR("2026-10-14T17:05:00Z", "compact")).toBe("14/10/26, 14:05");
  });
});
