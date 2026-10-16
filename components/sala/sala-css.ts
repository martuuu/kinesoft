import { DUR, EASE_OUT } from "@/lib/motion";

/*
 * CSS de /sala (mismo patrón que `RECEPTION_CSS`: un <style> con tokens del
 * design system, sin colores de estado nuevos — los fondos salen de `--rc-*` y
 * `--st-*`). Sin `>` ni comillas en los selectores: el <style> también viaja
 * en el HTML del server.
 *
 * Vive en un módulo SIN "use client" (FX2a): `loading.tsx` es server component
 * y lo usa para reservar exactamente el alto del header; importado desde un
 * módulo "use client" un server component recibe una referencia de cliente,
 * no el string.
 *
 * Fondos por estado (AGENTS §5: el fondo es el estado, la barra el servicio):
 * por llegar = blanco; en sala = `--rc-insala`; llamado = `--rc-called`
 * (sólido, texto blanco: se ve de lejos); en atención = `--rc-attending`;
 * demorado = `--rc-late` con borde. Los botones de las cards oscuras se
 * invierten para mantener el contraste.
 *
 * Nada de lo que aparece y desaparece solo mueve el tablero (FX2a · A2):
 * - la banda «Pase …» es un overlay absoluto colgado del bloque sticky
 *   (`.sala-top`), no un hijo del flujo: antes empujaba el tablero ~70 px y a
 *   los 8 s lo devolvía, y todas las cards con `layout` saltaban con spring;
 * - «Nadie en la sala por ahora» vive en `.sala-status`, un hueco del header
 *   que existe siempre con su alto reservado.
 *
 * Transiciones CSS con los valores de `lib/motion.ts` (DUR/EASE_OUT): la card
 * que cambia de fondo y el spring de framer que la desliza tienen que sentirse
 * del mismo sistema.
 *
 * MB-1c · C-MB4 (escritorio chico, 1366/1024 × 625/695 de alto útil): con 800 px de alto o menos el header va en
 * UNA fila (sin la fecha, como el escritorio de Recepción en compacto; contadores en línea de ~31 px), `.sala` calza
 * en la ventana (`100dvh − 28`, el padding de `main`) y el tablero ocupa el resto con las columnas de 236 px (a 1024
 * con el sidebar abierto entran 3 en vez de 2) y cards más densas. Antes: header de 134 px, columnas con
 * `100dvh − 230` y 1 card entera por columna a 1366×625. Escritorio alto: sin cambios.
 *
 * MB-1c · C-MB3 (< 768, antes < 640): una columna, la columna con gente esperando primero (`data-waiting` +
 * `order`), cada columna se pliega con su total (`.sala-col-fold`, solo acá) y todo lo tocable a 44 px.
 *
 * 360 px: `.sala-board` pasa a columna, sin scroll horizontal ni alto fijo
 * (la página scrollea), y el header deja de ser sticky para no tapar media
 * pantalla.
 *
 * VX0-b: la fecha del eyebrow ya viene capitalizada solo en la primera letra
 * (`salaDayLabel`, que desde RX-Z vive en `components/sala/sala-day-label.ts`
 * y comparten el Tablero y el escritorio; con `text-transform: capitalize`
 * salía «14 De Octubre»), y
 * el contador «Llamados» se resalta solo con `data-active` (valor > 0): en 0
 * el borde y el número azules llamaban la atención sin motivo (R2).
 */
const EASE = `cubic-bezier(${EASE_OUT.join(",")})`;
const T_BASE = `${DUR.base}s ${EASE}`;
const T_FAST = `${DUR.fast}s ${EASE}`;

