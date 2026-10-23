"use client";

/**
 * WA-U4 (T6, §26.5, C-WA9) · «Avisos por WhatsApp» en la Cuenta del portal: el paciente ve si recibe avisos, los activa
 * con el celular cargado en SUS datos y los da de baja.
 *
 * - El número llega ENMASCARADO del server (`getMyWhatsAppConsent`, WA-S5): esta tarjeta nunca ve el número completo,
 *   así que tampoco lo puede mostrar ni loguear. El paciente no tipea un número acá: cambiarlo es un pedido de «Mis
 *   datos» que aprueba el consultorio (WA-D17: el consentimiento queda anclado al número consentido).
 * - Activar exige la casilla DESTILDADA tildada a mano + el texto legal a la vista (mismo criterio que el alta del
 *   paciente y el turnero). Se manda `currentVersion` (la que leyó): si el texto cambió entre la carga y el clic, el
 *   server rechaza y pedimos recargar.
 * - Revocar va con segundo paso inline en `<details>` (ES4-D8: el portal no carga Confirm/Modal/Toast, C-F3).
 * - `canGrant` = el consultorio tiene WhatsApp activo. Sin eso no se ofrece activar (no saldría nada), pero un GRANTED
 *   se puede revocar igual: es un pedido de privacidad.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { setMyWhatsAppConsent, type getMyWhatsAppConsent } from "@/lib/portal-whatsapp-consent";
import { WA_CONSENT_TEXT } from "@/lib/whatsapp/copy";

export type PortalWaConsent = NonNullable<Awaited<ReturnType<typeof getMyWhatsAppConsent>>>;

export type WaConsentCardView = "active" | "paused" | "off" | "no_phone";

/** Pura (testeada): qué estado muestra la tarjeta. */
export function waConsentCardView(c: PortalWaConsent): WaConsentCardView {
  if (c.status === "GRANTED") return c.phoneChanged || c.versionOutdated ? "paused" : "active";
  return c.phoneValid ? "off" : "no_phone";
}

export const WA_PORTAL_COPY = {
  title: "Avisos por WhatsApp",
  activeTitle: "Recibís avisos de tus turnos por WhatsApp",
  offLead: "Te podemos avisar por WhatsApp cuando se agenda o se reprograma un turno, y el día anterior.",
  pausedPhone:
    "Tus avisos están en pausa: cambió el celular cargado en tus datos desde que los activaste. Si querés seguir recibiéndolos, volvé a activarlos.",
  pausedText: "Actualizamos el texto de los avisos. Leelo y volvé a activarlos para seguir recibiéndolos.",
  noPhone:
    "El teléfono que tiene cargado el consultorio no es un celular. Pedí el cambio desde «Mis datos» y, cuando lo aprueben, vas a poder activar los avisos.",
  checkbox: "Quiero recibir avisos de mis turnos por WhatsApp",
  revokeOpen: "Dejar de recibir avisos",
  revokeExplain: "Dejás de recibir avisos de tus turnos por WhatsApp. Los podés volver a activar cuando quieras.",
  revokeConfirm: "Sí, dejar de recibir avisos",
  grant: "Activar avisos",
  busy: "Guardando…",
  revoked: "Listo: no te vamos a mandar más avisos por WhatsApp.",
  granted: "Listo: te vamos a avisar por WhatsApp.",
} as const;

export function WhatsAppConsentCard({
  slug,
  consent,
  canGrant,
}: {
  slug: string;
  consent: PortalWaConsent;
  canGrant: boolean;
}) {
  const [c, setC] = useState(consent);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const view = waConsentCardView(c);
  const id = `portal-wa-${slug}`;
  const number = c.phoneMasked ? ` al ${c.phoneMasked}` : "";

  const save = (granted: boolean) => {
    if (pending) return;
    setError(null);
    setDone(null);
    start(async () => {
      const r = await setMyWhatsAppConsent({ slug, granted, version: c.currentVersion });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Lo que el server escribió: GRANTED queda anclado al celular actual y a la versión vigente.
      setC((prev) => ({ ...prev, status: r.data.status, phoneChanged: false, versionOutdated: false }));
      setChecked(false);
      setDone(r.data.status === "GRANTED" ? WA_PORTAL_COPY.granted : WA_PORTAL_COPY.revoked);
    });
  };

  const showGrant = canGrant && (view === "off" || view === "paused");

  return (
    <Card glass style={{ padding: 18, display: "grid", gap: 10 }} aria-labelledby={`${id}-title`} role="region">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 id={`${id}-title`} className="k-display" style={{ fontSize: 18, margin: 0 }}>
          {WA_PORTAL_COPY.title}
        </h2>
        <Tag tone={view === "active" ? "lime" : "soft"} variant="outline">
          {view === "active" ? "Activados" : view === "paused" ? "En pausa" : "Desactivados"}
        </Tag>
      </div>

      {view === "active" && (
        <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          {WA_PORTAL_COPY.activeTitle}
          {number}.
        </p>
      )}
      {view === "paused" && (
        <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          {c.phoneChanged ? WA_PORTAL_COPY.pausedPhone : WA_PORTAL_COPY.pausedText}
        </p>
      )}
      {view === "off" && <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5 }}>{WA_PORTAL_COPY.offLead}</p>}
      {view === "no_phone" && (
        <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5, color: "var(--navy-500)" }}>{WA_PORTAL_COPY.noPhone}</p>
      )}

      {/* Siempre montada (ZF3): una región viva que aparece junto con su texto no la anuncian varios lectores. */}
      <p role="status" className={done ? undefined : "k-sr-only"} style={done ? { fontSize: 14, margin: 0 } : undefined}>
        {done ?? ""}
      </p>
      {error && (
        <div role="alert" className="k-alert">
          {error}
        </div>
      )}

      {showGrant && (
        <div style={{ display: "grid", gap: 8 }}>
          <p id={`${id}-legal`} style={{ fontSize: 13, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
            {WA_CONSENT_TEXT}
          </p>
          <label htmlFor={id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer", fontSize: 14 }}>
            <input
              id={id}
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              aria-describedby={`${id}-legal`}
              style={{ width: 20, height: 20, flex: "none", margin: 0, accentColor: "var(--sky-600)" }}
            />
            <span>
              {WA_PORTAL_COPY.checkbox}
              {number}
            </span>
          </label>
          <Button
            variant="primary"
            size="md"
            block
            type="button"
            // `aria-disabled` y no `disabled` (como «Mis datos»): el foco no salta y el lector anuncia por qué no anda.
            aria-disabled={!checked || pending ? true : undefined}
            onClick={() => {
              if (checked) save(true);
            }}
          >
            {pending ? WA_PORTAL_COPY.busy : WA_PORTAL_COPY.grant}
          </Button>
        </div>
      )}

      {(view === "active" || view === "paused") && (
        <details>
          <summary
            style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "var(--sky-700)" }}
          >
            {WA_PORTAL_COPY.revokeOpen}
          </summary>
          <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
            <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>{WA_PORTAL_COPY.revokeExplain}</p>
            <Button
              variant="ghost"
              size="md"
              block
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => save(false)}
            >
              {pending ? WA_PORTAL_COPY.busy : WA_PORTAL_COPY.revokeConfirm}
            </Button>
          </div>
        </details>
      )}
    </Card>
  );
}
