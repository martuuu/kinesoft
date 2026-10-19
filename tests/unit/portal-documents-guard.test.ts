/**
 * [FC-1e] Red del portal «Documentos» (T4, brief §24.5 «Red», C-FC8; hallazgo 2 de §24.2).
 *
 * Por qué: hasta T4 el portal no tocaba la historia clínica (EV2-D5) y el guard `clinical-notes-guard` lo cuidaba con
 * una regex sobre los archivos del portal. T4 deshace EV2-D5 de forma ACOTADA: el paciente ve lo que le compartieron
 * (`PatientDocument`, foto HcPrintable v1 ya resuelta en texto). La regex sola ya no alcanza: un archivo del portal
 * que importe un módulo «neutral» que a su vez importe la lectura de notas pasaría el guard literal y llevaría la HC
 * entera al canal BYPASSRLS del portal. Por eso se mira el GRAFO de imports real (helper extraído de F-d):
 *   1. desde cualquier archivo del portal, todo módulo HC alcanzado está en `PORTAL_HC_ALLOWLIST`;
 *   2. ningún archivo alcanzado nombra el modelo de notas (comentarios incluidos), salvo los nombres de acción de la
 *      lista cerrada de `lib/audit.ts` (la ruta del PDF audita con `auditSecurityEvent`: es infraestructura, no datos);
 *   3. la lectura del portal (`lib/portal-documents-internal.ts`) no selecciona ni nombra lo que identifica a la nota o
 *      al Storage, y no hace `include:` (C-FC8: `select` explícito);
 *   4. las páginas nuevas son server y no suman JS de cliente al portal (+0 kB, §24.9).
 *
 * Lo que todavía no existe (lo crean FC-2h y FC-4a) arranca como `it.fails("[<sesión que lo da vuelta>] …")`. El
 * comportamiento (audit antes de los bytes, 503, staff → 404) se prueba con el símbolo real en las matrices de
 * integración; acá queda solo la forma estática.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  abs,
  importClosure,
  isHcNamespace,
  isPortalHcAllowed,
  portalEntries,
  PORTAL_HC_ALLOWLIST,
  type SpecCache,
} from "@/tests/helpers/import-graph";

/** Misma regex que `clinical-notes-guard` (EV2-1a), literal. */
const MENTION = /clinicalNote|ClinicalNote|clinical-notes/;
/** La de la matriz del portal (`portal-authz-matrix`, «sin evoluciones»): identificadores y columnas propias de la nota. */
const BANNED_PATTERN = /clinicalNote|ClinicalNote|clinical-notes|EVOLUTION|amendsNoteId|voidReason|authorPractitionerId/;

/**
 * Infraestructura alcanzada por TODO el portal (sesión → soporte → audit) que nombra el modelo solo como nombre de
 * acción de auditoría (`"clinicalNote.download",` en `SECURITY_EVENT_ACTIONS`). Cada línea con mención tiene que ser
 * EXACTAMENTE un string de acción: un comentario o un import que la nombre vuelve a poner el test en rojo.
 */
const ACTION_NAME_ONLY: Record<string, RegExp> = {
  "lib/audit.ts": /^\s*"[A-Za-z]+\.[A-Za-z_.]+",?\s*$/,
};

const PORTAL_DOCUMENTS_INTERNAL = "lib/portal-documents-internal.ts";
const DOCUMENTOS_FILES = [
  "app/(portal)/portal/c/[slug]/documentos/page.tsx",
  "app/(portal)/portal/c/[slug]/documentos/[id]/page.tsx",
  "app/(portal)/portal/c/[slug]/documentos/[id]/pdf/route.ts",
];

