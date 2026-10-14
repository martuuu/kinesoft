/**
 * BO2-E · guard estático de C-BO4 + comportamiento de `withSupportWritable` (plan §19.5, decisión 3 de Martin).
 *
 * Por qué un guard estático: la allowlist es la ÚNICA puerta de escritura del soporte. Una action nueva que alguien
 * envuelva «porque sí» (o un nombre copiado de otra) abriría escritura fuera de Configuración. El test lee el código
 * real de lib/ y app/ y exige, para cada `withSupportWritable("<archivo>#<export>", …)`:
 *   - nombre LITERAL (no una variable: el guard tiene que poder leerlo),
 *   - que esté en `SUPPORT_WRITABLE_ACTIONS`,
 *   - que `<archivo>` sea el archivo donde está la llamada y esté en los archivos de Configuración de C-BO4,
 *   - que `<export>` sea la action que la envuelve (el `export async function` inmediatamente anterior).
 * Y al revés: cada entrada de la lista existe como `export async function` en su archivo y, si el archivo ya usa
 * `withSupportWritable`, está envuelta (los de B y D pueden estar pendientes de su handoff).
 *
 * El comportamiento se prueba con la sesión mockeada (dependencia externa del módulo: el Actor); el símbolo bajo
 * test (`withSupportWritable`) y el contexto del request (`lib/request-context.ts`) son los reales.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { SUPPORT_CAPS, capabilitiesFor } from "@/lib/capabilities";

const actorRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/session", () => ({ tryGetActor: async () => actorRef.current }));

import { SUPPORT_WRITABLE_ACTIONS, SUPPORT_WRITABLE_FILES, withSupportWritable } from "@/lib/support-writable";
import { getRequestContext, runWithRequestContext } from "@/lib/request-context";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

type Call = { file: string; name: string | null; enclosing: string | null; line: number };

function findCalls(): Call[] {
  const calls: Call[] = [];
  for (const abs of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]) {
    const file = relative(ROOT, abs).split("\\").join("/");
    if (file === "lib/support-writable.ts") continue;
    const src = readFileSync(abs, "utf8");
    const re = /withSupportWritable\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const after = src.slice(m.index + m[0].length);
      const lit = /^\s*(["'`])([^"'`]+)\1\s*,/.exec(after);
      const before = src.slice(0, m.index);
      const exports = [...before.matchAll(/export\s+async\s+function\s+(\w+)/g)];
      calls.push({
        file,
        name: lit ? lit[2] : null,
        enclosing: exports.length ? exports[exports.length - 1][1] : null,
        line: before.split("\n").length,
      });
    }
  }
  return calls;
}

describe("[BO2-E] guard estático de C-BO4 (withSupportWritable)", () => {
  const calls = findCalls();

  it("hay acciones envueltas (el guard no pasa vacío)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(20);
  });

  it("cada withSupportWritable: nombre literal, en la lista, en su propio archivo de Configuración, y es su action", () => {
    for (const c of calls) {
      const where = `${c.file}:${c.line}`;
      expect(c.name, `${where}: el nombre tiene que ser un literal`).not.toBeNull();
      expect(SUPPORT_WRITABLE_ACTIONS.has(c.name!), `${where}: "${c.name}" no está en SUPPORT_WRITABLE_ACTIONS`).toBe(true);
      const [file, exp] = c.name!.split("#");
      expect(file, `${where}: el nombre dice otro archivo`).toBe(c.file);
      expect(SUPPORT_WRITABLE_FILES.has(c.file), `${where}: no es un archivo de Configuración`).toBe(true);
      expect(c.enclosing, `${where}: envuelve a otra action`).toBe(exp);
    }
  });

  it("cada entrada de la lista existe en un archivo de Configuración; si el archivo ya usa el wrapper, está envuelta", () => {
    const wrapped = new Set(calls.map((c) => c.name));
    for (const entry of SUPPORT_WRITABLE_ACTIONS) {
      const [file, exp] = entry.split("#");
      expect(SUPPORT_WRITABLE_FILES.has(file), entry).toBe(true);
      expect(existsSync(join(ROOT, file)), entry).toBe(true);
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(new RegExp(`export\\s+async\\s+function\\s+${exp}\\s*\\(`).test(src), `${entry}: no existe el export`).toBe(true);
      if (src.includes("withSupportWritable")) expect(wrapped.has(entry), `${entry}: está en la lista pero no envuelto`).toBe(true);
    }
  });

  it("los bloqueos de agenda (time-blocks) y lo clínico nunca son de Configuración", () => {
    expect(SUPPORT_WRITABLE_FILES.has("lib/time-blocks.ts")).toBe(false);
    for (const f of ["lib/bookings.ts", "lib/patients.ts", "lib/plans.ts", "lib/sessions.ts", "lib/files.ts", "lib/diagnosis.ts"]) {
      expect(SUPPORT_WRITABLE_FILES.has(f), f).toBe(false);
    }
    // Quién ve la HC no lo cambia soporte (no tiene acceso clínico).
    expect(SUPPORT_WRITABLE_ACTIONS.has("lib/tenant-settings.ts#setSharedPatientView")).toBe(false);
  });
});

describe("[BO2-E] SUPPORT_CAPS: Secretaria sin clínico + Configuración", () => {
  it("sin clinical.read / plans.manage / billing.manage; con tenant.admin y schedule.configure", () => {
    expect(SUPPORT_CAPS.has("clinical.read")).toBe(false);
    expect(SUPPORT_CAPS.has("plans.manage")).toBe(false);
    expect(SUPPORT_CAPS.has("billing.manage")).toBe(false);
    expect(SUPPORT_CAPS.has("tenant.admin")).toBe(true);
    expect(SUPPORT_CAPS.has("schedule.configure")).toBe(true);
    // Lo demás es exactamente lo de la Secretaria.
    for (const c of capabilitiesFor("ASSISTANT")) expect(SUPPORT_CAPS.has(c), c).toBe(true);
    expect([...SUPPORT_CAPS].sort()).toEqual([...capabilitiesFor("ASSISTANT"), "tenant.admin", "schedule.configure"].sort());
  });
});

describe("[BO2-E] withSupportWritable", () => {
  const NAME = "lib/insurers.ts#createInsurer";
  const base = { tenantId: "t1", userId: "u1", practitionerId: null, readOnly: true, supportSessionId: "s1" };
  const supportActor = (mode: "full" | "read_only" = "full") => ({
    tenantId: "t1",
    userId: "u1",
    practitionerId: null,
    access: { mode, reason: "", daysLeft: null },
    support: { sessionId: "s1", superadminEmail: "a@b.c" },
  });

  beforeEach(() => {
    actorRef.current = null;
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
  });

  it("soporte + action de la lista → corre con supportWritable (solo dentro de fn)", async () => {
    actorRef.current = supportActor();
    await runWithRequestContext({ ...base }, async () => {
      const inside = await withSupportWritable(NAME, async () => getRequestContext()?.supportWritable);
      expect(inside).toBe(true);
      expect(getRequestContext()?.supportWritable).toBeUndefined();
      expect(getRequestContext()?.readOnly).toBe(true);
    });
  });

  it("actor normal → fn tal cual, sin marca", async () => {
    actorRef.current = { ...supportActor(), support: null };
    await runWithRequestContext({ ...base, readOnly: false }, async () => {
      expect(await withSupportWritable(NAME, async () => getRequestContext()?.supportWritable)).toBeUndefined();
    });
  });

  it("soporte en un consultorio en solo lectura por su suscripción (enforce) → no se habilita", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    actorRef.current = supportActor("read_only");
    await runWithRequestContext({ ...base }, async () => {
      expect(await withSupportWritable(NAME, async () => getRequestContext()?.supportWritable)).toBeUndefined();
    });
  });

  it("nombre fuera de la lista → tira (error de programación) sin correr fn", async () => {
    let ran = false;
    await expect(
      withSupportWritable("lib/bookings.ts#createBooking", async () => {
        ran = true;
      })
    ).rejects.toThrow(/SUPPORT_WRITABLE_ACTIONS/);
    expect(ran).toBe(false);
  });
});
