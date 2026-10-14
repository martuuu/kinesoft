"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./accept-action";
import { InviteNotice } from "./invite-notice";

/**
 * «Unirme a {consultorio}» para quien ya tiene sesión con el email invitado
 * (A3b-S-auth; IAM-2b le pone el nombre del consultorio). Muestra el mensaje
 * de `acceptInvite` si falla (antes un `<form action>` dejaba la pantalla
 * igual, sin decir nada). Al aceptar, la action deja la cookie del
 * consultorio y se navega duro a /dashboard: el layout tiene que leer el
 * consultorio nuevo, no el que tenía cacheado el router.
 */
export function AcceptInviteButton({ token, tenantName }: { token: string; tenantName: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <InviteNotice tone="error" role="alert">
          {error}
        </InviteNotice>
      )}
      <Button
        type="button"
        variant="primary"
        disabled={pending}
        style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await acceptInvite(token);
            if (r.ok) window.location.assign("/dashboard");
            else setError(r.error);
          })
        }
      >
        {pending ? "Uniéndote…" : `Unirme a ${tenantName}`}
      </Button>
    </div>
  );
}
