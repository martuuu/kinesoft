/**
 * CF3 (D-CF3-8, sesión SH-U) · lógica pura del menú del teléfono del perfil y de «Compartir» por fila en Turnos.
 *
 * Puro a propósito (lo prueba `tests/unit/cf3-contact-actions.test.ts` sin DOM): el panel (`contact-actions.tsx`) es
 * un chunk diferido y solo pinta lo que sale de acá. Los datos llegan de `getPatientShareBundle` (SH-S), que ya es la
 * barrera de acceso (`full`/`admin`; si no, `hidden`) y ya viene sin nada clínico (`lib/patient-share-types.ts`).
 *
 * Los textos se arman SOLO con campos con nombre (nombre de pila, servicio, fecha, duración, profesional, sede, link de
 * la videollamada, consultorio): nunca con un spread del turno. Así, si algún día el bundle o la fila del perfil traen
 * un título, notas o un diagnóstico, no terminan en el chat del paciente (lo manda también la Secretaria, PD-13).
 */
import {
  bookingReminderText,
  shareNotice,
  turneroInviteText,
  upcomingBookingsText,
  whatsAppShareUrl,
  type ShareNotice,
} from "@/lib/booking-share";
import { canCollectCopago, type Capability } from "@/lib/capabilities";
import type { PatientShareBundle, PatientShareBundleVisible, PatientShareBooking } from "@/lib/patient-share-types";

export type ContactMenuItemId =
  | "chat"
  | "call"
  | "copyPhone"
  | "reminder"
  | "upcoming"
  | "turnero"
  | "paymentLink"
  | "portalInvite";

/**
 * Un ítem del menú. Los que mandan un mensaje (`message`) llevan al lado un «Copiar» (mismo texto): el link de WhatsApp
 * no siempre abre la app (WhatsApp Web, otro dispositivo) y la Secretaria lo pega en otro canal.
 */
export type ContactMenuItem = {
  id: ContactMenuItemId;
  label: string;
  separatorBefore?: boolean;
  /** `wa.me` / `tel:` (se abre en el mismo click, sin `await`: si no, el navegador bloquea la ventana). */
  href?: string;
  /** Texto que copia el «Copiar» del ítem (o el ítem mismo en «Copiar número»). */
  copyText?: string;
};

export type ContactMenuModel = {
  /** Aviso arriba de los ítems: sin acceso al contacto, o número que no sirve para WhatsApp. */
  notice: ShareNotice | null;
  items: ContactMenuItem[];
};

export const CONTACT_MENU_COPY = {
  trigger: (phone: string) => `Contactar al paciente: ${phone}`,
  menuLabel: "Contactar al paciente",
  loading: "Cargando…",
  loadError: "No pudimos cargar el contacto. Probá de nuevo.",
  chat: "Abrir chat de WhatsApp",
  call: "Llamar",
  copyPhone: "Copiar número",
  reminder: "Mandar recordatorio del próximo turno",
  upcoming: "Mandar los próximos turnos",
  turnero: "Mandar el link para sacar turno",
  paymentLink: "Generar link de pago",
  portalInvite: "Invitar al portal",
  portalResend: "Reenviar portal",
  copy: "Copiar",
  copied: "Copiado",
  copyFailed: "No pudimos copiar",
  copyFailedDetail: "Copialo a mano o usá WhatsApp.",
  hiddenTitle: "No ves el contacto de este paciente",
  hiddenDetail: "Podés copiar el número que figura en sus datos.",
  rowShare: "Compartir por WhatsApp",
  rowCopy: "Copiar recordatorio",
  rowAgenda: "Ver en agenda",
  rowMenu: "Opciones",
  rowMenuLabel: "Opciones del turno",
  rowUnavailable: "No pudimos preparar el recordatorio. Probá de nuevo.",
} as const;

const toShareBooking = (firstName: string, b: PatientShareBooking) => ({
  patientName: firstName,
  serviceName: b.serviceName,
  scheduledFor: b.startsAt,
  durationMin: b.durationMin,
});

const extrasOf = (bundle: PatientShareBundleVisible, b: PatientShareBooking | null) => ({
  clinicName: bundle.clinicName,
  locationName: b?.locationName ?? null,
  telemedicineUrl: b?.telemedicineUrl ?? null,
});

const recipient = (bundle: PatientShareBundleVisible) => (bundle.contact.status === "ok" ? bundle.contact.e164 : null);

/** Los mensajes del menú (puros). `null` = no corresponde ofrecerlo (sin turno próximo, turnero cerrado). */
export function contactMessages(bundle: PatientShareBundleVisible): {
  reminder: string | null;
  upcoming: string | null;
  turnero: string | null;
} {
  const next = bundle.upcoming[0] ?? null;
  return {
    reminder: next ? bookingReminderText(toShareBooking(bundle.firstName, next), extrasOf(bundle, next)) : null,
    // Con un solo turno «Próximos turnos» repite el recordatorio: se ofrece desde 2 (default de SH-U, en el reporte).
    upcoming:
      bundle.upcoming.length >= 2
        ? upcomingBookingsText({
            firstName: bundle.firstName,
            clinicName: bundle.clinicName,
            bookings: bundle.upcoming.map((b) => ({
              startsAt: new Date(b.startsAt),
              serviceName: b.serviceName,
              practitionerName: b.practitionerName,
              durationMin: b.durationMin,
            })),
          })
        : null,
    turnero: bundle.turneroUrl ? turneroInviteText({ clinicName: bundle.clinicName, url: bundle.turneroUrl }) : null,
  };
}

