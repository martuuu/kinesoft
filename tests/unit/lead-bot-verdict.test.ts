/**
 * VX-Z (B7): `leadBotVerdict` dejaba pasar CUALQUIER `startedAt` futuro («reloj del cliente adelantado»), así que un
 * bot que posteaba `startedAt` = año 2100 se salteaba el filtro de tiempo. Un reloj desfasado de verdad son minutos u
 * horas; más de 24 h en el futuro no es un humano → `bot`.
 */
import { describe, it, expect } from "vitest";
import { LEAD_MIN_FILL_MS, leadBotVerdict } from "@/lib/support-threads-types";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const H = 60 * 60_000;
const v = (startedAt: number | null, website = "") => leadBotVerdict({ website, startedAt, now: NOW });

describe("leadBotVerdict", () => {
  it("honeypot lleno o sin startedAt → bot", () => {
    expect(v(NOW - 10_000, "http://spam")).toBe("bot");
    expect(v(null)).toBe("bot");
  });
  it("menos de 3 s → bot; más → ok", () => {
    expect(v(NOW - LEAD_MIN_FILL_MS + 1)).toBe("bot");
    expect(v(NOW - LEAD_MIN_FILL_MS)).toBe("ok");
  });
  it("futuro de hasta 24 h (reloj adelantado) → ok", () => {
    expect(v(NOW + 1)).toBe("ok");
    expect(v(NOW + 24 * H)).toBe("ok");
  });
  it("más de 24 h en el futuro → bot", () => {
    expect(v(NOW + 24 * H + 1)).toBe("bot");
    expect(v(Date.UTC(2100, 0, 1))).toBe("bot");
  });
});
