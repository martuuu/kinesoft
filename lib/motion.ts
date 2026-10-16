/**
 * Shared motion vocabulary for KineSoft.
 *
 * One source of truth for easing + durations + variants so every animated
 * surface (modals, drawers, toasts, lists) feels like it
 * belongs to the same system. Values are intentionally subtle and quick —
 * the UI should feel alive, never sluggish.
 *
 * These are plain data objects (no JSX), safe to import from any client
 * component. `framer-motion` honours the user's `prefers-reduced-motion`
 * globally via the `<MotionConfig reducedMotion="user">` in ui-providers.
 */
import type { Transition, Variants } from "framer-motion";

/** The house easing curve — matches the Drawer's original cubic-bezier. */
export const EASE_OUT: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
export const EASE_IN_OUT: [number, number, number, number] = [0.4, 0, 0.2, 1];

export const DUR = {
  fast: 0.15,
  base: 0.22,
  slow: 0.3,
  /**
   * [SV03u] Un ciclo del anillo de llegada (`arrivalPulse`). 0,6 s × 2 ciclos =
   * 1,2 s: lo bastante largo para que la Secretaria lo vea con el rabillo del
   * ojo mientras atiende el mostrador, y corto para que con 5 profesionales
   * llegando a la vez el tablero no quede «latiendo» todo el tiempo.
   */
  pulse: 0.6,
} as const;

export const springSoft: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.9,
};

// PF1.0-a: `pageVariants` se borró. Lo usaba el `template.tsx` del workspace hasta PF-0c, que pasó la entrada de
// página a CSS (`.k-page-in`): nada visible en el primer render depende de framer (C-PF1.2).

/** Centered modal card. */
export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.97, y: 6, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/** Shared backdrop fade for modals + drawers. */
export const backdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/** Right-side drawer panel. `custom` = panel width (+gap) in px. */
export const drawerVariants: Variants = {
  initial: (offset: number) => ({ x: offset, opacity: 0.6 }),
  animate: { x: 0, opacity: 1, transition: { duration: DUR.slow, ease: EASE_OUT } },
  exit: (offset: number) => ({ x: offset, opacity: 0.4, transition: { duration: DUR.base, ease: EASE_IN_OUT } }),
};

/** Toast / snackbar — slides in from the right, springs into the stack. */
export const toastVariants: Variants = {
  initial: { opacity: 0, x: 40, scale: 0.96 },
  animate: { opacity: 1, x: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, x: 40, scale: 0.9, transition: { duration: DUR.base, ease: EASE_IN_OUT } },
};

/**
 * List container + item for staggered reveals (patient directory, agenda
 * lists). Use `staggerList` on the wrapper and `staggerItem` on each child.
 */
export const staggerList: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
};

/* ─────────────────────────────────────────────────────────────────────
 * [SV03u] Sala de espera en tiempo real (C-SV10).
 *
 * Contexto de densidad: la Secretaria mira 5+ columnas con decenas de filas, y
 * un lote de realtime puede traer 20 cambios juntos (batch de turnos, candado
 * del día). Todo lo de abajo está pensado para que un cambio se lea como un
 * movimiento claro y un lote grande como UN solo cambio, nunca como 20
 * parpadeos. Con `prefers-reduced-motion`, el `MotionConfig
 * reducedMotion="user"` de ui-providers anula transform y layout (las filas
 * aparecen ya en su lugar); lo que no es transform (el anillo) se apaga por
 * CSS en globals.css. En ambos casos el estado final se ve completo.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Fila de una lista en vivo (card de /sala, fila de Recepción).
 * - enter: 6 px y no 8 como `staggerItem` → en filas de ~56 px un desplazamiento
 *   mayor se lee como "salto" de la fila de abajo; 6 px se percibe como llegada.
 * - exit: scale .98 en vez de deslizar: con `AnimatePresence mode="popLayout"`
 *   la fila que se va sale del flujo al instante y las demás suben con el
 *   spring de `rowLayout`; si además se deslizara, habría dos movimientos
 *   cruzados en la misma zona. `DUR.fast` porque lo que se va importa menos
 *   que lo que llega.
 */