export type ContactMenuOptions = {
  /** Lo que muestra la ficha (lo que el actor ya ve): con `hidden` es lo único que se ofrece copiar. */
  displayedPhone: string | null;
  /** Hay a quién hacerle el link sin turno (`paymentLinkTargets(...).options.length > 0`). */
  paymentLinkAvailable: boolean;
  /** El hero completo pasa su flujo de «Enviar al portal»; sin él (modo admin) el ítem no se ofrece. */
  portalInviteAvailable: boolean;
  /** El paciente ya tiene cuenta del portal: el ítem dice «Reenviar portal», como el botón del hero. */
  portalLinked?: boolean;
};

export function contactMenuModel(bundle: PatientShareBundle, o: ContactMenuOptions): ContactMenuModel {
  if (bundle.contact.status === "hidden") {
    const shown = (o.displayedPhone ?? "").trim();
    return {
      notice: { title: CONTACT_MENU_COPY.hiddenTitle, detail: CONTACT_MENU_COPY.hiddenDetail },
      items: shown ? [{ id: "copyPhone", label: CONTACT_MENU_COPY.copyPhone, copyText: shown }] : [],
    };
  }
  const visible = bundle as PatientShareBundleVisible;
  const { phone } = visible.contact;
  const to = recipient(visible);
  const msgs = contactMessages(visible);
  const items: ContactMenuItem[] = [];
  if (phone.waChatHref) items.push({ id: "chat", label: CONTACT_MENU_COPY.chat, href: phone.waChatHref });
  if (phone.telHref) items.push({ id: "call", label: CONTACT_MENU_COPY.call, href: phone.telHref });
  if (phone.display) items.push({ id: "copyPhone", label: CONTACT_MENU_COPY.copyPhone, copyText: phone.display });
  const messages: [ContactMenuItemId, string, string | null][] = [
    ["reminder", CONTACT_MENU_COPY.reminder, msgs.reminder],
    ["upcoming", CONTACT_MENU_COPY.upcoming, msgs.upcoming],
    ["turnero", CONTACT_MENU_COPY.turnero, msgs.turnero],
  ];
  let first = items.length > 0;
  for (const [id, label, text] of messages) {
    if (!text) continue;
    items.push({ id, label, href: whatsAppShareUrl(text, to), copyText: text, separatorBefore: first || undefined });
    first = false;
  }
  let sep = items.length > 0;
  if (visible.canPaymentLink && o.paymentLinkAvailable) {
    items.push({ id: "paymentLink", label: CONTACT_MENU_COPY.paymentLink, separatorBefore: sep || undefined });
    sep = false;
  }
  if (visible.canPortalInvite && o.portalInviteAvailable) {
    items.push({
      id: "portalInvite",
      label: o.portalLinked ? CONTACT_MENU_COPY.portalResend : CONTACT_MENU_COPY.portalInvite,
      separatorBefore: sep || undefined,
    });
  }
  return { notice: shareNotice(visible.contact), items };
}

/** Candidatos del link de pago sin turno y el permiso del miembro (lo pasa el hero; null = sin link de pago). */
export type ContactPaymentLinkInput = {
  practitioners: readonly { id: string; name: string }[];
  capabilities: readonly Capability[];
  viewerPractitionerId: string | null;
};

/** Lo mínimo de una fila de Turnos para su recordatorio (campos con nombre: nada del título ni de las notas). */
export type RowShareBooking = {
  id: string;
  serviceName: string;
  scheduledFor: Date | string;
  durationMin: number;
  status: string;
};

/** «Compartir» por fila: turnos futuros y no cancelados (un ausente o uno ya pasado no se recuerda). */
export function isShareableRow(b: Pick<RowShareBooking, "scheduledFor" | "status">, now: number): boolean {
  return +new Date(b.scheduledFor) >= now && b.status !== "CANCELLED" && b.status !== "NO_SHOW";
}

/**
 * Recordatorio de UNA fila. Sede y videollamada salen del bundle si el turno está entre los 5 próximos (la fila del
 * perfil no las trae); si no, el recordatorio va sin ellas. Sin bundle visible (`hidden`, error) → el link sin
 * destinatario y el texto sin consultorio, con el nombre que ya muestra la ficha.
 */
export function rowReminder(
  bundle: PatientShareBundle | null,
  b: RowShareBooking,
  fallbackFirstName: string
): { text: string; href: string } {
  const visible = bundle && bundle.contact.status !== "hidden" ? (bundle as PatientShareBundleVisible) : null;
  const match = visible?.upcoming.find((u) => u.bookingId === b.id) ?? null;
  const name = (visible?.firstName ?? fallbackFirstName).trim();
  const text = bookingReminderText(
    { patientName: name, serviceName: b.serviceName, scheduledFor: b.scheduledFor, durationMin: b.durationMin },
    visible ? extrasOf(visible, match) : {}
  );
  return { text, href: whatsAppShareUrl(text, visible ? recipient(visible) : null) };
}

/**
 * A quién se le puede hacer un link de pago SIN turno desde el teléfono: la misma regla que `createPaymentLink` y que
 * `linkPractitionerOptions` de Facturación (copiada acá para no arrastrar `patient-links-list` al chunk): `collect`
 * ve a todos, `collectOwn` solo a su profesional. Default = el del viewer si está, o el único.
 */
export function paymentLinkTargets(o: ContactPaymentLinkInput): { options: { id: string; name: string }[]; defaultId: string | null } {
  const caps = new Set(o.capabilities);
  const seen = new Set<string>();
  const options = o.practitioners.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return canCollectCopago(caps, o.viewerPractitionerId, p.id);
  });
  const defaultId =
    o.viewerPractitionerId && options.some((p) => p.id === o.viewerPractitionerId)
      ? o.viewerPractitionerId
      : options.length === 1
        ? options[0].id
        : null;
  return { options: options.map((p) => ({ id: p.id, name: p.name })), defaultId };
}
