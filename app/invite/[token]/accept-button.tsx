"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./accept-action";

/**
 * Botón "Aceptar invitación" (A3b-S-auth). Antes era un `<form action>` que
 * solo redirigía si salía bien: cualquier rechazo (rate-limit, email sin
 * confirmar, cuenta del portal de pacientes, error de DB) dejaba la pantalla
 * igual, sin decir nada. Ahora muestra el mensaje de `acceptInvite`.
 */
export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <div
          role="alert"
          style={{
            padding: 12,
            borderRadius: 12,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}
      <Button
        type="button"
        variant="primary"
        disabled={pending}
        style={{ width: "100%", justifyContent: "center" }}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await acceptInvite(token);
            if (r.ok) router.push("/dashboard");
            else setError(r.error);
          })
        }
      >
        {pending ? "Aceptando…" : "Aceptar invitación"}
      </Button>
    </div>
  );
}
