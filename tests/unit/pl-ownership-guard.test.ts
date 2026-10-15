/**
 * PL-1b (C-PL5) — guard de titularidad, delegación y acceso clínico por MIEMBRO.
 *
 * Por qué: desde M8 el rol solo ya no dice qué puede hacer alguien. Un Titular/Admin puede no atender (decisión 8:
 * no ve HC) y «Configuración» / «Planes y pagos» se delegan a cualquier rol (decisión 7). Cada `role === "OWNER"`
 * o `role === "ADMIN"` nuevo es un lugar que se saltea eso (H-PL1 fue exactamente eso en `lib/visibility.ts`), y
 * cada `capabilitiesFor(rol)` nuevo sobre un actor le devuelve `clinical.read` a un Titular sin agenda.
 *
 * 1. Sin comparaciones NUEVAS `=== / !== "OWNER" | "ADMIN"` en `lib/`, `app/` y `components/`: las de hoy quedan
 *    congeladas por archivo (HEAD 14eb013, recontadas en PL-1b). Bajar está bien (y conviene bajar el número acá);
 *    subir falla. Para lo nuevo: `capabilitiesForMember` / `capabilitiesForActor` / `isClinicalMember`.
 * 2. Sin usos NUEVOS de `capabilitiesFor(` (el default por rol, deprecado) fuera de `lib/capabilities.ts`: mismo
 *    esquema. Los que quedan son handoffs de PL-1b (pasar a `memberCapabilitiesForActor` /
 *    `capabilitiesForMembership`) o hablan de un rol en abstracto (`team-internal`: el rol destino).
 * 3. `capabilitiesForMember({ role: "ADMIN", … })` nunca tiene `account.*`; `account.owner` es solo del OWNER;
 *    `SUPPORT_CAPS` nunca `account.*`.
 *
 * Se ignoran las líneas de comentario (`//`, `*`, `/*`): el porqué de muchos módulos cita el patrón viejo.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Role } from "@prisma/client";
import { SUPPORT_CAPS, capabilitiesForMember } from "@/lib/capabilities";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["lib", "app", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => walk(join(ROOT, d))).map((abs) => ({
  rel: relative(ROOT, abs).split("\\").join("/"),
  code: readFileSync(abs, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n"),
}));

function countBy(re: RegExp, skip: (rel: string) => boolean = () => false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FILES) {
    if (skip(f.rel)) continue;
    const n = (f.code.match(re) ?? []).length;
    if (n > 0) out[f.rel] = n;
  }
  return out;
}

function overAllowance(actual: Record<string, number>, allow: Record<string, number>): string[] {
  return Object.entries(actual)
    .filter(([f, n]) => n > (allow[f] ?? 0))
    .map(([f, n]) => `${f}: ${n} (permitidas ${allow[f] ?? 0})`);
}

const ROLE_EQ = /(?:===|!==)\s*["'](?:OWNER|ADMIN)["']|["'](?:OWNER|ADMIN)["']\s*(?:===|!==)/g;

/** Congelado en PL-1b. `lib/roles.ts` y `lib/capabilities.ts` son LA regla (`isClinicalMember`, `capabilitiesForMember`). */
const ROLE_EQ_ALLOW: Record<string, number> = {
  "app/(app)/configuracion/page.tsx": 1,
  "app/(app)/pacientes/[id]/page.tsx": 2,
  "app/suspendido/page.tsx": 3,
  "components/configuracion/configuracion-client.tsx": 8,
  "components/configuracion/controls.tsx": 3,
  "components/configuracion/panels/general-panel.tsx": 4,
  "components/configuracion/panels/users-panel.tsx": 7,
  "components/layout/access-banner.tsx": 2,
  "components/plataforma/team/team-logic.ts": 2,
  "components/plataforma/team/team-panel.tsx": 2,
  "lib/capabilities.ts": 2,
  "lib/invitations.ts": 2,
  "lib/onboarding-internal.ts": 1,
  "lib/onboarding-logic.ts": 1,
  "lib/onboarding.ts": 3,
  "lib/roles.ts": 2,
  // PL-1c (misma ola) sumó 7 en team-internal y 1 en invite-activation, revisadas en PL-1b: miran el rol del
  // miembro DESTINO («nunca sobre el Titular», C-PL3/PL-D5: el ADMIN invitado nace con «Configuración»), no deciden
  // qué puede el actor. Eran 11 en HEAD 14eb013. Integrador PL-1: 19 en team-internal (§20.17: «¿Atiende?» solo
  // del Titular y el ADMIN legado que se apaga, también rol destino) y 2 en saas-plan-change-internal (el Titular
  // nunca es candidato a deshabilitar, C-PL4; también rol destino).
  "lib/invite-activation-internal.ts": 1,
  "lib/saas-plan-change-internal.ts": 2,
  "lib/team-internal.ts": 19,
  "lib/tenant-export-logic.ts": 1,
  // H-PL1: eran 6 (`role === OWNER || role === ADMIN` ×3); ahora resuelve por miembro.
  "lib/visibility.ts": 0,
};

