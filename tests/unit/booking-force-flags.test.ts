import { describe, expect, it } from "vitest";
import {
  FORCE_FLAG_BY_KIND,
  forcePromptActionLabel,
  forcePromptConfirm,
  forcePromptHeadline,
  nextForcePrompt,
  withForce,
  type ForceableResult,
  type ForceFlags,
} from "@/lib/booking-force-flags";

// B5.7: qué aviso muestra cada caller (drawer, turnos-view, dashboard) y con
// qué flag re-llama. Si esto se rompe, el staff vuelve a quedar trabado ante
// un bloqueo / fuera de horario sin poder forzar.

const NEXT = "2026-10-01T13:00:00.000Z";
const blocked = { practitionerName: "Ana", reason: "Congreso", nextFreeISO: NEXT };
const outOfHours = { practitionerName: "Ana", nextFreeISO: null };
const conflict = { practitionerName: "Ana", nextFreeISO: NEXT };
const patientOverlap = { existingISO: NEXT };

describe("nextForcePrompt", () => {
  it.each([
    ["blocked", { blocked }, "allowBlocked"],
    ["outOfHours", { outOfHours }, "allowOutOfHours"],
    ["conflict", { conflict }, "allowOverbooking"],
    ["patientOverlap", { patientOverlap }, "allowPatientOverlap"],
  ] as const)("%s → flag %s", (kind, r, flag) => {
    const p = nextForcePrompt(r as ForceableResult);
    expect(p?.kind).toBe(kind);
    expect(p?.flag).toBe(flag);
    expect(FORCE_FLAG_BY_KIND[kind]).toBe(flag);
  });

  it("sin aviso forzable → null (el caller muestra `error`)", () => {
    expect(nextForcePrompt({})).toBeNull();
    expect(nextForcePrompt({ conflict: null, blocked: null })).toBeNull();
  });

  it("lleva profesional, motivo y próximo libre", () => {
    expect(nextForcePrompt({ blocked })).toEqual({
      kind: "blocked",
      flag: "allowBlocked",
      practitionerName: "Ana",
      reason: "Congreso",
      nextFreeISO: NEXT,
    });
    expect(nextForcePrompt({ outOfHours })?.nextFreeISO).toBeNull();
    expect(nextForcePrompt({ conflict })?.nextFreeISO).toBe(NEXT);
    expect(nextForcePrompt({ patientOverlap })?.nextFreeISO).toBeNull();
  });

  it("orden del server: bloqueo > horario > cupo > paciente", () => {
    const all: ForceableResult = { blocked, outOfHours, conflict, patientOverlap };
    expect(nextForcePrompt(all)?.kind).toBe("blocked");
    expect(nextForcePrompt(all, { allowBlocked: true })?.kind).toBe("outOfHours");
    expect(nextForcePrompt(all, { allowBlocked: true, allowOutOfHours: true })?.kind).toBe("conflict");
    expect(
      nextForcePrompt(all, { allowBlocked: true, allowOutOfHours: true, allowOverbooking: true })?.kind
    ).toBe("patientOverlap");
  });

  it("un aviso cuyo flag ya se mandó no se repite (no loopea)", () => {
    expect(nextForcePrompt({ blocked }, { allowBlocked: true })).toBeNull();
    expect(nextForcePrompt({ outOfHours }, { allowOutOfHours: true })).toBeNull();
    expect(nextForcePrompt({ conflict }, { allowOverbooking: true })).toBeNull();
    expect(nextForcePrompt({ patientOverlap }, { allowPatientOverlap: true })).toBeNull();
  });
});

describe("withForce", () => {
  it("acumula los flags entre reintentos sin mutar el anterior", () => {
    const sent: ForceFlags = { allowBlocked: true };
    const p = nextForcePrompt({ conflict }, sent)!;
    const next = withForce(sent, p);
    expect(next).toEqual({ allowBlocked: true, allowOverbooking: true });
    expect(sent).toEqual({ allowBlocked: true });
  });

  it("simula la cadena bloqueo → cupo → ok del server", () => {
    // Respuestas sucesivas del server según los flags recibidos.
    const server = (f: ForceFlags): ForceableResult & { ok: boolean } =>
      !f.allowBlocked ? { ok: false, blocked } : !f.allowOverbooking ? { ok: false, conflict } : { ok: true };
    let force: ForceFlags = {};
    const shown: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = server(force);
      if (r.ok) break;
      const p = nextForcePrompt(r, force);
      if (!p) break;
      shown.push(p.kind);
      force = withForce(force, p);
    }
    expect(shown).toEqual(["blocked", "conflict"]);
    expect(force).toEqual({ allowBlocked: true, allowOverbooking: true });
  });
});

describe("copy", () => {
  it("bloqueado / cupo forzados = sobreturno; fuera de horario / superpuesto = igual", () => {
    const label = (r: ForceableResult, a: "reschedule" | "edit" | "reactivate") =>
      forcePromptActionLabel(nextForcePrompt(r)!, a);
    expect(label({ blocked }, "reschedule")).toBe("Cargar como sobreturno");
    expect(label({ conflict }, "edit")).toBe("Cargar como sobreturno");
    expect(label({ outOfHours }, "reschedule")).toBe("Cargar igual");
    expect(label({ patientOverlap }, "edit")).toBe("Cargar igual");
    expect(label({ blocked }, "reactivate")).toBe("Reactivar como sobreturno");
    expect(label({ outOfHours }, "reactivate")).toBe("Reactivar igual");
  });

  it("titular con profesional y motivo del bloqueo", () => {
    expect(forcePromptHeadline(nextForcePrompt({ blocked })!)).toContain("Congreso");
    expect(
      forcePromptHeadline(nextForcePrompt({ blocked: { ...blocked, reason: null } })!)
    ).toBe("Ana tiene la agenda bloqueada en ese horario.");
    expect(forcePromptHeadline(nextForcePrompt({ outOfHours })!)).toContain("fuera de la agenda de Ana");
  });

  it("opciones de useConfirm al reactivar", () => {
    expect(forcePromptConfirm(nextForcePrompt({ blocked })!, "reactivate")).toEqual({
      title: "Ana tiene la agenda bloqueada en ese horario (Congreso).",
      message: "Si lo reactivás, queda como sobreturno.",
      confirmLabel: "Reactivar como sobreturno",
    });
    expect(forcePromptConfirm(nextForcePrompt({ outOfHours })!, "reactivate").message).toBe(
      "¿Reactivar igual?"
    );
  });
});
