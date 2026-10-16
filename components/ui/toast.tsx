"use client";

/**
 * Toast / snackbar system.
 *
 * Small snackbars docked top-right, newest on top, stacking downwards.
 * When a new toast enters above an existing one, the existing toasts
 * slide down to make room — that's the `layout` prop on each item doing
 * the work (framer-motion animates the positional shift automatically).
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success("Turno creado");
 *   toast.error("No pudimos guardar", { description: "Reintentá en un momento" });
 *
 * Mounted once near the root via `<ToastProvider>` (see ui-providers).
 *
 * [SV03u] Avisos de la sala de espera (C-SV8, aditivo: la API de antes sigue
 * igual):
 *   toast.show("arrival", "Llegó María G. · 10:30", {
 *     id: `arr:${bookingId}:${arrivedAt}`,       // dedupe: reemplaza, no apila
 *     leading: <Initials name="María G." />,     // en lugar del ícono del tono
 *     action: { label: "Ver sala", onClick: () => router.push("/sala") },
 *   });
 * - `id` repetido → se reemplaza el contenido EN SU LUGAR y se reinicia el
 *   tiempo (el mismo evento llega por el lote y por el resync: no son dos).
 * - El temporizador se pausa en hover y focus-within y reanuda con lo que
 *   faltaba (la Secretaria lo está leyendo, o tabuló hasta «Ver sala»).
 * - `onDismiss` se llama una vez cuando el toast se va, por la razón que sea.
 * La lógica de pila y reloj es pura y exportada (showToast, dismissToast,
 * toastClock*): el provider solo la aplica. Test:
 * tests/unit/render/toast-card.test.tsx.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { DUR, EASE_OUT, toastVariants } from "@/lib/motion";
import { IconCheck, IconUsers, IconX } from "@/components/ui/icons";

export type ToastTone = "success" | "error" | "warning" | "info" | "arrival";

export type ToastOptions = {
  description?: string;
  /** ms before auto-dismiss. 0 keeps it until dismissed manually. */
  duration?: number;
  /** [SV03u] Clave de dedupe: si ya hay un toast con este id, se reemplaza. */
  id?: string;
  /** [SV03u] Botón dentro del toast; al click ejecuta y cierra. */
  action?: { label: string; onClick: () => void };
  /** [SV03u] Avatar/iniciales a la izquierda, en lugar del ícono del tono. */
  leading?: ReactNode;
  /** [SV03u] Se llama una vez cuando el toast se va (cierre, tiempo, acción o pila llena). */
  onDismiss?: () => void;
};

export type ToastItem = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  duration: number;
  action?: { label: string; onClick: () => void };
  leading?: ReactNode;
  onDismiss?: () => void;
  /** Sube cada vez que un `id` repetido reemplaza el contenido: reinicia la
   *  barra de progreso y anima el texto nuevo sin remontar el card. */
  version: number;
};