export const rowVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/**
 * Spring del cambio de banda (En sala → Llamado → En atención): la card se
 * desliza a su nuevo lugar dentro de la misma `<ul>` en vez de desmontarse.
 * stiffness 420 (vs 520 de `springSoft`): el recorrido de una fila entre
 * bandas puede ser de 300+ px y con 520 llegaba "de golpe"; damping 38 y mass
 * 0.9 = sin rebote visible (un rebote en una lista densa se confunde con otro
 * cambio). Uso: `<m.li layout transition={rowLayout} variants={rowVariants}>`;
 * las transiciones de enter/exit de las variantes tienen prioridad, este
 * objeto solo gobierna `layout`.
 */
export const rowLayout: Transition = {
  layout: { type: "spring", stiffness: 420, damping: 38, mass: 0.9 },
};

/** Más de esta cantidad de cambios en un lote → `rowLayoutBulk`. */
export const ROW_BULK_THRESHOLD = 5;

/**
 * Lote grande (> 5 cambios, p. ej. un batch de 20 turnos o el candado del
 * día): sin spring de layout (las filas se ubican en su lugar sin cruzarse) y
 * un único fade de `DUR.base` para todo lo que entra o sale a la vez. 20
 * springs simultáneos en la misma columna se ven como un temblor, y 20
 * entradas escalonadas, como 20 parpadeos.
 */
export const rowLayoutBulk: Transition = {
  layout: { duration: 0 },
  default: { duration: DUR.base, ease: EASE_OUT },
};

/** Elige la transición de fila según el tamaño del lote que la disparó. */
export function rowTransition(changesInBatch: number): Transition {
  return changesInBatch > ROW_BULK_THRESHOLD ? rowLayoutBulk : rowLayout;
}

/**
 * Anillo de llegada (una vez por `arrivedAt`): 2 ciclos de `DUR.pulse`.
 *
 * Por qué una variable CSS y no `boxShadow` directo: framer-motion 11 no
 * resuelve `var(--lime-400)` DENTRO de un valor compuesto (solo si la variable
 * es el valor entero; ver `isCSSVariableToken`), así que `0 0 0 0
 * var(--lime-400)` → `0 0 0 8px rgba(…,0)` saltaba sin interpolar. Además el
 * lime cambia con la paleta del consultorio (en "coral" es amarillo). Acá se
 * anima solo `--k-pulse` (0 = anillo pegado y opaco, 1 = 8 px y transparente) y
 * la clase `.k-arrival-ring` de globals.css arma el `box-shadow` con
 * `var(--lime-400)` de la paleta vigente. Con reduced motion la clase no
 * dibuja el anillo (framer no frena variables CSS, solo transform/layout).
 *
 * Uso: `<m.li className="k-arrival-ring" variants={arrivalPulse}
 * initial="rest" animate="pulse" key={arrivedAt}>`, o `animate={pulseKey ?
 * "pulse" : "rest"}`. El card conserva su sombra propia vía `--k-ring-base`.
 */
export const arrivalPulse: Variants = {
  rest: { "--k-pulse": 1 },
  pulse: {
    "--k-pulse": [0, 1],
    transition: { duration: DUR.pulse, repeat: 1, ease: EASE_OUT },
  },
};

/**
 * Contador del header (En sala · Llamado · …) al cambiar: 1 → 1.15 → 1 en
 * `DUR.fast`. Escala y no color: el número sigue legible todo el tiempo y con
 * reduced motion simplemente no se mueve. Uso: `<m.span key={count}
 * variants={countBump} initial="rest" animate="bump">`.
 */
export const countBump: Variants = {
  rest: { scale: 1 },
  bump: { scale: [1, 1.15, 1], transition: { duration: DUR.fast, ease: EASE_OUT } },
};
