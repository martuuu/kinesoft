import type { ReceptionLayout } from "@/lib/preferences-constants";

/**
 * [PF1.1-sala · C-PF2] Cargadores de las tres caras de /sala (Tablero, «Lista y panel», «Flujo»).
 *
 * Por qué existen: hasta PF1 `/sala` bajaba las tres caras en el JS inicial (230,8 kB gz, brief-pf §3.1) aunque la
 * Secretaria usa una sola todo el día (`agendaPrefs.receptionLayout`). Ahora cada cara es un chunk aparte y
 * `SalaClient` monta solo la elegida con `next/dynamic` (con SSR: el primer pintado sigue llegando en el HTML, la
 * hidratación espera el chunk de esa cara y nada más).
 *
 * El escritorio son DOS chunks (el shell `reception-desk` y la cara `desk-list` o `desk-flow`): `preloadSalaFace` los
 * pide en paralelo, así la hidratación no encadena shell → cara (dos idas a la red).
 *
 * `import()` es idempotente (webpack cachea el módulo): llamarlo de más no baja nada dos veces. Solo los `import()`
 * dinámicos viven acá: este módulo no arrastra ninguna cara al bundle de quien lo importa.
 */
export const loadBoardFace = () => import("./sala-board-face");
export const loadReceptionDesk = () => import("./desk/reception-desk");
export const loadDeskList = () => import("./desk/desk-list");
export const loadDeskFlow = () => import("./desk/desk-flow");
export const loadDeskPayModal = () => import("./desk/desk-pay-modal");

/** Pide los chunks de una cara (sin await). Solo en el navegador: en el server todo ya está en el bundle. */
export function preloadSalaFace(layout: ReceptionLayout): void {
  if (typeof window === "undefined") return;
  const swallow = () => {}; // Si la red falla, el `next/dynamic` de la cara lo reintenta al montarla.
  if (layout === "board") {
    void loadBoardFace().catch(swallow);
    return;
  }
  void loadReceptionDesk().catch(swallow);
  void (layout === "list" ? loadDeskList() : loadDeskFlow()).catch(swallow);
}

/**
 * Las tres caras: lo dispara el foco o el hover de «Vista» (abre Apariencia, donde se cambia de cara), así el cambio
 * no espera red (C-PF2, precarga en el disparador).
 */
export function preloadSalaFaces(): void {
  preloadSalaFace("board");
  preloadSalaFace("list");
  preloadSalaFace("flow");
}
