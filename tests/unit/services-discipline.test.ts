/**
 * S13 · disciplina sugerida desde el catálogo (puro) y parseo del input de
 * servicio (`ServiceInput` de `lib/validation.ts`, el que usan las actions).
 */
import { describe, it, expect } from "vitest";
import { suggestDisciplineFromSpecialties } from "@/lib/services-discipline";
import { ServiceInput } from "@/lib/validation";

describe("suggestDisciplineFromSpecialties", () => {
  it("osteopatía → OSTEOPATHY", () => {
    expect(suggestDisciplineFromSpecialties(["osteopatia"])).toBe("OSTEOPATHY");
  });

  it("kinesiología (profesión u orientación kine-*) → KINESIOLOGY", () => {
    expect(suggestDisciplineFromSpecialties(["prof-kinesiologia"])).toBe("KINESIOLOGY");
    expect(suggestDisciplineFromSpecialties(["kine-neurologica"])).toBe("KINESIOLOGY");
    expect(suggestDisciplineFromSpecialties(["prof-kinesiologia", "kine-general"])).toBe("KINESIOLOGY");
  });

  it("especialidades de otra profesión se ignoran (fisiatría es médica)", () => {
    expect(suggestDisciplineFromSpecialties(["med-fisiatria"])).toBeNull();
    expect(suggestDisciplineFromSpecialties(["med-fisiatria", "prof-kinesiologia"])).toBe("KINESIOLOGY");
    expect(suggestDisciplineFromSpecialties(["prof-psicologia"])).toBeNull();
  });

  it("sin especialidades → null", () => {
    expect(suggestDisciplineFromSpecialties([])).toBeNull();
  });

  it("práctica de las dos disciplinas → null (ambigua, decide el admin)", () => {
    expect(suggestDisciplineFromSpecialties(["osteopatia", "prof-kinesiologia"])).toBeNull();
    expect(suggestDisciplineFromSpecialties(["kine-terapias-manuales", "osteopatia"])).toBeNull();
  });
});

describe("ServiceInput.discipline", () => {
  const base = { name: "Sesión" };

  it("acepta las dos disciplinas", () => {
    expect(ServiceInput.parse({ ...base, discipline: "KINESIOLOGY" }).discipline).toBe("KINESIOLOGY");
    expect(ServiceInput.parse({ ...base, discipline: "OSTEOPATHY" }).discipline).toBe("OSTEOPATHY");
  });

  it('"" (select vacío) y null = sin disciplina; ausente = no se toca', () => {
    expect(ServiceInput.parse({ ...base, discipline: "" }).discipline).toBeNull();
    expect(ServiceInput.parse({ ...base, discipline: null }).discipline).toBeNull();
    expect(ServiceInput.parse(base).discipline).toBeUndefined();
    expect(ServiceInput.partial().parse({ priceCents: 10 }).discipline).toBeUndefined();
  });

  it("rechaza cualquier otro valor", () => {
    expect(ServiceInput.safeParse({ ...base, discipline: "NONE" }).success).toBe(false);
    expect(ServiceInput.safeParse({ ...base, discipline: "kinesiology" }).success).toBe(false);
  });
});
