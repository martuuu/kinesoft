"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { Field } from "@/components/ui/field";
import { IconAlert, IconCheckCircle } from "@/components/ui/icons";
import { sendPasswordReset } from "@/lib/auth";
import { FORGOT_SENT } from "@/components/screens/auth-feedback";
import { ResendButton } from "@/components/screens/resend-verification";
import st from "./auth-screens.module.css";

/**
 * /forgot. La respuesta es SIEMPRE la genérica (`FORGOT_SENT`): exista o no la cuenta, para no confirmar qué
 * emails están registrados. IAM-2d: tras el envío, «Reenviar el link» (con cooldown) y «¿Email equivocado?
 * Volver», que vuelve al form con el email cargado.
 *
 * VX2-a: AuthShell `centered` con la h1 en la card (una sola por página); mismo copy que antes.
 */
export function ForgotScreen() {
  const [pending, start] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (formData: FormData) => {
    if (pending) return;
    setError(null);
    const email = String(formData.get("email") ?? "").trim();
    setDraft(email);
    start(async () => {
      const r = await sendPasswordReset({ email });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSentTo(email);
    });
  };

  return (
    <AuthShell variant="centered" footerLinks={[{ label: "Volver al login", href: "/login" }]}>
      <div className={st.stack} data-screen-label="Forgot">
        <div className={st.head}>
          <h1 className={st.title}>¿Olvidaste tu contraseña?</h1>
          <p className={st.sub}>Te mandamos por email un link para crear una contraseña nueva. Vence en 1 hora.</p>
        </div>

        {sentTo ? (
          <ForgotSent email={sentTo} onBack={() => setSentTo(null)} />
        ) : (
          <>
            <form action={onSubmit} className={st.fields}>
              {error && (
                <div className="k-alert" role="alert">
                  <IconAlert size={18} />
                  <span>{error}</span>
                </div>
              )}
              <Field id="forgot-email" label="Email">
                <input
                  className="k-input k-input-lg"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  defaultValue={draft}
                  placeholder="nombre@ejemplo.com"
                />
              </Field>
              <AuthSubmit label="Enviar link de recuperación" busyLabel="Enviando…" pending={pending} />
            </form>
            <p className={st.foot}>
              <Link href="/login" className="k-link">
                Volver al login
              </Link>
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** Estado «te mandamos un link» (exportado para el render test). El reenvío arranca con cooldown. */
export function ForgotSent({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div className={st.stack}>
      <div className="k-alert k-alert-success" role="status">
        <IconCheckCircle size={18} />
        <div className={st.alertBody}>
          <strong>Revisá tu email</strong>
          <span>{FORGOT_SENT}</span>
          <span>
            Lo pediste para <strong>{email}</strong>. ¿No llega? Revisá spam o promociones.
          </span>
        </div>
      </div>
      <ResendButton
        label="Reenviar el link"
        sentCopy={FORGOT_SENT}
        startCooling
        onSend={() => sendPasswordReset({ email })}
      />
      <p className={st.foot}>
        ¿Email equivocado?{" "}
        <button type="button" onClick={onBack} className={`k-link ${st.linkButton}`}>
          Volver
        </button>
        {" · "}
        <Link href="/login" className="k-link">
          Ir al login
        </Link>
      </p>
    </div>
  );
}
