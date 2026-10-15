import { readFileSync } from "fs";
import { join, resolve } from "path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DashboardLoading from "@/app/(app)/dashboard/loading";
import AgendaLoading from "@/app/(app)/agenda/loading";
import PacientesLoading from "@/app/(app)/pacientes/loading";
import PacienteLoading from "@/app/(app)/pacientes/[id]/loading";
import ConfiguracionLoading from "@/app/(app)/configuracion/loading";
import PlanesLoading from "@/app/(app)/planes/loading";
import SeguimientoLoading from "@/app/(app)/seguimiento/loading";
import DiagnosticoLoading from "@/app/(app)/diagnostico/loading";
import BibliotecaLoading from "@/app/(app)/biblioteca/loading";
import PlataformaLoading from "@/app/(platform)/plataforma/loading";
import ConsultoriosLoading from "@/app/(platform)/plataforma/consultorios/loading";
import UsuariosLoading from "@/app/(platform)/plataforma/usuarios/loading";
import WorkspaceTemplate from "@/app/(app)/template";

/**
 * [PF-0c] Navegación percibida: los `loading.tsx` son lo primero que ve el usuario al hacer click (y lo que guarda el
 * prefetch de la sidebar en rutas dinámicas). Tienen que renderizar sin datos ni contexto, anunciarse como «cargando»
 * y no arrastrar framer ni un client component (el esqueleto saldría recién al hidratar).
 * PL-F1c: /reportes ya no tiene esqueleto (la página redirige a /dashboard; ver `pl-f1c-dead-ui.test.tsx`).
 */
const ROOT = resolve(process.cwd());
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const CASES: Array<[string, ComponentType, string]> = [
  ["app/(app)/dashboard/loading.tsx", DashboardLoading, "Cargando el tablero"],
  ["app/(app)/agenda/loading.tsx", AgendaLoading, "Cargando la agenda"],
  ["app/(app)/pacientes/loading.tsx", PacientesLoading, "Cargando los pacientes"],
  ["app/(app)/pacientes/[id]/loading.tsx", PacienteLoading, "Cargando el perfil del paciente"],
  ["app/(app)/configuracion/loading.tsx", ConfiguracionLoading, "Cargando la configuración"],
  ["app/(app)/planes/loading.tsx", PlanesLoading, "Cargando los planes"],
  ["app/(app)/seguimiento/loading.tsx", SeguimientoLoading, "Cargando el seguimiento"],
  ["app/(app)/diagnostico/loading.tsx", DiagnosticoLoading, "Cargando el diagnóstico"],
  ["app/(app)/biblioteca/loading.tsx", BibliotecaLoading, "Cargando la biblioteca"],
  ["app/(platform)/plataforma/loading.tsx", PlataformaLoading, "Cargando Plataforma"],
  ["app/(platform)/plataforma/consultorios/loading.tsx", ConsultoriosLoading, "Cargando los consultorios"],
  ["app/(platform)/plataforma/usuarios/loading.tsx", UsuariosLoading, "Cargando los usuarios"],
];

describe("[PF-0c] esqueletos de carga", () => {
  it.each(CASES)("%s renderiza con aria-busy, rótulo y bloques .k-skel", (_file, Comp, label) => {
    const html = renderToStaticMarkup(createElement(Comp));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain(`aria-label="${label}"`);
    // Texto para lector de pantalla (el resto es aria-hidden).
    expect(html).toContain(`${label}…`);
    expect(html.match(/class="k-skel"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it.each(CASES)("%s no es client component ni importa framer", (file) => {
    const code = src(file);
    expect(code).not.toMatch(/^\s*["']use client["']/m);
    expect(code).not.toMatch(/framer-motion/);
  });

  it("la primitiva components/ui/skeleton.tsx es server-safe (sin use client, hooks ni framer)", () => {
    const code = src("components/ui/skeleton.tsx");
    expect(code).not.toMatch(/^\s*["']use client["']/m);
    expect(code).not.toMatch(/framer-motion/);
    expect(code).not.toMatch(/\buse(State|Effect|Reducer|Context|Ref)\b/);
  });
});

describe("[PF-0c] template.tsx de (app)", () => {
  it("no importa framer ni es client component: fade CSS .k-page-in", () => {
    const code = src("app/(app)/template.tsx");
    expect(code).not.toMatch(/framer-motion/);
    expect(code).not.toMatch(/^\s*["']use client["']/m);
    const html = renderToStaticMarkup(createElement(WorkspaceTemplate, null, createElement("p", null, "hola")));
    expect(html).toBe('<div class="k-page-in" style="height:100%"><p>hola</p></div>');
  });
});

describe("[PF-0c] CSS de esqueletos y entrada de página", () => {
  const CSS = src("app/globals.css");

  it(".k-page-in es solo opacidad de 120 ms (sin transform)", () => {
    expect(CSS).toMatch(/\.k-page-in\s*\{\s*animation:\s*k-page-in 120ms/);
    const kf = CSS.match(/@keyframes k-page-in\s*\{([\s\S]*?)\n\}/);
    expect(kf).not.toBeNull();
    expect(kf![1]).toContain("opacity");
    expect(kf![1]).not.toContain("transform");
  });

  it("prefers-reduced-motion apaga el shimmer y el fade", () => {
    const blocks = Array.from(CSS.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g), (m) => m[1]);
    const all = blocks.join("\n");
    expect(all).toMatch(/\.k-skel\s*\{[^}]*animation:\s*none/);
    expect(all).toMatch(/\.k-page-in\s*\{[^}]*animation:\s*none/);
  });
});

describe("[PF-0c] stagger del tablero", () => {
  it("la entrada de los KPIs no usa staggerList/staggerItem y entra en ≤ 200 ms con ≤ 6 ítems", () => {
    const code = src("components/screens/dashboard-screen.tsx");
    expect(code).not.toMatch(/variants=\{stagger(List|Item)\}/);
    const stagger = Number(code.match(/staggerChildren:\s*([\d.]+)/)![1]);
    const dur = Number(code.match(/KPI_ENTER_ITEM[\s\S]*?duration:\s*([\d.]+)/)![1]);
    expect(code).toMatch(/\.slice\(0, 6\)/);
    expect(5 * stagger + dur).toBeLessThanOrEqual(0.2);
  });
});
