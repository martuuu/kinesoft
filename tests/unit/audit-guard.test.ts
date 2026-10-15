/**
 * [PL-A] Guard del recorte de auditoría (plan §20.5.9; AUDIT §5.14 enmendado).
 *
 *  - Ningún `audit(` suelto en `lib/` ni `app/`: lo que se audita va con `auditInTx` en la tx del write, con
 *    `auditSecurityEvent` (allowlist) o con `auditPlatform*InTx`. El `audit()` viejo escribía por otra conexión y
 *    tragaba el error: un cambio de plata podía quedar sin rastro y un audit sobrevivir a un write revertido.
 *  - La allowlist de eventos de seguridad está congelada acá: agrandarla es una decisión, no un atajo.
 *  - Nada de `console.error` en `lib/`: los errores capturados van por `reportError` (redactado, con requestId y a
 *    Sentry si hay DSN). Excepción: `lib/env.ts`, que carga antes que el logger (el logger lo importa).
 *  - La extensión de lecturas de PHI y `getAuditedPrisma` no vuelven.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { SECURITY_EVENT_ACTIONS } from "@/lib/audit";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

/** Saca comentarios de bloque y de línea (sin parsear strings: alcanza para estos patrones). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

function offenders(dirs: string[], re: RegExp, allow: Set<string>): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    for (const f of walk(join(ROOT, d))) {
      const rel = relative(ROOT, f);
      if (allow.has(rel)) continue;
      code(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((l, i) => {
          if (re.test(l)) out.push(`${rel}:${i + 1}: ${l.trim()}`);
        });
    }
  }
  return out;
}

describe("[PL-A] guard de auditoría y errores", () => {
  it("sin `audit(` suelto ni import de `audit` en lib/ y app/", () => {
    const calls = offenders(["lib", "app"], /(^|[^A-Za-z0-9_.$])audit\s*\(/, new Set(["lib/audit.ts"]));
    const imports = offenders(["lib", "app"], /import\s*\{[^}]*\baudit\b[^}]*\}\s*from\s*["']@\/lib\/audit["']/, new Set());
    expect([...calls, ...imports]).toEqual([]);
  });

  it("la allowlist de eventos de seguridad es exactamente esta", () => {
    expect([...SECURITY_EVENT_ACTIONS].sort()).toEqual(
      ["patient.export", "patientFile.download", "tenant.export", "tenant.export.started"].sort()
    );
  });

  it("sin `console.error` en lib/ (usar reportError)", () => {
    expect(offenders(["lib"], /\bconsole\.error\s*\(/, new Set(["lib/env.ts"]))).toEqual([]);
  });

  it("la extensión de lecturas de PHI y getAuditedPrisma no vuelven", () => {
    expect(existsSync(join(ROOT, "lib", "audit-extension.ts"))).toBe(false);
    expect(offenders(["lib", "app"], /getAuditedPrisma|auditExtension/, new Set())).toEqual([]);
  });
});
