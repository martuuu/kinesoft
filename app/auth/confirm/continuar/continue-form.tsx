"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * El form que canjea el link (POST `/auth/confirm`, IAM-2c). Se manda solo UNA vez al montar; el botón
 * «Continuar» queda visible para el navegador sin JavaScript y para quien vuelve atrás a esta página (el
 * envío automático no se repite). Mientras se manda, el botón queda deshabilitado: un segundo POST con el
 * mismo token (ya gastado) terminaría en «el link venció o ya se usó».
 *
 * Por qué un POST y no canjear en el GET: los escáneres de correo (Outlook Safe Links) abren el link antes
 * que la persona; un GET que canjeaba les regalaba el token. Ver `app/auth/confirm/route.ts`.
 */
export function ContinueForm({ tokenHash, type, next }: { tokenHash: string; type: string; next: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const sentOnce = useRef(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (sentOnce.current) return;
    sentOnce.current = true;
    setSending(true);
    formRef.current?.requestSubmit();
  }, []);

  // Volver atrás a esta página (bfcache) restaura el estado «Confirmando…»: el botón vuelve a quedar usable.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSending(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  return (
    <form
      ref={formRef}
      method="post"
      action="/auth/confirm"
      onSubmit={() => setSending(true)}
      style={{ display: "grid", gap: 12 }}
    >
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="next" value={next} />
      <Button
        type="submit"
        variant="primary"
        disabled={sending}
        aria-busy={sending}
        style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
      >
        {sending ? "Confirmando…" : "Continuar"}
      </Button>
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)", textAlign: "center" }}>
        Si no avanza solo en unos segundos, tocá «Continuar».
      </p>
    </form>
  );
}
