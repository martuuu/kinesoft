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
 * VX-Z FX-portal: `useFormState(portalLinkFormAction)` con la action directa: anda sin JS (antes `onSubmit` +
 * `preventDefault`; sin JS el form hacía un GET a /portal con el email en la URL y no mandaba nada).
 */
import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconArrow } from "@/components/ui/icons";
import { ResendButton } from "@/components/screens/resend-verification";
import type { PortalLinkFormState } from "@/components/auth/auth-form-state";
import { requestPortalLink } from "@/lib/portal-auth";
import { portalLinkFormAction } from "./portal-link-action";

export function PortalEmailForm({ slug }: { slug: string | null }) {
  const [state, formAction] = useFormState<PortalLinkFormState, FormData>(portalLinkFormAction, null);
  // «Usar otro email» descarta ESTE estado (cada envío trae un objeto nuevo).
  const [dismissed, setDismissed] = useState<PortalLinkFormState>(null);
  const sent = state?.status === "sent" && state !== dismissed ? state : null;
  const error = state?.status === "error" ? state.error : null;

  if (sent) {
    return <PortalLinkSent email={sent.email} message={sent.message} slug={slug} onBack={() => setDismissed(sent)} />;
  }

  return (
    <form
      key={state ? state.email : "new"}
      action={formAction}
      style={{ display: "grid", gap: 10, textAlign: "left" }}
      noValidate
    >
      {slug && <input type="hidden" name="slug" value={slug} />}
      <Field id="portal-email" label="Tu email" error={error ?? undefined}>
        <input
          className="k-input k-input-lg"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          defaultValue={state?.email ?? ""}
          placeholder="nombre@ejemplo.com"
        />
      </Field>
      {/* `Field` pinta el error pero no lo anuncia (no es live region): este aviso solo para lector de pantalla
          cumple «errores con role="alert"» (VX §5) sin duplicarlo en pantalla. */}
      <div role="alert" className="k-sr-only">
        {error ?? ""}
      </div>
      <PortalLinkSubmit />
    </form>
  );
}

/** El botón lee el «enviando» del form (`useFormStatus`): con la action directa no hay `useTransition` que mirar. */
function PortalLinkSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button
      variant="ghost"
      size="lg"
      block
      type="submit"
      aria-disabled={pending || undefined}
      onClick={(e) => {
        // `aria-disabled` y no `disabled` (como AuthSubmit): el foco no salta; el segundo clic no manda otro POST.
        if (pending) e.preventDefault();
      }}
    >
      {pending ? "Enviando…" : "Mandame un link para entrar"} <IconArrow size={14} />
    </Button>
  );
}

/**
 * «Revisá tu email» (exportado para el render test). VX-Z: el título es una h2 que recibe el foco al aparecer (antes
 * un <div>: el foco quedaba en el botón que desaparecía y el lector no se enteraba del cambio).
 */
export function PortalLinkSent({
  email,
  message,
  slug,
  onBack,
}: {
  email: string;
  message: string;
  slug: string | null;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const resend = () => {
    const fd = new FormData();
    fd.set("email", email);
    if (slug) fd.set("slug", slug);
    return requestPortalLink(fd);
  };
  return (
    <div style={{ display: "grid", gap: 10, textAlign: "left" }}>
      <h2 ref={heading} tabIndex={-1} className="k-display" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
        Revisá tu email
      </h2>
      <p role="status" style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
        {message} Lo mandamos a <strong>{email}</strong>. Si no lo ves, fijate en spam o promociones.
      </p>
      <ResendButton label="Reenviar el link" sentCopy={message} startCooling onSend={resend} />
      <button
        type="button"
        onClick={onBack}
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
