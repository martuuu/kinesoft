/**
 * WA-P1 (T6, C-WA2) · Copy de la UI de WhatsApp (voseo rioplatense), client-safe. Un solo lugar para los textos que
 * comparten Configuración → WhatsApp, la sección del drawer del turno, la ficha del paciente y Plataforma.
 *
 * Los mapas son `Record<Unión, string>`: si M15 suma un valor y `types.ts` lo espeja, tsc obliga a darle etiqueta acá
 * (y `tests/unit/wa-p1-templates.test.ts` lo vuelve a chequear en runtime).
 *
 * Pendiente de Martin (C-WA9): el texto legal del consentimiento (`WA_CONSENT_TEXT`) lo revisa él antes del live.
 */
import type {
  WaAccountStatus,
  WaChannelBlockReason,
  WaErrorClass,
  WaMessageKind,
  WaMessageStatus,
  WaMessageTrigger,
  WaSetupStep,
  WaSkipReason,
  WaTemplateStatus,
} from "@/lib/whatsapp/types";

export const WA_ACCOUNT_STATUS_LABEL: Record<WaAccountStatus, string> = {
  SETUP: "Configurando",
  ACTIVE: "Conectado",
  REAUTH_REQUIRED: "Hay que volver a conectar",
  DISCONNECTED: "Desconectado",
};

export const WA_SETUP_STEP_LABEL: Record<WaSetupStep, string> = {
  TOKEN: "Autorizando la cuenta",
  SUBSCRIBED: "Recibiendo avisos de Meta",
  REGISTERED: "Número registrado",
  TEMPLATES: "Enviando las plantillas a revisión",
  DONE: "Listo",
};

export const WA_TEMPLATE_STATUS_LABEL: Record<WaTemplateStatus, string> = {
  NOT_SUBMITTED: "Sin enviar",
  PENDING: "En revisión de Meta",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
  PAUSED: "Pausada por Meta",
  DISABLED: "Deshabilitada por Meta",
};

export const WA_MESSAGE_KIND_LABEL: Record<WaMessageKind, string> = {
  BOOKING_CREATED: "Turno agendado",
  BOOKING_MOVED: "Turno reprogramado",
  BOOKINGS_UPDATED: "Turnos actualizados",
  BOOKING_REMINDER: "Recordatorio",
  DOCUMENT_SHARED: "Documento",
  TEST: "Mensaje de prueba",
  REPLY: "Respuesta automática",
};

export const WA_MESSAGE_TRIGGER_LABEL: Record<WaMessageTrigger, string> = {
  AUTO: "Automático",
  CRON: "Programado",
  MANUAL: "Enviado a mano",
  INBOUND: "Respuesta al paciente",
};

export const WA_MESSAGE_STATUS_LABEL: Record<WaMessageStatus, string> = {
  QUEUED: "En cola",
  SENDING: "Enviando",
  SENT: "Enviado",
  DELIVERED: "Entregado",
  READ: "Leído",
  FAILED: "No se pudo enviar",
  SKIPPED: "No se envió",
  CANCELLED: "Cancelado",
  EXPIRED: "Venció sin enviarse",
};

export const WA_CHANNEL_BLOCK_LABEL: Record<WaChannelBlockReason, string> = {
  no_account: "El consultorio no tiene WhatsApp conectado.",
  no_consent: "El paciente todavía no aceptó recibir avisos por WhatsApp.",
  revoked: "El paciente pidió no recibir avisos por WhatsApp.",
  invalid_phone: "El teléfono cargado no es un celular válido.",
  phone_changed: "El celular cambió desde que el paciente aceptó: hay que volver a pedirle el consentimiento.",
  template_pending: "La plantilla todavía no está aprobada por Meta.",
};

export const WA_SKIP_REASON_LABEL: Record<WaSkipReason, string> = {
  not_confirmed: "El turno no estaba confirmado.",
  no_patient: "El turno no tiene un paciente cargado.",
  no_consent: "El paciente no aceptó recibir avisos por WhatsApp.",
  revoked: "El paciente pidió no recibir avisos por WhatsApp.",
  invalid_phone: "El teléfono no es un celular válido.",
  phone_changed: "El celular cambió desde que el paciente aceptó.",
  too_soon: "Faltaba menos de una hora para el turno.",
  no_account: "WhatsApp no estaba conectado.",
  template_pending: "La plantilla no estaba aprobada por Meta.",
  mode_changed: "Cambió el modo de WhatsApp del sistema.",
  document_changed: "El documento cambió o se dejó de compartir.",
};

