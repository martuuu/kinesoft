import { describe, expect, it } from "vitest";
import { ACTIVE_DIAGNOSIS_TITLE_MAX, type DiagnosisSnapshot } from "@/lib/diagnoses-types";
import {
  activeDiagnosisTitle,
  dedupeRecents,
  isLateEntry,
  normalizeDiagnosisText,
  parseDiagnosisQuery,
  rankDiagnosisMatch,
} from "@/lib/diagnoses-logic";

const snap = (code: string | null, title: string): DiagnosisSnapshot => ({
  v: 1,
  source: code ? "icd11" : "text",
  refId: null,
  code,
  title,
  uri: null,
  release: null,
});

describe("[FC-1b] activeDiagnosisTitle ≤80", () => {
  it("«{código} {título}»; sin código, solo el título", () => {
    expect(activeDiagnosisTitle(snap("ME84.2", "Lumbalgia"))).toBe("ME84.2 Lumbalgia");
    expect(activeDiagnosisTitle(snap(null, "Esguince de tobillo"))).toBe("Esguince de tobillo");
    expect(activeDiagnosisTitle(snap("  FA20 ", "  Artrosis   de  rodilla \n"))).toBe("FA20 Artrosis de rodilla");
  });

  it("exactamente 80 no se corta", () => {
    const t = "a".repeat(80);
    expect(activeDiagnosisTitle(snap(null, t))).toBe(t);
  });

  it("más de 80 → corta en límite de palabra con «…» y nunca pasa de 80", () => {
    const title = "Lumbalgia mecánica con irradiación al miembro inferior izquierdo sin déficit neurológico agregado";
    const out = activeDiagnosisTitle(snap("ME84.2", title));
    expect(Array.from(out).length).toBeLessThanOrEqual(ACTIVE_DIAGNOSIS_TITLE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("ME84.2 Lumbalgia")).toBe(true);
    // Sin palabra partida: lo de antes de «…» es un prefijo de palabras enteras del original.
    const kept = out.slice(0, -1);
    expect(`ME84.2 ${title}`.startsWith(kept)).toBe(true);
    expect(`ME84.2 ${title}`.charAt(kept.length)).toBe(" ");
  });

  it("una palabra larguísima se corta duro (sin espacio razonable)", () => {
    const out = activeDiagnosisTitle(snap(null, "x".repeat(200)));
    expect(out).toBe(`${"x".repeat(79)}…`);
  });

  it("cuenta por code point (no parte un emoji)", () => {
    const out = activeDiagnosisTitle(snap(null, "🦴".repeat(100)));
    expect(Array.from(out).length).toBe(80);
    expect(out).toBe(`${"🦴".repeat(79)}…`);
  });
});

describe("[FC-1b] isLateEntry", () => {
  const occurredAt = "2026-10-10T23:00:00.000Z"; // 20:00 AR

  it("importada → siempre carga tardía", () => {
    expect(isLateEntry({ importSource: { kind: "docx" }, createdAt: occurredAt, occurredAt })).toBe(true);
  });

  it("createdAt − occurredAt > 24 h estricto", () => {
    const plus = (ms: number) => new Date(new Date(occurredAt).getTime() + ms);
    const H = 3_600_000;
    expect(isLateEntry({ importSource: null, createdAt: plus(24 * H), occurredAt })).toBe(false);
    expect(isLateEntry({ importSource: null, createdAt: plus(24 * H + 1), occurredAt })).toBe(true);
    expect(isLateEntry({ importSource: null, createdAt: plus(2 * H), occurredAt })).toBe(false);
    // Fecha de atención futura (no debería pasar) no marca.
    expect(isLateEntry({ importSource: null, createdAt: plus(-5 * H), occurredAt })).toBe(false);
  });

  it("no depende del día calendario: cuentan las horas, no las fechas UTC ni AR", () => {
    // Turno el 10 a las 23:00 AR (02:00Z del 11), ficha el 11 a las 23:30 AR (02:30Z del 12): cruza dos fechas UTC y
    // una sola AR; lo que cuenta son las horas.
    expect(
      isLateEntry({ importSource: null, occurredAt: "2026-10-11T02:00:00.000Z", createdAt: "2026-10-12T02:30:00.000Z" }),
    ).toBe(true);
    // Mismo día AR, cruzando la medianoche UTC: 23:00 AR → 01:00 AR (2 h) no es tardía.
    expect(
      isLateEntry({ importSource: null, occurredAt: "2026-10-11T02:00:00.000Z", createdAt: "2026-10-11T04:00:00.000Z" }),
    ).toBe(false);
  });

  it("acepta Date y string; fechas inválidas no marcan", () => {
    expect(isLateEntry({ importSource: null, createdAt: new Date("2026-10-20T00:00:00Z"), occurredAt: new Date("2026-10-01T00:00:00Z") })).toBe(true);
    expect(isLateEntry({ importSource: null, createdAt: "no-es-fecha", occurredAt })).toBe(false);
    expect(isLateEntry({ importSource: undefined, createdAt: occurredAt, occurredAt })).toBe(false);
  });
});

// ─── Stubs de FC-2c ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("[FC-1b] búsqueda de diagnósticos (stubs de FC-2c)", () => {
  it.fails("[FC-2c] parseDiagnosisQuery: <2 caracteres → null; patrón de código → codePrefix", () => {
    expect(parseDiagnosisQuery("a")).toBeNull();
    expect(parseDiagnosisQuery("ME84")?.codePrefix).toBeTruthy();
    expect(parseDiagnosisQuery("lumbalgia")?.codePrefix).toBeNull();
  });

  it.fails("[FC-2c] normalizeDiagnosisText sin tildes ni signos", () => {
    expect(normalizeDiagnosisText("Lumbalgía, AGUDA")).toBe("lumbalgia aguda");
  });

  it.fails("[FC-2c] rankDiagnosisMatch: código exacto 0 > prefijo 1", () => {
    const q = { text: "me84", codePrefix: "ME84" };
    expect(rankDiagnosisMatch({ code: "ME84", title: "Dolor" }, q)).toBe(0);
    expect(rankDiagnosisMatch({ code: "ME84.2", title: "Lumbalgia" }, q)).toBe(1);
  });

  it.fails("[FC-2c] dedupeRecents sin repetir", () => {
    const a = snap("ME84.2", "Lumbalgia");
    expect(dedupeRecents([[a], [a]], 8)).toHaveLength(1);
  });
});
