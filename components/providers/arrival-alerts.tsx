"use client";

/**
 * Avisos de la sala de espera (SV11b, plan §18.5 «Avisos», SV-D4 enmendada,
 * SV-D9, SV-D16). Lo monta `AppShell` DENTRO del `RealtimeProvider`, sobre todo
 * el workspace: el profesional se entera de que llegó su paciente esté en la
 * pantalla que esté (dashboard, historia clínica…), no solo en la agenda.
 *
 * Qué hace:
 * - Toast `arrival` «Llegó María G. · 10:30» al profesional del turno, y «Pase
 *   María G. · Consultorio 2 · Dra. Pérez» a quien opera la agenda de todos y no
 *   es ese profesional; acción «Ver sala» → `/sala`.
 * - Chime opcional (`lib/arrival-chime`) y contador en el título de la pestaña
 *   (`lib/tab-title`).
 * - Contexto `useAlertPrefs()`: las dos preferencias (`agendaPrefs.arrivalAlert`
 *   / `.callAlert`) con escritura optimista, compartidas por la Card de
 *   Configuración → General y el menú «Vista» de la agenda.
 *
 * Cómo (por qué así):
 * - Por DIFF del refetch, nunca por payload: el mensaje realtime no lleva PHI.
 *   Se siembra con los turnos de hoy al montar y cada lote relevante re-pide hoy
 *   y compara (`lib/arrival-alert-state`, puro e idempotente por
 *   `bookingId+arrivedAt` / `+calledAt`).
 * - Con las dos preferencias efectivas en `off`, o sin canal realtime (`live`
 *   false), no se crea el motor: ni fetch, ni listeners, ni AudioContext. Las
 *   preferencias igual se pueden editar en Configuración (FX2b, M4).
 * - Sonido (SV-D16): tras un resync (vuelta de la pestaña, reconexión) y en
 *   modo `polling` (canal caído: todo aviso sale de un resync `"poll"` cada
 *   60 s) los avisos salen SIN sonido; ver `effectiveMode`.
 * - En `/sala` no se muestra el toast de LLAMADO: la banda «Pase María G. ·
 *   Consultorio 2» de la sala ya lo anuncia (dos avisos del mismo llamado en la
 *   misma pantalla, uno arriba y otro en la esquina, es ruido). Título de
 *   pestaña y sonido siguen; la llegada se muestra igual (FX2b, M2).
 * - Toda la lógica que no es cableado de React vive en
 *   `createArrivalAlertsEngine` (`arrival-alerts-engine.tsx`) con deps
 *   inyectables: los render tests corren sin jsdom (no hay effects) y el motor
 *   se testea directo con fakes.
 * - Bundle (FX3, §18.10 punto 7): este archivo va en el first-load de TODAS las
 *   rutas del workspace. Acá queda solo el contexto de preferencias; el motor
 *   entra por `import()` dinámico cuando `alertsShouldRun`, y los controles
 *   (`components/realtime/alert-prefs-controls`) los importan solo Configuración
 *   y la agenda. Con el canal apagado (deploy inicial de prod) no se descarga
 *   nada de avisos. `alertsShouldRun` no usa `effectivePrefs` por lo mismo: un
 *   test ata las dos reglas.
 * - La pestaña que hizo la acción NO se auto-avisa: quien marca «Llegó» o
 *   «Llamar» llama `noteLocalReception(bookingId, result)` con el resultado de
 *   `markReceptionAction`, que suma las claves al `seen` antes de que llegue el
 *   eco del canal (la respuesta de la action llega antes que el lote coalescido
 *   de 250 ms + refetch). Sin esa llamada, el único auto-aviso posible es el de
 *   la Secretaria que llama al paciente de otro profesional (handoff SV10a/SV10b).
 */
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
import { usePathname, useRouter } from "next/navigation";
import { useRealtime } from "@/components/providers/realtime-provider";
import { useToast } from "@/components/ui/toast";
// Solo tipos (se borran al compilar): el motor, `lib/arrival-alert-state`, el
// chime y el título de la pestaña entran por `import()` (ver `ArrivalAlerts`).
import type { AlertPrefs, AlertViewer } from "@/lib/arrival-alert-state";
import type { AlertMode } from "@/lib/preferences-constants";

// La pestaña tiene a lo sumo un motor vivo; `noteLocalReception` (en
// `lib/arrival-local-notes.ts`, sin dependencias de server) lo alcanza sin que
// Recepción ni `/sala` pasen por el contexto. Se re-exporta por compatibilidad.
export { noteLocalReception } from "@/lib/arrival-local-notes";

// ── Preferencias (contexto) ───────────────────────────────────────────

export type AlertPrefsContextValue = {
  arrivalAlert: AlertMode;
  callAlert: AlertMode;
  setArrivalAlert: (m: AlertMode) => void;
  setCallAlert: (m: AlertMode) => void;
  /** «Cuando llega un paciente mío»: quien atiende (haya o no canal realtime). */
  appliesArrival: boolean;
  /** «Cuando un profesional llama a un paciente»: `agenda.operateAll` (haya o no canal). */
  appliesCall: boolean;
  /**
   * Hay canal realtime en el consultorio (driver ≠ `off`). Aparte de `applies*`
   * (FX2b, M4): Configuración muestra la Card igual, con una nota, para que el
   * usuario deje elegido el aviso antes de que se encienda la sala en vivo; el
   * menú «Vista» de la agenda la oculta sin canal (ahí sería un control muerto).
   */
  live: boolean;
};