/** Lo que ve el consultorio cuando falla un envío. Nunca el mensaje crudo de Meta. */
export const WA_ERROR_CLASS_LABEL: Record<WaErrorClass, string> = {
  retry: "WhatsApp no respondió. Se vuelve a intentar solo.",
  recipient: "No se le pudo entregar a ese número (puede que no tenga WhatsApp).",
  account: "Meta marcó un problema con la cuenta de WhatsApp del consultorio.",
  payment: "Falta cargar o actualizar el medio de pago en Meta.",
  template: "La plantilla no está disponible en Meta. Revisá su estado en Configuración → WhatsApp.",
  auth: "Hay que volver a conectar WhatsApp.",
};

/** Etiqueta del `errorCode` guardado (`clase:código`, `timeout`, `network`, `http:503`). */
export function waErrorLabel(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;
  const cls = errorCode.split(":")[0];
  if (cls in WA_ERROR_CLASS_LABEL) return WA_ERROR_CLASS_LABEL[cls as WaErrorClass];
  if (cls === "timeout" || cls === "network" || cls === "http") return WA_ERROR_CLASS_LABEL.retry;
  return "No se pudo enviar.";
}

/** Badge de la tarjeta del turno (WA-D21): texto + `aria-label`, nunca solo color. */
export const WA_REPLY_BADGE = {
  confirmed: { text: "Confirmó", ariaLabel: "El paciente confirmó el turno por WhatsApp" },
  cancelRequested: { text: "Pidió cancelar", ariaLabel: "El paciente avisó por WhatsApp que no puede ir" },
} as const;

export const WA_COPY = {
  sectionTitle: "WhatsApp",
  connect: "Conectar WhatsApp",
  reconnect: "Volver a conectar",
  resume: "Seguir con la configuración",
  disconnect: "Desconectar WhatsApp",
  disconnectConfirm:
    "Se dejan de mandar avisos y se cancelan los mensajes en cola. El número sigue registrado en Meta y lo podés volver a conectar.",
  sendTest: "Mandar mensaje de prueba",
  testLimit: "Podés mandar hasta 5 pruebas por día.",
  sendReminder: "Mandar recordatorio",
  reminderCooldown: "Ya se mandó un recordatorio hace poco. Probá de nuevo en unos minutos.",
  historyTitle: "Historial de WhatsApp",
  historyEmpty: "Todavía no se mandó nada por WhatsApp para este turno.",
  staleReply: "El paciente respondió a un horario anterior.",
  dismissReply: "Marcar como visto",
  paymentChecklist: "Cargá un medio de pago en Meta: cada aviso entregado tiene un costo que cobra Meta, no nosotros.",
  switches: {
    autoBookingNotice: "Avisar al paciente cuando se agenda o se reprograma un turno",
    autoReminder: "Mandar un recordatorio el día anterior, con «Confirmo» / «No puedo ir»",
    autoReplyText: "Responder con los datos de contacto cuando el paciente escribe",
  },
  consentCheckbox: "El paciente acepta recibir avisos de sus turnos por WhatsApp",
  consentCheckboxSelf: "Acepto recibir avisos de mis turnos por WhatsApp",
  shareByWhatsApp: "El paciente pidió recibirlo por WhatsApp",
  simulatorTitle: "Simulador de Meta (solo desarrollo)",
} as const;

/**
 * Texto de consentimiento (versión `WA_CONSENT_VERSION`). BORRADOR: lo revisa Martin (C-WA9) antes de pasar a live; si
 * cambia, sube la versión.
 */
export const WA_CONSENT_TEXT =
  "Vas a recibir por WhatsApp avisos de tus turnos (cuando se agendan, se reprograman y el día anterior) desde el número del consultorio. Los mensajes no incluyen datos de salud. Podés darte de baja cuando quieras respondiendo BAJA.";
