"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthSubmitStatus } from "@/components/auth/auth-submit";
import { forgotFormAction } from "@/components/auth/auth-form-actions";
import type { ForgotFormState } from "@/components/auth/auth-form-state";
import { Field } from "@/components/ui/field";
import { IconAlert, IconCheckCircle } from "@/components/ui/icons";
import { sendPasswordReset } from "@/lib/auth";
import { FORGOT_SENT } from "@/components/screens/auth-feedback";
import { ResendButton } from "@/components/screens/resend-verification";
import { useFocusOnMount } from "@/components/screens/signup-screen";
import st from "./auth-screens.module.css";

/**
 * /forgot. La respuesta es SIEMPRE la genérica (`FORGOT_SENT`): exista o no la cuenta, para no confirmar qué
 * emails están registrados. IAM-2d: tras el envío, «Reenviar el link» (con cooldown) y «¿Email equivocado?
 * Volver», que vuelve al form con el email cargado.
 *
 * VX2-a: AuthShell `centered` con la h1 en la card (una sola por página); mismo copy que antes.
 * VX-Z FX-auth: `useFormState(forgotFormAction)` con la action directa (anda sin JS); «Revisá tu email» es una h2
 * que recibe el foco al aparecer.
 */
export function ForgotScreen() {
  const [state, formAction] = useFormState<ForgotFormState, FormData>(forgotFormAction, null);
  const [dismissed, setDismissed] = useState<ForgotFormState>(null);
  const sent = state?.status === "sent" && state !== dismissed ? state : null;
  const failed = state?.status === "error" ? state : null;
  const draft = state?.email ?? "";

  return (
    <AuthShell variant="centered" footerLinks={[{ label: "Volver al login", href: "/login" }]}>
      <div className={st.stack} data-screen-label="Forgot">
        <div className={st.head}>
          <h1 className={st.title}>¿Olvidaste tu contraseña?</h1>
          <p className={st.sub}>Te mandamos por email un link para crear una contraseña nueva. Vence en 1 hora.</p>
        </div>

        {sent ? (
          <ForgotSent email={sent.email} onBack={() => setDismissed(sent)} />
        ) : (
          <>
            <form key={state ? draft : "new"} action={formAction} className={st.fields}>
              {failed && (
                <div className="k-alert" role="alert">
                  <IconAlert size={18} />
                  <span>{failed.error}</span>
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
              <AuthSubmitStatus label="Enviar link de recuperación" busyLabel="Enviando…" />
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
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className={st.stack}>
      <div className="k-alert k-alert-success" role="status">
        <IconCheckCircle size={18} />
        <div className={st.alertBody}>
          {/* VX-Z: h2 (era un <strong>) con el mismo aspecto, para que el foco caiga en el título del estado nuevo. */}
          <h2 ref={heading} tabIndex={-1} style={{ margin: 0, font: "inherit", fontWeight: 700 }}>
            Revisá tu email
          </h2>
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
