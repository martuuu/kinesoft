import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SsrHold } from "@/components/agenda/views/ssr-hold";
import { AGENDA_VIEW_CHUNKS, agendaViewChunksReady, type AgendaViewChunk } from "@/components/agenda/views/view-chunks";
import { receptionBottomGap, receptionScrollMaxHeight } from "@/components/agenda/reception/reception-fit";
import { DayLockButton } from "@/components/agenda/day-lock/day-lock-button";
import { SALA_CSS } from "@/components/sala/sala-css";

/**
 * [MB-Z-F2] Fixes del revisor visual B sobre agenda y sala: CLS de las vistas dinámicas (360/390), scroll del
 * documento en Recepción a 1366/1024 × 625/695, targets de 44 px bajo 768, cards del Día al ancho y Recepción
 * compacta a 390, `/sala` con «Barra superior». Render estático + el CSS (las medidas reales las retoma el revisor).
 */
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const lastMedia = (css: string, q: string) => {
  const i = css.lastIndexOf(`@media ${q}`);
  expect(i, q).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("\n}\n", i));
};

describe("[MB-Z-F2] CLS: el HTML del server de una vista dinámica queda quieto hasta su chunk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("qué chunks espera cada vista (Día ninguno: es import estático)", () => {
    expect(AGENDA_VIEW_CHUNKS.timeline).toEqual([]);
    expect(AGENDA_VIEW_CHUNKS.week).toEqual(["week-grid", "week-list"]);
    const loaded = new Set<AgendaViewChunk>(["week-grid"]);
    expect(agendaViewChunksReady("timeline", loaded)).toBe(true);
    expect(agendaViewChunksReady("week", loaded)).toBe(false);
    loaded.add("week-list");
    expect(agendaViewChunksReady("week", loaded)).toBe(true);
    expect(agendaViewChunksReady("list", loaded)).toBe(false);
    expect(agendaViewChunksReady("vista-rara", loaded)).toBe(true);
  });

  it("server: la vista real dentro de un wrapper sin caja; sin `wrap`, los hijos tal cual", () => {
    const html = renderToStaticMarkup(
      <SsrHold ready={false}>
        <p>vista</p>
      </SsrHold>
    );
    expect(html).toBe('<div style="display:contents"><p>vista</p></div>');
    expect(renderToStaticMarkup(<SsrHold ready={false} wrap={false}><p>vista</p></SsrHold>)).toBe("<p>vista</p>");
  });

  it("cliente sin chunk: el mismo wrapper con innerHTML vacío (React no toca el HTML del server al hidratar)", () => {
    vi.stubGlobal("window", {});
    const held = renderToStaticMarkup(
      <SsrHold ready={false}>
        <p>vista</p>
      </SsrHold>
    );
    expect(held).toBe('<div style="display:contents"></div>');
    const live = renderToStaticMarkup(
      <SsrHold ready>
        <p>vista</p>
      </SsrHold>
    );
    expect(live).toContain("<p>vista</p>");
  });

  it("agenda-client: las vistas van envueltas, el chunk se marca al llegar y el cliente no re-suspende en el lazy", () => {
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toContain("<SsrHold ready={viewReady} wrap={agendaViewChunks(view).length > 0}>");
    expect(code).toContain("loadViewChunks(agendaViewChunks(view)).then(release, release);");
    for (const c of ["ReceptionViewC", "PractitionerDayViewC", "RoomDayPanelC", "WeekGridViewC", "ListViewC", "WeekDayListC"]) {
      expect(code).toContain(`<${c}\n`);
    }
    // Sin el JSX directo de los `dynamic()` (pasaría por Suspense en el cliente).
    expect(code).not.toMatch(/<(ListView|WeekDayList|WeekGridView|ReceptionView|RoomDayPanel|PractitionerDayView)\n/);
    // Siguen fuera del first load: ningún import estático de las vistas.
    expect(code).not.toMatch(/^import [^;]*(list-view|week-day-list|week-grid-view|reception-view|room-day-panel|practitioner-day-view)/m);
  });
});

describe("[MB-Z-F2] Recepción en escritorio chico: el documento no scrollea (C-MB4)", () => {
  it("suma lo que queda debajo: borde de la card, la leyenda con el gap de la agenda y el padding de main", () => {
    // Revisor: 46 px de scroll a 1366×625 con sidebar (leyenda 38 + gap 8; el 14 de main ya estaba).
    const sidebar = receptionBottomGap(1, [
      { siblings: [], gap: 0, padBottom: 0 }, // .k-page-in
      { siblings: [], gap: 0, padBottom: 0 }, // contenedor de la vista
      { siblings: [38], gap: 8, padBottom: 0 }, // .agendaRoot: la leyenda
      { siblings: [], gap: 0, padBottom: 14 }, // main con sidebar
    ]);
    expect(sidebar).toBe(61);
    // «Barra superior»: main con 18 de padding abajo.
    const topbar = receptionBottomGap(1, [{ siblings: [38], gap: 8, padBottom: 0 }, { siblings: [], gap: 0, padBottom: 18 }]);
    expect(topbar).toBe(65);
    expect(receptionScrollMaxHeight(625, 300, sidebar)).toBe(264);
    // Sub-píxeles: redondea para arriba (un 0,4 de más es 1 px de scroll del documento).
    expect(receptionBottomGap(0.4, [])).toBe(1);
    expect(receptionBottomGap(-3, [])).toBe(0);
  });

  it("reception-view mide con el DOM real y observa main (cambia la leyenda o el chrome)", () => {
    const code = src("components/agenda/reception/reception-view.tsx");
    expect(code).toContain("measureReceptionBottomGap(el, section)");
    expect(code).toContain('const main = sectionRef.current?.closest("main");');
  });
});

