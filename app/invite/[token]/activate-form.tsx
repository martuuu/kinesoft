"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { activateInvitationAction } from "./activate-action";
import { inviteLoginHref } from "./invite-state";
import { InviteNotice } from "./invite-notice";

/**
 * «Activar tu cuenta» (IAM-2b). Reemplaza el CTA «Crear mi cuenta» que mandaba
 * a `/signup?invite=` (punto 4 del QA: `signUp` sobre el usuario que ya había
 * creado `inviteUserByEmail` no mandaba nada y el invitado quedaba afuera).
 *
 * El email lo fija la invitación (se muestra, no se edita: si no, cualquiera
 * con el link se registraría con SU email). Nombre y apellido vienen
 * precargados de la invitación y se pueden corregir. Al terminar, la action
 * inicia sesión y redirige a /dashboard.
 */
export function ActivateForm({
  token,
  email,
  firstName,
  lastName,
  tenantName,
}: {
  token: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantName: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});

  const onSubmit = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await activateInvitationAction({
        token,
        firstName: String(fd.get("firstName") ?? ""),
        lastName: String(fd.get("lastName") ?? ""),
        password: String(fd.get("password") ?? ""),
        passwordConfirm: String(fd.get("passwordConfirm") ?? ""),
      });
      // Éxito = la action redirige (no vuelve nada).
      if (!r) return;
      setError({ code: r.code, message: r.error });
      setFieldErrors(r.fieldErrors ?? {});
    });
  };

  const needsLogin = error && (error.code === "account_exists" || error.code === "signin_failed" || error.code === "accepted");

  return (
    <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 16 }}>
      {/* El email es fijo (lo pone la invitación): se muestra en un input de solo lectura con `autocomplete="username"`
          para que el gestor de contraseñas guarde la contraseña nueva asociada a ESE email. No viaja en el form: la
          action lo toma de la invitación. */}
      <Field id="invite-email" label="Email" hint="Es el email al que te invitaron: con este vas a ingresar.">
        <input className="k-input k-input-lg" type="email" value={email} readOnly autoComplete="username" />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Field id="invite-first-name" label="Nombre" error={fieldErrors.firstName?.[0]}>
          <input
            className="k-input k-input-lg"
            name="firstName"
            required
            defaultValue={firstName}
            autoComplete="given-name"
          />
        </Field>
        <Field id="invite-last-name" label="Apellido" error={fieldErrors.lastName?.[0]}>
          <input
            className="k-input k-input-lg"
            name="lastName"
            required
            defaultValue={lastName}
            autoComplete="family-name"
          />
        </Field>
      </div>

      <Field
        id="invite-password"
        label="Contraseña"
        hint="Mínimo 8 caracteres, con al menos una letra y un número."
        error={fieldErrors.password?.[0]}
      >
        <PasswordInput name="password" required autoComplete="new-password" large />
      </Field>
      <Field id="invite-password-confirm" label="Repetí la contraseña" error={fieldErrors.passwordConfirm?.[0]}>
        <PasswordInput name="passwordConfirm" required autoComplete="new-password" large />
      </Field>

      {error && (
        <InviteNotice tone="error" role="alert">
          {error.message}
          {needsLogin && (
            <div style={{ marginTop: 8 }}>
              <Link href={inviteLoginHref(token, email)} className="k-link">
                Ingresar
              </Link>
              {" · "}
              <Link href="/forgot" className="k-link">
                Olvidé mi contraseña
              </Link>
            </div>
          )}
        </InviteNotice>
      )}

      <Button variant="primary" type="submit" size="lg" block disabled={pending}>
        {pending ? "Activando tu cuenta…" : `Activar mi cuenta y unirme a ${tenantName}`}
      </Button>

      <p style={{ fontSize: 14, color: "var(--navy-500)", textAlign: "center", margin: 0 }}>
        ¿Ya tenés cuenta en KineSoft?{" "}
        <Link href={inviteLoginHref(token, email)} className="k-link">
          Ingresá para unirte
        </Link>
      </p>
    </form>
  );
}
