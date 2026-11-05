/**
 * CF3 ZF4a (B, auditoría de CT-I): «¿este miembro supervisa todo el consultorio?» en UN solo predicado
 * (`isOversightMember`, lib/roles-core.ts). Antes `OVERSIGHT_ROLES` estaba copiado en `lib/visibility.ts` (`memberTier`,
 * la barrera de la HC) y en `lib/dashboard.ts` (`countsScopeTokenFor`, el token de cache de los counts), y el co-titular
 * se sumaba aparte en cada uno: si una copia cambiaba y la otra no, el dashboard contaba un universo distinto del que
 * la HC le abre.
 *
 * Símbolo real; el guard de fuente asegura que las dos copias no vuelvan.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "@prisma/client";
import { isOversightMember } from "@/lib/roles-core";

const ROLES: Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];

describe("[CF3-ZF4a6] isOversightMember", () => {
  it("Titular y Administrador/a supervisan; Profesional, Secretaria y Facturación no", () => {
    expect(Object.fromEntries(ROLES.map((role) => [role, isOversightMember({ role })]))).toEqual({
      OWNER: true,
      ADMIN: true,
      PRACTITIONER: false,
      ASSISTANT: false,
      BILLING: false,
    });
  });

  it("co-titular (PRACTITIONER + grantCoOwner) supervisa como el Titular; el flag en otro rol no abre nada", () => {
    expect(isOversightMember({ role: "PRACTITIONER", grantCoOwner: true })).toBe(true);
    expect(isOversightMember({ role: "PRACTITIONER", grantCoOwner: false })).toBe(false);
    expect(isOversightMember({ role: "ASSISTANT", grantCoOwner: true })).toBe(false);
    expect(isOversightMember({ role: "BILLING", grantCoOwner: true })).toBe(false);
  });

  it("visibility.ts y dashboard.ts usan el predicado (sin copia local de OVERSIGHT_ROLES)", () => {
    for (const f of ["lib/visibility.ts", "lib/dashboard.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/OVERSIGHT_ROLES\s*[:=]/);
      expect(src, f).toMatch(/isOversightMember\(/);
    }
  });
});
