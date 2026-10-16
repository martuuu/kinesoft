"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { ButtonLink } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { IconAlert, IconCheckCircle } from "@/components/ui/icons";
import { updatePasswordWithRecoverySession } from "@/lib/auth";
import st from "./auth-screens.module.css";

/**
 * /reset (A3c-S-signup). `mode` lo decide el server (ver app/(auth)/reset):
 *   - "recovery": llegó por el link del mail (cookie `ks_recovery`) → solo la
 *     clave nueva;
 *   - "change": sesión común → además la contraseña actual;
 *   - "expired": sin sesión → link vencido, pedir otro.
 *
 * VX2-a: AuthShell `centered`, h1 en la card, `Field` + `PasswordInput` con `autocomplete` correcto (la actual es
 * `current-password`, las dos nuevas `new-password`: así el gestor de contraseñas ofrece generar una y guarda la
 * nueva en vez de pisar la vieja).
 */
export function ResetScreen({ mode }: { mode: "recovery" | "change" | "expired" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});

  const onSubmit = (formData: FormData) => {
    if (pending) return;
    setError(null);
    setFieldErrors({});
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (password !== confirm) {
      setFieldErrors({ confirm: ["Las contraseñas no coinciden."] });
      return;
    }
    start(async () => {
      const r = await updatePasswordWithRecoverySession({
        password,
        currentPassword: mode === "change" ? String(formData.get("currentPassword") ?? "") : "",
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      setDone(true);
      // Pausa breve para que se lea la confirmación; después, al panel.
      setTimeout(() => router.replace("/dashboard"), 1200);
    });
  };

  if (mode === "expired") {
    return (
      <AuthShell variant="centered" footerLinks={[{ label: "Volver al login", href: "/login" }]}>
        <div className={st.stack} data-screen-label="Reset">
          <div className={st.head}>
            <h1 className={st.title}>Nueva contraseña</h1>
          </div>
          <div className="k-alert" role="alert">
            <IconAlert size={18} />
            <span>El link venció o ya se usó. Pedí uno nuevo: te llega por email y vence en 1 hora.</span>
          </div>
          {/* IAM-2d: la salida es un botón, no un link al pie. Es navegación: ButtonLink (un solo <a>). */}
          <ButtonLink href="/forgot" size="lg" block>
            Pedir un link nuevo
          </ButtonLink>
          <p className={st.foot}>
            <Link href="/login" className="k-link">
              Volver al login
            </Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell variant="centered" footerLinks={[{ label: "Volver al login", href: "/login" }]}>
      <div className={st.stack} data-screen-label="Reset">
        <div className={st.head}>
          <h1 className={st.title}>Nueva contraseña</h1>
          <p className={st.sub}>
            Una vez actualizada, te llevamos directo a tu panel. Vas a poder usar la nueva contraseña en todos los
            dispositivos.
          </p>
        </div>

        {done ? (
          <div className="k-alert k-alert-success" role="status">
            <IconCheckCircle size={18} />
            <span>Contraseña actualizada. Te llevamos a tu panel…</span>
          </div>
        ) : (
          <>
            <form action={onSubmit} className={st.fields}>
              {error && (
                <div className="k-alert" role="alert">
                  <IconAlert size={18} />
                  <span>{error}</span>
                </div>
              )}
              {mode === "change" && (
                <Field
                  id="reset-current"
                  label="Contraseña actual"
                  hint={fieldErrors.currentPassword ? undefined : "¿No la recordás? Pedí un link desde «¿Olvidaste tu contraseña?»."}
                  error={fieldErrors.currentPassword?.[0]}
                >
                  <PasswordInput name="currentPassword" autoComplete="current-password" required large />
                </Field>
              )}
              <Field
                id="reset-password"
                label="Nueva contraseña"
                hint="Al menos 8 caracteres, con una letra y un número."
                error={fieldErrors.password?.[0]}
              >
                <PasswordInput name="password" autoComplete="new-password" required minLength={8} large />
              </Field>
              <Field id="reset-confirm" label="Confirmar contraseña" error={fieldErrors.confirm?.[0]}>
                <PasswordInput name="confirm" autoComplete="new-password" required minLength={8} large />
              </Field>
              <AuthSubmit label="Guardar nueva contraseña" busyLabel="Guardando…" pending={pending} />
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
