import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// [TV-2w2] El drawer de «Pantallas» (TV-2w1) va diferido: el mock de `next/dynamic` NO llama al loader, así el test
// no depende del chunk del drawer y además prueba que renderizar el botón cerrado no lo pide.
const { loaderCalls } = vi.hoisted(() => ({ loaderCalls: { n: 0 } }));
vi.mock("next/dynamic", () => ({
  default: () => {
    return function DynamicMock() {
      loaderCalls.n += 1;
      return <div data-testid="drawer-mock" />;
    };
  },
}));

import { DisplaysButton, DisplaysContext } from "@/components/sala/displays/displays-button";
import { DeskHeader } from "@/components/sala/desk/desk-header";
import { SalaHeader } from "@/components/sala/sala-header";

const withCtx = (canManage: boolean | null, node: React.ReactNode) =>
  canManage === null ? node : <DisplaysContext.Provider value={{ canManage }}>{node}</DisplaysContext.Provider>;

const deskHeader = (
  <DeskHeader
    dayKey="2026-10-22"
    clock={new Date("2026-10-22T13:00:00Z")}
    kpis={{ enSala: 0, enAtencion: 0, demorados: 0, terminados: 0, total: 0 }}
    query=""
    onQuery={() => {}}
    searchRef={{ current: null }}
    onNewBooking={() => {}}
    onOpenView={null}
  />
);
const salaHeader = (
  <SalaHeader
    dayLabel="Jueves, 22 de octubre"
    counters={{ enSala: 0, llamados: 0, enAtencion: 0, atendidos: 0 }}
    groupBy="practitioner"
    canGroupByRoom={false}
    onGroupBy={() => {}}
    query=""
    onQuery={() => {}}
    status={null}
  />
);

describe("[TV-2w2] botón «Pantallas» de /sala", () => {
  it("[TV-2w2] con permiso se ve «Pantallas» (target de 44 px en mobile vía k-btn-sm) y el drawer no se monta cerrado", () => {
    loaderCalls.n = 0;
    const html = renderToStaticMarkup(withCtx(true, <DisplaysButton />));
    expect(html).toContain("Pantallas");
    expect(html).toContain("k-btn-sm");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("drawer-mock");
    expect(loaderCalls.n).toBe(0);
  });

  it("[TV-2w2] sin permiso o sin provider no se dibuja nada", () => {
    expect(renderToStaticMarkup(withCtx(false, <DisplaysButton />))).toBe("");
    expect(renderToStaticMarkup(withCtx(null, <DisplaysButton />))).toBe("");
  });

  it("[TV-2w2] los dos headers de /sala lo muestran solo con permiso", () => {
    for (const header of [deskHeader, salaHeader]) {
      expect(renderToStaticMarkup(withCtx(true, header))).toContain("Pantallas");
      expect(renderToStaticMarkup(withCtx(false, header))).not.toContain("Pantallas");
    }
  });
});

describe("[TV-2w2] displays-drawer nunca entra estático al bundle de /sala", () => {
  const root = join(process.cwd(), "components/sala");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
    });

  it("[TV-2w2] ningún archivo de components/sala/** lo importa ni re-exporta estático", () => {
    const staticImport = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'][^"']*displays-drawer["']/;
    const sideEffect = /(?:^|\n)\s*import\s*["'][^"']*displays-drawer["']/;
    const offenders = walk(root)
      .filter((p) => !p.endsWith("displays-drawer.tsx"))
      .filter((p) => {
        const src = readFileSync(p, "utf8");
        return staticImport.test(src) || sideEffect.test(src);
      })
      .map((p) => relative(process.cwd(), p));
    expect(offenders).toEqual([]);
  });

  it("[TV-2w2] el botón lo carga con next/dynamic + import() diferido", () => {
    const src = readFileSync(join(root, "displays/displays-button.tsx"), "utf8");
    expect(src).toMatch(/from\s+["']next\/dynamic["']/);
    expect(src).toMatch(/import\(\s*["']\.\/displays-drawer["']\s*\)/);
  });
});
