import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DisciplineChip, disciplineChipText } from "@/components/planes/discipline-chip";

/** [P3-C] V1-D18: chip `Kine · 3/10` con aria "Sesión 3 de 10 · Kinesiología"; nunca el título. */

describe("DisciplineChip", () => {
  it("chip de sesión: texto corto visible, aria con el literal de planSessionLabel", () => {
    const html = renderToStaticMarkup(<DisciplineChip discipline="KINESIOLOGY" ordinal={3} totalLive={10} />);
    expect(html).toContain(">Kine · 3/10<");
    expect(html).toContain('aria-label="Sesión 3 de 10 · Kinesiología"');
    expect(html).toContain('role="img"');
    expect(html).toContain("var(--disc-kine)");
  });

  it("legacy sin disciplina: 'Plan · 2/8' y sin color de disciplina", () => {
    const html = renderToStaticMarkup(<DisciplineChip discipline={null} ordinal={2} totalLive={8} />);
    expect(html).toContain(">Plan · 2/8<");
    expect(html).toContain('aria-label="Sesión 2 de 8"');
    expect(html).not.toContain("--disc-");
  });

  it("solo disciplina: corta por default, larga a pedido", () => {
    expect(disciplineChipText({ discipline: "OSTEOPATHY" })).toEqual({ text: "Osteo", ariaLabel: "Osteopatía" });
    expect(disciplineChipText({ discipline: "OSTEOPATHY", label: "long" }).text).toBe("Osteopatía");
    expect(disciplineChipText({ discipline: null }).text).toBe("Plan");
  });

  it("un título colado en las props no se renderiza (la entrada no lo lee)", () => {
    const props = { discipline: "KINESIOLOGY" as const, ordinal: 1, totalLive: 4, title: "Lumbalgia" };
    const html = renderToStaticMarkup(<DisciplineChip {...props} />);
    expect(html).not.toContain("Lumbalgia");
  });
});
