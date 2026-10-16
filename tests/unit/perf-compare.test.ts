/**
 * PF-Z: regla estricta del payload de la agenda en `tests/perf/compare.ts` (C-PF8, AUDIT `perf-agenda-payload-1mb`).
 * La función es pura; el CLI solo la aplica sobre la clave `agendaPayloadBytes` de la corrida.
 */
import { describe, it, expect } from "vitest";
import { AGENDA_PAYLOAD_MAX_BYTES, checkAgendaPayload } from "@/tests/perf/compare";

describe("checkAgendaPayload", () => {
  it("el techo es 400 kB", () => {
    expect(AGENDA_PAYLOAD_MAX_BYTES).toBe(400_000);
  });
  it("pasa en el techo y falla por encima (el ~1 MB de antes de PF2 falla)", () => {
    expect(checkAgendaPayload(400_000).status).toBe("ok");
    expect(checkAgendaPayload(400_001).status).toBe("fail");
    expect(checkAgendaPayload(802_569).status).toBe("fail");
  });
  it("sin medición no falla (se informa)", () => {
    expect(checkAgendaPayload(null).status).toBe("missing");
    expect(checkAgendaPayload(undefined).status).toBe("missing");
  });
});
