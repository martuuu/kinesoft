"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClassName } from "@/components/ui/button";

/**
 * [VX2-a] Botón principal de los forms de auth con estado «enviando» («Ingresando…», «Creando tu cuenta…»).
 *
 * Dos usos:
 * - Form nativo (login: `action="/api/auth/sign-in"`): sin `pending`, escucha el `submit` de su form. Así el form
 *   sigue andando sin JavaScript y, con JS, el segundo clic no manda otro POST (el rate limit de login es por IP+email).
 * - Form con server action (signup, forgot, reset): la pantalla le pasa `pending` de su `useTransition`.
 *
 * `aria-disabled` y no `disabled` mientras envía: un botón `disabled` pierde el foco en medio del envío y el lector
 * de pantalla no anuncia el cambio de texto. Volver atrás (bfcache) lo devuelve a su estado normal.
 */
export function AuthSubmit({
  label,
  busyLabel,
  pending,
}: {
  label: string;
  busyLabel: string;
  pending?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [submitted, setSubmitted] = useState(false);
  const controlled = pending !== undefined;

  useEffect(() => {
    if (controlled) return;
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: Event) => {
      if (!e.defaultPrevented) setSubmitted(true);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSubmitted(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, [controlled]);

  const busy = controlled ? pending : submitted;
  return (
    <button
      ref={ref}
      type="submit"
      className={buttonClassName({ variant: "primary", size: "lg", block: true })}
      aria-disabled={busy || undefined}
      onClick={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      {busy ? (
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          <span className="k-spinner" aria-hidden="true" />
          {busyLabel}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
