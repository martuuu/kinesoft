"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { LegalAcceptCheckbox } from "@/components/legal/legal-accept";
import { acceptInvite } from "./accept-action";
import { InviteNotice } from "./invite-notice";

/**
 * Lo que va como `acceptLegal` a `acceptInvite`: la casilla tildada (checkbox nativo, "on"). Exportado para el render
 * test (sin DOM no hay submit).
 */
export function acceptInviteLegalFrom(fd: FormData): boolean {
  return fd.get("acceptLegal") === "on";
}

/**
 * «Unirme a {consultorio}» para quien ya tiene sesión con el email invitado
 * (A3b-S-auth; IAM-2b le pone el nombre del consultorio). Muestra el mensaje
 * de `acceptInvite` si falla (antes un `<form action>` dejaba la pantalla
 * igual, sin decir nada). Al aceptar, la action deja la cookie del
 * consultorio y se navega duro a /dashboard: el layout tiene que leer el
 * consultorio nuevo, no el que tenía cacheado el router.
 *
 * PV (§27, LG-U): `legalAccepted` lo decide la página (`hasAcceptedCurrentLegal` del usuario de la sesión). Si no
 * aceptó la versión vigente (cuenta creada con Google/Facebook que nunca pasó por el onboarding, o versión nueva de
 * los textos) se muestra la casilla y `acceptInvite` la recibe; el server la exige y la registra en la tx de la
 * unión (`invite_accept`). Es un `<form>` (antes un botón con `onClick`) para que el `required` de la casilla frene
 * el envío antes de ir al server.
 */
export function AcceptInviteButton({
  token,
  tenantName,
  legalAccepted,
}: {
  token: string;
  tenantName: string;
  legalAccepted: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);

  const onSubmit = (fd: FormData) =>
    start(async () => {
      setError(null);
      setLegalError(null);
      const r = await acceptInvite(token, acceptInviteLegalFrom(fd));
      if (r.ok) {
        window.location.assign("/dashboard");
        return;
      }
      // El error de la casilla va al lado de la casilla (y no se repite arriba).
      const legal = r.fieldErrors?.acceptLegal?.[0];
      if (legal) setLegalError(legal);
      else setError(r.error);
    });

  return (
    <form action={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <InviteNotice tone="error" role="alert">
          {error}
        </InviteNotice>
      )}
      {/* Si el server la pide igual (la página la ocultó y cambió la versión entre medio), se muestra con su error. */}
      {(!legalAccepted || legalError) && (
        <LegalAcceptCheckbox id="invite-accept-legal" error={legalError ?? undefined} />
      )}
      <Button type="submit" variant="primary" size="lg" block disabled={pending}>
        {pending ? "Uniéndote…" : `Unirme a ${tenantName}`}
      </Button>
    </form>
  );
}
