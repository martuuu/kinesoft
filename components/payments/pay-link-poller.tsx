"use client";

/**
 * [TP-3i] Poller de `/pagar/[token]` al volver de Mercado Pago (`?r=ok|pending`, plan §25.10: 3 s × 60).
 *
 * Por qué `router.refresh()` y no un fetch propio: la página es un server component que lee el link con
 * `getPublicPaymentLink` (sin datos del paciente, rate limit 60/min/IP). Refrescar re-renderiza ESA lectura; así el
 * poller no necesita una API nueva ni traer `PayLinkView` al cliente, y queda en lo mínimo que exige el grupo `public`
 * (≤120 kB, §25.11). 1 consulta cada 3 s = 20/min: entra en el rate limit con margen. Refrescar no escribe nada (el
 * GET nunca escribe, C-TP9): el estado lo mueve el webhook.
 *
 * El componente sobrevive al refresh (misma posición en el árbol), así que el contador sigue; cuando el server
 * devuelve un estado final la página deja de montarlo (`active` = false) y el ciclo se corta solo.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** §25.10: 60 consultas cada 3 s ≈ 3 min, como el resultado del turnero (`booking-result.tsx`). */
export const PAY_LINK_POLL = { intervalMs: 3000, maxAttempts: 60 } as const;

/**
 * Copy del timeout. Vive acá y no en `PAY_LINK_COPY` (`pay-link-view.tsx`) porque este es el único módulo cliente de
 * la página: importar la vista desde acá la mandaría entera al bundle.
 */
export const PAY_LINK_POLL_TIMEOUT = {
  note: "Mercado Pago todavía no nos confirmó el pago.",
  action: "Ver el estado del link",
} as const;

export type PollStep = "idle" | "wait" | "timedOut";

/** Qué hace el poller con `attempts` consultas hechas. Puro: lo fija el render test sin timers. */
export function nextPollStep(active: boolean, attempts: number): PollStep {
  if (!active) return "idle";
  return attempts >= PAY_LINK_POLL.maxAttempts ? "timedOut" : "wait";
}

export function PayLinkPoller({ active, resetHref }: { active: boolean; resetHref: string }) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const step = nextPollStep(active, attempts);

  useEffect(() => {
    if (step !== "wait") return;
    const t = setTimeout(() => {
      router.refresh();
      setAttempts((a) => a + 1);
    }, PAY_LINK_POLL.intervalMs);
    return () => clearTimeout(t);
  }, [step, attempts, router]);

  if (step === "idle") return null;
  // `data-pay-poller` marca que la página está esperando (lo afirma el render test). Al agotarse, se dice qué hacer
  // sin prometer nada: abrir el link sin `?r=` muestra el estado real (y el botón, si el pago no se hizo).
  return (
    <div data-pay-poller={step}>
      {step === "timedOut" && (
        <p style={{ margin: "20px 0 0", fontSize: "var(--fs-sm)", color: "var(--navy-500)" }}>
          {PAY_LINK_POLL_TIMEOUT.note}{" "}
          <a href={resetHref} className="k-link">
            {PAY_LINK_POLL_TIMEOUT.action}
          </a>
        </p>
      )}
    </div>
  );
}
