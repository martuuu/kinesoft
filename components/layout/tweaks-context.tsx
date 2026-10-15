"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { updateAgendaViewPrefs, updateUserPreferences } from "@/lib/preferences";
import {
  DEFAULT_AGENDA_VIEW_PREFS,
  DEFAULT_PREFERENCES,
  RECEPTION_LAYOUTS,
  type AgendaPrefs,
  type ReceptionLayout,
} from "@/lib/preferences-constants";

export type Palette = "sky" | "mint" | "coral" | "violet";
export type DashChrome = "sidebar" | "topbar";

/**
 * Lo que guarda «Apariencia» (ex «Tweaks», §20.18: se mantiene y se arreglan sus opciones rotas).
 *
 * PL-F1c: se quitaron `agendaView` («Timeline / Semana / Lista») y `patientCard` («Card de paciente»): eran del
 * prototipo y nadie los leía (la agenda decide la vista por URL y `mode-toggle.tsx`; la ficha no tiene variantes).
 * Si vuelven, que sea con un lector real y su test (`tests/unit/render/pl-f1c-tweaks.test.tsx`).
 */
export type TweaksState = {
  palette: Palette;
  dashChrome: DashChrome;
  sidebarCollapsed: boolean;
  /** Panel cerrado. No se persiste: cada carga arranca cerrado (el panel abierto tapaba contenido). */
  minimised: boolean;
};

const DEFAULTS: TweaksState = {
  palette: "sky",
  dashChrome: "sidebar",
  sidebarCollapsed: true,
  minimised: true,
};

const STORAGE_KEY = "kinesoft:tweaks";
const PALETTES: readonly Palette[] = ["sky", "mint", "coral", "violet"];

/**
 * Estado inicial desde lo guardado en el navegador. Puro (exportado para el test). Ignora claves viejas
 * (`agendaView`, `patientCard`), valores fuera de rango y `minimised` (siempre arranca cerrado). La paleta del
 * server (`serverPalette`), si viene, gana sobre la del navegador: es la que sigue al usuario entre dispositivos y
 * la misma que guarda Perfil → Ajustes.
 */
export function hydrateTweaks(raw: string | null, serverPalette?: Palette | null): TweaksState {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    /* JSON roto: defaults */
  }
  const palette =
    serverPalette && PALETTES.includes(serverPalette)
      ? serverPalette
      : PALETTES.includes(stored.palette as Palette)
        ? (stored.palette as Palette)
        : DEFAULTS.palette;
  return {
    palette,
    dashChrome: stored.dashChrome === "topbar" ? "topbar" : "sidebar",
    sidebarCollapsed: typeof stored.sidebarCollapsed === "boolean" ? stored.sidebarCollapsed : DEFAULTS.sidebarCollapsed,
    minimised: true,
  };
}

const DEFAULT_AGENDA: AgendaPrefs = {
  agendaShowWeekHeader: DEFAULT_PREFERENCES.agendaShowWeekHeader,
  agendaShowSaturday: DEFAULT_PREFERENCES.agendaShowSaturday,
  agendaShowSunday: DEFAULT_PREFERENCES.agendaShowSunday,
};

/**
 * RX-0 (C-RX2): guarda la cara de `/sala` elegida en Apariencia. Optimista: `apply(next)` ya se hizo antes de
 * llamar; acá se espera al server y, si falla (solo lectura, red caída, patch rechazado), se vuelve a `prev`, pero
 * SOLO si este pedido sigue siendo el último (`isLatest`): con dos clics rápidos (Lista → Flujo) la respuesta tardía
 * de un pedido viejo no puede pisar lo elegido después. Puro y exportado para el test (sin DOM no hay effects).
 * Devuelve si quedó guardado.
 */
export async function persistReceptionLayout(
  next: ReceptionLayout,
  prev: ReceptionLayout,
  deps: {
    save: (v: ReceptionLayout) => Promise<{ ok: boolean }>;
    apply: (v: ReceptionLayout) => void;
    isLatest: () => boolean;
  }
): Promise<boolean> {
  let ok = false;
  try {
    ok = (await deps.save(next)).ok;
  } catch {
    ok = false;
  }
  if (!ok && deps.isLatest()) deps.apply(prev);
  return ok;
}

type Ctx = {
  t: TweaksState;
  set: <K extends keyof TweaksState>(key: K, value: TweaksState[K]) => void;
  /**
   * Per-user agenda preferences. Unlike `t` (localStorage-only chrome
   * tweaks), these are server-backed in `UserPreferences` — seeded from
   * the server at mount and persisted on change so they follow the user
   * across devices and stay in sync with /configuracion.
   */
  agenda: AgendaPrefs;
  setAgenda: <K extends keyof AgendaPrefs>(key: K, value: AgendaPrefs[K]) => void;
  /**
   * RX: cara de `/sala` («Tablero», «Lista y panel», «Flujo»). Server-backed en `agendaPrefs.receptionLayout`
   * (no en localStorage: `/sala` es SSR y la PC de recepción es compartida, brief RX §3). Se llama
   * `receptionLayout` y nunca «view»: la agenda ya tiene `view` por URL y el contexto tenía `agendaView`.
   */
  receptionLayout: ReceptionLayout;
  /** Optimista; si `updateAgendaViewPrefs` falla vuelve al valor anterior (`persistReceptionLayout`). */
  setReceptionLayout: (v: ReceptionLayout) => void;
};