const NOOP_PREFS: AlertPrefsContextValue = {
  arrivalAlert: "visual",
  callAlert: "visual",
  setArrivalAlert: () => {},
  setCallAlert: () => {},
  appliesArrival: false,
  appliesCall: false,
  live: false,
};

const AlertPrefsContext = createContext<AlertPrefsContextValue>(NOOP_PREFS);

/** Fuera del provider (tests, superficies sin workspace): nada aplica, los controles no se muestran. */
export function useAlertPrefs(): AlertPrefsContextValue {
  return useContext(AlertPrefsContext);
}

/** ¿La ruta es la Sala de espera? (ahí la banda anuncia el llamado: sin toast). */
export function isSalaPath(pathname: string | null | undefined): boolean {
  return pathname === "/sala" || (pathname ?? "").startsWith("/sala/");
}

/** ¿Hay que crear el motor? Puro: lo usa el provider y el render test. */
export function alertsShouldRun(viewer: AlertViewer, prefs: AlertPrefs, live: boolean): boolean {
  if (!live) return false;
  // = `effectivePrefs` de `lib/arrival-alert-state`, inlineado (ver cabecera).
  const arrival = viewer.practitionerId ? prefs.arrivalAlert : "off";
  const call = viewer.canOperateAll ? prefs.callAlert : "off";
  return arrival !== "off" || call !== "off";
}

export function ArrivalAlerts({
  viewer,
  initialPrefs,
  live = true,
  children,
}: {
  viewer: AlertViewer;
  initialPrefs: AlertPrefs;
  /** false = no hay canal realtime (`driver:"off"`): sin motor; los controles solo en Configuración. */
  live?: boolean;
  children?: ReactNode;
}) {
  const [prefs, setPrefs] = useState<AlertPrefs>(initialPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Un `router.refresh()` o una navegación re-renderiza el layout con lo que
  // quedó en la base: solo se adopta si de verdad cambió (otra pestaña), para
  // no pisar un cambio optimista en vuelo con el mismo valor viejo.
  const lastInitial = useRef(initialPrefs);
  useEffect(() => {
    const li = lastInitial.current;
    if (li.arrivalAlert === initialPrefs.arrivalAlert && li.callAlert === initialPrefs.callAlert) return;
    lastInitial.current = initialPrefs;
    setPrefs({ arrivalAlert: initialPrefs.arrivalAlert, callAlert: initialPrefs.callAlert });
  }, [initialPrefs]);

  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const { subscribe, onResync } = useRealtime();

  const { practitionerId, canOperateAll } = viewer;
  const shouldRun = alertsShouldRun(viewer, prefs, live);

  useEffect(() => {
    if (!shouldRun) return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    import("@/components/providers/arrival-alerts-engine").then(
      ({ startArrivalAlerts }) => {
        if (cancelled) return;
        dispose = startArrivalAlerts({
          viewer: { practitionerId, canOperateAll },
          getPrefs: () => prefsRef.current,
          subscribe,
          onResync: (fn) => onResync(() => fn()),
          show: (title, opts) => toastRef.current.show("arrival", title, opts),
          openSala: () => routerRef.current.push("/sala"),
          suppressCallToast: () => isSalaPath(pathnameRef.current),
        });
      },
      () => {
        // Chunk que no cargó (deploy nuevo, red): sin avisos en esta pestaña; la
        // sala y la agenda siguen andando. No se reintenta en loop.
      },
    );
    return () => {
      cancelled = true;
      dispose?.();
      dispose = null;
    };
  }, [shouldRun, practitionerId, canOperateAll, subscribe, onResync]);

  const persist = useCallback((field: keyof AlertPrefs, mode: AlertMode) => {
    const before = prefsRef.current[field];
    if (before === mode) return;
    setPrefs((p) => ({ ...p, [field]: mode }));
    const revert = (msg?: string) => {
      setPrefs((p) => (p[field] === mode ? { ...p, [field]: before } : p));
      toastRef.current.error("No pudimos guardar el aviso", { description: msg ?? "Reintentá en un momento." });
    };
    import("@/lib/preferences")
      .then(({ updateAgendaViewPrefs }) => updateAgendaViewPrefs({ [field]: mode }))
      .then(
        (r) => {
          if (!r.ok) revert(r.error);
        },
        () => revert(),
      );
  }, []);

  const value = useMemo<AlertPrefsContextValue>(
    () => ({
      arrivalAlert: prefs.arrivalAlert,
      callAlert: prefs.callAlert,
      setArrivalAlert: (m) => persist("arrivalAlert", m),
      setCallAlert: (m) => persist("callAlert", m),
      appliesArrival: !!practitionerId,
      appliesCall: canOperateAll,
      live,
    }),
    [prefs, persist, live, practitionerId, canOperateAll],
  );

  return <AlertPrefsContext.Provider value={value}>{children}</AlertPrefsContext.Provider>;
}
