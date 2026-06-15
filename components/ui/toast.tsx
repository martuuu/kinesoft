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
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toastVariants } from "@/lib/motion";
import { IconCheck, IconX } from "@/components/ui/icons";

type ToastTone = "success" | "error" | "warning" | "info";

type ToastOptions = {
  description?: string;
  /** ms before auto-dismiss. 0 keeps it until dismissed manually. */
  duration?: number;
};

type ToastItem = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  duration: number;
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

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (tone: ToastTone, title: string, opts?: ToastOptions) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const duration = opts?.duration ?? DEFAULT_DURATION;
      const item: ToastItem = { id, tone, title, description: opts?.description, duration };
      // Newest on top → prepend. Cap the stack so a burst can't fill the
      // viewport (oldest at the bottom falls off).
      setToasts((prev) => [item, ...prev].slice(0, 5));
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }
      return id;
    },
    [dismiss]
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
      <Toaster toasts={toasts} onDismiss={dismiss} />
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
    iconColor: "#9F1F1F",
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
};

function Toaster({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
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
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: "min(360px, calc(100vw - 32px))",
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            variants={toastVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ pointerEvents: "auto" }}
          >
            <ToastCard item={t} onDismiss={() => onDismiss(t.id)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = TONE[item.tone];
  return (
    <div
      role="status"
      className="k-glass-strong"
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)", lineHeight: 1.3 }}>
          {item.title}
        </div>
        {item.description && (
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.4 }}>
            {item.description}
          </div>
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
          padding: 2,
          borderRadius: 6,
          display: "inline-flex",
          marginTop: 1,
        }}
      >
        <IconX size={13} />
      </button>
      {item.duration > 0 && (
        <motion.span
          aria-hidden
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: item.duration / 1000, ease: "linear" }}
          style={{
            position: "absolute",
            left: 4,
            right: 0,
            bottom: 0,
            height: 2,
            background: tone.bar,
            opacity: 0.4,
            transformOrigin: "left",
          }}
        />
      )}
    </div>
  );
}
