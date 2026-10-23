/**
 * [INT] Guard estático de WhatsApp (T6, plan §26.3 fila INT y §26.10 punto 3).
 *
 * Por qué: los mensajes de WhatsApp salen a Meta, que NO es un encargado de tratamiento de datos de salud del
 * consultorio (Ley 25.326, WA-D16). Las garantías de C-WA2/C-WA5 (una sola puerta a la Graph API, un solo escritor de
 * las tablas de M15, el simulador que nunca llega a prod, plantillas sin PHI, nada de teléfonos en los logs) viven en
 * convenciones que un import o un `logger.info` nuevo rompen sin que falle ningún test de comportamiento. Este archivo
 * las fija sobre el código real (sin comentarios: un JSDoc que nombra un host no es una llamada):
 *   1. `graph.facebook.com` solo en `lib/whatsapp/graph.ts` (el cliente) y el simulador. Cualquier host de Facebook en
 *      el código de la app, solo en la allowlist documentada abajo (cada entrada con su porqué).
 *   2. Las tablas `WhatsApp*` (M15) se escriben solo desde los `lib/whatsapp/*-internal.ts` (y la rotación de claves).
 *   3. El simulador (`lib/whatsapp/fake-graph*.ts`) solo lo importan su ruta (`/api/whatsapp/fake/*`), él mismo, los
 *      tests y los scripts: si lo importara la app, el Meta falso viajaría en el bundle de prod.
 *   4. `lib/whatsapp/templates.ts` (la única entrada de parámetros) no lee servicio, notas, diagnóstico, título ni
 *      profesional, y del input lee solo los cuatro campos de `WaTemplateInput`.
 *   5. Ningún log del área lleva el destinatario (`to`, `from`, teléfono): el número es PHI y se guarda solo como
 *      hash + enmascarado.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { abs, rel, resolveLocal, valueSpecifiers, walk } from "@/tests/helpers/import-graph";

const APP_DIRS = ["app", "lib", "components"];
const APP_FILES = ["middleware.ts", "instrumentation.ts"];

function appSources(): string[] {
  const out = APP_DIRS.flatMap((d) => walk(abs(d)).map(rel));
  for (const f of APP_FILES) {
    try {
      readFileSync(abs(f));
      out.push(f);
    } catch {
      /* no existe */
    }
  }
  return out.sort();
}

const read = (relPath: string) => readFileSync(abs(relPath), "utf8");
/** Mismo criterio que `valueSpecifiers`: fuera los comentarios, sin comerse el `//` de un `https://`. */
const code = (relPath: string) =>
  read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const isSimulator = (f: string) => /^lib\/whatsapp\/fake-graph(-html)?\.ts$/.test(f) || f.startsWith("app/api/whatsapp/fake/");

/**
 * Hosts de Facebook en el código de la app fuera del cliente y del simulador. Cada entrada, con su porqué:
 *   - whatsapp-panel.tsx: link «Abrir WhatsApp Manager» (`business.facebook.com`), navegación del usuario, sin datos.
 *   - whatsapp-signup.ts: carga del SDK de Facebook (`connect.facebook.net`) para el Embedded Signup y la regex del
 *     origen del `postMessage` (`*.facebook.com`). Nunca le pega a la Graph API: el `code` va al server.
 */
const FACEBOOK_HOST_ALLOWLIST = new Set([
  "components/configuracion/panels/whatsapp-panel.tsx",
  "components/configuracion/panels/whatsapp-signup.ts",
]);

/**
 * Escritores de `WhatsApp*` fuera de `lib/whatsapp/*-internal.ts`:
 *   - secret-box-rotate-internal.ts: re-sella `WhatsAppCredential` con la clave nueva (runbook de rotación, WA-S1);
 *     no cambia el token, solo el sobre.
 */
const WRITER_ALLOWLIST = new Set(["lib/secret-box-rotate-internal.ts"]);

const WA_MODEL = "whatsApp(?:Account|Credential|Template|Message|Inbound)";
const PRISMA_WRITE = new RegExp(
  `\\.${WA_MODEL}\\s*\\.\\s*(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\\b`,
);
const RAW_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"WhatsApp(?:Account|Credential|Template|Message|Inbound)"/i;