type ToastApi = {
  success: (title: string, opts?: ToastOptions) => string;
  error: (title: string, opts?: ToastOptions) => string;
  warning: (title: string, opts?: ToastOptions) => string;
  info: (title: string, opts?: ToastOptions) => string;
  show: (tone: ToastTone, title: string, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4500;
/** [SV03u] Un aviso de llegada se lee con el paciente adelante: 12 s (§18.5). */
const ARRIVAL_DURATION = 12000;
export const TOAST_STACK_MAX = 5;

export function toastDefaultDuration(tone: ToastTone): number {
  return tone === "arrival" ? ARRIVAL_DURATION : DEFAULT_DURATION;
}

// ── Pila (pura) ───────────────────────────────────────────────────────

/**
 * Alta en la pila. Un `id` que ya está reemplaza al anterior EN SU LUGAR
 * (sin saltar arriba: el card no se mueve bajo el mouse de quien lo lee) y
 * sube `version`. Uno nuevo entra arriba; la pila se corta en
 * `TOAST_STACK_MAX` y los que se caen vuelven en `dropped` para limpiar su
 * timer y avisar su `onDismiss`.
 */
export function showToast(
  list: ReadonlyArray<ToastItem>,
  item: ToastItem,
  max = TOAST_STACK_MAX,
): { toasts: ToastItem[]; dropped: ToastItem[]; replaced: boolean } {
  const at = list.findIndex((t) => t.id === item.id);
  if (at >= 0) {
    const toasts = list.slice();
    toasts[at] = { ...item, version: list[at].version + 1 };
    return { toasts, dropped: [], replaced: true };
  }
  const next = [{ ...item, version: 0 }, ...list];
  return { toasts: next.slice(0, max), dropped: next.slice(max), replaced: false };
}

export function dismissToast(
  list: ReadonlyArray<ToastItem>,
  id: string,
): { toasts: ReadonlyArray<ToastItem>; removed: ToastItem | null } {
  const removed = list.find((t) => t.id === id) ?? null;
  if (!removed) return { toasts: list, removed: null };
  return { toasts: list.filter((t) => t.id !== id), removed };
}

// ── Reloj (puro) ──────────────────────────────────────────────────────

/**
 * Tiempo de vida de un toast. `startedAt` = desde cuándo corre (null =
 * pausado); `remaining` = lo que faltaba al último arranque. Hover y foco se
 * llevan por separado: con el mouse encima y el foco en «Ver sala», sacar el
 * mouse no lo tiene que reanudar.
 */
export type ToastClock = {
  remaining: number;
  startedAt: number | null;
  hover: boolean;
  focus: boolean;
};

/** Arranca (o reinicia por `id` repetido) con la duración completa; si el
 *  toast estaba retenido, queda pausado. */
export function toastClockRestart(prev: ToastClock | null, duration: number, now: number): ToastClock {
  const hover = prev?.hover ?? false;
  const focus = prev?.focus ?? false;
  return { remaining: duration, startedAt: hover || focus ? null : now, hover, focus };
}

export function toastClockHold(c: ToastClock, kind: "hover" | "focus", on: boolean, now: number): ToastClock {
  const next = { ...c, [kind]: on };
  const held = next.hover || next.focus;
  if (held && c.startedAt !== null) {
    return { ...next, remaining: Math.max(0, c.remaining - (now - c.startedAt)), startedAt: null };
  }
  if (!held && c.startedAt === null) return { ...next, startedAt: now };
  return next;
}

// ── Provider ──────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastItem>>([]);
  // La pila vive también en un ref: show/dismiss corren en handlers y
  // necesitan el valor actual para saber qué se reemplaza o se cae, y los
  // efectos (timers, onDismiss) no pueden ir dentro de un updater de
  // setState (StrictMode lo corre dos veces).
  const listRef = useRef<ReadonlyArray<ToastItem>>([]);
  const clocks = useRef<Map<string, ToastClock>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const commit = useCallback((next: ReadonlyArray<ToastItem>) => {
    listRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = useCallback((id: string) => {
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const forget = useCallback(
    (t: ToastItem) => {
      clearTimer(t.id);
      clocks.current.delete(t.id);
      t.onDismiss?.();
    },
    [clearTimer],
  );

  const dismiss = useCallback(
    (id: string) => {
      const r = dismissToast(listRef.current, id);
      if (!r.removed) return;
      commit(r.toasts);
      forget(r.removed);
    },
    [commit, forget],
  );

  /** Programa el cierre según el reloj: si está pausado, no hay timer. */
  const schedule = useCallback(
    (id: string) => {
      clearTimer(id);
      const c = clocks.current.get(id);
      if (!c || c.startedAt === null) return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), c.remaining),
      );
    },
    [clearTimer, dismiss],
  );

  const show = useCallback(
    (tone: ToastTone, title: string, opts?: ToastOptions) => {
      const id = opts?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const duration = opts?.duration ?? toastDefaultDuration(tone);
      const item: ToastItem = {
        id,
        tone,
        title,
        description: opts?.description,
        duration,
        action: opts?.action,
        leading: opts?.leading,
        onDismiss: opts?.onDismiss,
        version: 0,
      };
      // Newest on top → prepend. Cap the stack so a burst can't fill the
      // viewport (oldest at the bottom falls off).
      const r = showToast(listRef.current, item);
      commit(r.toasts);
      r.dropped.forEach(forget);
      if (duration > 0) {
        clocks.current.set(id, toastClockRestart(clocks.current.get(id) ?? null, duration, Date.now()));
        schedule(id);
      } else {
        clearTimer(id);
        clocks.current.delete(id);
      }
      return id;
    },
    [commit, forget, schedule, clearTimer],
  );

  const hold = useCallback(
    (id: string, kind: "hover" | "focus", on: boolean) => {
      const c = clocks.current.get(id);
      if (!c) return;
      clocks.current.set(id, toastClockHold(c, kind, on, Date.now()));
      schedule(id);
    },
    [schedule],
  );

  // Clear any pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, opts) => show("success", title, opts),
      error: (title, opts) => show("error", title, opts),
      warning: (title, opts) => show("warning", title, opts),
      info: (title, opts) => show("info", title, opts),
      dismiss,
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} onHold={hold} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

const TONE: Record<
  ToastTone,
  { bar: string; iconBg: string; iconColor: string; glyph: React.ReactNode }
> = {
  success: {
    bar: "#36B37E",
    iconBg: "rgba(54,179,126,0.16)",
    iconColor: "#1F7A52",
    glyph: <IconCheck size={13} stroke={3} />,
  },
  error: {
    bar: "#E14B4B",
    iconBg: "rgba(228,70,70,0.16)",
    iconColor: "var(--danger-fg)",
    glyph: <span style={{ fontWeight: 800, fontSize: 13 }}>!</span>,
  },
  warning: {
    bar: "#D98200",
    iconBg: "rgba(255,176,32,0.18)",
    iconColor: "#9A5B00",
    glyph: <span style={{ fontWeight: 800, fontSize: 13 }}>!</span>,
  },
  info: {
    bar: "var(--sky-700)",
    iconBg: "rgba(31,79,190,0.14)",
    iconColor: "var(--sky-700)",
    glyph: <span style={{ fontWeight: 800, fontSize: 12 }}>i</span>,
  },
  // [SV03u] Llegada / llamado: el lime de "En sala" (--rc-insala) es el
  // color de "el paciente está acá" en todo el producto. La barra va en
  // --lime-500 (el 300 se pierde sobre el vidrio) y el ícono, navy sobre lime.
  arrival: {
    bar: "var(--lime-500)",
    iconBg: "var(--lime-300)",
    iconColor: "var(--navy-900)",
    glyph: <IconUsers size={12} stroke={2.4} />,
  },
};

function Toaster({
  toasts,
  onDismiss,
  onHold,
}: {
  toasts: ReadonlyArray<ToastItem>;
  onDismiss: (id: string) => void;
  onHold: (id: string, kind: "hover" | "focus", on: boolean) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-relevant="additions"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: "var(--z-toast)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: "min(360px, calc(100vw - 32px))",
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          // key = id: un reemplazo por id NO remonta el card (sin salida y
          // entrada); `layout` acomoda la altura si el texto nuevo es más largo.
          <m.div
            key={t.id}
            layout
            variants={toastVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ pointerEvents: "auto" }}
          >
            <ToastCard
              item={t}
              onDismiss={() => onDismiss(t.id)}
              onAction={() => {
                // Primero la acción (navegar a /sala), después cerrar: si la
                // acción tira, el toast queda y el usuario puede reintentar.
                t.action?.onClick();
                onDismiss(t.id);
              }}
              onHold={(kind, on) => onHold(t.id, kind, on)}
            />
          </m.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}

/**
 * Card presentacional (sin estado de tiempo): el provider le pasa los
 * handlers. Exportado para los render tests (C-SV8).
 */
export function ToastCard({
  item,
  onDismiss,
  onAction,
  onHold,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onAction?: () => void;
  onHold?: (kind: "hover" | "focus", on: boolean) => void;
}) {
  const tone = TONE[item.tone];
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    // focus-within: moverse entre «Ver sala» y la X no reanuda.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    onHold?.("focus", false);
  };
  return (
    <div
      role="status"
      className="k-glass-strong k-toast"
      data-tone={item.tone}
      onMouseEnter={() => onHold?.("hover", true)}
      onMouseLeave={() => onHold?.("hover", false)}
      onFocus={() => onHold?.("focus", true)}
      onBlur={onBlur}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: 11,
        padding: "12px 12px 12px 14px",
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(15,30,51,0.16)",
        overflow: "hidden",
      }}
    >
      {/* tone accent bar */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: tone.bar,
        }}
      />
      {item.leading ? (
        <span
          data-toast-leading
          style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", marginTop: 1 }}
        >
          {item.leading}
        </span>
      ) : (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: tone.iconBg,
            color: tone.iconColor,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginTop: 1,
          }}
        >
          {tone.glyph}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Con un id repetido cambia `version` y SOLO el texto se remonta con
            un fundido corto: el texto nuevo "aparece" en el mismo lugar. En la
            primera aparición no anima (ya entra el card). Los botones quedan
            FUERA de este bloque keyed (FX2b): si la Secretaria tabuló hasta «Ver
            sala» y llega el mismo aviso por el resync, remontar el botón le
            sacaba el foco al <body>. */}
        <m.div
          key={item.version}
          data-toast-text
          initial={item.version > 0 ? { opacity: 0.25, y: 3 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)", lineHeight: 1.3 }}>
            {item.title}
          </div>
          {item.description && (
            <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.4 }}>
              {item.description}
            </div>
          )}
        </m.div>
        {item.action && (
          // Área de toque ≥ 32 px sin cambiar el look: el <button> es un marco
          // transparente con padding (y margen negativo que lo compensa) y la
          // píldora visible es el span de adentro, igual que antes.
          <button
            type="button"
            data-toast-action
            onClick={onAction}
            aria-label={`${item.action.label}: ${item.title}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 32,
              margin: "2px -4px -6px",
              padding: "6px 4px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              borderRadius: 999,
            }}
          >
            <span
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
                lineHeight: 1.3,
                background: item.tone === "arrival" ? "var(--lime-300)" : "rgba(31,79,190,0.1)",
                color: item.tone === "arrival" ? "var(--navy-900)" : "var(--sky-700)",
              }}
            >
              {item.action.label}
            </span>
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cerrar notificación"
        style={{
          flexShrink: 0,
          background: "transparent",
          border: "none",
          color: "var(--navy-300)",
          cursor: "pointer",
          // 32×32 de área con la X de 13 px en el mismo lugar que antes (17 px
          // con padding 2): 7,5 px de margen negativo por lado lo compensan, y
          // entra en el padding de 12 px del card.
          width: 32,
          height: 32,
          padding: 0,
          margin: "-6.5px -7.5px -7.5px -7.5px",
          borderRadius: 8,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconX size={13} />
      </button>
      {item.duration > 0 && (
        // [SV03u] Barra CSS (no framer) para poder pausarla en hover y
        // focus-within con animation-play-state (globals.css), en sincronía
        // con el reloj del provider. key = version: un reemplazo por id la
        // remonta y vuelve a arrancar llena.
        <span
          key={item.version}
          aria-hidden
          className="k-toast-progress"
          style={{ background: tone.bar, animationDuration: `${item.duration}ms` }}
        />
      )}
    </div>
  );
}
