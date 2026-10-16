import { describe, it, expect } from "vitest";
import {
  PortalPendingChanges,
  changedFieldNames,
  fitsPendingChangesBudget,
  pendingChangesByteLength,
  PORTAL_PENDING_CHANGES_MAX_BYTES,
} from "@/lib/portal-pending-changes";

/**
 * [P4-C] Contrato de `PatientChangeRequest.changes` (brief ES4 §3.5): `.strict()` en raíz y anidados, topes por campo,
 * espejo del CHECK de 4096 B y «al menos una clave».
 */

const ok = (v: unknown) => PortalPendingChanges.safeParse(v).success;

describe("[P4-C] PortalPendingChanges", () => {
  it("acepta la forma completa de PLANES §12", () => {
    const v = {
      phone: "+54 9 11 5555-5555",
      email: "ana@example.com",
      emergencyContact: { name: "Juan", relation: "Hermano", phone: "1144445555" },
      coverage: { insurerName: "OSDE", planName: "210", memberId: "123456" },
    };
    const r = PortalPendingChanges.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(v);
  });

  it("acepta null donde la forma lo permite (borrar el valor)", () => {
    expect(ok({ phone: null })).toBe(true);
    expect(ok({ email: null })).toBe(true);
    expect(ok({ emergencyContact: null })).toBe(true);
    expect(ok({ coverage: { insurerName: "OSDE", planName: null, memberId: null } })).toBe(true);
    expect(ok({ emergencyContact: { name: "Juan", relation: null, phone: "1144445555" } })).toBe(true);
  });

  it("coverage no admite null (no es «borrar la cobertura» desde el portal)", () => {
    expect(ok({ coverage: null })).toBe(false);
  });

  it("rechaza claves extra en la raíz", () => {
    expect(ok({ phone: "1144445555", dni: "30111222" })).toBe(false);
  });

  it("rechaza claves extra en emergencyContact (strict anidado)", () => {
    expect(ok({ emergencyContact: { name: "J", phone: "1144445555", email: "x@y.com" } })).toBe(false);
  });

  it("rechaza claves extra en coverage (strict anidado)", () => {
    expect(ok({ coverage: { insurerName: "OSDE", insurerId: "abc" } })).toBe(false);
  });

  it("rechaza {} y claves solo con undefined", () => {
    expect(ok({})).toBe(false);
    expect(ok({ phone: undefined })).toBe(false);
  });

  it("aplica los topes por campo", () => {
    const s = (n: number) => "a".repeat(n);
    // ES4-Z B2: teléfono de 6 a 30 caracteres.
    expect(ok({ phone: s(30) })).toBe(true);
    expect(ok({ phone: s(31) })).toBe(false);
    expect(ok({ phone: s(6) })).toBe(true);
    expect(ok({ phone: s(5) })).toBe(false);
    const local = s(120 - "@example.com".length);
    expect(ok({ email: `${local}@example.com` })).toBe(true);
    expect(ok({ email: `a${local}@example.com` })).toBe(false);
    expect(ok({ email: "no-es-un-mail" })).toBe(false);
    const ec = (o: object) => ({ emergencyContact: { name: "J", phone: "1144445555", ...o } });
    expect(ok(ec({ name: s(80) }))).toBe(true);
    expect(ok(ec({ name: s(81) }))).toBe(false);
    expect(ok(ec({ relation: s(40) }))).toBe(true);
    expect(ok(ec({ relation: s(41) }))).toBe(false);
    expect(ok(ec({ phone: s(31) }))).toBe(false);
    expect(ok(ec({ phone: s(5) }))).toBe(false);
    const cov = (o: object) => ({ coverage: { insurerName: "OSDE", ...o } });
    expect(ok(cov({ insurerName: s(80) }))).toBe(true);
    expect(ok(cov({ insurerName: s(81) }))).toBe(false);
    expect(ok(cov({ planName: s(81) }))).toBe(false);
    expect(ok(cov({ memberId: s(40) }))).toBe(true);
    expect(ok(cov({ memberId: s(41) }))).toBe(false);
  });

  it("rechaza obligatorios vacíos o con solo espacios", () => {
    expect(ok({ emergencyContact: { name: "  ", phone: "1144445555" } })).toBe(false);
    expect(ok({ coverage: { insurerName: "" } })).toBe(false);
    expect(ok({ phone: "" })).toBe(false);
  });

  it("rechaza tipos equivocados", () => {
    expect(ok({ phone: 1144445555 })).toBe(false);
    expect(ok({ emergencyContact: "Juan" })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
  });
});

describe("[P4-C] tope de bytes (espejo de PatientChangeRequest_changes_check)", () => {
  const sized = (n: number) => {
    // {"x":"…"} = 8 bytes de envoltorio.
    const v = { x: "a".repeat(n - 8) };
    expect(pendingChangesByteLength(v)).toBe(n);
    return v;
  };

  it("4096 B entra, 4097 B no", () => {
    expect(PORTAL_PENDING_CHANGES_MAX_BYTES).toBe(4096);
    expect(fitsPendingChangesBudget(sized(4096))).toBe(true);
    expect(fitsPendingChangesBudget(sized(4097))).toBe(false);
  });

  it("cuenta bytes UTF-8, no caracteres", () => {
    expect(pendingChangesByteLength({ x: "ñ" })).toBe(10); // 8 de envoltorio + 2 de la ñ
  });

  it("el schema rechaza un payload de 4097 B", () => {
    const v = { phone: "1144445555", pad: "a".repeat(4097) };
    expect(pendingChangesByteLength(v)).toBeGreaterThan(4096);
    expect(ok(v)).toBe(false);
  });

  it("el peor caso permitido por los topes por campo entra en el CHECK", () => {
    const s = (n: number) => "\u0001".repeat(n); // se serializa como \u0001 (6 B por carácter)
    const worst = {
      phone: s(30),
      email: null,
      emergencyContact: { name: s(80), relation: s(40), phone: s(30) },
      coverage: { insurerName: s(80), planName: s(80), memberId: s(40) },
    };
    expect(fitsPendingChangesBudget(worst)).toBe(true);
  });
});

describe("[P4-C] changedFieldNames", () => {
  it("devuelve los nombres en orden fijo, sin valores", () => {
    expect(
      changedFieldNames({ coverage: { insurerName: "OSDE" }, phone: null, email: "a@b.com" }),
    ).toEqual(["phone", "email", "coverage"]);
    expect(changedFieldNames({ emergencyContact: null })).toEqual(["emergencyContact"]);
  });

  it("ignora claves con undefined", () => {
    expect(changedFieldNames({ phone: undefined, email: "a@b.com" })).toEqual(["email"]);
  });
});
