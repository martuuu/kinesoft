import { describe, it, expect } from "vitest";
import { receptionSections, RECEPTION_SECTIONS } from "@/components/agenda/reception/reception-sections";
import { receptionRowOperable } from "@/components/agenda/reception/reception-operable";
import type { ReceptionState } from "@/lib/reception-state";

const e = (id: string, state: ReceptionState) => ({ id, state });
// Orden de `sortForReception`: en atención arriba, después cronológico, cancelados al final.
const entries = [
  e("box", "en-atencion"),
  e("hecho", "atendido"),
  e("demorado", "demorado"),
  e("sala", "en-sala"),
  e("llamado", "llamado"),
  e("futuro", "por-llegar"),
  e("ausente", "ausente"),
  e("cancel", "cancelado"),
];

describe("[AS-0d] receptionSections (Recepción plegable a 390)", () => {
  it("«Esperando» primero, sin secciones vacías y el orden de entrada adentro de cada una", () => {
    const s = receptionSections(entries, "todos");
    expect(s.map((x) => x.id)).toEqual(["esperando", "en-atencion", "por-llegar", "atendidos", "ausentes", "cancelados"]);
    expect(s[0].entries.map((x) => x.id)).toEqual(["sala", "llamado"]);
    expect(s[2].entries.map((x) => x.id)).toEqual(["demorado", "futuro"]);
    expect(receptionSections([e("a", "por-llegar")], "todos").map((x) => x.id)).toEqual(["por-llegar"]);
  });
  it("cada estado cae en exactamente una sección", () => {
    const all: ReceptionState[] = ["por-llegar", "demorado", "en-sala", "llamado", "en-atencion", "atendido", "ausente", "cancelado"];
    for (const st of all) expect(RECEPTION_SECTIONS.filter((s) => s.states.includes(st))).toHaveLength(1);
    const total = receptionSections(entries, "todos").reduce((n, s) => n + s.entries.length, 0);
    expect(total).toBe(entries.length);
  });
  it("con «Todos» lo terminado arranca plegado; con otro filtro todo abierto; lo elegido por el usuario manda", () => {
    const open = (f: Parameters<typeof receptionSections>[1], t = {}) =>
      Object.fromEntries(receptionSections(entries, f, t).map((s) => [s.id, s.open]));
    expect(open("todos")).toEqual({ esperando: true, "en-atencion": true, "por-llegar": true, atendidos: false, ausentes: false, cancelados: false });
    expect(Object.values(open("atendidos")).every(Boolean)).toBe(true);
    expect(open("todos", { atendidos: true, esperando: false })).toMatchObject({ atendidos: true, esperando: false });
  });
});

describe("[AS-0d] receptionRowOperable = regla de markReceptionAction", () => {
  it("canOperate del DTO (full ∨ operateAll) alcanza", () => {
    expect(receptionRowOperable({ practitionerId: "p2", canOperate: true }, "p1")).toBe(true);
    expect(receptionRowOperable({ practitionerId: "p2" }, null)).toBe(true);
  });
  it("turno PROPIO con paciente basic: el server lo acepta (isActorPractitioner) y la UI también", () => {
    expect(receptionRowOperable({ practitionerId: "p1", canOperate: false }, "p1")).toBe(true);
  });
  it("turno ajeno sin acceso: no", () => {
    expect(receptionRowOperable({ practitionerId: "p2", canOperate: false }, "p1")).toBe(false);
    expect(receptionRowOperable({ practitionerId: "p2", canOperate: false }, null)).toBe(false);
    expect(receptionRowOperable({ practitionerId: "", canOperate: false }, "")).toBe(false);
  });
});
