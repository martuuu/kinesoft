/**
 * [PF1.2-planes-bib] Biblioteca: C1 (sin <button> anidados → sin error de hidratación), C2 (filtros en Drawer «Filtros
 * (n)» debajo de 1024, por clases del CSS Module) y pulido (PageHeader, sin `outline: none`, sin emoji).
 *
 * Se mockea el framework (navegación, `next/dynamic`) y las server actions (red); nunca `BibliotecaClient`.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/biblioteca",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/favourites", () => ({ toggleFavourite: async () => ({ ok: true }) }));
vi.mock("@/lib/exercises", () => ({ createExercise: async () => ({ ok: true }), ensureTag: async () => ({}) }));

import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { BibliotecaClient } from "@/components/biblioteca/biblioteca-client";
import type { ExerciseRow } from "@/lib/exercises-types";

const ex = (over: Partial<ExerciseRow> & { id: string }): ExerciseRow => ({
  slug: over.id,
  name: `Ejercicio ${over.id}`,
  description: null,
  difficulty: 2,
  defaultSets: 3,
  defaultReps: 12,
  durationSeconds: null,
  equipment: null,
  muscleGroups: "Cuádriceps",
  cues: null,
  instructions: null,
  videoUrl: null,
  kind: "EXERCISE",
  isPrivate: false,
  isBasic: false,
  isFavourite: false,
  conditionsCount: 0,
  conditions: [],
  ...over,
});

const render = (over: Partial<React.ComponentProps<typeof BibliotecaClient>> = {}) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <BibliotecaClient
          items={[ex({ id: "a" }), ex({ id: "b", isPrivate: true, isFavourite: true })]}
          facets={{ muscleGroups: ["Cuádriceps"], equipment: ["Banda"], difficulties: [1, 2], conditions: [] }}
          active={{ difficulty: 2 }}
          tags={[]}
          capabilities={{ plan: "CONSULTORIO", canFavourite: true, hasFullCatalog: true }}
          {...over}
        />
      </ConfirmProvider>
    </ToastProvider>
  );

/** ¿Hay un <button> abierto dentro de otro <button>? (lo que rompía la hidratación, C1). */
function hasNestedButton(html: string): boolean {
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)button\b/g)) {
    if (m[1]) depth--;
    else if (++depth > 1) return true;
  }
  return false;
}

describe("[PF1.2] Biblioteca", () => {
  it("C1: la card no anida botones; el principal es el nombre y la estrella es hermana", () => {
    const html = render();
    expect(hasNestedButton(html)).toBe(false);
    expect(html).toMatch(/<button type="button" class="[^"]*cardMain[^"]*"[^>]*>Ejercicio a<\/button>/);
    expect(html).toContain('aria-label="Agregar Ejercicio a a favoritos"');
    expect(html).toContain('aria-label="Quitar Ejercicio b de favoritos"');
    // Detectaría la regresión: el helper sí ve un anidado.
    expect(hasNestedButton("<button><span><button>x</button></span></button>")).toBe(true);
  });

  it("C2: «Filtros (n)» con el conteo activo y panel lateral por clase (se esconde < 1024 en CSS)", () => {
    const html = render();
    expect(html).toContain("Filtros (1)");
    expect(html).toMatch(/<aside class="[^"]*aside[^"]*" aria-label="Filtros"/);
    expect(html).toMatch(/class="[^"]*layout[^"]*"/);
    expect(html).not.toContain("grid-template-columns:260px 1fr");
  });

  it("pulido: PageHeader (un h1), sin outline:none en línea, sin emoji en filtros ni chips", () => {
    const html = render();
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    expect(html).toContain("2 ejercicios");
    expect(html).not.toMatch(/outline:\s*none/);
    expect(html).not.toMatch(/[⭐🔒✓]/u);
    expect(html).toContain(">Mío<");
  });

  it("maniobras: copy propio en el alta y el buscador", () => {
    const html = render({ mode: "manual-therapy", items: [ex({ id: "m", kind: "MANUAL_THERAPY" })] });
    expect(html).toContain("1 maniobra");
    expect(html).toContain("Nueva maniobra");
    expect(html).toContain('aria-label="Buscar maniobra"');
  });

  it("vacío con filtros: ofrece «Limpiar filtros»", () => {
    expect(render({ items: [] })).toContain(">Limpiar filtros<");
  });
});
