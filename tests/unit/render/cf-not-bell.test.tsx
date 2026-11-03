/**
 * [CF-F] CF-NOT (§28, ola CF-1) — campana de notificaciones.
 *
 * Reporte del cliente: «Las notificaciones me marca solo las últimas 4 y no tiene realtime». El panel medía 420 px
 * (~4,9 filas) con la barra de scroll oculta en macOS; el «Cargando…» se trababa si un poll pisaba la apertura; y con
 * la «Barra lateral» la campana solo existía en el dashboard.
 *
 * - [CF-F1] render del panel real (`NotificationsPanel`) con 20 filas: pie con cuántas hay, desvanecido de «más» y
 *   «Ver anteriores».
 * - [CF-F3] `createBellFeed` (lib/notifications-live.ts, el símbolo que usa la campana) con respuestas controladas a
 *   mano: el estado no queda en «loading» si un poll pisa la apertura, ni si la apertura falla.
 * - La barra lateral monta la campana.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/agenda",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  countUnreadNotifications: async () => 0,
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));

// [ZF3] La barra móvil trae el menú de cuenta (sus server actions): mockeadas como en pf1-shell.test.
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));

import { NotificationsPanel } from "@/components/dashboard/notifications-panel";
import { Sidebar } from "@/components/layout/sidebar";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import {
  BELL_PAGE,
  BELL_PAGE_MAX,
  bellFooter,
  bellIsShown,
  createBellFeed,
  createBellGate,
  type BellFeedState,
} from "@/lib/notifications-live";
import { MobileBar } from "@/components/layout/mobile-bar";
import type { NotificationRow } from "@/lib/notifications-types";

const row = (i: number): NotificationRow => ({
  id: `n${i}`,
  kind: "PATIENT_NEW",
  title: `Nuevo paciente · P ${i}`,
  body: null,
  link: `/pacientes/p${i}`,
  readAt: null,
  createdAt: new Date(Date.UTC(2026, 9, 30, 12, i)),
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
const noop = () => {};
const panel = (state: BellFeedState<NotificationRow>) =>
  renderToStaticMarkup(
    <NotificationsPanel state={state} onRow={noop} onMarkAll={noop} onMore={noop} onRetry={noop} />
  );

describe("[CF-F1] el panel deja ver que hay más", () => {
  it("[CF-F1] con 20 filas: las 20 en la lista, desvanecido de «más», pie «Las 20 más recientes» y «Ver anteriores»", () => {
    const html = panel({ rows: rows(20), unread: 20, status: "ready", limit: BELL_PAGE });
    expect(html.match(/Nuevo paciente · P \d+/g)).toHaveLength(20);
    expect(html).toContain("data-bell-more");
    expect(html).toContain("Las 20 más recientes");
    expect(html).toContain("deslizá para ver más"); // [ZF3] B19: «ver todas» prometía las 50
    expect(html).toMatch(/<button[^>]*>Ver anteriores<\/button>/);
    // La lista es la que scrollea (el pie queda fijo abajo, siempre visible).
    expect(html).toMatch(/data-bell-list=""[^>]*overflow-y:auto/);
  });

  it("[CF-F1] con 3 filas: sin desvanecido ni «Ver anteriores», pie con el total", () => {
    const html = panel({ rows: rows(3), unread: 0, status: "ready", limit: BELL_PAGE });
    expect(html).not.toContain("data-bell-more");
    expect(html).not.toContain("Ver anteriores");
    expect(html).toContain("3 notificaciones");
  });

  it("[CF-F1] bellFooter: «Ver anteriores» solo con la página llena y por debajo del tope del server", () => {
    expect(bellFooter(0, BELL_PAGE)).toBeNull();
    expect(bellFooter(1, BELL_PAGE)).toEqual({ label: "1 notificación", canLoadMore: false });
    expect(bellFooter(BELL_PAGE, BELL_PAGE)!.canLoadMore).toBe(true);
    expect(bellFooter(BELL_PAGE_MAX, BELL_PAGE_MAX)).toEqual({ label: "Las 50 más recientes", canLoadMore: false });
    expect(bellFooter(32, BELL_PAGE_MAX)).toEqual({ label: "32 notificaciones", canLoadMore: false });
  });

  it("[CF-F3] error sin filas: «No pudimos cargar» + «Reintentar», no «Cargando…»", () => {
    const html = panel({ rows: [], unread: 0, status: "error", limit: BELL_PAGE });
    expect(html).not.toContain("Cargando…");
    expect(html).toContain("No pudimos cargar las notificaciones.");
    expect(html).toContain("Reintentar");
  });
});

/** Promesas resueltas a mano, en el orden que elige el test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const rowsReqs: ReturnType<typeof deferred<{ rows: NotificationRow[]; unread: number }>>[] = [];
  const countReqs: ReturnType<typeof deferred<number>>[] = [];
  const limits: number[] = [];
  let last: BellFeedState<NotificationRow> | null = null;
  const feed = createBellFeed<NotificationRow>({
    fetchRows: (limit) => {
      limits.push(limit);
      const d = deferred<{ rows: NotificationRow[]; unread: number }>();
      rowsReqs.push(d);
      return d.promise;
    },
    fetchCount: () => {
      const d = deferred<number>();
      countReqs.push(d);
      return d.promise;
    },
    onChange: (s) => (last = s),
  });
  return { feed, rowsReqs, countReqs, limits, state: () => last ?? feed.state };
}

describe("[CF-F3] createBellFeed: «Cargando…» no se traba", () => {
  it("[CF-F3] un poll con filas sale después de la apertura y responde antes: la apertura igual deja el panel listo", async () => {
    const h = harness();
    h.feed.setOpen(true); // apertura → rows #0
    expect(h.state().status).toBe("loading");
    h.feed.refresh(); // poll con el desplegable abierto → rows #1
    // El poll responde primero y la apertura después: antes la apertura se tiraba y el poll no ponía `loaded`.
    h.rowsReqs[1].resolve({ rows: rows(5), unread: 2 });
    await flush();
    expect(h.state().status).toBe("ready");
    h.rowsReqs[0].resolve({ rows: rows(4), unread: 9 });
    await flush();
    // La más vieja no pisa a la más nueva ya aplicada.
    expect(h.state()).toMatchObject({ status: "ready", unread: 2 });
    expect(h.state().rows).toHaveLength(5);
  });

  it("[CF-F3] la apertura responde antes que el poll que salió después: se aplica (no se descarta por la secuencia)", async () => {
    const h = harness();
    h.feed.setOpen(true);
    h.feed.refresh();
    h.rowsReqs[0].resolve({ rows: rows(3), unread: 1 });
    await flush();
    expect(h.state()).toMatchObject({ status: "ready", unread: 1 });
    h.rowsReqs[1].resolve({ rows: rows(6), unread: 4 });
    await flush();
    expect(h.state()).toMatchObject({ status: "ready", unread: 4 });
    expect(h.state().rows).toHaveLength(6);
  });

  it("[CF-F3] la apertura falla (sin red): pasa a «error», y «Reintentar» la vuelve a pedir", async () => {
    const h = harness();
    h.feed.setOpen(true);
    h.rowsReqs[0].reject(new Error("offline"));
    await flush();
    expect(h.state().status).toBe("error");
    h.feed.retry();
    expect(h.state().status).toBe("loading");
    h.rowsReqs[1].resolve({ rows: rows(2), unread: 0 });
    await flush();
    expect(h.state().status).toBe("ready");
  });

  it("[CF-F3] «marcar todas» mientras carga: la respuesta vieja se descarta y se re-piden las filas (no queda en loading)", async () => {
    const h = harness();
    h.feed.setOpen(true);
    h.feed.patch(() => ({ unread: 0 }));
    h.rowsReqs[0].resolve({ rows: rows(3), unread: 3 });
    await flush();
    expect(h.rowsReqs).toHaveLength(2);
    expect(h.state().unread).toBe(0);
    h.rowsReqs[1].resolve({ rows: rows(3), unread: 0 });
    await flush();
    expect(h.state()).toMatchObject({ status: "ready", unread: 0 });
  });

  it("[CF-F] cerrado: si cambia el contador se piden también las filas; si no cambia, solo el contador", async () => {
    const h = harness();
    h.feed.refresh();
    h.countReqs[0].resolve(1);
    await flush();
    expect(h.rowsReqs).toHaveLength(0); // el primer conteo es la base
    h.feed.refresh();
    h.countReqs[1].resolve(1);
    await flush();
    expect(h.rowsReqs).toHaveLength(0);
    h.feed.refresh();
    h.countReqs[2].resolve(3);
    await flush();
    expect(h.rowsReqs).toHaveLength(1);
    h.rowsReqs[0].resolve({ rows: rows(3), unread: 3 });
    await flush();
    expect(h.state()).toMatchObject({ status: "ready", unread: 3 });
  });

  it("[CF-F] «Ver anteriores» pide 50 y los polls siguientes siguen en 50", async () => {
    const h = harness();
    h.feed.setOpen(true);
    h.rowsReqs[0].resolve({ rows: rows(20), unread: 0 });
    await flush();
    h.feed.loadMore();
    h.feed.refresh();
    expect(h.limits).toEqual([BELL_PAGE, BELL_PAGE_MAX, BELL_PAGE_MAX]);
    h.feed.loadMore(); // ya en el tope: no pide
    expect(h.limits).toHaveLength(3);
  });
});

describe("[CF-F] la barra lateral monta la campana", () => {
  it("[CF-F] el <aside> de escritorio muestra la campana que le pasa el AppShell", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={[]}>
        <Sidebar caps={[]} bell={<NotificationsBell placement="side" />} />
      </TenantModulesProvider>
    );
    expect(html).toMatch(/<aside[^>]*>[\s\S]*<button[^>]*aria-label="Notificaciones"/);
  });

  it("[CF-F] el AppShell se la pasa al Sidebar (con la barra lateral, en todas las pantallas)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/layout/app-shell.tsx", "utf8");
    expect(src).toMatch(/<Sidebar[\s\S]*?bell=\{<NotificationsBell placement="side" \/>\}/);
  });
});

/*
 * [ZF3] A1 (CF-ZB): con «Barra lateral», en mobile no quedaba ninguna campana (el Sidebar es `.desktopOnly` y la del
 * dashboard se había sacado), y el `<aside>` oculto seguía poleando. Ahora la barra móvil también lleva campana y
 * cada una pide solo si se ve. Los render tests no corren effects: el gate se prueba con el símbolo real
 * (`createBellGate` + `bellIsShown`, los que usa `NotificationsBell`) y un viewport simulado.
 */
