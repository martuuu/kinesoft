"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { IconArrow } from "@/components/ui/icons";
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
    <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 14 }}>
      <div>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Email</span>
        <div
          style={{
            marginTop: 6,
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(15,30,51,0.04)",
            border: "1px solid rgba(15,30,51,0.08)",
            fontSize: 14,
            color: "var(--navy-700)",
            overflowWrap: "anywhere",
          }}
        >
          {email}
        </div>
        <span style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--navy-300)" }}>
          Es el email al que te invitaron: con este vas a ingresar.
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <FormField
          label="Nombre"
          name="firstName"
          required
          defaultValue={firstName}
          error={fieldErrors.firstName?.[0]}
        />
        <FormField
          label="Apellido"
          name="lastName"
          required
          defaultValue={lastName}
          error={fieldErrors.lastName?.[0]}
        />
      </div>

      <FormField
        label="Contraseña"
        name="password"
        type="password"
        required
        placeholder="••••••••"
        hint="Mínimo 8 caracteres, con al menos una letra y un número."
        error={fieldErrors.password?.[0]}
      />
      <FormField
        label="Repetí la contraseña"
        name="passwordConfirm"
        type="password"
        required
        placeholder="••••••••"
        error={fieldErrors.passwordConfirm?.[0]}
      />

      {error && (
        <InviteNotice tone="error" role="alert">
          {error.message}
          {needsLogin && (
            <div style={{ marginTop: 8 }}>
              <Link href={inviteLoginHref(token, email)} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
                Ingresar
              </Link>
              {" · "}
              <Link href="/forgot" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
                Olvidé mi contraseña
              </Link>
            </div>
          )}
        </InviteNotice>
      )}

      <Button
        variant="primary"
        type="submit"
        disabled={pending}
        style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
      >
        {pending ? "Activando tu cuenta…" : `Activar mi cuenta y unirme a ${tenantName}`} <IconArrow size={16} />
      </Button>

      <div style={{ fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
        ¿Ya tenés cuenta en KineSoft?{" "}
        <Link href={inviteLoginHref(token, email)} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
          Ingresá para unirte
        </Link>
      </div>
    </form>
  );
}
