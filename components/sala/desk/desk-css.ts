import { DUR, EASE_OUT } from "@/lib/motion";

/*
 * CSS del escritorio de Recepción (RX-1b, brief RX §1.1 y §4.4): el shell (`.desk`), el header, la franja de
 * profesionales, la banda de llamado, los botones de acción, el tag de estado, el menú ⋯ y el modal de cobro. Las
 * caras (A «Lista y panel», B «Flujo») traen su propio CSS (`DESK_LIST_CSS`, `DESK_FLOW_CSS`, RX-2).
 *
 * Mismo patrón que `SALA_CSS`: un <style> con tokens del design system, módulo SIN "use client" (un server
 * component que lo importe recibe el string). Sin `>` ni comillas en los selectores ni en los valores: el <style>
 * viaja en el HTML del server y React escapa esos caracteres (un test lo fija).
 *
 * Colores: solo tokens. El fondo de cada estado sale de `--rc-*`/`--st-*` (AGENTS §5: el fondo es el estado, la
 * barra el servicio); la demora del profesional reusa esos mismos tokens (al día = completado, ámbar = demorado,
 * rojo = demorado sólido con texto blanco: el repo no tiene un token rojo y el revisor de RX-Z no acepta colores
 * nuevos). El profesional se marca con iniciales, nunca con color.
 *
 * Ancho (§4.4): container queries sobre `.desk` (`container: desk / inline-size`), no viewport, porque el ancho útil
 * depende del sidebar (64 o 232 px):
 *   - wide ≥ 1180 px de contenedor: todo visible;
 *   - compact 720-1179: las reglas `@media (max-width:1279px)` del prototipo, pasadas al contenedor (sin KPIs ni
 *     fecha, «Nuevo» corto);
 *   - stack < 720 (390, o 1024 con el sidebar abierto): una columna CON scroll de página, KPIs 2×2, franja con scroll
 *     horizontal propio, targets de 44 px (los del menú ⋯ van aparte, por `@media`: está en un portal fuera de
 *     `.desk`).
 * Fallback sin container queries (Chrome < 105, Safari < 16): los mismos cortes con `@media`, sumando los 64 px del
 * sidebar colapsado.
 *
 * Alto (§4.4): `.desk-frame` mide `100dvh − top` y no scrollea: cada lista scrollea adentro de su card. El shell
 * pisa el alto con un `style.height` inline medido (`getBoundingClientRect().top + 14`, así absorbe la banda de
 * soporte o de facturación); el valor de acá (28 px) es el del primer paint del server. Es inline y no una custom
 * property propia porque `tests/unit/design-tokens.test.ts` exige que toda custom property usada esté definida en globals.css. Con
 * `data-fit=natural` (ventana de menos de 560 px de alto) el shell saca el inline; en stack el `!important` le gana
 * al inline: alto natural y la página scrollea.
 *
 * MB-1c (C-MB4): el header mide 56 px justos (54 + borde; antes 58 con el botón de 40 y 8 px de padding), la franja
 * que el contrato fija en ≤ 56 a 1366×625/695. En stack aparece `.desk-fold` (pliegue de cada card o carril, C-MB3) y
 * bajo 640 el modal de cobro apila sus botones a ancho completo (hoja de C-MB2).
 *
 * `.desk` es el contenedor: `container-type` aplica contención de layout, así que un `position: fixed` adentro
 * quedaría anclado a `.desk` y recortado por su overflow. Por eso el menú ⋯ va en un portal al body y el modal de
 * cobro se monta como hermano de `.desk`, nunca adentro.
 */
const EASE = `cubic-bezier(${EASE_OUT.join(",")})`;
const T_FAST = `${DUR.fast}s ${EASE}`;

/** Corte wide/compact y compact/stack, en ancho de CONTENEDOR (§4.4). */
export const DESK_COMPACT_MAX = 1179;
export const DESK_STACK_MAX = 719;
/** Ancho del sidebar colapsado: el fallback por viewport suma esto. */
const SIDEBAR_PX = 64;

const COMPACT_RULES = `
.desk-kpis { display: none; }
.desk-date { display: none; }
.desk-head { gap: 10px; padding-left: 14px; }
.desk-search { width: 220px; margin-left: auto; }
.desk-new .desk-lbl-long, .desk-new kbd { display: none; }
.desk-new .desk-lbl-short { display: inline; }
.desk-pro { grid-template-columns: 30px minmax(0, 1fr); gap: 8px; padding: 8px; }
.desk-pro .desk-av { width: 30px; height: 30px; font-size: 11px; }
.desk-pro-name { font-size: 13px; }
.desk-act-ico { display: none; }
.desk-act[data-kind=arrive] .desk-act-ico, .desk-act[data-kind=pay] .desk-act-ico { display: inline-flex; }
`;

