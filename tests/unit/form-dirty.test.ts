/**
 * lib/form-dirty (A2b-S-ui ítem 3) — la lógica pura detrás del dirty-guard de
 * los drawers (turno nuevo, nuevo paciente, edición de paciente, drawer de
 * turno). Lo visual (el confirm al cerrar) va por QA manual.
 */
import { describe, it, expect } from "vitest";
import { formStateKey, isFormDirty, recordsDiffer } from "@/lib/form-dirty";

describe("formStateKey + isFormDirty", () => {
  const base = formStateKey(
    [
      ["firstName", ""],
      ["serviceId", "svc_1"],
    ],
    { isGuest: false, coverage: "particular" }
  );

  it("mismo estado → limpio", () => {
    const same = formStateKey(
      [
        ["firstName", ""],
        ["serviceId", "svc_1"],
      ],
      { coverage: "particular", isGuest: false } // otro orden de claves
    );
    expect(isFormDirty(base, same)).toBe(false);
  });

  it("escribir en un campo → sucio; volver al valor original → limpio", () => {
    const typed = formStateKey(
      [
        ["firstName", "Ana"],
        ["serviceId", "svc_1"],
      ],
      { isGuest: false, coverage: "particular" }
    );
    expect(isFormDirty(base, typed)).toBe(true);
    const erased = formStateKey(
      [
        ["firstName", ""],
        ["serviceId", "svc_1"],
      ],
      { isGuest: false, coverage: "particular" }
    );
    expect(isFormDirty(base, erased)).toBe(false);
  });

  it("estado fuera de los inputs (switch, select controlado) cuenta", () => {
    const toggled = formStateKey(
      [
        ["firstName", ""],
        ["serviceId", "svc_1"],
      ],
      { isGuest: true, coverage: "particular" }
    );
    expect(isFormDirty(base, toggled)).toBe(true);
  });

  it("undefined en extra equivale a null (no genera falso sucio)", () => {
    expect(formStateKey([], { a: undefined })).toBe(formStateKey([], { a: null }));
  });

  it("archivos: se comparan por nombre", () => {
    const a = formStateKey([["file", { name: "rx.pdf" }]]);
    expect(isFormDirty(a, formStateKey([["file", { name: "rx.pdf" }]]))).toBe(false);
    expect(isFormDirty(a, formStateKey([["file", { name: "otro.pdf" }]]))).toBe(true);
  });

  it("sin foto inicial nunca es sucio (no bloquea cerrar un drawer recién montado)", () => {
    expect(isFormDirty(null, base)).toBe(false);
  });
});

describe("recordsDiffer (formularios controlados por estado)", () => {
  const initial = { durationMin: 45, notes: "", title: "Lumbalgia", description: null };

  it("sin cambios → false (null/undefined/'' de bordes)", () => {
    expect(recordsDiffer(initial, { durationMin: 45, notes: "", title: "Lumbalgia", description: undefined })).toBe(false);
    expect(recordsDiffer(initial, { ...initial, title: "  Lumbalgia " })).toBe(false);
  });

  it("un campo distinto → true", () => {
    expect(recordsDiffer(initial, { ...initial, durationMin: 60 })).toBe(true);
    expect(recordsDiffer(initial, { ...initial, notes: "trae estudios" })).toBe(true);
  });

  it("campo nuevo con valor → true", () => {
    expect(recordsDiffer({ a: 1 }, { a: 1, b: "x" })).toBe(true);
  });
});
