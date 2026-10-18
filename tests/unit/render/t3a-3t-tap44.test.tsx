/**
 * [T3a-3t] Targets táctiles de 44 px restantes (`mbz-tap-backlog-44`), sin cambiar lo visual.
 *
 * Bajo 768 el área de toque crece con un pseudo-elemento absoluto (transparente, sin `content` visible) en vez de
 * subir `min-height`: el control se ve igual que en escritorio y solo cambia dónde se puede tocar. Cubre:
 * - celdas del mini-calendario (gap de 2 px: el pseudo se extiende 1 px por lado y las celdas teselan la grilla
 *   sin solaparse; a 390 cada celda mide ~43 → 45 px de área);
 * - «Ver todos →» y la fila (link) de Pacientes recientes (alto 44 centrado);
 * - segmentado «Visual · Visual y sonido · Apagado» (32 → 44 de alto);
 * - `MiniSwitch` de Servicios por profesional (38×22 → 44×44).
 * El pliegue del timeline («Ver 08:00–10:00 (sin turnos)») ya llegó a 44 en MB-Z-F2 (`.dayFold` con `min-height`,
 * test en `mbz-f2-agenda-sala.test.tsx`): acá solo se fija que siga.
 *
 * Vitest en `node`: markup real por SSR + CSS real leído del disco. Se mockean red, router y `next/dynamic`.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/dashboard", () => ({ getMonthBookingDays: vi.fn(async () => []) }));
vi.mock("@/lib/arrival-chime", () => ({ previewChime: vi.fn(async () => true) }));

import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { AlertModeControl } from "@/components/realtime/alert-prefs-controls";

const ROOT = join(__dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const css = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "");

/** Bloque de la ÚLTIMA `@media <q>` del archivo (las reglas nuevas van al final). */
const lastMedia = (source: string, q: string) => {
  const i = source.lastIndexOf(`@media ${q}`);
  expect(i, q).toBeGreaterThan(-1);
  const open = source.indexOf("{", i);
  let depth = 1;
  let j = open + 1;
  while (depth > 0 && j < source.length) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") depth--;
    j++;
  }
  return source.slice(open + 1, j - 1);
};
const MOBILE = "(max-width: 767px)";

describe("[T3a-3t] 44 px por pseudo-elemento bajo 768", () => {
  it("dashboard: celdas del calendario, «Ver todos →» y filas de recientes", () => {
    const m = lastMedia(css("components/dashboard/dashboard.module.css"), MOBILE);
    // Alto 44 centrado y ancho al menos 44, sea cual sea el tamaño del link.
    expect(m).toMatch(/\.hit44 \{\s*position: relative;/);
    expect(m).toMatch(
      /\.hit44::after \{\s*content: "";\s*position: absolute;\s*top: calc\(50% - 22px\);\s*bottom: calc\(50% - 22px\);\s*left: min\(0px, calc\(50% - 22px\)\);\s*right: min\(0px, calc\(50% - 22px\)\);/
    );
    // Celda: medio gap por lado (teselan sin solaparse). Sin `position` acá: la celda ya es `relative` inline.
    expect(m).toMatch(/\.calCell::before \{\s*content: "";\s*position: absolute;\s*inset: -1px;/);

    const cal = renderToStaticMarkup(<MiniCalendar initialBookingDays={[3]} />);
    const cells = [...cal.matchAll(/<button[^>]*aria-label="Ver agenda del \d+[^"]*"[^>]*>/g)].map((x) => x[0]);
    expect(cells.length).toBeGreaterThanOrEqual(28);
    for (const c of cells) {
      expect(c).toMatch(/class="[^"]*calCell/);
      expect(c).toMatch(/position:relative/);
    }

    const recent = renderToStaticMarkup(
      <RecentPatients
        items={[
          {
            id: "p1",
            name: "Ana Pérez",
            cond: "Lumbalgia",
            sessionsDone: 2,
            sessionsTotal: 10,
            nextBookingId: null,
            nextBookingAt: null,
            nextBookingUpdatedAt: null,
            access: "full",
          },
        ]}
      />
    );
    expect(recent).toMatch(/<a[^>]*class="[^"]*hit44[^"]*"[^>]*href="\/pacientes"|<a[^>]*href="\/pacientes"[^>]*class="[^"]*hit44/);
    expect(recent).toMatch(/<a[^>]*class="[^"]*hit44[^"]*"[^>]*href="\/pacientes\/p1"|<a[^>]*href="\/pacientes\/p1"[^>]*class="[^"]*hit44/);
  });

  it("segmentado de avisos: 32 → 44 de alto sin tocar el alto visual", () => {
    const m = lastMedia(css("components/realtime/alert-prefs-controls.module.css"), MOBILE);
    expect(m).toMatch(/\.seg \{\s*position: relative;/);
    expect(m).toMatch(/\.seg::before \{\s*content: "";\s*position: absolute;\s*inset: -8px 0 -4px;/);
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(
        <AlertModeControl label="Avisos" value="visual" onChange={() => {}} compact={compact} />
      );
      const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((x) => x[0]);
      expect(radios).toHaveLength(3);
      for (const r of radios) {
        expect(r).toMatch(/class="[^"]*seg/);
        expect(r).toMatch(/min-height:32px/); // lo visual queda igual
      }
    }
  });

  it("MiniSwitch de servicios: 38×22 → 44×44 por pseudo", () => {
    const code = src("components/configuracion/panels/practitioners/services-editor.tsx");
    const pse = code.slice(code.indexOf("const PSE_CSS = `"));
    const m = lastMedia(pse.slice(0, pse.indexOf("`;")), MOBILE);
    expect(m).toMatch(/\.pse \.pse-switch::before \{\s*content: "";\s*position: absolute;\s*inset: -11px -3px;/);
    const sw = code.slice(code.indexOf("function MiniSwitch"));
    expect(sw).toMatch(/className="pse-switch"[\s\S]*?width: 38,\s*height: 22,[\s\S]*?position: "relative"/);
  });

  it("pliegue del timeline: sigue en 44 (MB-Z-F2)", () => {
    const m = lastMedia(css("components/agenda/views/views.module.css"), MOBILE);
    expect(m).toMatch(/\.dayFold \{\s*min-height: 44px;/);
    expect(src("components/agenda/views/timeline-view.tsx")).toContain("className={viewStyles.dayFold}");
  });
});
