/**
 * [CF3-SHU] Guard del first load de `/pacientes/[id]` para el menú del teléfono (D-CF3-8). El perfil está a ≈10 kB de
 * su techo (≈169,5 de 180): el botón del teléfono entra estático (ícono + estado), pero el panel, la lectura y el
 * `PaymentLinkDrawer` tienen que bajar por `import()`. `check-bundle-budget` mide recién con `next build`, así que un
 * import estático «cómodo» (p. ej. `import { ContactActionsPanel } from …` en el hero) se vería en el gate; este guard
 * lo frena en el unit.
 *
 * Mismo criterio que `hc-first-load-guard.test.ts`: grafo real de imports ESTÁTICOS de valor desde la página (sin
 * `import type`, sin seguir `import()`, sin entrar a `"use server"`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { abs, rel, resolveLocal } from "@/tests/helpers/import-graph";

const ENTRY = "app/(app)/pacientes/[id]/page.tsx";
const PANEL = "components/patients/contact-actions.tsx";

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const isUseServer = (src: string) => /^\s*["']use server["'];?/.test(stripComments(src).trimStart());

function staticSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (!m[2]) out.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

function staticClosure(entry: string): Set<string> {
  const start = abs(entry);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, "utf8");
    if (file !== start && isUseServer(src)) continue;
    for (const spec of staticSpecifiers(src)) {
      const local = resolveLocal(spec, file);
      if (!local || seen.has(local)) continue;
      seen.add(local);
      queue.push(local);
    }
  }
  return new Set([...seen].map(rel));
}

const closure = staticClosure(ENTRY);

describe("[CF3-SHU] menú del teléfono diferido", () => {
  it("[CF3-SHU-13] sanidad: el hero (con el botón) está en el first load", () => {
    expect(closure.has("components/patients/profile/hero.tsx")).toBe(true);
    expect(closure.has("components/patients/patient-profile.tsx")).toBe(true);
  });

  it("[CF3-SHU-14] panel, lógica del menú y PaymentLinkDrawer fuera del first load", () => {
    for (const f of [
      PANEL,
      "components/patients/contact-actions-logic.ts",
      "components/payments/payment-link-drawer.tsx",
      "components/payments/payment-link-share.tsx",
      "lib/booking-share.ts",
    ]) {
      expect(closure.has(f), `${f} entró estático al first load de ${ENTRY}`).toBe(false);
    }
  });

  it("[CF3-SHU-15] el hero y la pestaña Turnos lo bajan con import(), y nadie lo importa estático (ni `type`)", () => {
    for (const f of ["components/patients/profile/hero.tsx", "components/patients/profile/views/turnos-view.tsx"]) {
      const src = stripComments(readFileSync(abs(f), "utf8"));
      expect(src, f).toContain('import("@/components/patients/contact-actions")');
      expect(src, f).not.toMatch(/from\s*["']@\/components\/patients\/contact-actions["']/);
    }
    const patientProfile = stripComments(readFileSync(abs("components/patients/patient-profile.tsx"), "utf8"));
    expect(patientProfile).not.toMatch(/from\s*["']@\/components\/patients\/contact-actions["']/);
  });

  it("[CF3-SHU-16] el panel llama a getPatientShareBundle (la barrera de acceso es el server)", () => {
    const src = stripComments(readFileSync(abs(PANEL), "utf8"));
    expect(src).toMatch(/import\s*\{[^}]*\bgetPatientShareBundle\b[^}]*\}\s*from\s*["']@\/lib\/booking-share-actions["']/);
  });
});
