/**
 * A3c-S-signup — lógica pura del guard de la app, del stepper y del slug.
 * B5.5 ONB — pasos Sede y Tu horario: retome, saltos y "semana propia".
 * IAM-3a — gate sin bucles: /sin-acceso, /elegir-consultorio y ningún destino que rebote a sí mismo.
 * BO1-A — bloqueos de sesión (usuario deshabilitado, consultorio suspendido/dado de baja): /cuenta-desactivada y
 * /suspendido, también fuera de (app) y como slugs reservados.
 */
import { describe, it, expect } from "vitest";
import type { AccessState } from "@/lib/access-logic";
import {
  APP_GATE_DESTINATIONS,
  decideAppGate,
  deriveResumeStep,
  isCustomSchedule,
  isValidSlug,
  maxReachableStep,
  ONBOARDING_STEPS,
  STEP,
  pickFreeSlug,
  resolveStep,
  slugify,
  type AppGateInput,
  type AppGateBlock,
  type OnboardingProgress,
} from "@/lib/onboarding-logic";

const OK: AccessState = { kind: "ok", tenantId: "t1" };
const gate = (p: Partial<AppGateInput>) =>
  decideAppGate({
    hasSession: false,
    hasActor: false,
    access: null,
    needsChoice: false,
    role: null,
    onboardingCompleted: false,
    nextPath: null,
    ...p,
  });

