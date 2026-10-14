/**
 * [IAM-0c] Etiquetas únicas de rol (C-IAM2). Antes había 5 mapas distintos:
 * `users-panel.tsx` decía «Owner»/«Admin»/«Asistente», `step-team.tsx`
 * «Asistente / Secretaría» y `/invite` mostraba el enum crudo («ASSISTANT»).
 * Martin no encontraba a la Secretaria en Usuarios (§19.1 punto 1).
 */
import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import {
  ROLE_ORDER,
  roleLabel,
  roleDescription,
  CLINICAL_ROLES,
  isClinicalRole,
  INVITABLE_ROLES,
  PRACTITIONER_FOR_ALL_ROLES,
} from "@/lib/roles";
import { capabilitiesFor } from "@/lib/capabilities";

const ALL: Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];

describe("[IAM-0c] roleLabel", () => {
  it("una etiqueta por rol, la Secretaria es «Secretario/a»", () => {
    expect(roleLabel("OWNER")).toBe("Dueño/a");
    expect(roleLabel("ADMIN")).toBe("Administrador/a");
    expect(roleLabel("PRACTITIONER")).toBe("Kinesiólogo/a");
    expect(roleLabel("ASSISTANT")).toBe("Secretario/a");
    expect(roleLabel("BILLING")).toBe("Facturación");
  });

  it("el profesional depende de la vertical: Kinesiología o sin vertical → Kinesiólogo/a; General → Profesional", () => {
    expect(roleLabel("PRACTITIONER", "KINESIOLOGY")).toBe("Kinesiólogo/a");
    expect(roleLabel("PRACTITIONER", null)).toBe("Kinesiólogo/a");
    expect(roleLabel("PRACTITIONER", undefined)).toBe("Kinesiólogo/a");
    expect(roleLabel("PRACTITIONER", "GENERAL")).toBe("Profesional");
  });

  it("los demás roles no cambian con la vertical", () => {
    for (const r of ALL.filter((x) => x !== "PRACTITIONER")) {
      expect(roleLabel(r, "GENERAL")).toBe(roleLabel(r, "KINESIOLOGY"));
    }
  });

  it("nunca devuelve el enum crudo", () => {
    for (const r of ALL) {
      for (const v of ["GENERAL", "KINESIOLOGY", null] as const) {
        expect(roleLabel(r, v)).not.toBe(r);
      }
    }
  });
});

describe("[IAM-0c] roleDescription", () => {
  it("Secretario/a y Facturación con el texto acordado", () => {
    expect(roleDescription("ASSISTANT")).toBe("Maneja la agenda y la recepción de todos. No ve historias clínicas.");
    expect(roleDescription("BILLING")).toBe("Ve cobros y facturación. No ve historias clínicas.");
  });

  it("una línea no vacía para cada rol y vertical", () => {
    for (const r of ALL) {
      for (const v of ["GENERAL", "KINESIOLOGY", null] as const) {
        const d = roleDescription(r, v);
        expect(d.length).toBeGreaterThan(10);
        expect(d).not.toContain("\n");
      }
    }
  });

  it("coherente con la matriz: dice «No ve historias clínicas» exactamente en los roles sin clinical.read", () => {
    for (const r of ALL) {
      const reads = capabilitiesFor(r).has("clinical.read");
      expect(roleDescription(r).includes("No ve historias clínicas")).toBe(!reads);
    }
  });

  it("en General el profesional no menciona planes (el módulo no existe ahí)", () => {
    expect(roleDescription("PRACTITIONER", "GENERAL")).not.toMatch(/plan/i);
  });
});

describe("[IAM-0c] conjuntos de roles", () => {
  it("ROLE_ORDER tiene los 5 roles, en orden de jerarquía", () => {
    expect([...ROLE_ORDER]).toEqual(["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]);
  });

  it("clínicos = OWNER, ADMIN, PRACTITIONER (los que leen clínica en la matriz)", () => {
    expect([...CLINICAL_ROLES].sort()).toEqual(["ADMIN", "OWNER", "PRACTITIONER"]);
    for (const r of ALL) {
      expect(isClinicalRole(r)).toBe(capabilitiesFor(r).has("clinical.read"));
    }
  });

  it("invitables: todos menos OWNER, con Kinesiólogo/a primero (es el default del selector)", () => {
    expect(new Set(INVITABLE_ROLES)).toEqual(new Set(["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]));
    expect(INVITABLE_ROLES).not.toContain("OWNER");
    expect([...INVITABLE_ROLES]).toEqual(["PRACTITIONER", "ASSISTANT", "ADMIN", "BILLING"]);
  });

  it("PRACTITIONER_FOR_ALL_ROLES sigue en true hasta IAM-4", () => {
    expect(PRACTITIONER_FOR_ALL_ROLES).toBe(true);
  });
});