const read = (rel: string) => readFileSync(abs(rel), "utf8");
const isClient = (rel: string) => /^\s*["']use client["'];?/.test(read(rel).replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*\n)*/, ""));

/** Menciones del modelo de notas en un archivo alcanzado, descontando las líneas de acción permitidas. */
function mentions(rel: string): string[] {
  const ok = ACTION_NAME_ONLY[rel];
  return read(rel)
    .split("\n")
    .flatMap((l, i) => (MENTION.test(l) && !(ok && ok.test(l)) ? [`${rel}:${i + 1}: ${l.trim()}`] : []));
}

describe("[FC-1e] red del portal: grafo de imports y lectura de documentos", () => {
  const cache: SpecCache = new Map();
  const closure = () => importClosure(portalEntries(), cache);

  it("el grafo del portal no pasa vacío y sí ve un módulo HC desde una superficie del equipo (anti falso verde)", () => {
    const entries = portalEntries();
    for (const must of ["app/(portal)/portal/page.tsx", "app/(portal)/portal/c/[slug]/page.tsx", "lib/portal.ts", "components/portal/portal-tabs.tsx"]) {
      expect(entries).toContain(must);
    }
    const reached = closure();
    expect(reached.has("lib/portal-identity-internal.ts")).toBe(true);
    expect(reached.has("lib/audit.ts")).toBe(true); // la excepción de abajo no es letra muerta
    // Desde el perfil del paciente (equipo) el MISMO recorrido llega a las lecturas de notas: si no, el guard es ciego.
    const team = importClosure(["app/(app)/pacientes/[id]/page.tsx"], cache);
    const hcOutside = [...team.keys()].filter((f) => isHcNamespace(f) && !isPortalHcAllowed(f));
    expect(hcOutside.length).toBeGreaterThan(0);
    expect([...team.keys()].some((f) => MENTION.test(read(f)))).toBe(true);
  });

  it("la allow-list HC del portal es la de C-FC8 (sumar una entrada es una decisión de PHI, con planning)", () => {
    expect([...PORTAL_HC_ALLOWLIST]).toEqual([
      "lib/hc-doc.ts",
      "lib/hc-print-types.ts",
      "lib/hc-print-model.ts",
      "lib/hc-pdf/",
      "components/hc/",
      "lib/portal-documents-internal.ts",
    ]);
    for (const p of PORTAL_HC_ALLOWLIST) expect(isHcNamespace(p), p).toBe(true);
  });

  it("[FC-1e] grafo de imports del portal limitado a la allow-list HC", () => {
    const reached = closure();
    const offenders = [...reached.entries()]
      .filter(([f]) => isHcNamespace(f) && !isPortalHcAllowed(f))
      .map(([f, chain]) => `${f}\n    ${chain.join("\n    → ")}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("[FC-1e] ningún archivo alcanzado desde el portal nombra el modelo de notas (comentarios incluidos)", () => {
    const reached = closure();
    const offenders = [...reached.keys()].flatMap((f) => mentions(f).map((m) => `${m}\n    vía ${reached.get(f)!.join(" → ")}`));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("la excepción de lib/audit.ts acepta solo nombres de acción (anti falso verde)", () => {
    const re = ACTION_NAME_ONLY["lib/audit.ts"];
    expect(re.test(`  "clinicalNote.download",`)).toBe(true);
    expect(re.test(`  // clinicalNote: comentario`)).toBe(false);
    expect(re.test(`import { x } from "@/lib/clinical-notes-internal";`)).toBe(false);
    expect(re.test(`  await tx.clinicalNote.findMany({})`)).toBe(false);
  });

  // ── Lo que crea FC-2h (lectura + ruta del PDF) ─────────────────────────────────────────────────────────────────

  it("[FC-2h] portal-documents-internal sin noteId, sourceDigest, pdfStorageKey ni include:", () => {
    expect(existsSync(abs(PORTAL_DOCUMENTS_INTERNAL)), `${PORTAL_DOCUMENTS_INTERNAL} no existe`).toBe(true);
    const src = read(PORTAL_DOCUMENTS_INTERNAL);
    expect(src).toMatch(/^import "server-only";/m);
    // C-FC8 literal: `select` sin `noteId`, `sourceDigest`, `pdfStorageKey`, `idempotencyKey` ni `sharedBy*`. Se mira
    // el texto entero (comentarios incluidos), igual que el guard literal.
    for (const banned of ["noteId", "sourceDigest", "pdfStorageKey", "idempotencyKey", "sharedBy", "include:"]) {
      expect(src.includes(banned), `${PORTAL_DOCUMENTS_INTERNAL} nombra «${banned}»`).toBe(false);
    }
    expect(src).not.toMatch(BANNED_PATTERN);
    expect(src).toMatch(/\bpatientDocument\s*\.\s*find(Many|First)\s*\(/);
    expect(src).toMatch(/\bselect\s*:/);
    expect(src).toMatch(/\brevokedAt\s*:\s*null\b/); // solo los vivos
    for (const fn of ["listPortalDocuments", "getPortalDocument", "loadPortalDocumentPdf"]) {
      expect(src, fn).toMatch(new RegExp(`export async function ${fn}\\s*\\(`));
    }
  });

  it("[FC-2h] la ruta del PDF es server, pasa por requirePortalPatient y audita patientDocument.download", () => {
    const route = DOCUMENTOS_FILES[2];
    expect(existsSync(abs(route)), `${route} no existe`).toBe(true);
    const src = read(route);
    expect(isClient(route)).toBe(false);
    expect(src).toMatch(/requirePortalPatient\(/);
    expect(src).not.toMatch(BANNED_PATTERN);
    // C-FC8 pone el audit en `loadPortalDocumentPdf` («ANTES de devolver»); se acepta también en la ruta. El orden
    // real (fila antes del primer byte; audit caído → 503) lo afirma `portal-authz-matrix`.
    const both = src + "\n" + (existsSync(abs(PORTAL_DOCUMENTS_INTERNAL)) ? read(PORTAL_DOCUMENTS_INTERNAL) : "");
    expect(both).toMatch(/auditSecurityEvent\(\s*\{[\s\S]*?"patientDocument\.download"/);
  });

  // ── Lo que crea FC-4a (páginas server) ─────────────────────────────────────────────────────────────────────────

  it('[FC-4a] página server sin literales prohibidos y sin "use client" nuevos', () => {
    for (const f of DOCUMENTOS_FILES) expect(existsSync(abs(f)), `${f} no existe`).toBe(true);
    for (const f of DOCUMENTOS_FILES) {
      expect(isClient(f), `${f} es "use client"`).toBe(false);
      expect(read(f), f).not.toMatch(BANNED_PATTERN);
    }
    // +0 kB de cliente (§24.9): todo módulo `"use client"` que alcancen las páginas nuevas ya lo alcanzaba el resto del
    // portal. HcDocView / HcPrintableView son server; un `"use client"` nuevo en el camino suma JS al portal.
    const rest = portalEntries().filter((f) => !f.includes("/documentos/"));
    const before = new Set([...importClosure(rest, cache).keys()].filter(isClient));
    const docs = [...importClosure(DOCUMENTOS_FILES, cache).keys()].filter(isClient);
    expect(docs.filter((f) => !before.has(f))).toEqual([]);
  });
});
