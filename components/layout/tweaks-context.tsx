"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { updateUserPreferences } from "@/lib/preferences";
import { DEFAULT_PREFERENCES, type AgendaPrefs } from "@/lib/preferences-constants";

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
};

const TweaksContext = createContext<Ctx | null>(null);

export function TweaksProvider({
  children,
  initialAgenda,
  initialPalette = null,
}: {
  children: ReactNode;
  initialAgenda?: AgendaPrefs;
  /** PL-F1c: `UserPreferences.palette` (lo lee el layout `(app)`). null = sin server (tests, demo). */
  initialPalette?: Palette | null;
}) {
  const [t, setT] = useState<TweaksState>(() => ({
    ...DEFAULTS,
    palette: initialPalette && PALETTES.includes(initialPalette) ? initialPalette : DEFAULTS.palette,
  }));
  const [agenda, setAgendaState] = useState<AgendaPrefs>(initialAgenda ?? DEFAULT_AGENDA);

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

  const value = useMemo(() => ({ t, set, agenda, setAgenda }), [t, set, agenda, setAgenda]);

  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export function useTweaks() {
  const ctx = useContext(TweaksContext);
  if (!ctx) throw new Error("useTweaks must be used within TweaksProvider");
  return ctx;
}
