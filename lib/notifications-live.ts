/**
 * [AS-0c] Campana en vivo, sin migración (plan §21.4 punto 8). Antes el contador se pedía UNA vez al montar el shell:
 * un turno reservado por el turnero (que notifica al profesional) no aparecía hasta recargar. Ahora la campana se
 * re-pide sola:
 * - cada 60 s con la pestaña visible (oculta no pide: una pestaña olvidada no martilla el server) y en seguida al
 *   volver a verse. Es el mismo `createVisiblePoller` del respaldo del realtime (HF-1b), no una copia;
 * - al volver el foco a la ventana (otra app adelante con la pestaña visible no dispara `visibilitychange`). Foco y
 *   visibilidad suelen llegar juntos: dentro de `BELL_MIN_GAP_MS` cuenta como uno;
 * - con cada lote de la agenda en vivo (`useRealtime().subscribe`), con un debounce: un turno nuevo trae su
 *   notificación en la misma operación, y los lotes llegan en ráfagas (mover un plan son N eventos).
 * Puro (timers y `isVisible`/`now` inyectables): los render tests no corren effects y esto se testea con fake timers.
 * Vive en lib/ y no al lado de la campana: el grafo del shell (pf1-shell.test) admite de components/dashboard solo
 * la campana. Va sin "use server" ni `server-only`: corre en el cliente.
 */
import { createVisiblePoller } from "@/components/providers/realtime-provider";

export const BELL_POLL_MS = 60_000;
export const BELL_REALTIME_DEBOUNCE_MS = 1_500;
export const BELL_MIN_GAP_MS = 5_000;

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
const hostTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type BellRefreshReason = "poll" | "visible" | "focus" | "realtime";

export function createBellLive(o: {
  refresh: (reason: BellRefreshReason) => void;
  isVisible: () => boolean;
  now?: () => number;
  timers?: Timers;
}) {
  const timers = o.timers ?? hostTimers;
  const now = o.now ?? (() => Date.now());
  let running = false;
  let last = -Infinity;
  let debounce: unknown = null;

  const fire = (reason: BellRefreshReason) => {
    last = now();
    o.refresh(reason);
  };
  const poller = createVisiblePoller({
    intervalMs: BELL_POLL_MS,
    timers,
    isVisible: o.isVisible,
    onPoll: (r) => {
      // «visible» y «focus» llegan juntos al volver a la pestaña: el segundo no repite el pedido.
      if (r === "visible" && now() - last < BELL_MIN_GAP_MS) return;
      fire(r === "visible" ? "visible" : "poll");
    },
  });
  const clearDebounce = () => {
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = null;
  };

  return {
    start() {
      running = true;
      poller.start();
    },
    stop() {
      running = false;
      poller.stop();
      clearDebounce();
    },
    handleVisibility(visible: boolean) {
      poller.handleVisibility(visible);
    },
    handleFocus() {
      if (!running || !o.isVisible() || now() - last < BELL_MIN_GAP_MS) return;
      fire("focus");
    },
    handleRealtime() {
      if (!running) return;
      clearDebounce();
      debounce = timers.setTimeout(() => {
        debounce = null;
        if (running) fire("realtime");
      }, BELL_REALTIME_DEBOUNCE_MS);
    },
  };
}

/*
 * [CF-F] CF-NOT (§28): filas, contador y «Cargando…» de la campana, fuera del componente para testearlo con el
 * símbolo real (los render tests no corren effects).
 *
 * Bugs que motivan esto (reporte del cliente: «me marca solo las últimas 4 y no tiene realtime»):
 * - «Cargando…» trabado: la apertura y el poll compartían una secuencia de «solo la última respuesta». Si un poll
 *   (con el desplegable abierto pide filas) arrancaba después de la apertura, la respuesta de la apertura se tiraba y
 *   la del poll ponía las filas pero no `loaded`: el panel quedaba en «Cargando…» para siempre. Ahora una respuesta
 *   se descarta solo si algo MÁS NUEVO ya se aplicó (o hubo un cambio local, p. ej. «marcar todas»), no porque haya
 *   salido otro pedido después; y cualquier respuesta con filas deja el panel listo.
 * - El fetch de apertura no tenía `.catch`: sin red quedaba «Cargando…». Ahora pasa a `error` con «Reintentar».
 * - Con el desplegable cerrado solo se pedía el contador: al abrir, las filas eran las de la apertura anterior hasta
 *   que volvía la respuesta. Ahora, si el contador cambió, se piden también las filas.
 */
export const BELL_PAGE = 20;
/** Tope de `listNotifications` (lib/notifications.ts, PV-W1a): «Ver anteriores» pide hasta acá. */
export const BELL_PAGE_MAX = 50;

export type BellStatus = "idle" | "loading" | "ready" | "error";
export type BellFeedState<Row> = { rows: Row[]; unread: number; status: BellStatus; limit: number };