export const SALA_CSS = `
.sala { display: grid; gap: 14px; min-width: 0; }
.sala-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.sala-top { position: sticky; top: 0; z-index: 5; }
.sala-head { display: grid; gap: 12px; padding: 12px 14px; margin: -2px -2px 0; border-radius: var(--r-lg); background: var(--glass-bg-strong); -webkit-backdrop-filter: blur(18px) saturate(160%); backdrop-filter: blur(18px) saturate(160%); border: 1px solid rgba(15,30,51,0.06); box-shadow: 0 6px 20px rgba(15,30,51,0.05); }
.sala-head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px 18px; flex-wrap: wrap; min-width: 0; }
.sala-head-title { min-width: 0; }
.sala-eyebrow { font-size: 12px; font-weight: 500; color: var(--navy-400); min-height: 18px; }
.sala-h1-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sala-h1 { font-size: 28px; margin: 0; line-height: 1.15; }

.sala-counters { display: flex; gap: 8px; margin: 0; flex-wrap: wrap; }
.sala-counter { display: grid; gap: 1px; min-width: 84px; padding: 7px 12px; border-radius: var(--r-sm); background: var(--card-bg); border: 1px solid rgba(15,30,51,0.06); }
.sala-counter dt { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--navy-400); white-space: nowrap; }
.sala-counter dd { margin: 0; }
.sala-counter-n { display: inline-block; font-size: 22px; font-weight: 700; line-height: 1.15; color: var(--navy-900); transform-origin: left center; }
.sala-counter[data-counter=llamados][data-active] { border-color: rgba(31,79,190,0.25); }
.sala-counter[data-counter=llamados][data-active] .sala-counter-n { color: var(--rc-called-bg); }
.sala-counter-ph { color: var(--navy-300); }

.sala-tools { justify-content: flex-start; flex-wrap: nowrap; min-height: 38px; }
.sala-seg { position: relative; flex-shrink: 0; display: inline-flex; padding: 3px; border-radius: 999px; background: rgba(15,30,51,0.06); }
.sala-seg-btn { position: relative; min-height: 32px; padding: 6px 14px; border: none; border-radius: 999px; background: transparent; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--navy-500); cursor: pointer; transition: color ${T_FAST}; }
.sala-seg-btn[aria-pressed=true] { color: var(--navy-900); }
.sala-seg-thumb { position: absolute; inset: 0; border-radius: 999px; background: var(--card-bg); box-shadow: 0 1px 3px rgba(15,30,51,0.12); }
.sala-seg-label { position: relative; }
.sala-search { position: relative; display: inline-flex; align-items: center; gap: 8px; flex: 1 1 220px; max-width: 340px; min-width: 0; min-height: 36px; padding: 0 2px 0 12px; border-radius: 999px; background: var(--card-bg); border: 1px solid rgba(15,30,51,0.1); color: var(--navy-400); transition: border-color ${T_FAST}, box-shadow ${T_FAST}; }
.sala-search:focus-within { border-color: var(--sky-700); box-shadow: var(--focus-ring); }
.sala-search input { flex: 1; min-width: 0; border: none; outline: 2px solid transparent; background: transparent; font: inherit; font-size: 13px; color: var(--navy-900); padding: 8px 0; }
.sala-search input::-webkit-search-cancel-button { display: none; }
.sala-search-clear { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; border-radius: 999px; background: rgba(15,30,51,0.06); color: var(--navy-700); cursor: pointer; transition: background-color ${T_FAST}; }
.sala-search-clear:hover { background: rgba(15,30,51,0.1); }
.sala-status { flex: 1 1 0; min-width: 0; display: flex; justify-content: flex-end; align-items: center; min-height: 20px; font-size: 12.5px; color: var(--navy-500); }
.sala-status-msg { margin: 0; display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.sala-status-msg strong { color: var(--navy-900); font-weight: 600; white-space: nowrap; }
.sala-status-msg span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sala-status-dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 999px; background: var(--navy-300); }

.sala-call { position: absolute; left: 0; right: 0; top: calc(100% + 10px); z-index: 6; display: flex; justify-content: center; padding: 0 12px; pointer-events: none; }
.sala-call-inner { display: flex; align-items: center; gap: 10px; max-width: 100%; padding: 12px 20px 12px 14px; border-radius: 999px; background: var(--rc-called-bg); color: var(--rc-called-fg); font-size: 18px; font-weight: 700; letter-spacing: -0.01em; box-shadow: 0 14px 34px rgba(31,79,190,0.32), 0 2px 6px rgba(15,30,51,0.12); }
.sala-call-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sala-call-icon { display: inline-flex; flex-shrink: 0; width: 32px; height: 32px; align-items: center; justify-content: center; border-radius: 999px; background: rgba(255,255,255,0.18); }

.sala-note { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: var(--r-md); background: var(--card-bg); border: 1px dashed rgba(15,30,51,0.14); color: var(--navy-500); font-size: 13.5px; }
.sala-note strong { color: var(--navy-900); font-weight: 600; }
.sala-empty { display: grid; justify-items: center; gap: 6px; padding: 48px 20px; border-radius: var(--r-lg); background: var(--card-bg); border: 1px solid rgba(15,30,51,0.06); color: var(--navy-500); text-align: center; }
.sala-empty strong { font-size: 17px; color: var(--navy-900); }
.sala-empty[aria-busy=true] strong { font-weight: 600; color: var(--navy-500); }
.sala-empty-day { gap: 8px; padding: 56px 20px; }
.sala-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-bottom: 4px; border-radius: 999px; background: rgba(15,30,51,0.05); color: var(--navy-500); }
.sala-empty-text { margin: 0; max-width: 360px; font-size: 13.5px; line-height: 1.45; color: var(--navy-500); }
.sala-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
.sala-empty-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; text-decoration: none; }

.sala-fade { min-width: 0; }
.sala-board { display: flex; align-items: flex-start; gap: 12px; overflow-x: auto; padding: 2px 2px 10px; scroll-snap-type: x proximity; }
.sala-col { flex: 1 0 260px; min-width: 260px; max-width: 420px; display: flex; flex-direction: column; max-height: calc(100dvh - 230px); min-height: 220px; border-radius: var(--r-lg); background: var(--bg-panel); border: 1px solid rgba(15,30,51,0.05); scroll-snap-align: start; }
.sala-col-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 10px 14px; border-bottom: 1px solid rgba(15,30,51,0.06); border-radius: var(--r-lg) var(--r-lg) 0 0; background: var(--bg-panel); }
.sala-col-title { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 700; color: var(--navy-900); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sala-col-occ { flex-shrink: 0; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; background: var(--card-bg); color: var(--navy-700); border: 1px solid rgba(15,30,51,0.1); transition: background-color ${T_BASE}, color ${T_BASE}, border-color ${T_BASE}; }
.sala-col-occ[data-full] { background: var(--rc-attending-bg); color: var(--rc-attending-fg); border-color: var(--rc-attending-bg); }
.sala-col-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 10px; }
.sala-col-empty { margin: 14px 4px 4px; font-size: 12.5px; color: var(--navy-400); }
.sala-list { position: relative; list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.sala-item { position: relative; }
.sala-sep { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding: 0 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--navy-400); }
.sala-sep-n { font-size: 10.5px; letter-spacing: 0; }
.sala-sep[data-band=called] { color: var(--rc-called-bg); }
.sala-sep[data-band=late] { color: var(--rc-late-fg); }
.sala-later { margin: 0 10px 10px; min-height: 36px; border-radius: var(--r-sm); border: 1px dashed rgba(15,30,51,0.18); background: transparent; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--navy-500); cursor: pointer; transition: background-color ${T_FAST}, color ${T_FAST}; }
.sala-later:hover { background: rgba(15,30,51,0.03); color: var(--navy-900); }
.sala-col-fold { display: none; flex-shrink: 0; align-items: center; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; margin: -8px -10px -8px 0; padding: 0 8px; border: none; border-radius: 10px; background: transparent; font: inherit; font-size: 13px; font-weight: 700; color: var(--navy-500); cursor: pointer; }
.sala-col-fold svg { transition: transform ${T_FAST}; }
.sala-col-fold[aria-expanded=false] svg { transform: rotate(-90deg); }
.sala-col-fold:focus-visible { outline: 2px solid var(--sky-700); outline-offset: -2px; }

.sala-ring { position: absolute; inset: 0; border-radius: 14px; pointer-events: none; }
.sala-card { position: relative; display: grid; gap: 4px; padding: 10px 12px 10px 16px; border-radius: 14px; background: var(--card-bg); color: var(--navy-900); border: 1px solid rgba(15,30,51,0.06); box-shadow: 0 1px 2px rgba(15,30,51,0.05), 0 4px 14px rgba(15,30,51,0.05); overflow: hidden; transition: background-color ${T_BASE}, color ${T_BASE}, border-color ${T_BASE}; }
.sala-card:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 2px; }
.sala-card[data-state=en-sala] { background: var(--rc-insala-bg); color: var(--rc-insala-fg); border-color: transparent; }
.sala-card[data-state=llamado] { background: var(--rc-called-bg); color: var(--rc-called-fg); border-color: transparent; }
.sala-card[data-state=en-atencion] { background: var(--rc-attending-bg); color: var(--rc-attending-fg); border-color: transparent; }
.sala-card[data-state=demorado] { background: var(--rc-late-bg); border-color: var(--rc-late-border); }
.sala-card[aria-busy=true] { cursor: progress; }
.sala-card-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; }
.sala-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sala-card-time { font-size: 12.5px; font-weight: 700; color: var(--navy-500); }
.sala-card-tag { font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; padding: 2px 8px; border-radius: 999px; background: rgba(15,30,51,0.06); color: inherit; white-space: nowrap; }
.sala-card[data-state=llamado] .sala-card-tag, .sala-card[data-state=en-atencion] .sala-card-tag { background: rgba(255,255,255,0.18); }
.sala-card[data-state=en-sala] .sala-card-time, .sala-card[data-state=en-sala] .sala-card-meta { color: var(--navy-700); }
.sala-card[data-state=llamado] .sala-card-time, .sala-card[data-state=llamado] .sala-card-meta, .sala-card[data-state=en-atencion] .sala-card-time, .sala-card[data-state=en-atencion] .sala-card-meta { color: rgba(255,255,255,0.86); }
.sala-card[data-state=demorado] .sala-card-tag, .sala-card[data-state=demorado] .sala-card-time, .sala-card[data-state=demorado] .sala-card-meta { color: var(--rc-late-fg); }
.sala-card[data-state=demorado] .sala-card-tag { background: rgba(255,255,255,0.6); }
.sala-card-name { font-size: 15px; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.sala-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; font-size: 12px; color: var(--navy-500); }
.sala-card-service { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sala-pill { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.sala-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; font-size: 12px; }
.sala-card-ctx { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.sala-card-room { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sala-card-wait { margin-left: auto; font-weight: 700; white-space: nowrap; }
.sala-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.sala-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 6px 12px; border-radius: 999px; font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; border: 1px solid rgba(15,30,51,0.14); background: var(--card-bg); color: var(--navy-900); transition: transform ${T_FAST}, box-shadow ${T_FAST}, background-color ${T_FAST}, border-color ${T_FAST}, color ${T_FAST}; }
.sala-btn:hover:not(:disabled) { transform: translateY(-1px); }
.sala-btn:active:not(:disabled) { transform: translateY(0); }
.sala-btn[data-kind=primary] { background: var(--sky-700); border-color: var(--sky-700); color: var(--card-bg); box-shadow: 0 3px 10px rgba(31,79,190,0.25); }
.sala-btn[data-kind=ghost] { background: transparent; border-color: transparent; color: inherit; text-decoration: underline; text-underline-offset: 2px; padding-left: 6px; padding-right: 6px; }
.sala-card[data-state=llamado] .sala-btn[data-kind=primary], .sala-card[data-state=en-atencion] .sala-btn[data-kind=primary] { background: var(--card-bg); border-color: var(--card-bg); color: var(--navy-900); box-shadow: none; }
.sala-card[data-state=llamado] .sala-btn[data-kind=secondary], .sala-card[data-state=en-atencion] .sala-btn[data-kind=secondary] { background: transparent; border-color: rgba(255,255,255,0.5); color: var(--card-bg); }
.sala-btn:disabled { opacity: 0.55; cursor: progress; }
.sala-btn:focus-visible, .sala-seg-btn:focus-visible, .sala-later:focus-visible, .sala-search-clear:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 2px; }
.sala-card[data-state=llamado] .sala-btn:focus-visible, .sala-card[data-state=en-atencion] .sala-btn:focus-visible, .sala-card[data-state=llamado]:focus-visible, .sala-card[data-state=en-atencion]:focus-visible { outline-color: var(--navy-900); }

.sala-skel { border-radius: 14px; background: rgba(15,30,51,0.05); border: 1px solid rgba(15,30,51,0.04); }
.sala-skel-eyebrow { display: inline-block; width: 140px; height: 12px; vertical-align: middle; border-radius: 6px; }
.sala-skel-search { flex: 1 1 220px; max-width: 340px; height: 36px; border-radius: 999px; }
.sala-skel-avatar { width: 30px; height: 30px; border-radius: 999px; }
.sala-skel-title { width: 120px; height: 14px; border-radius: 6px; }
.sala-skel-body { display: grid; gap: 8px; align-content: start; padding-top: 12px; }
.sala-skel-desk { height: calc(100dvh - 120px); min-height: 420px; }

@media (prefers-reduced-motion: reduce) {
  .sala-card, .sala-btn, .sala-seg-btn, .sala-search, .sala-search-clear, .sala-col-occ, .sala-later, .sala-col-fold svg { transition: none; }
  .sala-btn:hover:not(:disabled) { transform: none; }
}

@media (max-width: 767px) {
  .sala-top { position: relative; }
  .sala-head { padding: 12px; }
  .sala-h1 { font-size: 24px; }
  .sala-counters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .sala-counter { min-width: 0; }
  .sala-tools { flex-wrap: wrap; }
  .sala-search { max-width: none; flex-basis: 100%; }
  .sala-status { flex-basis: 100%; justify-content: flex-start; }
  .sala-call-inner { font-size: 16px; }
  .sala-board { flex-direction: column; align-items: stretch; overflow: visible; padding: 0; scroll-snap-type: none; }
  .sala-col { flex: none; width: 100%; min-width: 0; max-width: none; max-height: none; min-height: 0; }
  .sala-col-body { overflow: visible; }
  .sala-btn { min-height: 44px; padding: 8px 14px; }
  .sala-seg-btn { min-height: 44px; }
  .sala-search { min-height: 44px; }
  .sala-search input { min-height: 42px; }
  .sala-search-clear { width: 40px; height: 40px; }
  .sala-later { min-height: 44px; }
  .sala-col[data-waiting=true] { order: -1; }
  .sala-col-fold { display: inline-flex; }
  .sala-col[data-collapsed=true] .sala-col-body, .sala-col[data-collapsed=true] .sala-later { display: none; }
  .sala-col[data-collapsed=true] .sala-col-head { border-bottom: 0; border-radius: var(--r-lg); }
}

@media (min-width: 768px) and (max-height: 800px) {
  .sala { gap: 10px; height: calc(100vh - 28px); height: calc(100dvh - 28px); grid-template-rows: auto minmax(0, 1fr); align-content: start; }
  .sala-empty, .sala-note { align-self: start; }
  .sala-fade { min-height: 0; height: 100%; }
  .sala-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 12px; }
  .sala-head-row { display: contents; }
  .sala-head-title { order: 1; }
  .sala-eyebrow { display: none; }
  .sala-h1 { font-size: 22px; }
  .sala-seg { order: 2; }
  .sala-search, .sala-skel-search { order: 3; flex: 1 1 180px; max-width: 280px; }
  .sala-status { order: 4; flex: 1 1 0; }
  .sala-counters { order: 5; margin-left: auto; flex-wrap: nowrap; gap: 6px; }
  .sala-counter { display: flex; flex-direction: row-reverse; justify-content: flex-end; align-items: baseline; gap: 6px; min-width: 0; padding: 5px 10px; }
  .sala-counter-n { font-size: 18px; }
  .sala-board { height: 100%; box-sizing: border-box; }
  .sala-col { flex-basis: 236px; min-width: 236px; max-height: 100%; min-height: 0; }
  .sala-col-head { min-height: 44px; padding: 6px 12px; }
  .sala-col-body { padding: 2px 8px 8px; }
  .sala-list { gap: 6px; }
  .sala-sep { margin-top: 4px; }
  .sala-card { gap: 2px; padding: 7px 10px 7px 14px; }
  .sala-card-actions { margin-top: 4px; gap: 4px; }
  .sala-btn { min-height: 28px; padding: 4px 10px; }
  .sala-later { min-height: 32px; margin: 0 8px 8px; }
}
`;
