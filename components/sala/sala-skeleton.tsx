import { SALA_CSS } from "./sala-css";
import { SALA_COPY, SALA_COUNTERS } from "@/lib/sala-board-state";

/*
 * Esqueletos de /sala. Módulo SIN "use client" y sin hooks: lo pinta `loading.tsx` (server) y lo usan como `loading`
 * los `next/dynamic` de `SalaClient` (cliente). Ese `loading` solo se ve al CAMBIAR de cara desde Apariencia sin
 * recargar: en la carga normal la cara llega en el HTML del server y la hidratación conserva ese HTML mientras baja
 * el chunk (PF1.1-sala, C-PF2).
 */

/**
 * Esqueleto del Tablero (SV10a; FX2a). Usa las MISMAS clases y el mismo CSS que el tablero (`SALA_CSS`): el header
 * con sus cuatro contadores, la fila de herramientas (alto mínimo reservado = el del segmentado) y las columnas.
 * Antes era una maqueta con medidas a mano, más baja que el header real, y al llegar los datos todo el tablero bajaba
 * de golpe. Los contadores muestran «–»: el título y los rótulos son reales y no cambian al cargar.
 *
 * Sin shimmer: es una pantalla que se abre una vez y queda abierta todo el día.
 */
export function SalaBoardSkeleton() {
  const card = (h: number, i: number) => <div key={i} className="sala-skel" style={{ height: h }} />;
  return (
    <div className="sala" aria-busy="true" aria-label="Cargando la sala de espera">
      <style>{SALA_CSS}</style>
      <div className="sala-top">
        <header className="sala-head">
          <div className="sala-head-row">
            <div className="sala-head-title">
              <div className="sala-eyebrow">
                <span className="sala-skel sala-skel-eyebrow" />
              </div>
              <div className="sala-h1-row">
                <h1 className="k-display sala-h1">{SALA_COPY.title}</h1>
              </div>
            </div>
            <dl className="sala-counters" aria-hidden="true">
              {SALA_COUNTERS.map((c) => (
                <div key={c.key} className="sala-counter" data-counter={c.key}>
                  <dt>{c.label}</dt>
                  <dd>
                    <span className="sala-counter-n sala-counter-ph k-mono">–</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="sala-head-row sala-tools">
            <div className="sala-skel sala-skel-search" />
            <div className="sala-status" />
          </div>
        </header>
      </div>
      <div className="sala-board" aria-hidden="true">
        {[0, 1, 2].map((c) => (
          <div key={c} className="sala-col">
            <div className="sala-col-head">
              <div className="sala-skel sala-skel-avatar" />
              <div className="sala-skel sala-skel-title" />
            </div>
            <div className="sala-col-body sala-skel-body">{[96, 96, 72].map(card)}</div>
          </div>
        ))}
      </div>
      <span className="sala-sr">Cargando…</span>
    </div>
  );
}

/**
 * Esqueleto del escritorio de Recepción (caras «Lista y panel» y «Flujo»): un bloque del alto que ocupa el
 * escritorio (`.desk-frame` calza en la ventana), así cambiar de cara no colapsa la página mientras baja el chunk.
 */
export function SalaDeskSkeleton() {
  return (
    <div className="sala" aria-busy="true" aria-label="Cargando la Recepción">
      <style>{SALA_CSS}</style>
      <div className="sala-skel sala-skel-desk" />
      <span className="sala-sr">Cargando…</span>
    </div>
  );
}
