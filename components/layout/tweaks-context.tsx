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
export type AgendaView = "timeline" | "grilla" | "lista";
export type PatientCard = "rich" | "compact" | "clinical";

export type TweaksState = {
  palette: Palette;
  dashChrome: DashChrome;
  sidebarCollapsed: boolean;
  agendaView: AgendaView;
  patientCard: PatientCard;
  minimised: boolean;
};

const DEFAULTS: TweaksState = {
  palette: "sky",
  dashChrome: "sidebar",
  sidebarCollapsed: true,
  agendaView: "lista",
  patientCard: "clinical",
  minimised: false,
};

const STORAGE_KEY = "kinesoft:tweaks";

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
}: {
  children: ReactNode;
  initialAgenda?: AgendaPrefs;
}) {
  const [t, setT] = useState<TweaksState>(DEFAULTS);
  const [agenda, setAgendaState] = useState<AgendaPrefs>(initialAgenda ?? DEFAULT_AGENDA);

  // Hydrate from localStorage once.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setT({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, []);

  // Persist + apply palette to <html>.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-palette", t.palette);
  }, [t]);

  const set: Ctx["set"] = useCallback((key, value) => {
    setT((prev) => ({ ...prev, [key]: value }));
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