describe("[ZF3] A1 una campana visible y un solo poller por viewport", () => {
  type FakeBtn = { getClientRects(): { length: number } };
  /** Viewport simulado: el CSS de shell.module.css (`.desktopOnly` oculto < 768, `.mobileBar` oculto ≥ 768). */
  function viewport(width: number) {
    const listeners = new Set<() => void>();
    const v = {
      width,
      button(where: "desktop" | "mobile"): FakeBtn {
        return { getClientRects: () => ({ length: (where === "desktop") === v.width >= 768 ? 1 : 0 }) };
      },
      watch(cb: () => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      resize(w: number) {
        v.width = w;
        listeners.forEach((cb) => cb());
      },
    };
    return v;
  }
  /** Una campana montada: cuenta sus pollers activos como lo haría el effect del feed. */
  function mountBell(v: ReturnType<typeof viewport>, where: "desktop" | "mobile", active: Map<string, boolean>) {
    const btn = v.button(where);
    return createBellGate({ isShown: () => bellIsShown(btn), watch: (cb) => v.watch(cb), onActive: (on) => active.set(where, on) });
  }
  const pollers = (m: Map<string, boolean>) => [...m.entries()].filter(([, on]) => on).map(([k]) => k);

  it("[ZF3] mobile (390): pide la de la barra móvil; la del Sidebar oculto no", () => {
    const v = viewport(390);
    const active = new Map<string, boolean>();
    mountBell(v, "desktop", active);
    mountBell(v, "mobile", active);
    expect(pollers(active)).toEqual(["mobile"]);
  });

  it("[ZF3] escritorio (1280): pide la del Sidebar/TopBar; la de la barra móvil oculta no", () => {
    const v = viewport(1280);
    const active = new Map<string, boolean>();
    mountBell(v, "desktop", active);
    mountBell(v, "mobile", active);
    expect(pollers(active)).toEqual(["desktop"]);
  });

  it("[ZF3] al cruzar los 768 px se apaga una y se prende la otra (nunca dos); stop deja de mirar", () => {
    const v = viewport(1280);
    const active = new Map<string, boolean>();
    const calls: string[] = [];
    const a = createBellGate({
      isShown: () => bellIsShown(v.button("desktop")),
      watch: (cb) => v.watch(cb),
      onActive: (on) => (active.set("desktop", on), calls.push(`desktop:${on}`)),
    });
    mountBell(v, "mobile", active);
    v.resize(500);
    expect(pollers(active)).toEqual(["mobile"]);
    v.resize(400); // sigue en mobile: no re-notifica
    expect(calls).toEqual(["desktop:true", "desktop:false"]);
    a.stop();
    v.resize(1000);
    expect(calls).toHaveLength(2);
  });

  it("[ZF3] sin elemento o con display:none no se ve", () => {
    expect(bellIsShown(null)).toBe(false);
    expect(bellIsShown({ getClientRects: () => ({ length: 0 }) })).toBe(false);
    expect(bellIsShown({ getClientRects: () => ({ length: 2 }) })).toBe(true);
  });

  it("[ZF3] la barra móvil muestra la campana que le pasa el AppShell", () => {
    const html = renderToStaticMarkup(<MobileBar userName="Ana Pérez" bell={<NotificationsBell placement="bar" />} />);
    const header = html.match(/<header[^>]*data-mobile-bar[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header.match(/aria-label="Notificaciones"/g)).toHaveLength(1);
  });

  it("[ZF3] el AppShell pasa una campana a la barra móvil y otra al chrome de escritorio; el dashboard ninguna", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync("components/layout/app-shell.tsx", "utf8");
    expect(shell).toMatch(/<MobileBar[\s\S]*?bell=\{<NotificationsBell placement="bar" \/>\}/);
    const dash = readFileSync("components/screens/dashboard-screen.tsx", "utf8");
    expect(dash).not.toMatch(/<NotificationsBell/);
    // La campana arranca el feed solo detrás del gate.
    const bell = readFileSync("components/dashboard/notifications-bell.tsx", "utf8");
    expect(bell).toMatch(/if \(!shown\) return;\s*const feed = createBellFeed/);
  });
});

describe("[ZF3] M9/B19 teclado y targets de la campana", () => {
  it("[ZF3] B19: «Marcar todas como leídas» y «Ver anteriores» miden 44 px de alto", () => {
    const html = panel({ rows: rows(20), unread: 20, status: "ready", limit: BELL_PAGE });
    for (const label of ["Marcar todas como leídas", "Ver anteriores"]) {
      const btn = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
      expect(btn, label).toMatch(/min-height:44px/);
      expect(btn, label).toMatch(/padding:8px 10px/);
    }
  });

  it("[ZF3] M9: el panel recibe el foco al abrir y Escape lo devuelve a la campana", async () => {
    const { readFileSync } = await import("node:fs");
    const bell = readFileSync("components/dashboard/notifications-bell.tsx", "utf8");
    expect(bell).toMatch(/\(first \?\? pop\)\.focus\(\)/);
    expect(bell).toMatch(/e\.key !== "Escape"\) return;\s*setOpen\(false\);[\s\S]{0,160}btnRef\.current\?\.focus\(\)/);
    expect(bell).toMatch(/role="dialog"\s*aria-label="Notificaciones"\s*tabIndex=\{-1\}/);
  });
});
