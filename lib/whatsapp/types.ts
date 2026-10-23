/**
 * WA-P1 (T6, C-WA2, brief §26.5) · Tipos y DTOs de WhatsApp, client-safe.
 *
 * Por qué las uniones a mano en vez de importar los enums de `@prisma/client`: este módulo lo importan client components
 * (Configuración → WhatsApp, la sección del drawer del turno) y el runtime de Prisma no puede entrar al bundle del
 * cliente. El precio es que M15 o una migración futura pueden sumar un valor al enum de Postgres sin que nadie lo sume
 * acá; por eso `tests/unit/wa-p1-logic.test.ts` compara cada lista contra `Object.values(<Enum>)` de Prisma y tsc
 * compara los tipos (mismo patrón que `lib/payment-method.ts`, AS-1k1).
 *
 * Nada de PHI en estos DTOs (WA-D16): el teléfono viaja solo enmascarado (`toMasked`) y el historial no tiene cuerpo
 * (la cola no lo guarda: se re-arma de la plantilla).
 */

// ── Espejos de los enums de M15 (orden = el del enum en schema.prisma) ──────────────────────────────────────────

export const WA_ACCOUNT_STATUSES = ["SETUP", "ACTIVE", "REAUTH_REQUIRED", "DISCONNECTED"] as const;
export type WaAccountStatus = (typeof WA_ACCOUNT_STATUSES)[number];

export const WA_SETUP_STEPS = ["TOKEN", "SUBSCRIBED", "REGISTERED", "TEMPLATES", "DONE"] as const;
export type WaSetupStep = (typeof WA_SETUP_STEPS)[number];

export const WA_TEMPLATE_KEYS = [
  "BOOKING_CREATED",
  "BOOKING_MOVED",
  "BOOKINGS_UPDATED",
  "BOOKING_REMINDER",
  "DOCUMENT_SHARED",
] as const;
export type WaTemplateKey = (typeof WA_TEMPLATE_KEYS)[number];

export const WA_TEMPLATE_STATUSES = ["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"] as const;
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number];

export const WA_MESSAGE_KINDS = [
  "BOOKING_CREATED",
  "BOOKING_MOVED",
  "BOOKINGS_UPDATED",
  "BOOKING_REMINDER",
  "DOCUMENT_SHARED",
  "TEST",
  "REPLY",
] as const;
export type WaMessageKind = (typeof WA_MESSAGE_KINDS)[number];

export const WA_MESSAGE_TRIGGERS = ["AUTO", "CRON", "MANUAL", "INBOUND"] as const;
export type WaMessageTrigger = (typeof WA_MESSAGE_TRIGGERS)[number];

export const WA_MESSAGE_STATUSES = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];

export const WA_INBOUND_KINDS = ["CONFIRM", "CANCEL_REQUEST", "OPT_OUT", "OPT_IN", "TEXT", "OTHER"] as const;
export type WaInboundKind = (typeof WA_INBOUND_KINDS)[number];

export const WA_CONSENT_STATUSES = ["GRANTED", "REVOKED"] as const;
export type WaConsentStatus = (typeof WA_CONSENT_STATUSES)[number];

export const WA_CONSENT_SOURCES = ["STAFF", "TURNERO", "PORTAL", "WHATSAPP"] as const;
export type WaConsentSource = (typeof WA_CONSENT_SOURCES)[number];

/** Modo del canal (`WHATSAPP_MODE`, C-WA1). `off` no tiene cuenta: el CHECK de M15 solo admite los otros tres. */
export type WaMode = "off" | "fake" | "sandbox" | "live";
export type WaAccountMode = Exclude<WaMode, "off">;

/**
 * Versión del texto de consentimiento (C-WA9). Se guarda en `Patient.waConsentVersion` (CHECK
 * `^[a-z0-9.-]{1,32}$`): si el texto legal cambia, sube la versión y se sabe qué aceptó cada paciente.
 */
export const WA_CONSENT_VERSION = "wa-2026-10-v1";