describe("decideAppGate", () => {
  it("sin sesión → /login, con next si hay path", () => {
    expect(gate({})).toBe("/login");
    expect(gate({ nextPath: "/agenda?d=2026-10-01" })).toBe("/login?next=%2Fagenda%3Fd%3D2026-10-01");
    // /dashboard es el default del login: no hace falta ensuciar la URL.
    expect(gate({ nextPath: "/dashboard" })).toBe("/login");
  });

  it("sesión sin ninguna membresía → /onboarding (no /login: era un loop)", () => {
    expect(gate({ hasSession: true, access: { kind: "needs_onboarding" } })).toBe("/onboarding");
    // Sin foto (no debería pasar con sesión): el destino conservador de antes.
    expect(gate({ hasSession: true, access: null })).toBe("/onboarding");
  });

  it("[IAM-3a] membresías sin ninguna usable → /sin-acceso (antes /onboarding → «done» → /dashboard: bucle)", () => {
    for (const reason of ["all_disabled", "missing_practitioner", "pending_only"] as const) {
      expect(gate({ hasSession: true, access: { kind: "no_access", reason } })).toBe("/sin-acceso");
    }
  });

  it("[IAM-3a] acceso ok pero sin Actor (carrera) → /sin-acceso, que no rebota solo a la app", () => {
    expect(gate({ hasSession: true, access: OK })).toBe("/sin-acceso");
  });

  it("[IAM-3a] 2+ consultorios sin cookie válida → /elegir-consultorio con next (decisión 6)", () => {
    const base = { hasSession: true, hasActor: true, access: OK, role: "PRACTITIONER", onboardingCompleted: true, needsChoice: true };
    expect(gate(base)).toBe("/elegir-consultorio");
    expect(gate({ ...base, nextPath: "/dashboard" })).toBe("/elegir-consultorio");
    expect(gate({ ...base, nextPath: "/agenda?d=2026-10-01" })).toBe("/elegir-consultorio?next=%2Fagenda%3Fd%3D2026-10-01");
    // Antes que el alta abierta: primero se elige DÓNDE entrar.
    expect(gate({ ...base, role: "OWNER", onboardingCompleted: false })).toBe("/elegir-consultorio");
  });

  it("OWNER con el alta sin terminar → /onboarding", () => {
    expect(gate({ hasSession: true, hasActor: true, access: OK, role: "OWNER", onboardingCompleted: false })).toBe("/onboarding");
  });

  it("un miembro no-OWNER entra aunque el dueño no haya terminado el alta", () => {
    for (const role of ["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]) {
      expect(gate({ hasSession: true, hasActor: true, access: OK, role, onboardingCompleted: false })).toBeNull();
    }
  });

  it("alta completa → renderiza la app", () => {
    expect(gate({ hasSession: true, hasActor: true, access: OK, role: "OWNER", onboardingCompleted: true })).toBeNull();
  });

  it("actor demo (sin sesión ni foto) → renderiza la app", () => {
    expect(gate({ hasSession: false, hasActor: true, access: null, role: "OWNER", onboardingCompleted: true })).toBeNull();
  });

  it("[BO1-A] usuario deshabilitado → /cuenta-desactivada, gane lo que gane el resto", () => {
    expect(gate({ hasSession: true, block: "user_disabled", access: { kind: "no_access", reason: "all_disabled" } })).toBe(
      "/cuenta-desactivada"
    );
    // Aunque hubiera Actor (carrera entre la foto y el bloqueo), el bloqueo manda.
    expect(gate({ hasSession: true, hasActor: true, access: OK, role: "OWNER", onboardingCompleted: true, block: "user_disabled" })).toBe(
      "/cuenta-desactivada"
    );
  });

  it("[BO1-A] consultorio suspendido o dado de baja (sin otro usable) → /suspendido, sin next", () => {
    for (const block of ["tenant_suspended", "tenant_closed"] as const) {
      expect(gate({ hasSession: true, block, access: { kind: "no_access", reason: "all_disabled" }, nextPath: "/agenda" })).toBe(
        "/suspendido"
      );
    }
  });

  it("[BO1-A] sin sesión un bloqueo no se aplica (no hay a quién mostrárselo): /login", () => {
    expect(gate({ hasSession: false, block: "user_disabled" })).toBe("/login");
  });

  it("[IAM-3a] ningún destino rebota a sí mismo: todos viven fuera de (app), en todas las combinaciones", () => {
    const accesses: Array<AccessState | null> = [
      null,
      OK,
      { kind: "needs_onboarding" },
      { kind: "no_access", reason: "all_disabled" },
      { kind: "no_access", reason: "missing_practitioner" },
      { kind: "no_access", reason: "pending_only" },
    ];
    const appRoutes = ["/dashboard", "/agenda", "/pacientes", "/configuracion", "/plataforma", "/sala"];
    const blocks: Array<AppGateBlock | null> = [null, "user_disabled", "tenant_suspended", "tenant_closed"];
    let seen = 0;
    for (const hasSession of [false, true])
      for (const hasActor of [false, true])
        for (const access of accesses)
          for (const needsChoice of [false, true])
            for (const role of [null, "OWNER", "PRACTITIONER", "ASSISTANT"])
              for (const onboardingCompleted of [false, true])
                for (const block of blocks)
                for (const nextPath of [null, "/dashboard", "/agenda?d=1"]) {
                  const to = decideAppGate({ hasSession, hasActor, access, needsChoice, role, onboardingCompleted, nextPath, block });
                  seen++;
                  if (to === null) continue;
                  const path = to.split("?")[0];
                  expect(APP_GATE_DESTINATIONS).toContain(path);
                  expect(appRoutes.some((r) => path === r || path.startsWith(`${r}/`))).toBe(false);
                  // El `next` que se propaga nunca apunta a la pantalla misma.
                  const next = new URLSearchParams(to.split("?")[1] ?? "").get("next");
                  if (next) expect(next.split("?")[0]).not.toBe(path);
                }
    expect(seen).toBeGreaterThan(4000);
  });

  it("[IAM-3a] los destinos del gate son slugs reservados (un consultorio no puede tapar la ruta)", () => {
    for (const d of APP_GATE_DESTINATIONS) expect(isValidSlug(d.slice(1))).toBe(false);
  });

  it("[BO1-A] /suspendido y /cuenta-desactivada están entre los destinos y son slugs reservados", () => {
    expect(APP_GATE_DESTINATIONS).toContain("/suspendido");
    expect(APP_GATE_DESTINATIONS).toContain("/cuenta-desactivada");
    expect(isValidSlug("suspendido")).toBe(false);
    expect(isValidSlug("cuenta-desactivada")).toBe(false);
    // slugify nunca propone uno reservado.
    expect(slugify("Suspendido")).not.toBe("suspendido");
  });
});

const prog = (p: Partial<OnboardingProgress>): OnboardingProgress => ({
  hasTenant: true,
  locationReady: false,
  ownScheduleSaved: false,
  servicesCount: 0,
  insurersCount: 0,
  invitationsCount: 0,
  ...p,
});

describe("ONBOARDING_STEPS / STEP", () => {
  it("orden del alta: cuenta, consultorio, sede, horario, tu horario, servicios, OS, equipo, listo", () => {
    expect(ONBOARDING_STEPS.map((s) => s.key)).toEqual([
      "account", "clinic", "location", "hours", "myHours", "services", "insurers", "team", "done",
    ]);
    // Numeración contigua desde 1 (el riel y "Paso N de M" dependen de eso).
    ONBOARDING_STEPS.forEach((s, i) => expect(s.n).toBe(i + 1));
  });

  it("STEP mapea cada clave a su número y el último es Listo", () => {
    expect(STEP).toEqual({ clinic: 2, location: 3, hours: 4, myHours: 5, services: 6, insurers: 7, team: 8, done: 9 });
    expect(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1].key).toBe("done");
  });
});

