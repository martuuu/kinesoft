import { describe, it, expect } from "vitest";
import { BOTTOM_NAV_PRIORITY, bottomNavFor, navFor, type BottomNavEntry } from "@/lib/nav";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

/**
 * MB-0c · `bottomNavFor` (C-MB1): la barra inferior bajo 768 px sale de `navFor` (lib/nav.ts sigue siendo la única
 * fuente del nav). Prioridad Inicio → Agenda → Sala → Pacientes; si falta alguno se completa con los siguientes de
 * `navFor` en su orden hasta 4; el 5.º es siempre «Más».
 */
const links = (e: BottomNavEntry[]) => e.filter((x) => x.kind === "link");
const hrefs = (e: BottomNavEntry[]) => links(e).map((x) => (x.kind === "link" ? x.href : ""));
const labels = (e: BottomNavEntry[]) => e.map((x) => x.label);

function check(e: BottomNavEntry[]) {
  // ≤ 4 destinos + «Más» al final, siempre.
  expect(links(e).length).toBeLessThanOrEqual(4);
  expect(e[e.length - 1]).toEqual({ kind: "more", label: "Más" });
  expect(e.filter((x) => x.kind === "more")).toHaveLength(1);
  // Sin duplicados.
  expect(new Set(hrefs(e)).size).toBe(hrefs(e).length);
}

const KINE_CLINICA = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });
const GENERAL_CONSULTORIO = modulesFor({ vertical: "GENERAL", plan: "CONSULTORIO", publicBookingEnabled: false });
const KINE_CONSULTORIO = modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: false });
const GENERAL_INDIVIDUAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false });

describe("[MB-0c] bottomNavFor (C-MB1)", () => {
  it("prioridad fija: Inicio, Agenda, Sala, Pacientes", () => {
    expect([...BOTTOM_NAV_PRIORITY]).toEqual(["/dashboard", "/agenda", "/sala", "/pacientes"]);
  });

  it("Secretaria en Clínica (agenda + sala + pacientes): los 4 de la prioridad, Sala con rótulo corto", () => {
    const e = bottomNavFor(KINE_CLINICA, capabilitiesFor("ASSISTANT"));
    check(e);
    expect(hrefs(e)).toEqual(["/dashboard", "/agenda", "/sala", "/pacientes"]);
    expect(labels(e)).toEqual(["Inicio", "Agenda", "Sala", "Pacientes", "Más"]);
  });

  it("profesional sin sala (General sin Clínica): Inicio, Agenda, Pacientes y «Más» (no hay con qué completar)", () => {
    const e = bottomNavFor(GENERAL_CONSULTORIO, capabilitiesFor("PRACTITIONER"));
    check(e);
    expect(labels(e)).toEqual(["Inicio", "Agenda", "Pacientes", "Más"]);
  });

  it("profesional Kine sin sala (Consultorio): completa con el siguiente de navFor en su orden (Planes)", () => {
    const caps = capabilitiesFor("PRACTITIONER");
    const e = bottomNavFor(KINE_CONSULTORIO, caps);
    check(e);
    expect(hrefs(e)).not.toContain("/sala");
    const rest = navFor(KINE_CONSULTORIO, caps).filter((it) => !BOTTOM_NAV_PRIORITY.includes(it.href));
    expect(hrefs(e)).toEqual(["/dashboard", "/agenda", "/pacientes", rest[0].href]);
    expect(rest[0].href).toBe("/planes");
  });

  it("BILLING (ve la agenda, no recepciona): sin Sala aunque el plan la tenga", () => {
    const e = bottomNavFor(KINE_CLINICA, capabilitiesFor("BILLING"));
    check(e);
    expect(hrefs(e)).not.toContain("/sala");
    expect(hrefs(e).slice(0, 3)).toEqual(["/dashboard", "/agenda", "/pacientes"]);
  });

  it("Individual (Titular): sin Sala; nunca más de 4 destinos", () => {
    const e = bottomNavFor(GENERAL_INDIVIDUAL, capabilitiesFor("OWNER"));
    check(e);
    expect(hrefs(e)).not.toContain("/sala");
    expect(hrefs(e)[0]).toBe("/dashboard");
  });

  it("sin módulos ni caps: solo Inicio + «Más» (falla cerrado como navFor)", () => {
    const e = bottomNavFor(new Set(), undefined);
    check(e);
    expect(hrefs(e)).toEqual(["/dashboard"]);
  });

  it("cada destino conserva el ícono de su entrada del nav (misma fuente que el sidebar)", () => {
    const e = bottomNavFor(KINE_CLINICA, capabilitiesFor("OWNER"));
    const nav = navFor(KINE_CLINICA, capabilitiesFor("OWNER"));
    for (const x of links(e)) {
      if (x.kind !== "link") continue;
      expect(x.icon).toBe(nav.find((it) => it.href === x.href)?.icon);
    }
  });
});
