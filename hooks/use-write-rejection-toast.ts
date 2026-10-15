"use client";

/**
 * [BO-Z B10] Red común para escrituras rechazadas que ninguna pantalla atrapa. La extrajimos de la banda de soporte
 * (BO3-F) para usarla también con el consultorio en solo lectura REAL (`enforce` + prueba vencida / impago / baja):
 * muchas pantallas no atrapan el throw de la action (p. ej. `createBooking`) y en producción Next lo redacta a un
 * Error genérico con `digest`, así que el usuario tocaba «Guardar» y no pasaba nada.
 *
 * Mientras `enabled`, un `unhandledrejection` que `matches` se muestra como Toast «No se guardó» con `description`
 * (función: se evalúa en el momento, p. ej. para mirar la ruta). Es una red, no el arreglo: cada action debería
 * devolver `{ ok:false, error }`.
 */
import { useEffect } from "react";
import { useToast } from "@/components/ui/toast";

export type WriteRejectionToastOptions = {
  enabled: boolean;
  matches: (reason: unknown) => boolean;
  description: (reason: unknown) => string;
  title?: string;
};

export function useWriteRejectionToast({ enabled, matches, description, title = "No se guardó" }: WriteRejectionToastOptions) {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const onRejection = (e: PromiseRejectionEvent) => {
      if (!matches(e.reason)) return;
      e.preventDefault();
      toast.error(title, { description: description(e.reason) });
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
    // `matches`/`description` suelen ser funciones de módulo; si llegan inline, re-suscribir es barato.
  }, [enabled, matches, description, title, toast]);
}

/**
 * ¿El rechazo es una escritura frenada por modo lectura? En dev llega el `ReadOnlyModeError` con su nombre; en
 * producción Next lo reemplaza por un Error genérico con `digest` (el mensaje real no sale del server). Cualquier otra
 * cosa (un fetch del cliente, un bug de UI sin digest) no se toca.
 */
export function isWriteRejection(reason: unknown, knownMessages: readonly string[] = []): boolean {
  if (!reason || typeof reason !== "object") return false;
  const r = reason as { name?: unknown; message?: unknown; digest?: unknown };
  if (r.name === "ReadOnlyModeError") return true;
  if (typeof r.message === "string" && knownMessages.includes(r.message)) return true;
  return typeof r.digest === "string" && r.digest.length > 0;
}