const STACK_RULES = `
.desk-frame { height: auto !important; overflow: visible; }
.desk-head { flex-wrap: wrap; row-gap: 10px; padding: 10px 12px; }
.desk-title { flex: 1 1 auto; }
.desk-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; width: 100%; order: 6; margin: 0; }
.desk-kpi { border-left: 0; border-radius: var(--r-sm); background: var(--bg-panel); padding: 6px 10px; }
.desk-search { order: 5; width: 100%; flex: 1 1 100%; }
.desk-search input { height: 44px; }
.desk-new, .desk-view, .desk-call-close { min-height: 44px; }
.desk-view { width: 44px; }
.desk-strip { grid-auto-columns: minmax(208px, 78%); }
.desk-pro { height: auto; min-height: 64px; }
.desk-act { height: auto; min-height: 44px; }
.desk-act[data-kind=more] { width: 44px; }
.desk-act-ico { display: inline-flex; }
.desk-call { top: 8px; }
.desk-call-inner { white-space: normal; }
.desk-fold { display: inline-flex; }
`;

export const DESK_CSS = `
.desk { container: desk / inline-size; container-type: inline-size; min-width: 0; }
.desk-frame { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 12px; min-width: 0; height: calc(100dvh - 28px); overflow: hidden; }
.desk-frame[data-fit=natural] { height: auto; overflow: visible; }
.desk-body { position: relative; min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
.desk-body-skel { min-height: 320px; border-radius: 14px; background: rgba(15,30,51,0.05); border: 1px solid rgba(15,30,51,0.04); }
.desk-face { min-height: 0; min-width: 0; }
.desk-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.desk-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.desk kbd, .desk-kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px; font: 600 11px/1 var(--font-mono); color: var(--navy-400); background: rgba(15,30,51,0.05); border: 1px solid rgba(15,30,51,0.1); }

.desk-head { display: flex; align-items: center; gap: 16px; min-height: 54px; padding: 7px 12px 7px 20px; border-radius: var(--r-md); background: var(--card-bg); border: 1px solid rgba(15,30,51,0.07); box-shadow: 0 1px 2px rgba(15,30,51,0.04); min-width: 0; }
.desk-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.desk-h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; white-space: nowrap; line-height: 1.2; }
.desk-date { color: var(--navy-500); font-size: 14px; white-space: nowrap; }
.desk-kpis { display: flex; gap: 2px; margin: 0 0 0 auto; }
.desk-kpi { display: grid; padding: 2px 12px; border-left: 1px solid rgba(15,30,51,0.08); }
.desk-kpi:first-child { border-left: 0; }
.desk-kpi dt { order: 2; font-size: 11px; color: var(--navy-500); white-space: nowrap; }
.desk-kpi dd { order: 1; margin: 0; font-size: 18px; font-weight: 650; line-height: 1.1; color: var(--navy-900); font-variant-numeric: tabular-nums; }
.desk-kpi[data-warn=true] dd { color: var(--rc-late-fg); }
.desk-search { position: relative; width: 260px; min-width: 160px; flex-shrink: 1; }
.desk-search-ico { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--navy-400); display: inline-flex; pointer-events: none; }
.desk-search input { width: 100%; height: 40px; padding: 0 40px 0 38px; border-radius: 12px; border: 1px solid rgba(15,30,51,0.12); background: var(--bg-panel); font: inherit; font-size: 15px; color: var(--navy-900); }
.desk-search input:focus { outline: 2px solid transparent; border-color: var(--sky-700); box-shadow: var(--focus-ring); background: var(--card-bg); }
.desk-search kbd { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); }
.desk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--navy-500); cursor: pointer; }
.desk-search-clear:hover { background: rgba(15,30,51,0.06); color: var(--navy-900); }
.desk-new { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; font-size: 14px; white-space: nowrap; }
.desk-new kbd { background: rgba(255,255,255,0.16); color: var(--card-bg); border-color: rgba(255,255,255,0.25); }
.desk-lbl-short { display: none; }
.desk-clock { font-size: 18px; font-weight: 500; color: var(--navy-700); white-space: nowrap; }
.desk-view { flex-shrink: 0; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; border: 1px solid rgba(15,30,51,0.12); background: var(--card-bg); color: var(--navy-500); cursor: pointer; transition: border-color ${T_FAST}, color ${T_FAST}; }
.desk-view:hover { border-color: var(--navy-900); color: var(--navy-900); }

.desk-call { position: absolute; left: 0; right: 0; top: 64px; z-index: 6; display: flex; justify-content: center; padding: 0 12px; pointer-events: none; }
.desk-call-inner { display: flex; align-items: center; gap: 12px; max-width: 100%; padding: 10px 10px 10px 16px; border-radius: 14px; background: var(--rc-called-bg); color: var(--rc-called-fg); font-size: 15px; font-weight: 600; white-space: nowrap; box-shadow: 0 16px 36px rgba(31,79,190,0.35); pointer-events: auto; }
.desk-call-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.desk-call-close { min-height: 32px; padding: 0 10px; border-radius: 8px; border: 0; background: rgba(255,255,255,0.16); color: var(--rc-called-fg); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }

.desk-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(176px, 1fr); gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; padding-bottom: 2px; }
.desk-pro { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; align-items: center; text-align: left; height: 64px; padding: 8px 10px; border-radius: 14px; border: 1px solid rgba(15,30,51,0.07); background: var(--card-bg); box-shadow: 0 1px 2px rgba(15,30,51,0.04); position: relative; overflow: hidden; font: inherit; color: var(--navy-900); cursor: pointer; transition: border-color ${T_FAST}, box-shadow ${T_FAST}; }
.desk-pro:hover { border-color: rgba(15,30,51,0.2); }
.desk-pro[aria-pressed=true] { border-color: var(--navy-900); box-shadow: inset 0 0 0 1px var(--navy-900); }
.desk-av { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; background: var(--navy-900); color: var(--card-bg); }
.desk-pro-txt { min-width: 0; }
.desk-pro-l1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.desk-pro-name { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk-pro-l2 { display: block; font-size: 12px; color: var(--navy-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.desk-pro-l2 b { color: var(--navy-900); font-weight: 600; }
.desk-pro-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(15,30,51,0.05); }
.desk-pro-prog i { display: block; height: 100%; background: var(--navy-200); }
.desk-delay { margin-left: auto; flex-shrink: 0; height: 20px; padding: 0 7px; border-radius: 999px; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
.desk-delay[data-status=free] { background: var(--st-pending-bg); color: var(--navy-500); }
.desk-delay[data-status=on-time] { background: var(--st-completed-bg); color: var(--st-completed-fg); }
.desk-delay[data-status=late] { background: var(--rc-late-bg); color: var(--rc-late-fg); box-shadow: inset 0 0 0 1px var(--rc-late-border); }
.desk-delay[data-status=very-late] { background: var(--rc-late-fg); color: var(--card-bg); }

.desk-tag { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 650; white-space: nowrap; font-variant-numeric: tabular-nums; background: var(--st-pending-bg); color: var(--st-pending-fg); }
.desk-tag[data-state=por-llegar] { background: var(--st-confirmed-bg); color: var(--st-confirmed-fg); }
.desk-tag[data-state=demorado] { background: var(--rc-late-bg); color: var(--rc-late-fg); box-shadow: inset 0 0 0 1px var(--rc-late-border); }
.desk-tag[data-state=en-sala] { background: var(--rc-insala-bg); color: var(--rc-insala-fg); }
.desk-tag[data-state=llamado] { background: var(--rc-called-bg); color: var(--rc-called-fg); }
.desk-tag[data-state=en-atencion] { background: var(--rc-attending-bg); color: var(--rc-attending-fg); }
.desk-tag[data-state=atendido] { background: var(--st-completed-bg); color: var(--st-completed-fg); }
.desk-tag[data-state=ausente] { background: var(--st-noshow-bg); color: var(--st-noshow-fg); }
.desk-tag[data-state=cancelado] { background: var(--st-cancelled-bg); color: var(--st-cancelled-fg); }

.desk-acts { display: inline-flex; gap: 4px; justify-content: flex-end; align-items: center; }
.desk-act { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid transparent; font: inherit; font-size: 13px; font-weight: 650; white-space: nowrap; cursor: pointer; transition: background-color ${T_FAST}, border-color ${T_FAST}, transform ${T_FAST}; }
.desk-act:active:not(:disabled) { transform: scale(0.97); }
.desk-act:disabled { opacity: 0.55; cursor: progress; }
.desk-act-ico { display: inline-flex; }
.desk-act[data-kind=arrive] { background: var(--navy-900); color: var(--card-bg); }
.desk-act[data-kind=arrive]:hover:not(:disabled) { background: var(--navy-700); }
.desk-act[data-kind=call] { background: var(--rc-called-bg); color: var(--rc-called-fg); }
.desk-act[data-kind=call]:hover:not(:disabled) { background: var(--sky-800); }
.desk-act[data-kind=attend] { background: var(--card-bg); color: var(--navy-900); border-color: rgba(15,30,51,0.18); }
.desk-act[data-kind=attend]:hover:not(:disabled) { border-color: var(--navy-900); }
.desk-act[data-kind=done] { background: var(--st-completed-bg); color: var(--st-completed-fg); border-color: var(--st-completed-border); }
.desk-act[data-kind=pay] { background: var(--lime-300); color: var(--navy-900); }
.desk-act[data-kind=pay]:hover:not(:disabled) { background: var(--lime-400); }
.desk-act[data-kind=more] { width: 36px; padding: 0; background: transparent; color: var(--navy-500); }
.desk-act[data-kind=more]:hover:not(:disabled), .desk-act[data-kind=more][aria-expanded=true] { background: rgba(15,30,51,0.06); color: var(--navy-900); }
.desk-act[data-block=true] { width: 100%; }
.desk-paid { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--st-completed-fg); white-space: nowrap; }

.desk-menu { position: fixed; z-index: 60; min-width: 220px; max-width: calc(100vw - 16px); padding: 6px; border-radius: 12px; background: var(--card-bg); box-shadow: 0 0 0 1px rgba(15,30,51,0.08), 0 18px 40px rgba(15,30,51,0.18); display: grid; gap: 2px; }
.desk-menu-h { padding: 6px 10px 4px; font-size: 12px; color: var(--navy-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk-menu-item { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; text-align: left; font: inherit; font-size: 14px; font-weight: 500; color: var(--navy-900); text-decoration: none; cursor: pointer; }
.desk-menu-item:hover { background: var(--bg-panel); }
.desk-menu-item:focus-visible { background: var(--bg-panel); outline: 2px solid var(--sky-700); outline-offset: -2px; }
.desk-menu-sep { border: 0; height: 1px; background: rgba(15,30,51,0.07); margin: 4px 0; }

.desk-fold { display: none; flex-shrink: 0; align-items: center; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; margin: -6px -6px -6px 0; padding: 0 8px; border: 0; border-radius: 10px; background: transparent; font: inherit; font-size: 13px; font-weight: 650; color: var(--navy-500); cursor: pointer; }
.desk-fold svg { transition: transform ${T_FAST}; }
.desk-fold[aria-expanded=false] svg { transform: rotate(-90deg); }
.desk-fold:focus-visible { outline: 2px solid var(--sky-700); outline-offset: -2px; }

.desk-pay { display: grid; gap: 16px; }
.desk-pay-amt { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 16px; border-radius: 14px; background: var(--bg-panel); color: var(--navy-500); font-size: 14px; }
.desk-pay-amt b { font-size: 28px; font-weight: 650; line-height: 1; letter-spacing: -0.02em; color: var(--navy-900); font-variant-numeric: tabular-nums; }
.desk-pay-note { margin: 0; font-size: 13px; color: var(--navy-500); }
.desk-pay-f { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.desk-pay-f .k-btn { min-height: 44px; }

@container desk (max-width: ${DESK_COMPACT_MAX}px) {${COMPACT_RULES}}
@container desk (max-width: ${DESK_STACK_MAX}px) {${STACK_RULES}}
@supports not (container-type: inline-size) {
  @media (max-width: ${DESK_COMPACT_MAX + SIDEBAR_PX}px) {${COMPACT_RULES}}
  @media (max-width: ${DESK_STACK_MAX + SIDEBAR_PX}px) {${STACK_RULES}}
}

/* Menú ⋯ con targets de 44 px en táctil o pantalla angosta. NO va en STACK_RULES: el menú vive en un portal al
   body, fuera de .desk, y la container query de .desk nunca lo alcanza (RX-Z #13). */
@media (pointer: coarse), (max-width: ${DESK_STACK_MAX}px) {
  .desk-menu-item { min-height: 44px; }
}

/* Modal de cobro como hoja (C-MB2/C-MB3): bajo 640 los botones van apilados a ancho completo. Por @media y no en
   STACK_RULES: el modal es un portal fuera de .desk. */
@media (max-width: 639px) {
  .desk-pay-f { flex-direction: column-reverse; }
  .desk-pay-f .k-btn { width: 100%; justify-content: center; }
}

@media (prefers-reduced-motion: reduce) {
  .desk-pro, .desk-act, .desk-view, .desk-menu-item, .desk-fold svg { transition: none; }
  .desk-act:active:not(:disabled) { transform: none; }
}
`;
