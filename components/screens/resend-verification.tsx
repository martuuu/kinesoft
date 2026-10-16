"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { resendVerification } from "@/lib/auth";
import type { ActionResult } from "@/lib/validation";
import {
  RESEND_COOLDOWN_S,
  RESEND_VERIFICATION_SENT,
  cooldownSecondsLeft,
  resendButtonLabel,
} from "@/components/screens/auth-feedback";

/**
 * Botón de «reenviar» con cooldown visible (IAM-2d). Lo usan el signup y el onboarding (verificación), el
 * login (verificación desde el aviso de error) y /forgot (link de contraseña).
 *
 * Por qué el cooldown: sin él, el doble clic o la impaciencia quemaban el rate limit por email (3/h) en
 * segundos y el tercer intento ya decía «demasiados pedidos». Con `startCooling` arranca contando: se usa
 * cuando el mail se acaba de mandar (pantalla «Revisá tu email»).
 *
 * `onSend` recibe el contenedor del botón para que el caso del login pueda leer el email del form que lo
 * contiene (`Button` no reenvía `ref`).
 * Si la action falla (email inválido, rate limit) se muestra el error y NO arranca el cooldown.
 *
 * VX2-a: tamaño `md` (44 px, táctil en mobile) y ancho completo con las clases de C-F2, sin estilos inline.
 */
export function ResendButton({
  label,
  sentCopy,
  onSend,
  startCooling = false,
  variant = "ghost",
}: {
  label: string;
  sentCopy: string;
  onSend: (el: HTMLElement | null) => Promise<ActionResult<unknown>>;
  startCooling?: boolean;
  variant?: "primary" | "ghost";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const [until, setUntil] = useState<number | null>(() =>
    startCooling ? Date.now() + RESEND_COOLDOWN_S * 1000 : null
  );
  const [now, setNow] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  const left = cooldownSecondsLeft(until, now);

  const onClick = () => {
    setFeedback(null);
    start(async () => {
      const r = await onSend(ref.current);
      if (!r.ok) {
        setFeedback({ tone: "error", text: r.error });
        return;
      }
      const n = Date.now();
      setNow(n);
      setUntil(n + RESEND_COOLDOWN_S * 1000);
      setFeedback({ tone: "ok", text: sentCopy });
    });
  };

  return (
    <div ref={ref} style={{ display: "grid", gap: 8 }}>
      <Button type="button" variant={variant} size="md" block disabled={pending || left > 0} onClick={onClick}>
        {resendButtonLabel(label, left, pending)}
      </Button>
      {feedback && (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={feedback.tone === "error" ? "k-field-error" : "k-hint"}
          style={{ margin: 0, lineHeight: 1.5 }}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}

/**
 * «Reenviar el email de confirmación» (C-IAM6 `resendVerification`). Con `email` fijo (signup, onboarding)
 * usa ese; sin él (login) lee el campo `email` del form que lo contiene: el que la persona tipeó.
 */
export function ResendVerification({
  email,
  label = "Reenviar el email",
  startCooling = false,
  variant,
}: {
  email?: string;
  label?: string;
  startCooling?: boolean;
  variant?: "primary" | "ghost";
}) {
  return (
    <ResendButton
      label={label}
      sentCopy={RESEND_VERIFICATION_SENT}
      startCooling={startCooling}
      variant={variant}
      onSend={async (el) => {
        const typed = el?.closest("form")?.elements.namedItem("email");
        const value = email ?? (typed instanceof HTMLInputElement ? typed.value : "");
        if (!value.trim()) return { ok: false, error: "Escribí tu email en el formulario y volvé a tocar el botón." };
        const fd = new FormData();
        fd.set("email", value.trim());
        return resendVerification(fd);
      }}
    />
  );
}