describe("[MB-Z-F2] Targets de 44 px bajo 768 (`.k-tap-m`, globals.css por handoff)", () => {
  it("el candado (también el compacto de la Semana) lleva la clase", () => {
    expect(renderToStaticMarkup(<DayLockButton state="open" onClick={() => {}} compact />)).toContain('class="k-tap-m"');
    expect(renderToStaticMarkup(<DayLockButton state="locked" onClick={() => {}} />)).toContain('class="k-tap-m"');
  });

  it("toolbar: modo, leyenda de plan, chips, salas, sedes y opciones", () => {
    for (const f of [
      "components/agenda/mode-toggle.tsx",
      "components/agenda/plan-legend.tsx",
      "components/agenda/practitioner-chips.tsx",
      "components/agenda/room-filter.tsx",
      "components/agenda/location-filter.tsx",
      "components/agenda/view-options-menu.tsx",
    ]) {
      expect(src(f), f).toContain("k-tap-m");
    }
    expect(src("components/agenda/practitioner-chips.tsx").match(/className="k-tap-m"/g)).toHaveLength(4);
    expect(src("components/agenda/view-options-menu.tsx").match(/k-tap-m/g)).toHaveLength(4);
  });
});

describe("[MB-Z-F2] Día y Recepción a 390", () => {
  it("Día: cards al ancho, sin el hueco «Nuevo turno», hora y pliegue a 44 px", () => {
    const css = src("components/agenda/views/views.module.css");
    const m = lastMedia(css, "(max-width: 767px)");
    expect(m).toMatch(/\.dayCard \{\s*flex-grow: 1 !important;\s*max-width: none !important;/);
    expect(m).toMatch(/\.slotFiller \{\s*display: none;/);
    expect(m).toMatch(/\.slotLabel \{\s*min-height: 44px;/);
    expect(m).toMatch(/\.dayFold \{\s*min-height: 44px;/);
    const tl = src("components/agenda/views/timeline-view.tsx");
    expect(tl.match(/className=\{viewStyles\.dayCard\}/g)).toHaveLength(2);
    expect(tl).toContain("className={viewStyles.slotFiller}");
  });

  it("Recepción < 640: KPIs en una franja y filtros en una fila, con scroll de costado", () => {
    const code = src("components/agenda/reception/reception-view.tsx");
    const m = code.slice(code.indexOf("@media (max-width: 639px)"));
    expect(m).toMatch(/\.rcp-counters \{ display: flex; gap: 6px; overflow-x: auto;/);
    expect(m).toMatch(/\.rcp-filters \{ flex-wrap: nowrap; overflow-x: auto;/);
    expect(m).not.toContain("repeat(2, minmax(0, 1fr))");
  });
});

describe("[MB-Z-F2] /sala con «Barra superior» en monitores bajos", () => {
  it("CSS: el alto fijo descuenta la barra (dvh con respaldo vh)", () => {
    const short = SALA_CSS.slice(SALA_CSS.indexOf("@media (min-width: 768px) and (max-height: 800px)"));
    // Integrador MB-Z: el alto de la barra es el medido (`--k-topbar-h`), no 94 fijo (a 1366/1024 mide 135).
    expect(short).toMatch(/\.sala\[data-chrome=topbar\] \{ height: calc\(100vh - var\(--k-topbar-h\) - 18px\); height: calc\(100dvh - var\(--k-topbar-h\) - 18px\); \}/);
  });

  it("el Tablero pone `data-chrome` desde la tweak (opcional: sin provider, nada)", () => {
    const code = src("components/sala/sala-board-face.tsx");
    expect(code).toContain('useTweaksOptional()?.t?.dashChrome === "topbar" ? "topbar" : undefined');
    expect(code).toContain('<div className="sala" data-chrome={chrome}>');
  });
});

describe("[MB-Z integrador] la página hidrata en vez de re-renderizarse entera en el cliente", () => {
  // Medido en el navegador (MutationObserver): el `setT` urgente del effect de TweaksProvider llegaba por contexto al
  // Suspense de `agenda/loading.tsx` todavía deshidratado y React tiraba TODO el HTML del server (CLS 0,18 a 390 en
  // Semana/Lista/Recepción, con `SsrHold` y todo). Como transición, React hidrata primero; sin cambios, no hay update.
  it("TweaksProvider hidrata localStorage dentro de startTransition y sin update si no cambió nada", () => {
    const code = src("components/layout/tweaks-context.tsx");
    expect(code).toContain("startTransition(() => setT((prev) => (sameTweaks(prev, next) ? prev : next)));");
    expect(code).not.toMatch(/^\s*setT\(hydrateTweaks\(/m);
  });

  it("el alto fijo con «Barra superior» sale de `--k-topbar-h` (medida por AppShell, 94 por defecto)", () => {
    expect(src("app/globals.css")).toMatch(/--k-topbar-h: 94px;/);
    const shell = src("components/layout/app-shell.tsx");
    expect(shell).toContain('root.style.setProperty("--k-topbar-h", `${Math.ceil(h)}px`)');
    expect(shell).toContain('root.style.removeProperty("--k-topbar-h")');
    expect(src("components/agenda/views/views.module.css")).not.toContain("100dvh - 112px");
  });
});
