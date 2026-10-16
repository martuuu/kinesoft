"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { SaasPlan } from "@prisma/client";
import { submitLeadForm } from "@/lib/leads";
import type { ActionResult } from "@/lib/validation";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { IconAlert, IconCheckCircle } from "@/components/ui/icons";
import styles from "./contact-form.module.css";

/**
 * Formulario de contacto de la landing (VX2-c2, C-VX-L) → `submitLeadForm` (lead en la bandeja de /plataforma, C-PL11).
 *
 * - **Funciona sin JS**: `useFormState(submitLeadForm, null)` con la server action directa (no envuelta: envolverla en
 *   una función del cliente rompe el progressive enhancement). Sin JS el POST va igual y la página vuelve con el estado.
 * - **`startedAt` obligatorio** (PL-Z a4#2, `leadBotVerdict`): hidden con el instante del render SSR/ISR, que se
 *   reemplaza por `Date.now()` al montar. Sin JS queda el del render, que siempre tiene más de 3 s de antigüedad, así
 *   que un humano sin JS no cae como bot. Cierra la fila `a4#2 lead-sin-startedAt` de AUDIT.
 * - **Honeypot `website`** fuera de pantalla (no `display:none`, que algunos bots detectan), `tabIndex={-1}`,
 *   `autoComplete="off"` y el contenedor `aria-hidden`: ni el teclado ni el lector de pantalla llegan.
 * - Estados: éxito con `role="status"`, error con `role="alert"`; al cambiar el estado el foco va al mensaje
 *   (`tabIndex={-1}`) para que quien usa teclado o lector no quede abajo del botón sin enterarse.
 * - Sin framer (C-F3: la landing es superficie pública).
 */

export type PlanOption = { value: SaasPlan; label: string };
export type ContactFormLimits = { name: number; email: number; phone: number; clinicName: number; message: number };

type LeadState = ActionResult<{ received: true }> | null;

export const CONTACT_SUCCESS_TITLE = "Recibimos tu consulta.";
export const CONTACT_SUCCESS_TEXT = "Te respondemos al email que dejaste.";
export const CONTACT_ERROR_FALLBACK = "No pudimos enviar tu consulta. Probá de nuevo en unos minutos.";

/** Puro: estado de la action → mensaje visible. `null` = todavía no se envió. */
export function contactFeedback(state: LeadState): { kind: "success" | "error"; text: string } | null {
  if (!state) return null;
  if (state.ok) return { kind: "success", text: CONTACT_SUCCESS_TEXT };
  return { kind: "error", text: state.error?.trim() || CONTACT_ERROR_FALLBACK };
}

/** Puro: primer error de un campo (los nombres son las claves de `submitLead`). */
export function contactFieldError(state: LeadState, field: string): string | undefined {
  if (!state || state.ok) return undefined;
  return state.fieldErrors?.[field]?.[0];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
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
        "Enviar consulta"
      )}
    </Button>
  );
}

export function ContactForm({
  startedAt,
  planOptions,
  limits,
}: {
  startedAt: number;
  planOptions: PlanOption[];
  limits: ContactFormLimits;
}) {
  const [state, formAction] = useFormState(submitLeadForm, null);
  const [shownAt, setShownAt] = useState(startedAt);
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);

  // Con JS, el reloj arranca cuando el form de verdad se mostró (el valor SSR puede ser de hace una hora por el ISR).
  useEffect(() => {
    setShownAt(Date.now());
  }, []);

  useEffect(() => {
    if (!state) return;
    messageRef.current?.focus();
    // Éxito: se vacían los campos para que no quede un segundo envío a un click.
    if (state.ok) formRef.current?.reset();
  }, [state]);

  const feedback = contactFeedback(state);
  const err = (f: string) => contactFieldError(state, f);

  return (
    <form ref={formRef} action={formAction} className={styles.form} aria-labelledby="contacto-title">
      {feedback?.kind === "success" && (
        <div ref={messageRef} tabIndex={-1} role="status" className={`k-alert k-alert-success ${styles.message}`}>
          <IconCheckCircle />
          <span>
            <strong>{CONTACT_SUCCESS_TITLE}</strong> {feedback.text}
          </span>
        </div>
      )}
      {feedback?.kind === "error" && (
        <div ref={messageRef} tabIndex={-1} role="alert" className={`k-alert ${styles.message}`}>
          <IconAlert />
          <span>{feedback.text}</span>
        </div>
      )}

      <div className={styles.two}>
        <Field id="contact-name" label="Nombre" error={err("name")}>
          <input className="k-input k-input-lg" name="name" type="text" autoComplete="name" required maxLength={limits.name} />
        </Field>
        <Field id="contact-email" label="Email" error={err("email")}>
          <input
            className="k-input k-input-lg"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={limits.email}
          />
        </Field>
      </div>

      <div className={styles.two}>
        <Field id="contact-phone" label="Teléfono" optional error={err("phone")}>
          <input className="k-input k-input-lg" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={limits.phone} />
        </Field>
        <Field id="contact-clinic" label="Consultorio" optional error={err("clinicName")}>
          <input
            className="k-input k-input-lg"
            name="clinicName"
            type="text"
            autoComplete="organization"
            maxLength={limits.clinicName}
          />
        </Field>
      </div>

      <Field id="contact-plan" label="Plan que te interesa" optional error={err("planInterest")}>
        <select className="k-input k-input-lg" name="planInterest" defaultValue="">
          <option value="">Todavía no sé</option>
          {planOptions.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <Field id="contact-message" label="Mensaje" hint="No incluyas datos de pacientes." error={err("message")}>
        <textarea className="k-input" name="message" rows={5} required maxLength={limits.message} />
      </Field>

      <div className={styles.hp} aria-hidden="true">
        <label htmlFor="contact-website">No completar</label>
        <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <input type="hidden" name="startedAt" value={String(shownAt)} />

      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
