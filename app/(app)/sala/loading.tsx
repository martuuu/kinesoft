import { SALA_CSS } from "@/components/sala/sala-css";
import { SALA_COPY, SALA_COUNTERS } from "@/lib/sala-board-state";

/**
 * Esqueleto de /sala mientras resuelve el server (SV10a; FX2a). Usa las MISMAS
 * clases y el mismo CSS que el tablero (`SALA_CSS`, módulo sin "use client"):
 * el header con sus cuatro contadores, la fila de herramientas (alto mínimo
 * reservado = el del segmentado) y las columnas. Antes era una maqueta con
 * medidas a mano, más baja que el header real, y al llegar los datos todo el
 * tablero bajaba de golpe. Los contadores muestran «–»: el título y los
 * rótulos son reales y no cambian al cargar.
 *
 * Sin shimmer: es una pantalla que se abre una vez y queda abierta todo el día.
 */
export default function SalaLoading() {
  const card = (h: number, i: number) => <div key={i} className="sala-skel" style={{ height: h }} />;
  return (
    <div className="sala" aria-busy="true" aria-label="Cargando la sala de espera">
      <style>{SALA_CSS}</style>
      <div className="sala-top">
        <header className="sala-head">
          <div className="sala-head-row">
            <div className="sala-head-title">
              <div className="sala-eyebrow">
                <span className="sala-skel" style={{ display: "inline-block", width: 140, height: 12, verticalAlign: "middle" }} />
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
            <div className="sala-skel" style={{ flex: "1 1 220px", maxWidth: 340, height: 36, borderRadius: 999 }} />
            <div className="sala-status" />
          </div>
        </header>
      </div>
      <div className="sala-board" aria-hidden="true">
        {[0, 1, 2].map((c) => (
          <div key={c} className="sala-col">
            <div className="sala-col-head">
              <div className="sala-skel" style={{ width: 30, height: 30, borderRadius: 999 }} />
              <div className="sala-skel" style={{ width: 120, height: 14, borderRadius: 6 }} />
            </div>
            <div className="sala-col-body" style={{ display: "grid", gap: 8, alignContent: "start", paddingTop: 12 }}>
              {[96, 96, 72].map(card)}
            </div>
          </div>
        ))}
      </div>
      <span className="sala-sr">Cargando…</span>
    </div>
  );
}
