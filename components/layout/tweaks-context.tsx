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

type Ctx = {
  t: TweaksState;
  set: <K extends keyof TweaksState>(key: K, value: TweaksState[K]) => void;
};

const TweaksContext = createContext<Ctx | null>(null);

export function TweaksProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<TweaksState>(DEFAULTS);

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

  const value = useMemo(() => ({ t, set }), [t, set]);

  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export function useTweaks() {
  const ctx = useContext(TweaksContext);
  if (!ctx) throw new Error("useTweaks must be used within TweaksProvider");
  return ctx;
}