describe("[INT] whatsapp-guard", () => {
  const files = appSources();

  it("sanity: el escaneo ve el cliente, el simulador y los escritores", () => {
    for (const f of [
      "lib/whatsapp/graph.ts",
      "lib/whatsapp/fake-graph.ts",
      "lib/whatsapp/outbox-internal.ts",
      "app/api/whatsapp/fake/[...path]/route.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("graph.facebook.com solo en lib/whatsapp/graph.ts y el simulador", () => {
    const bad = files.filter((f) => !isSimulator(f) && f !== "lib/whatsapp/graph.ts" && /graph\.facebook\.com/.test(code(f)));
    expect(bad).toEqual([]);
    expect(code("lib/whatsapp/graph.ts")).toMatch(/graph\.facebook\.com/);
  });

  it("hosts de Facebook en la app solo en el cliente, el simulador y la allowlist documentada", () => {
    const bad = files.filter(
      (f) =>
        !isSimulator(f) &&
        f !== "lib/whatsapp/graph.ts" &&
        !FACEBOOK_HOST_ALLOWLIST.has(f) &&
        /facebook\\?\.(?:com|net)/.test(code(f)),
    );
    expect(bad).toEqual([]);
    // La allowlist no puede quedar vieja: cada entrada sigue nombrando un host de Facebook.
    for (const f of FACEBOOK_HOST_ALLOWLIST) expect(code(f)).toMatch(/facebook\\?\.(?:com|net)/);
  });

  it("las tablas WhatsApp* se escriben solo desde lib/whatsapp/*-internal.ts", () => {
    const writers = files.filter((f) => PRISMA_WRITE.test(code(f)) || RAW_WRITE.test(code(f)));
    const bad = writers.filter((f) => !/^lib\/whatsapp\/[a-z-]+-internal\.ts$/.test(f) && !WRITER_ALLOWLIST.has(f));
    expect(bad).toEqual([]);
    // La cola (único escritor de WhatsAppMessage) y el alta existen como escritores: si el regex dejara de ver
    // escrituras, el test pasaría vacío.
    expect(writers).toEqual(expect.arrayContaining(["lib/whatsapp/outbox-internal.ts", "lib/whatsapp/account-internal.ts"]));
    for (const f of WRITER_ALLOWLIST) expect(writers).toContain(f);
  });

  it("WhatsAppMessage se escribe solo desde la cola (lib/whatsapp/outbox-internal.ts)", () => {
    const re = /\.whatsAppMessage\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\b|INSERT\s+INTO\s+"WhatsAppMessage"/i;
    const bad = files.filter((f) => f !== "lib/whatsapp/outbox-internal.ts" && re.test(code(f)));
    expect(bad).toEqual([]);
  });

  it("el simulador solo lo importan su ruta y él mismo (tests y scripts quedan fuera del escaneo)", () => {
    const sim = new Set([abs("lib/whatsapp/fake-graph.ts"), abs("lib/whatsapp/fake-graph-html.ts")]);
    const bad: string[] = [];
    for (const f of files) {
      if (isSimulator(f)) continue;
      for (const spec of valueSpecifiers(read(f))) {
        const target = resolveLocal(spec, abs(f));
        if (target && sim.has(target)) bad.push(`${f} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
    // La ruta lo carga DIFERIDO (import dinámico), así ni el chunk del handler lo trae fuera de `fake`.
    expect(code("app/api/whatsapp/fake/[...path]/route.ts")).toMatch(/import\(\s*["']@\/lib\/whatsapp\/fake-graph["']\s*\)/);
  });

  it("lib/whatsapp/templates.ts no lee servicio, notas, diagnóstico, título ni profesional", () => {
    const src = code("lib/whatsapp/templates.ts");
    expect(src).not.toMatch(/service|notes?\b|diagnos|title|practitioner|reason|treatment/i);
    // Del input solo los cuatro campos de `WaTemplateInput`.
    const reads = new Set([...src.matchAll(/\binput\.(\w+)/g)].map((m) => m[1]));
    expect([...reads].sort()).toEqual(["clinicName", "count", "firstName", "scheduledFor"]);
    expect(src).not.toMatch(/\.\.\.\s*input\b/);
  });

  it("ningún log del área WhatsApp lleva el destinatario ni el teléfono", () => {
    const area = files.filter(
      (f) =>
        f.startsWith("lib/whatsapp/") ||
        /^lib\/(whatsapp-[\w-]+|portal-whatsapp-consent)\.ts$/.test(f) ||
        /^app\/api\/(webhooks\/whatsapp|cron\/whatsapp|whatsapp)\//.test(f),
    );
    expect(area.length).toBeGreaterThan(10);
    const PHONE_KEY = /(?<![\w.$])(?:to|from|phone\w*|\w*Phone|e164|waId|wa_id|recipient|toMasked|fromMasked|replyText|body|text)\s*[:,}]/;
    const bad: string[] = [];
    let calls = 0;
    for (const f of area) {
      for (const call of logCalls(code(f))) {
        calls++;
        // Fuera el nombre del evento (1.er string): «whatsapp.inbound.reply_not_sent» no es un campo.
        const args = call.replace(/^\(\s*(["'`])[^"'`]*\1/, "(");
        if (PHONE_KEY.test(args)) bad.push(`${f}: logger${call.slice(0, 120)}`);
      }
    }
    expect(bad).toEqual([]);
    expect(calls).toBeGreaterThan(30); // si el extractor se rompe, el test no pasa vacío
  });
});

/** Argumentos `( … )` de cada `logger.<nivel>(` / `console.<nivel>(`, balanceando paréntesis y saltando strings. */
function logCalls(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:logger|console)\.(?:info|warn|error|debug|log)\s*\(/g;
  for (const m of src.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length - 1;
    const start = i;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}
