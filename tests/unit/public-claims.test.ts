/**
 * [VX2-c1] Guard de claims prohibidos en las superficies públicas (brief VX §3.4).
 *
 * Por qué: la landing vieja (`components/screens/landing-screen.tsx`, H-LAND) prometía cosas que la app no hace
 * (WhatsApp, Google Calendar, factura electrónica, AES-256, «+500 consultorios», testimonios) y el turnero prometió
 * «te mandamos un email» sin que saliera ninguno (PL-F1c). El copy público solo dice lo que tiene evidencia en el
 * código (§3.1-§3.3); este guard frena que vuelva un claim de la lista negra.
 *
 * Alcance (literal del brief): las entradas de C-F7 + `components/landing/**`, `components/auth/**`,
 * `components/screens/{login,signup,forgot,reset}-screen.tsx`, `components/booking/**`, `lib/portal-copy.ts`; se suma
 * `app/opengraph-image.tsx` (es copy público aunque C-F7 no la liste).
 *
 * Qué se mira: el código **sin comentarios** (los comentarios explican por qué un claim NO está, y nombrarlo ahí no es
 * prometerlo). Excepción: una línea con `// claim-ok: <archivo>:<línea>` (en la misma línea o en la anterior) que
 * apunte a la evidencia.
 *
 * Desvío del literal: `/\d+\s?%/` pelado da falsos positivos con estilos (`width: "100%"`); se busca el porcentaje
 * como claim (seguido de palabra: «30 % menos», «50% más rápido») o en texto JSX, no en valores de estilo.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

const FORBIDDEN: { id: string; re: RegExp }[] = [
  { id: "whatsapp", re: /whatsapp/i },
  { id: "google calendar", re: /google calendar/i },
  { id: "afip / factura electrónica", re: /afip|factura electr/i },
  { id: "aes-256", re: /aes-?256/i },
  { id: "hipaa", re: /hipaa/i },
  { id: "sso", re: /\bsso\b/i },
  { id: "dictado", re: /dictado/i },
  { id: "servidores en argentina", re: /servidores en argentina/i },
  { id: "débito automático", re: /débito automático/i },
  { id: "testimonios", re: /testimoni/i },
  { id: "porcentaje", re: /\d+\s?%(?=\s+[A-Za-zÁÉÍÓÚáéíóúñ])|>[^<{]*\d+\s?%/ },
  { id: "+N consultorios", re: /\+\s?\d+\s+(consultorios|profesionales|pacientes)/i },
  { id: "pantalla de la sala", re: /pantalla de la sala/i },
  { id: "te mandamos un email", re: /te mandamos un (e-?mail|correo)/i },
  { id: "cancelás gratis", re: /cancelás gratis/i },
  { id: "matrícula", re: /matr[ií]cula/i },
  { id: "mantenerme conectado", re: /mantenerme conectad/i },
  { id: "app móvil", re: /app (móvil|movil)|app store|play store/i },
  { id: "IA", re: /inteligencia artificial|\bIA\b/ },
  { id: "precio de ejemplo", re: /precio de ejemplo/i },
];

/**
 * Coincidencias que NO son claims, en archivos que esta sesión no puede tocar (dueño único). Cada una con su
 * evidencia; el dueño puede pasarlas a `// claim-ok:` en el archivo y borrarlas de acá.
 */
const LEGIT: { file: string; id: string; why: string }[] = [
  // VX2-d2: el WhatsApp DEL CONSULTORIO de `booking-unavailable.tsx` pasó a `// claim-ok: prisma/schema.prisma:58`.
];

/**
 * Claims reales que quedan para la sesión dueña (ratchet: el test exige que sigan ahí, así cuando se arreglan hay que
 * sacarlos de la lista y nadie suma uno nuevo).
 */
const PENDING: { file: string; id: string; owner: string }[] = [
  // VX2-d1 sacó «100% seguro» + «Tu información clínica está cifrada» del turnero (handoff 12): no queda ninguno.
];

const EXTS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    out.push(abs);
    return out;
  }
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) walk(rel(p), out);
    else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** C-F7 (literal) + los extras de §3.4. */