// ── Motivos ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Por qué no se le puede escribir a un paciente (la sección del drawer y la ficha del paciente):
 *   - `no_account`: el consultorio no tiene una cuenta ACTIVE;
 *   - `no_consent`: nunca se le preguntó (`waConsent` NULL);
 *   - `revoked`: dijo que no o respondió BAJA;
 *   - `invalid_phone`: lo cargado no es un celular argentino (`normalizeArMobile`);
 *   - `phone_changed`: el celular actual no es el consentido (WA-D17: el consentimiento no viaja con el número);
 *   - `template_pending`: la plantilla que haría falta no está APPROVED en Meta.
 */
export const WA_CHANNEL_BLOCK_REASONS = [
  "no_account",
  "no_consent",
  "revoked",
  "invalid_phone",
  "phone_changed",
  "template_pending",
] as const;
export type WaChannelBlockReason = (typeof WA_CHANNEL_BLOCK_REASONS)[number];

export type WaPatientChannel = { state: "ready" } | { state: "blocked"; reason: WaChannelBlockReason };

/**
 * Por qué un mensaje de turno no se encola / se salta (`WhatsAppMessage.skipReason`, CHECK `^[a-z_]{1,40}$`).
 * Superset de los del paciente: suma lo que depende del turno.
 */
export const WA_SKIP_REASONS = [
  "not_confirmed",
  "no_patient",
  "no_consent",
  "revoked",
  "invalid_phone",
  "phone_changed",
  "too_soon",
  "no_account",
  "template_pending",
  "mode_changed",
  "document_changed",
  // WA-S2 (handoff aplicado en WA-S3): el aviso era de otro horario (un «reprogramado», un «actualizados» o un
  // recordatorio quedó viejo porque el turno se volvió a mover; el del horario nuevo tiene su propia clave).
  "rescheduled",
] as const;
export type WaSkipReason = (typeof WA_SKIP_REASONS)[number];

/** Clase de un error de Graph (`classifyGraphError`): decide si se reintenta y a quién se le echa la culpa. */
export const WA_ERROR_CLASSES = ["retry", "recipient", "account", "payment", "template", "auth"] as const;
export type WaErrorClass = (typeof WA_ERROR_CLASSES)[number];

// ── DTOs ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WaTemplateView = {
  key: WaTemplateKey;
  name: string;
  status: WaTemplateStatus;
  /** Motivo de rechazo de Meta tal cual (no tiene PHI: es sobre la plantilla). */
  rejectedReason: string | null;
};

/** Configuración → WhatsApp. `null` en la action = el consultorio nunca conectó una cuenta. */
export type WaAccountView = {
  id: string;
  mode: WaAccountMode;
  status: WaAccountStatus;
  setupStep: WaSetupStep;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimit: string | null;
  autoBookingNotice: boolean;
  autoReminder: boolean;
  autoReplyText: boolean;
  /** Meta avisó un problema con el medio de pago del consultorio (`paymentIssueAt`). */
  paymentIssueAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  connectedAt: string;
  templates: WaTemplateView[];
};

/** Una fila del historial de envíos del turno. Sin cuerpo y con el número enmascarado. */
export type WaHistoryItem = {
  id: string;
  kind: WaMessageKind;
  trigger: WaMessageTrigger;
  status: WaMessageStatus;
  toMasked: string;
  /** Horario del turno al que se refería el mensaje (sirve para ver que un aviso viejo es de otro horario). */
  bookingScheduledFor: string | null;
  seriesCount: number | null;
  errorCode: string | null;
  skipReason: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
};

/** Respuesta del paciente al recordatorio (WA-D21/D22). `stale` = respondió a otro horario: la agenda no la muestra. */
export type WaPatientReply = {
  confirmedAt: string | null;
  cancelRequestedAt: string | null;
  replyFor: string;
  stale: boolean;
};

/** Sección WhatsApp del drawer del turno (`getBookingWhatsAppPanel`). */
export type BookingWaPanel = {
  channel: WaPatientChannel;
  history: WaHistoryItem[];
  reply: WaPatientReply | null;
  /** El actor puede mandar el recordatorio a mano (operador de agenda o el profesional del turno). */
  canSendReminder: boolean;
  /** Tope de 1 cada 10 min: hasta cuándo el botón queda deshabilitado (ISO), o null. */
  reminderAvailableAt: string | null;
};
