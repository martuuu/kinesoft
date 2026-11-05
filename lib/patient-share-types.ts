/**
 * CF3 (D-CF3-8, sesión SH-S) · contrato de «Compartir desde el perfil»: lo que devuelve `getPatientShareBundle`
 * (`lib/booking-share-actions.ts`) y lo que pinta el menú del teléfono del perfil (SH-U).
 *
 * Tipos solos (sin runtime): un `"use server"` exporta solo funciones async, y el client component los importa sin
 * arrastrar el server.
 *
 * Lo que NUNCA viaja acá: título del turno, notas, descripción, diagnóstico ni título del plan. La lista la puede pedir
 * la Secretaria (acceso `admin`, PD-13) y termina en el chat del paciente; `cf3-patient-share.test.ts` fija las claves.
 */
import type { PhoneActions, ShareContact } from "@/lib/booking-share";

/**
 * Un turno próximo, en la forma mínima que necesitan el recordatorio y «Próximos turnos». Es también el `nextBooking`
 * del perfil `full` (`lib/patient-profile-loader.ts`): misma lectura, mismas claves.
 */
export type PatientShareBooking = {
  bookingId: string;
  /** ISO (UTC). El texto lo formatea en hora AR (`formatDateAR`), nunca con el reloj del host. */
  startsAt: string;
  serviceName: string;
  /** Nombre público del profesional (`publicPractitionerName`: nunca el email). */
  practitionerName: string;
  durationMin: number;
  /** La sede del turno solo si el consultorio tiene más de una activa (con una sola, nombrarla es ruido); si no, null. */
  locationName: string | null;
  /** Solo con `isTelemedicine`. `bookingReminderText` además lo descarta si no es `https://`. */
  telemedicineUrl: string | null;
};

export type PatientShareUpcoming = PatientShareBooking & {
  /**
   * Puede generar un link de pago de ESTE turno: cobros online prendidos y `canCollectCopago` sobre su profesional
   * (`billing.collect`, o `billing.collectOwn` si el turno es suyo). Los bloqueos del turno (ya pagado, link vivo)
   * los sigue diciendo `createPaymentLink`.
   */
  canPaymentLink: boolean;
};

/** Contacto visible: el estado de siempre (`ShareContact` sin `hidden`) más las acciones del teléfono. */
export type PatientShareContactVisible = Exclude<ShareContact, { status: "hidden" }> & { phone: PhoneActions };

export type PatientShareBundleHidden = { contact: { status: "hidden" } };

export type PatientShareBundleVisible = {
  contact: PatientShareContactVisible;
  firstName: string;
  clinicName: string;
  /** URL absoluta del turnero del consultorio; null si está cerrado (switch apagado o consultorio suspendido). */
  turneroUrl: string | null;
  /** ≤ `UPCOMING_SHARE_MAX` futuros no cancelados ni ausentes, del más cercano al más lejano. */
  upcoming: PatientShareUpcoming[];
  /**
   * «Link de pago» sin turno (desde el teléfono): cobros online + `billing.collect`, o `billing.collectOwn` con acceso
   * `full` al paciente (la misma regla que `createPaymentLink` sin `bookingId`). Soporte nunca.
   */
  canPaymentLink: boolean;
  /** «Invitar al portal»: acceso `full`, email cargado y consultorio que puede escribir (como `sendPatientPortalInvite`). */
  canPortalInvite: boolean;
};

/** `hidden` = el actor no ve el contacto (nivel `basic`/`none`, otro tenant, id malo): sin turnos ni nada más. */
export type PatientShareBundle = PatientShareBundleHidden | PatientShareBundleVisible;
