import { contactHref } from "@/lib/support-contact";
import type { TicketMotivo } from "@/lib/support-ticket-sources";

/**
 * «escribinos» de soporte como link a `/contacto?motivo=<slug>` (PV §27, TK-U2). Es un fragmento de oración: el que
 * lo usa pone lo de antes y lo de después («…: <SupportContact /> para elegir un plan.»).
 *
 * Antes ([BO-Z B4]) era un `mailto:` a `NEXT_PUBLIC_SUPPORT_EMAIL`, o «escribile al equipo» sin link si no estaba.
 * Decisión de Martin (27-oct, literal): «que todos los contactos de formularios y consultas a soporte vayan a la parte
 * de /plataforma de Superadmin, y se abran como "tickets"». `/contacto` decide por la sesión (lead, Configuración →
 * Soporte o ticket con la identidad de la sesión), así que el link sirve igual en la landing, en las pantallas de
 * bloqueo y adentro de la app, y ya no depende de que haya un email configurado.
 *
 * Ya no recibe `subject` ni `email` (PV INT-c los sacó): el asunto lo pone el origen del ticket (`motivo`) y el link no
 * es un mailto.
 *
 * Sin "use client" ni hooks: sirve en server components (pantallas de bloqueo) y en client components. `<a>` y no
 * `next/link`: es una navegación a una página que puede redirigir (con consultorio usable → Configuración), y el
 * prefetch de un link en una banda de toda la app no aporta.
 */
export function SupportContact({
  capital = false,
  motivo,
}: {
  /** Inicio de oración: «Escribinos» / «escribinos». */
  capital?: boolean;
  /** Slug de `/contacto?motivo=` (decide el título y el origen del ticket). Sin él, el contacto genérico. */
  motivo?: TicketMotivo;
}) {
  return (
    <a
      href={contactHref(motivo)}
      data-support-contact
      style={{ color: "inherit", fontWeight: 700, textDecoration: "underline" }}
    >
      {capital ? "Escribinos" : "escribinos"}
    </a>
  );
}
