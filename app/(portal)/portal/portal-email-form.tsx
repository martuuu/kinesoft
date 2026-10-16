"use client";

/**
 * «Entrar con tu email» del portal del paciente (IAM-3c, IAM-D5: Google + magic link).
 *
 * Pide el link con `requestPortalLink` (respuesta genérica: no dice si el email tiene ficha) y pasa a
 * «Revisá tu email» con «Reenviar» y el mismo cooldown de 60 s que las pantallas de auth (IAM-2d,
 * `ResendButton`): sin cooldown, la impaciencia quemaba en segundos el límite por email (3/h).
 * `slug` (opcional) viene de `/portal?c=<slug>` (CTA de `/portal/c/<slug>`): el link vuelve a ese consultorio.
 * VX2-f (D-VX28): `Field` + `.k-input-lg` (C-F2/C-F5, como el login), `autoComplete="email"` e `inputMode` para el
 * teclado del celular, y «Usar otro email» con área táctil de 44 px.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconArrow } from "@/components/ui/icons";
import { ResendButton } from "@/components/screens/resend-verification";
import { requestPortalLink } from "@/lib/portal-auth";

export function PortalEmailForm({ slug }: { slug: string | null }) {
  const [pending, start] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = (email: string) => {
    const fd = new FormData();
    fd.set("email", email);
    if (slug) fd.set("slug", slug);
    return requestPortalLink(fd);
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    setError(null);
    start(async () => {
      const r = await send(email);
      if (!r.ok) {
        setError(r.fieldErrors?.email?.[0] ?? r.error);
        return;
      }
      setMessage(r.data.message);
      setSentTo(email);
    });
  };

  if (sentTo) {
    return (
      <div style={{ display: "grid", gap: 10, textAlign: "left" }}>
        <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
          Revisá tu email
        </div>
        <p role="status" style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
          {message} Lo mandamos a <strong>{sentTo}</strong>. Si no lo ves, fijate en spam o promociones.
        </p>
        <ResendButton
          label="Reenviar el link"
          sentCopy={message}
          startCooling
          onSend={() => send(sentTo)}
        />
        <button
          type="button"
          onClick={() => {
            setSentTo(null);
            setError(null);
          }}
          style={{
            background: "none",
            border: 0,
            padding: 0,
            minHeight: 44,
            fontSize: 14,
            color: "var(--sky-700)",
            fontWeight: 600,
            cursor: "pointer",
            justifySelf: "start",
          }}
        >
          Usar otro email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 10, textAlign: "left" }} noValidate>
      <Field id="portal-email" label="Tu email" error={error ?? undefined}>
        <input
          className="k-input k-input-lg"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="nombre@ejemplo.com"
          disabled={pending}
        />
      </Field>
      {/* `Field` pinta el error pero no lo anuncia (no es live region): este aviso solo para lector de pantalla
          cumple «errores con role="alert"» (VX §5) sin duplicarlo en pantalla. */}
      <div role="alert" className="k-sr-only">
        {error ?? ""}
      </div>
      <Button variant="ghost" size="lg" block type="submit" disabled={pending}>
        {pending ? "Enviando…" : "Mandame un link para entrar"} <IconArrow size={14} />
      </Button>
    </form>
  );
}