const TweaksContext = createContext<Ctx | null>(null);

export function TweaksProvider({
  children,
  initialAgenda,
  initialPalette = null,
  initialReceptionLayout = DEFAULT_AGENDA_VIEW_PREFS.receptionLayout,
}: {
  children: ReactNode;
  initialAgenda?: AgendaPrefs;
  /** PL-F1c: `UserPreferences.palette` (lo lee el layout `(app)`). null = sin server (tests, demo). */
  initialPalette?: Palette | null;
  /** RX-0: `agendaPrefs.receptionLayout` ya sanitizado (layout `(app)`). Sin server: "board". */
  initialReceptionLayout?: ReceptionLayout;
}) {
  const [t, setT] = useState<TweaksState>(() => ({
    ...DEFAULTS,
    palette: initialPalette && PALETTES.includes(initialPalette) ? initialPalette : DEFAULTS.palette,
  }));
  const [agenda, setAgendaState] = useState<AgendaPrefs>(initialAgenda ?? DEFAULT_AGENDA);
  const [receptionLayout, setReceptionLayoutState] = useState<ReceptionLayout>(() =>
    RECEPTION_LAYOUTS.includes(initialReceptionLayout) ? initialReceptionLayout : DEFAULT_AGENDA_VIEW_PREFS.receptionLayout
  );
  // Copia sincrónica del valor vigente (el «previo» del rollback no puede salir de un closure viejo) y número del
  // último pedido (ver `persistReceptionLayout`).
  const receptionLayoutRef = useRef(receptionLayout);
  const receptionReq = useRef(0);

  // Hydrate from localStorage once (la paleta del server gana: ver `hydrateTweaks`).
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage bloqueado: defaults */
    }
    setT(hydrateTweaks(raw, initialPalette));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist + apply palette to <html>.
  useEffect(() => {
    try {
      // `minimised` no se guarda: cada carga arranca con el panel cerrado.
      const persisted = { palette: t.palette, dashChrome: t.dashChrome, sidebarCollapsed: t.sidebarCollapsed };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-palette", t.palette);
  }, [t]);

  const set: Ctx["set"] = useCallback((key, value) => {
    setT((prev) => ({ ...prev, [key]: value }));
    // PL-F1c (M1 del barrido): la paleta solo iba a localStorage y el dashboard la pisaba con la del server al
    // cargar: elegías «mint» acá y al pasar por Inicio volvía la anterior. Ahora se guarda en el server, como
    // `setAgenda` (fire-and-forget: si falla, p. ej. en solo lectura, solo no sobrevive a la recarga).
    if (key === "palette") void updateUserPreferences({ palette: value as Palette });
  }, []);

  const setAgenda: Ctx["setAgenda"] = useCallback((key, value) => {
    // Optimistic local update keeps the UI instant…
    setAgendaState((prev) => ({ ...prev, [key]: value }));
    // …then persist server-side (fire-and-forget; a failure just means the
    // toggle won't survive a reload, never blocks the user).
    void updateUserPreferences({ [key]: value } as Partial<AgendaPrefs>);
  }, []);

  const setReceptionLayout: Ctx["setReceptionLayout"] = useCallback((v) => {
    const prev = receptionLayoutRef.current;
    if (v === prev) return;
    const apply = (x: ReceptionLayout) => {
      receptionLayoutRef.current = x;
      setReceptionLayoutState(x);
    };
    apply(v);
    const req = ++receptionReq.current;
    void persistReceptionLayout(v, prev, {
      save: (x) => updateAgendaViewPrefs({ receptionLayout: x }),
      apply,
      isLatest: () => receptionReq.current === req,
    });
  }, []);

  const value = useMemo(
    () => ({ t, set, agenda, setAgenda, receptionLayout, setReceptionLayout }),
    [t, set, agenda, setAgenda, receptionLayout, setReceptionLayout]
  );

  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export function useTweaks() {
  const ctx = useContext(TweaksContext);
  if (!ctx) throw new Error("useTweaks must be used within TweaksProvider");
  return ctx;
}

/**
 * RX-0 (C-RX2): como `useTweaks`, pero null fuera del provider en vez de tirar. Lo usa `SalaClient` para elegir la
 * cara (`useTweaksOptional()?.receptionLayout ?? initialLayout`): sus render tests lo montan sin `TweaksProvider`.
 */
export function useTweaksOptional(): Ctx | null {
  return useContext(TweaksContext);
}