const CAPS_BY_ROLE = /\bcapabilitiesFor\(/g;

/**
 * Integrador PL-1: aplicados los handoffs H1b-1..18, solo quedan `lib/authz.ts` (el soporte vale como la Secretaria,
 * `capabilitiesFor("ASSISTANT")`) y `team-internal` (`supportRoleError`: el rol DESTINO en abstracto). Cero en el
 * resto: un `capabilitiesFor(` nuevo sobre un actor vuelve a abrir H-PL1.
 */
const CAPS_BY_ROLE_ALLOW: Record<string, number> = {
  "lib/authz.ts": 1,
  "lib/team-internal.ts": 1,
};

describe("[PL-1b] guard de titularidad y acceso por miembro", () => {
  it("el escáner ve el código (anti-false-green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(countBy(ROLE_EQ)["lib/team-internal.ts"]).toBeGreaterThan(0);
    expect(countBy(CAPS_BY_ROLE)["lib/authz.ts"]).toBeGreaterThan(0);
  });

  it('sin comparaciones nuevas `=== "OWNER" | "ADMIN"` fuera de la allowlist congelada', () => {
    expect(overAllowance(countBy(ROLE_EQ), ROLE_EQ_ALLOW)).toEqual([]);
  });

  it("sin usos nuevos de `capabilitiesFor(` (default por rol) fuera de lib/capabilities.ts", () => {
    expect(overAllowance(countBy(CAPS_BY_ROLE, (f) => f === "lib/capabilities.ts"), CAPS_BY_ROLE_ALLOW)).toEqual([]);
  });

  it("ADMIN nunca tiene account.* (con cualquier combinación de clinical/grantSettings/grantBilling salvo grantBilling → solo account.billing)", () => {
    for (const clinical of [true, false]) {
      for (const grantSettings of [true, false]) {
        const caps = capabilitiesForMember({ role: "ADMIN", clinical, grantSettings, grantBilling: false });
        expect([...caps].filter((c) => c.startsWith("account."))).toEqual([]);
        // Ni con «Planes y pagos» delegado llega a titular.
        expect(capabilitiesForMember({ role: "ADMIN", clinical, grantSettings, grantBilling: true }).has("account.owner")).toBe(false);
      }
    }
  });

  it("account.owner solo del OWNER, nunca por delegación", () => {
    const roles: Role[] = ["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];
    for (const role of roles) {
      const caps = capabilitiesForMember({ role, clinical: true, grantSettings: true, grantBilling: true });
      expect(caps.has("account.owner")).toBe(false);
    }
    expect(capabilitiesForMember({ role: "OWNER", clinical: false, grantSettings: false, grantBilling: false }).has("account.owner")).toBe(true);
  });

  it("SUPPORT_CAPS sin account.* (ni clinical.read ni plans.manage)", () => {
    expect([...SUPPORT_CAPS].filter((c) => c.startsWith("account."))).toEqual([]);
    expect(SUPPORT_CAPS.has("clinical.read")).toBe(false);
    expect(SUPPORT_CAPS.has("plans.manage")).toBe(false);
  });
});
