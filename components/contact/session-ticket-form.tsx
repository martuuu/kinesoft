"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { submitSessionTicket } from "@/lib/tickets";
import { sessionTicketReceived, type SessionTicketState } from "@/lib/tickets-types";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { IconAlert, IconCheckCircle } from "@/components/ui/icons";
import styles from "./session-ticket-form.module.css";

/**
 * Form de `/contacto` para quien TIENE sesión pero no puede entrar a la app (consultorio suspendido o dado de baja,
 * usuario deshabilitado, alta a medio hacer) y por eso no tiene Configuración → Soporte (PV §27, TK-U2). Postea a
 * `submitSessionTicket` (`lib/tickets.ts`), que abre el ticket en /plataforma.
 *
 * - **Identidad de la sesión, nunca del form**: no hay campos de nombre ni de email. La respuesta va al email de la
 *   sesión, que la página muestra arriba («Te respondemos a {email}.»). Si el form pidiera el email, cualquiera con
 *   sesión abriría tickets a nombre de otro; la action además ignora un `email` agregado a mano.
 * - Solo postea lo que la action lee (`motivo`, `message`, `phone`, `tenantId`; su zod es `.strict()`). `tenantId`
 *   solo aparece si la persona es titular/admin de MÁS de un consultorio bloqueado; el server lo vuelve a validar
 *   contra la foto de la sesión.
 * - **Funciona sin JS**: `useFormState` con la server action directa (como `ContactForm` de la landing). Sin JS el POST
 *   va igual y la página vuelve con el estado.
 * - Éxito: solo el mensaje (`role="status"`), sin el form: no queda un segundo envío a un click (el tope es de 5 por
 *   día y cada uno le manda un mail a Plataforma). Error: `role="alert"` arriba del form, que sigue con lo escrito.
 * - Superficie pública (C-F3): sin Drawer/Modal/Toast/framer; lo vigila `tests/unit/public-surface-imports.test.ts`.
 */

export type SessionTicketTenantOption = { tenantId: string; tenantName: string };
export type SessionTicketLimits = { message: number; phone: number };

export const SESSION_TICKET_ERROR_FALLBACK = "No pudimos enviar tu mensaje. Probá de nuevo en unos minutos.";

/** Puro: estado de la action → mensaje visible. `null` = todavía no se envió. */
export function sessionTicketFeedback(state: SessionTicketState): { kind: "success" | "error"; text: string } | null {
  if (!state) return null;
  if (state.ok) return { kind: "success", text: sessionTicketReceived(state.data.email) };
  return { kind: "error", text: state.error?.trim() || SESSION_TICKET_ERROR_FALLBACK };
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      block
      aria-disabled={pending || undefined}
      // aria-disabled y no `disabled`: el botón no pierde el foco mientras envía; el doble click se corta acá.
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {pending ? (
        <>
          <span className="k-spinner" aria-hidden="true" />
          Enviando…
        </>
      ) : (
        "Enviar mensaje"
      )}
    </Button>
  );
}

export function SessionTicketForm({
  motivo,
  title,
  limits,
  tenants = [],
}: {
  /** Slug de `?motivo=` (informativo para la action: el destino lo decide la sesión). */
  motivo: string;
  /** Nombre accesible del form (el título de la página). */
  title: string;
  limits: SessionTicketLimits;
  /** Consultorios bloqueados donde es titular/admin. Con 2 o más, elige cuál; el primero es el suspendido. */
  tenants?: SessionTicketTenantOption[];
}) {
  const [state, formAction] = useFormState(submitSessionTicket, null);
  const messageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state) messageRef.current?.focus();
  }, [state]);

  const feedback = sessionTicketFeedback(state);
  const err = (f: string) => (state && !state.ok ? state.fieldErrors?.[f]?.[0] : undefined);

  if (feedback?.kind === "success") {
    return (
      <div ref={messageRef} tabIndex={-1} role="status" className={`k-alert k-alert-success ${styles.message}`}>
        <IconCheckCircle />
        <span>{feedback.text}</span>
      </div>
    );
  }

  return (
    <form action={formAction} className={styles.form} aria-label={title}>
      {feedback?.kind === "error" && (
        <div ref={messageRef} tabIndex={-1} role="alert" className={`k-alert ${styles.message}`}>
          <IconAlert />
          <span>{feedback.text}</span>
        </div>
      )}

      {tenants.length > 1 && (
        <Field id="ticket-tenant" label="Consultorio" error={err("tenantId")}>
          <select className="k-input k-input-lg" name="tenantId" defaultValue={tenants[0]?.tenantId}>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field id="ticket-message" label="Mensaje" hint="No incluyas datos de pacientes." error={err("message")}>
        <textarea className="k-input" name="message" rows={5} required maxLength={limits.message} />
      </Field>

      <Field
        id="ticket-phone"
        label="Teléfono"
        optional
        hint="Si preferís que te llamemos."
        error={err("phone")}
      >
        <input className="k-input k-input-lg" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={limits.phone} />
      </Field>

      <input type="hidden" name="motivo" value={motivo} />

      <SubmitButton />
    </form>
  );
}