export function publicCopyFiles(): string[] {
  const appAll = walk("app").map(rel);
  const C_F7_DIRS = [
    "app/(auth)/",
    "app/(booking)/",
    "app/(portal)/",
    "app/invite/",
    "app/sin-acceso/",
    "app/suspendido/",
    "app/cuenta-desactivada/",
    "app/mantenimiento/",
    "app/verificar-acceso/",
    "app/elegir-consultorio/",
  ];
  const fromApp = appAll.filter(
    (f) =>
      C_F7_DIRS.some((d) => f.startsWith(d)) ||
      (f.startsWith("app/auth/") && /\/page\.tsx$/.test(f)) ||
      ["app/page.tsx", "app/not-found.tsx", "app/global-error.tsx", "app/opengraph-image.tsx"].includes(f),
  );
  const extras = [
    ...walk("components/landing"),
    ...walk("components/auth"),
    ...walk("components/booking"),
    ...["login", "signup", "forgot", "reset"].flatMap((n) => walk(`components/screens/${n}-screen.tsx`)),
    ...walk("lib/portal-copy.ts"),
  ].map(rel);
  return [...new Set([...fromApp, ...extras])].sort();
}

/**
 * Saca comentarios conservando las líneas (para reportar archivo:línea). `//` solo cuenta como comentario si no viene
 * después de `:` (así `https://…` dentro de un string queda).
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const CLAIM_OK = /\/\/\s*claim-ok:\s*\S+:\d+/;

export function findClaims(file: string, src: string): string[] {
  const raw = src.split("\n");
  const code = stripComments(src).split("\n");
  const hits: string[] = [];
  code.forEach((line, i) => {
    for (const f of FORBIDDEN) {
      if (!f.re.test(line)) continue;
      if (CLAIM_OK.test(raw[i]) || (i > 0 && CLAIM_OK.test(raw[i - 1]))) continue;
      hits.push(`${file}:${i + 1} [${f.id}] ${raw[i].trim().slice(0, 140)}`);
    }
  });
  return hits;
}

describe("[VX2-c1] claims prohibidos en superficies públicas (§3.4)", () => {
  const files = publicCopyFiles();

  it("el alcance no está vacío y cubre la landing (sin falso verde)", () => {
    expect(files).toContain("app/page.tsx");
    expect(files.some((f) => f.startsWith("components/landing/"))).toBe(true);
    expect(files.some((f) => f.startsWith("app/(auth)/"))).toBe(true);
    expect(files.some((f) => f.startsWith("components/booking/"))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  const allHits = () => files.flatMap((f) => findClaims(f, readFileSync(join(ROOT, f), "utf8")));
  const matches = (h: string, e: { file: string; id: string }) => h.startsWith(`${e.file}:`) && h.includes(`[${e.id}]`);

  it("ningún archivo público promete lo que no existe", () => {
    const hits = allHits().filter((h) => !LEGIT.some((e) => matches(h, e)) && !PENDING.some((e) => matches(h, e)));
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("los pendientes con dueño siguen ahí (si se arreglaron, sacalos de PENDING)", () => {
    const hits = allHits();
    for (const p of PENDING) expect(hits.some((h) => matches(h, p)), `${p.file} [${p.id}] (${p.owner})`).toBe(true);
  });

  it("el detector agarra lo que dice (sin falso verde)", () => {
    const bad = [
      `<p>Recordatorios por WhatsApp</p>`,
      `const t = "Más de +500 consultorios";`,
      `<li>Sincroniza con Google Calendar</li>`,
      `<p>Ahorrá 30% de tiempo</p>`,
      `<span>30 % menos ausencias</span>`,
      `<p>Te mandamos un email con el turno</p>`,
      `<label>Matrícula</label>`,
      `<p>Diagnóstico con IA</p>`,
      `<p>Débito automático de Mercado Pago</p>`,
    ];
    for (const b of bad) expect(findClaims("x.tsx", b), b).not.toEqual([]);
  });

  it("no cuenta comentarios, estilos ni URLs, y respeta claim-ok con evidencia", () => {
    const ok = [
      `// Sin «pantalla de la sala»: realtime off (D-VX26)`,
      `/* la landing vieja prometía WhatsApp */`,
      `{/* sin testimonios */}`,
      `<div style={{ width: "100%" }} />`,
      `const u = "https://example.com"; // sin débito automático`,
      `<p>Hablá por WhatsApp</p> // claim-ok: lib/whatsapp.ts:12`,
    ];
    for (const o of ok) expect(findClaims("x.tsx", o), o).toEqual([]);
    // claim-ok sin archivo:línea no alcanza
    expect(findClaims("x.tsx", `<p>WhatsApp</p> // claim-ok: confiá`)).not.toEqual([]);
  });
});