describe("deriveResumeStep / resolveStep", () => {
  it("retoma en el paso siguiente a lo último cargado", () => {
    expect(deriveResumeStep(prog({ hasTenant: false }))).toBe(STEP.clinic);
    expect(deriveResumeStep(prog({}))).toBe(STEP.location);
    expect(deriveResumeStep(prog({ locationReady: true }))).toBe(STEP.hours);
    expect(deriveResumeStep(prog({ locationReady: true, ownScheduleSaved: true }))).toBe(STEP.services);
    expect(deriveResumeStep(prog({ locationReady: true, ownScheduleSaved: true, servicesCount: 2 }))).toBe(STEP.insurers);
    expect(
      deriveResumeStep(prog({ locationReady: true, ownScheduleSaved: true, servicesCount: 2, insurersCount: 1 }))
    ).toBe(STEP.team);
    expect(deriveResumeStep(prog({ servicesCount: 2, invitationsCount: 1 }))).toBe(STEP.done);
  });

  it("es monótona: un dato más adelante nunca hace retroceder el retome", () => {
    // Alta abierta antes de B-pre: servicios cargados, sede sin dirección y
    // la plantilla del alta → no vuelve a Sede (queda en el riel y el resumen).
    expect(deriveResumeStep(prog({ servicesCount: 1 }))).toBe(STEP.insurers);
    // Semana guardada sin haber puesto la dirección (saltó desde el riel).
    expect(deriveResumeStep(prog({ ownScheduleSaved: true }))).toBe(STEP.services);
    const flags: Array<Partial<OnboardingProgress>> = [
      {},
      { locationReady: true },
      { ownScheduleSaved: true },
      { servicesCount: 1 },
      { insurersCount: 1, servicesCount: 1 },
      { invitationsCount: 1, servicesCount: 1 },
    ];
    for (const base of flags) {
      for (const extra of flags) {
        const a = deriveResumeStep(prog(base));
        const b = deriveResumeStep(prog({ ...base, ...extra }));
        expect(b, JSON.stringify({ base, extra })).toBeGreaterThanOrEqual(a);
      }
    }
  });

  it("sin tenant solo existe Consultorio", () => {
    for (const s of ["3", "5", "7", "9"]) expect(resolveStep(s, prog({ hasTenant: false }))).toBe(STEP.clinic);
  });

  it("sin servicios no se pasa de Servicios, pero Sede y Tu horario se pueden abrir", () => {
    expect(resolveStep(String(STEP.done), prog({}))).toBe(STEP.services);
    expect(resolveStep(String(STEP.insurers), prog({}))).toBe(STEP.services);
    expect(resolveStep(String(STEP.services), prog({}))).toBe(STEP.services);
    expect(resolveStep(String(STEP.location), prog({}))).toBe(STEP.location);
    expect(resolveStep(String(STEP.myHours), prog({}))).toBe(STEP.myHours);
    expect(resolveStep(String(STEP.clinic), prog({}))).toBe(STEP.clinic);
  });

  it("step inválido o fuera de rango → el paso derivado", () => {
    for (const s of [undefined, null, "", "abc", "1", "10", "2.5"]) {
      expect(resolveStep(s, prog({ servicesCount: 1 }))).toBe(STEP.insurers);
    }
  });

  it("con servicios se puede volver a cualquier paso", () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) expect(resolveStep(String(n), prog({ servicesCount: 1 }))).toBe(n);
  });
});

describe("maxReachableStep (riel)", () => {
  it("sin tenant: solo Consultorio; sin servicios: hasta Servicios; con servicios: todo", () => {
    expect(maxReachableStep(prog({ hasTenant: false }))).toBe(STEP.clinic);
    expect(maxReachableStep(prog({}))).toBe(STEP.services);
    expect(maxReachableStep(prog({ locationReady: true, ownScheduleSaved: true }))).toBe(STEP.services);
    expect(maxReachableStep(prog({ servicesCount: 1 }))).toBe(STEP.done);
  });
});

describe("isCustomSchedule", () => {
  const def = (dow: number) => `psch_default_${dow}`;

  it("la plantilla del alta (ids determinísticos) no cuenta como semana propia", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((dow) => ({ id: def(dow), dow }));
    expect(isCustomSchedule(rows, def)).toBe(false);
  });

  it("sin franjas (horario heredado del consultorio) tampoco", () => {
    expect(isCustomSchedule([], def)).toBe(false);
  });

  it("una fila con otro id = guardada a mano (savePractitionerWeek reemplaza con cuids)", () => {
    expect(isCustomSchedule([{ id: "ckabc123", dow: 1 }], def)).toBe(true);
    expect(isCustomSchedule([{ id: def(1), dow: 1 }, { id: "ckxyz", dow: 1 }], def)).toBe(true);
  });

  it("el id determinístico de OTRO día no se confunde (dow 1 con el id del dow 2)", () => {
    expect(isCustomSchedule([{ id: def(2), dow: 1 }], def)).toBe(true);
  });
});

describe("slug", () => {
  it("slugify normaliza acentos, espacios y símbolos", () => {
    expect(slugify("Centro Kinésico Movare")).toBe("centro-kinesico-movare");
    expect(slugify("  Ñandú & Cía.  ")).toBe("nandu-cia");
  });

  it("slugify nunca devuelve algo inválido ni reservado", () => {
    for (const n of ["!!", "🙂", "ab", "Agenda", "login", "x".repeat(80)]) {
      const s = slugify(n);
      expect(isValidSlug(s), `${n} → ${s}`).toBe(true);
    }
  });

  it("pickFreeSlug agrega sufijo y respeta el largo máximo", () => {
    expect(pickFreeSlug("movare", [])).toBe("movare");
    expect(pickFreeSlug("movare", ["movare"])).toBe("movare-2");
    expect(pickFreeSlug("movare", ["movare", "movare-2", "movare-3"])).toBe("movare-4");
    const long = "a".repeat(40);
    const s = pickFreeSlug(long, [long]);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(isValidSlug(s)).toBe(true);
  });
});