export function createBellFeed<Row>(o: {
  fetchRows: (limit: number) => Promise<{ rows: Row[]; unread: number }>;
  fetchCount: () => Promise<number>;
  onChange: (s: BellFeedState<Row>) => void;
}) {
  let state: BellFeedState<Row> = { rows: [], unread: 0, status: "idle", limit: BELL_PAGE };
  let open = false;
  let alive = true;
  let seq = 0;
  // Última respuesta aplicada (por tipo) y último cambio local: una respuesta más vieja que cualquiera de los dos se tira.
  let rowsApplied = 0;
  let countApplied = 0;
  let localChange = 0;
  let latestRowsReq = 0;
  let knownCount: number | null = null;

  const set = (patch: Partial<BellFeedState<Row>>) => {
    state = { ...state, ...patch };
    if (alive) o.onChange(state);
  };

  const loadRows = () => {
    const n = ++seq;
    latestRowsReq = n;
    if (state.status === "idle" || state.status === "error") set({ status: "loading" });
    o.fetchRows(state.limit).then(
      (data) => {
        if (!alive) return;
        if (n <= localChange) {
          // Salió antes de un «marcar como leída»: traería el estado viejo. Si el panel todavía espera filas, se piden
          // de nuevo (si no, quedaría en «Cargando…» por haberla tirado).
          if (state.status === "loading" && n === latestRowsReq) loadRows();
          return;
        }
        if (n <= rowsApplied) return;
        rowsApplied = n;
        const patch: Partial<BellFeedState<Row>> = { rows: data.rows, status: "ready" };
        if (n > countApplied) {
          countApplied = n;
          knownCount = data.unread;
          patch.unread = data.unread;
        }
        set(patch);
      },
      () => {
        if (!alive) return;
        // Sin red o sesión vencida: si ya había filas se quedan; si el panel esperaba la primera carga, «Reintentar».
        if (state.status === "loading" && n === latestRowsReq) set({ status: "error" });
      }
    );
  };

  const loadCount = () => {
    const n = ++seq;
    o.fetchCount().then(
      (unread) => {
        if (!alive || n <= localChange || n <= countApplied) return;
        countApplied = n;
        const changed = knownCount !== null && unread !== knownCount;
        knownCount = unread;
        set({ unread });
        // Con el desplegable cerrado: si llegó (o se leyó) algo, las filas también, para que al abrir ya estén.
        if (changed) loadRows();
      },
      () => {
        // Queda el número de antes; el próximo tick reintenta.
      }
    );
  };

  return {
    get state() {
      return state;
    },
    /** Tick del poll / foco / realtime: con el desplegable abierto, filas; cerrado, el contador. */
    refresh() {
      if (open) loadRows();
      else loadCount();
    },
    setOpen(next: boolean) {
      open = next;
      if (next) loadRows();
    },
    /** «Ver anteriores»: de 20 a 50 (el tope del server). */
    loadMore() {
      if (state.limit >= BELL_PAGE_MAX) return;
      set({ limit: BELL_PAGE_MAX });
      loadRows();
    },
    retry() {
      loadRows();
    },
    /** Cambio optimista local (marcar leída / todas): invalida las respuestas en vuelo. */
    patch(fn: (s: BellFeedState<Row>) => Partial<BellFeedState<Row>>) {
      localChange = ++seq;
      const p = fn(state);
      if (p.unread !== undefined) knownCount = p.unread;
      set(p);
    },
    stop() {
      alive = false;
    },
  };
}

/**
 * [CF-F1] Pie del panel: cuántas hay y si se pueden pedir más. Con el alto viejo (420 px) entraban ~4,9 filas y en
 * macOS la barra de scroll está oculta: parecía que había solo 4. El pie siempre dice cuántas se muestran.
 */
export function bellFooter(count: number, limit: number): { label: string; canLoadMore: boolean } | null {
  if (count === 0) return null;
  const canLoadMore = count >= limit && limit < BELL_PAGE_MAX;
  const label =
    count === 1 ? "1 notificación" : count >= limit ? `Las ${count} más recientes` : `${count} notificaciones`;
  return { label, canLoadMore };
}

/*
 * [ZF3] A1 (CF-ZB): una sola campana que pide, la que se ve. El AppShell monta una campana por chrome (Sidebar o
 * TopBar, ocultos bajo 768 px con `.desktopOnly`) y otra en la barra móvil (oculta desde 768). El HTML es el mismo en
 * cualquier ancho (el server no conoce el viewport y así no hay salto al hidratar), pero cada `NotificationsBell`
 * arrancaba su poller al montarse: con la campana del Sidebar, el `<aside>` oculto en mobile seguía pidiendo el conteo
 * cada 60 s, y la barra móvil no tenía campana justamente para no sumar otro poller oculto en escritorio (con lo que
 * en mobile, con «Barra lateral», no quedaba ninguna). Ahora cada campana mira si su botón está pintado y solo la
 * visible arranca el feed; al cruzar los 768 px se apaga una y se prende la otra.
 * Se decide por el botón pintado (`getClientRects`) y no por el ancho: así sigue al CSS real (`display: none` de
 * `.desktopOnly` / `.mobileBar`) sin copiar el breakpoint en la lógica; `BELL_VIEWPORT_QUERY` es solo el aviso de que
 * hay que volver a mirar.
 */
export const BELL_VIEWPORT_QUERY = "(min-width: 768px)";

/** ¿El botón de la campana está pintado? `display: none` en él o en un ancestro = sin cajas. Sin elemento, no. */
export function bellIsShown(el: { getClientRects(): { length: number } } | null | undefined): boolean {
  return !!el && el.getClientRects().length > 0;
}

/**
 * Prende/apaga el feed de una campana según se vea. `watch` avisa cuando puede haber cambiado (el `change` del
 * media query); `onActive` solo se llama cuando el valor cambia (la primera vez, siempre).
 */
export function createBellGate(o: {
  isShown: () => boolean;
  watch: (recheck: () => void) => () => void;
  onActive: (active: boolean) => void;
}) {
  let current: boolean | null = null;
  let alive = true;
  const recheck = () => {
    if (!alive) return;
    const next = o.isShown();
    if (next === current) return;
    current = next;
    o.onActive(next);
  };
  recheck();
  const unwatch = o.watch(recheck);
  return {
    recheck,
    stop() {
      alive = false;
      unwatch();
    },
  };
}
