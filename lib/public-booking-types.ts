/**
 * Non-server-action types + small helpers for the public booking flow.
 * Lives outside `lib/public-booking.ts` because that file is `"use server"`
 * and Next forbids non-async exports there.
 */
import { z } from "zod";
import type { TenantVertical } from "@prisma/client";
import type { ChargeStatus } from "@/lib/online-charge-logic";
import type { PaymentPolicyInput } from "@/lib/booking-payment-policy-types";

/**
 * Lo que ve el wizard público (`getPublicClinic`). Desde B3.2 (motor de
 * disponibilidad) solo trae lo que se ofrece ONLINE: profesionales con
 * membresía aceptada que tengan al menos un servicio habilitado y PUBLIC
 * (`PractitionerService`; sin fila = default de Configuración), y servicios
 * que algún profesional ofrezca así. Los campos marcados "B3.2" son nuevos y
 * OPCIONALES: el wizard actual no los usa; los consume B5.6 (filtros de
 * cobertura y sede, "cualquier profesional").
 */
export type PublicClinic = {
  slug: string;
  name: string;
  legalName: string | null;
  palette: string;
  /** EV1-C2: tipo de consultorio, solo para el copy del wizard (Clínica general
   *  no dice «Kinesiología» ni «sesión»). Opcional para los fixtures viejos:
   *  sin ella, el copy de Kinesiología de siempre. */
  vertical?: TenantVertical;
  /** VX2-d1: horario resumido de las franjas reales («Lun a vie 8 a 19 · Sáb 9 a 13», `summarizeOpeningHours`).
   *  null/ausente = sin franjas vigentes: el turnero no muestra horario (antes decía «lun-sáb 8 a 19hs» fijo). */
  openingSummary?: string | null;
  /**
   * CF3b PH-S (handoff de PH-U2): logo del consultorio, `/<slug>/logo?v=<logoUpdatedAt ms>` (ruta pública que sirve
   * con la sede publicada o el turnero abierto); null/ausente = sin logo. Lo pinta `PractitionerStep` chico sobre la
   * foto de cada profesional. Opcional para los fixtures viejos.
   */
  logoUrl?: string | null;
  practitioners: {
    id: string;
    name: string;
    specialty: string | null;
    licenseNumber: string | null;
    yearsExp: number | null;
    // DIR-D18: sin `rating`. Viajaba al cliente sin que el wizard lo usara y es un dato de seed (nadie escribe
    // `Practitioner.rating`); el directorio tampoco lo publica.
    /** B3.2: sedes donde atiende (sus franjas en sedes activas; sin franjas =
     *  la principal). Orden de `PublicClinic.locations`. */
    locationIds?: string[];
    /** B3.2: coberturas que acepta (ids de `PublicClinic.insurers`).
     *  Sin fila `PractitionerPayer` = aceptada; Particular siempre. */
    acceptedInsurerIds?: string[];
    /** CF3b PH-S (M24, contrato FOTO): `/api/public/pro-photo/<id>?v=<ms>` SOLO con `Practitioner.showPhotoPublic`
     *  (opt-in de este consultorio) y una foto subida; null/ausente = iniciales. Nunca `UserProfile.avatarUrl`.
     *  Opcional para los fixtures viejos. */
    photoUrl?: string | null;
  }[];
  services: {
    id: string;
    name: string;
    description: string | null;
    /** Duración a mostrar: la del servicio, o el override del único
     *  profesional que lo ofrece. Por profesional: `durationByPractitioner`. */
    durationMin: number;
    priceCents: number;
    /**
     * Filtro del wizard actual (`s.practitionerId === elegido || null`).
     * B3.2: si UN solo profesional lo ofrece online, es ese (aunque el
     * servicio sea del consultorio); si lo ofrecen varios, null. Con 3+
     * profesionales y un servicio ofrecido por 2, el wizard viejo lo muestra
     * también al tercero: la lista de horarios sale vacía y el submit lo
     * rechaza (seguro, no ideal) → B5.6 debe filtrar con `practitionerIds`.
     */
    practitionerId: string | null;
    /** B3.2: quiénes lo ofrecen online (habilitado + PUBLIC), en el orden de
     *  `practitioners`. Fuente de verdad para filtrar. */
    practitionerIds?: string[];
    /** B3.2: duración efectiva por profesional (override de PractitionerService). */
    durationByPractitioner?: Record<string, number>;
  }[];
  /** B3.2: sedes activas, la principal primero. */
  locations?: PublicLocation[];
  /** B3.2: coberturas activas del consultorio (sin montos). */
  insurers?: { id: string; name: string; isParticular: boolean }[];
  /**
   * T5 (C-TP8, literal; TP-K1): cobro online del turnero con la cuenta del vendedor. null/ausente = sin cobro online
   * (política OFF, `MP_CONNECT_MODE=off` o ningún profesional con cuenta usable): «Confirmar turno» como TP-0.
   * `practitionerIds`: profesionales con cuenta usable (la propia ACTIVE, o la del consultorio con `useClinicAccount`);
   * para los demás el wizard no ofrece pagar. El wizard COTIZA con el copago de Particular (`particularCopagoCents`,
   * enmienda PEND-a) o, sin él, con `priceCents` (`quoteOnlineCharge`); con obra social no promete número. Si el server
   * cobra otro monto (copago de obra social), el interstitial lo muestra antes de ir a Mercado Pago (TP-UI-D6).
   * Reemplaza a `onlineCheckout` (TP-0, `TURNERO_CHECKOUT=platform`), que TP-2c sacó: la cuenta de la plataforma ya no
   * cobra turnos (H-TP1).
   */
  onlinePayment?: PublicClinicOnlinePayment | null;
  /**
   * WA-S8 (§26.5, contrato para WA-U4): el consultorio avisa por WhatsApp = `WHATSAPP_MODE` ≠ off Y una cuenta del
   * consultorio ACTIVE en ese mismo modo (con otro modo el outbox no manda, C-WA7). Solo con true el wizard muestra la
   * casilla de consentimiento (DESTILDADA, texto `WA_CONSENT_TEXT`) y manda `waConsent` en el submit. Siempre lo
   * setea el server; es opcional solo por los fixtures viejos (ausente = false).
   */
  whatsappNotices?: boolean;
  /**
   * CF3 (D-CF3-1/3, contrato PR-T ↔ PR-P): lo que paga un PARTICULAR nuevo con ESE profesional, por servicio:
   * `particularQuotes[practitionerId][serviceId]` = `particularQuoteCents` de `lib/copago.ts` (precio del profesional →
   * «Particular» del consultorio → precio del servicio), la misma rama sin cobertura de `resolveBookingCopagoCents`
   * que usa el submit. Un profesional con `showPublicPrice=false` NO aparece (el precio no viaja en el HTML); un
   * servicio que no ofrece, tampoco. Ausente = payload viejo → el wizard muestra `priceCents` como siempre
   * (`particularQuoteFor`). Nunca trae copagos de obras sociales.
   */
  particularQuotes?: Record<string /* practitionerId */, Record<string /* serviceId */, number>>;
  /**
   * CF3 (D-CF3-5): profesional con opt-in `showContactForInsured` (y consentimiento v2 vigente sobre su número). Solo
   * el booleano: el número NO viaja en el HTML, lo trae `getInsuredContact` (con rate limit) cuando el paciente con
   * obra social llega al resumen. Clave ausente = false.
   */
  insuredContactAvailable?: Record<string /* practitionerId */, boolean>;
  /**
   * CF3 (D-CF3-5): teléfono público del consultorio (`Tenant.phone`, el mismo que publica el directorio) para el
   * fallback «Consultá tu cobertura con el consultorio» de un paciente con obra social. null/ausente = no hay: solo el
   * texto.
   */
  clinicPhone?: string | null;
};

/**
 * CF3 (D-CF3-5): resultado de `getInsuredContact(slug, practitionerId)` (PR-P). Solo links ya armados y el nombre
 * (mismo criterio que `PublicLeadContact`). `none` = sin opt-in, sin consentimiento, profesional no reservable o slug
 * ajeno (un único valor a propósito: no dice cuál); `rate_limited` = superó el tope. En los dos casos el wizard cae a
 * «Consultá tu cobertura con el consultorio.» (`insuredCoverageText(null, …)`).
 */
export type PublicInsuredContact =
  | { ok: true; name: string; waUrl: string; telUrl: string }
  | { ok: false; reason: "none" | "rate_limited" };

/**
 * C-TP8: `PublicClinic.onlinePayment`. Nunca trae nada de la cuenta (es público) ni copagos de obras sociales.
 *
 * Enmienda de C-TP8 (PEND-a, §26.9; decisión por default de Martin §26.1 #5): `particularCopagoCents` = el copago de
 * Particular (`Insurer.isParticular`, el mismo que lee `getParticularCopagoCents` y que el server usa como base del
 * cobro de un paciente sin cobertura, AUDIT §5.5). Antes el wizard cotizaba con `Service.priceCents` y el server cobraba
 * el copago (hallazgo «particular-en-cero-cotiza» de T5-Z): con Particular en $ 8.000 y el servicio en $ 10.000 el botón
 * prometía $ 10.000; con Particular en $ 0 prometía un pago que no existía. Es el precio de lista para cualquiera que
 * reserve sin obra social: público por naturaleza (lo mismo que ve quien llama al consultorio).
 *   - número (incluido 0): hay fila Particular; 0 = el server no cobra online a un particular.
 *   - null: el consultorio no tiene fila Particular → el server cobra el precio del servicio.
 *   - ausente: payload viejo (fixtures de T5) → el wizard cotiza con el precio, como antes.
 * Solo se lee con el cobro online prendido (dentro de `onlinePayment`): con `MP_CONNECT_MODE=off` o la política en OFF
 * `getPublicClinic` no hace ninguna lectura extra.
 */
export type PublicClinicOnlinePayment = {
  mode: "OPTIONAL" | "REQUIRED";
  chargeKind: PaymentPolicyInput["chargeKind"];
  fixedCents: PaymentPolicyInput["fixedCents"];
  percentBps: PaymentPolicyInput["percentBps"];
  cancellationNote: PaymentPolicyInput["cancellationNote"];
  practitionerIds: string[];
  particularCopagoCents?: number | null;
};

export type PublicLocation = {
  id: string;
  name: string;
  address: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  isPrimary: boolean;
};

/**
 * Un horario de la grilla pública. `locationId` (B3.2, opcional): la sede de
 * la franja donde cae; null/ausente = sin sede configurada. El submit asigna
 * esa sede al turno: el cliente NO la manda.
 */
export type PublicSlot = { iso: string; time: string; available: boolean; locationId?: string | null };

/** "Cualquier profesional" (B3.2, `findFirstPublicSlot`): el primer horario
 *  libre de la grilla pública entre quienes ofrecen el servicio online. */
export type PublicFirstSlot = {
  practitionerId: string;
  iso: string;
  /** "HH:MM" de pared AR. */
  time: string;
  /** "YYYY-MM-DD" AR (para posicionar el calendario del wizard). */
  date: string;
  durationMin: number;
  locationId: string | null;
};

/** Input de `listPublicSlots` (validado en el server: viene de un anónimo). */
export const ListPublicSlotsSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** B3.2: solo franjas de esa sede. */
  locationId: z.string().min(1).max(40).optional(),
});
export type ListPublicSlotsInput = z.infer<typeof ListPublicSlotsSchema>;

/**
 * TP-1 (plan §22.5, TP-D2; contrato literal TP-1s ↔ TP-1u): ventana de 5 días HÁBILES del turnero. Un día hábil es
 * uno en que el profesional atiende (franjas después de excepciones y bloqueos de día completo) y que todavía tiene
 * horarios por delante desde ahora + la anticipación mínima. `slots` trae SOLO los libres; un hábil sin libres viene
 * `full` («Completo»).
 */
export type PublicWindowDay = { date: string /* YYYY-MM-DD AR */; status: "open" | "full"; slots: PublicSlot[] /* solo libres */ };
/**
 * `nextFrom`: desde qué día pedir «Siguientes ›» (el día después del último de la ventana), null si no hay más.
 * `reachedEnd`: la búsqueda llegó al tope (6 semanas / `maxLeadDays` / 90 días) sin completar 5 hábiles, o no queda
 * nada después. `skippedFrom`: si los 5 primeros hábiles estaban completos y la ventana avanzó sola, el `from`
 * pedido (para «No había turnos libres del 19 al 23; te mostramos desde el lun 26»); si no, null.
 * `minLeadMinutes` (CF, decisión 6 / CF-D9): la anticipación EFECTIVA del (profesional, servicio) = PractitionerService
 * > consultorio > 60', para el copy «Los turnos online se piden con al menos N de anticipación» (el wizard la pinta solo
 * si es > 60). Ausente en las ventanas vacías por compuerta (turnero cerrado, servicio ajeno, fuera del tope).
 */
export type PublicSlotWindow = {
  days: PublicWindowDay[];
  nextFrom: string | null;
  reachedEnd: boolean;
  skippedFrom: string | null /* si avanzó solo: desde qué día no había libres */;
  minLeadMinutes?: number;
  /** CF2 (D-CF2-10): contacto del profesional cuando HOY hay lugar libre dentro de la anticipación (que el turnero no
   *  deja reservar). Clave OMITIDA si no corresponde (no `undefined`): la ventana de siempre queda byte a byte igual. */
  leadContact?: PublicLeadContact;
};

/**
 * CF2 (D-CF2-10): lo que el wizard necesita para «¿Necesitás un turno antes?». Solo links ya armados
 * (`buildLeadContact`, `lib/public-lead-contact.ts`) y el nombre: nunca horarios (el paciente coordina con el
 * profesional) ni el número suelto en otra clave.
 */
export type PublicLeadContact = { name: string; waUrl: string; telUrl: string };
export type ListPublicSlotWindowInput = { tenantSlug: string; practitionerId: string; serviceId: string; from?: string /* YYYY-MM-DD; default hoy AR */; locationId?: string };

/** Validación server de `ListPublicSlotWindowInput` (viene de un anónimo). Mismos topes que `ListPublicSlotsSchema`. */
export const ListPublicSlotWindowSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  locationId: z.string().min(1).max(40).optional(),
});

/** Input de `findFirstPublicSlot` ("cualquier profesional", B3.2). */
export const FirstPublicSlotSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  serviceId: z.string().min(1).max(40),
  /** Cobertura del paciente (`PublicClinic.insurers[].id`): solo profesionales que la aceptan. */
  insurerId: z.string().min(1).max(40).optional(),
  locationId: z.string().min(1).max(40).optional(),
  /** Desde qué día AR buscar (default: hoy). */
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type FirstPublicSlotInput = z.infer<typeof FirstPublicSlotSchema>;

export type PublicBookingStatus = {
  bookingId: string;
  status: string;
  paymentStatus: string;
  tenantSlug: string;
  tenantName: string;
  serviceName: string;
  practitionerName: string;
  scheduledFor: string;
  durationMin: number;
  /** Initials only — never the full name, since this endpoint is unauth. */
  patientInitials: string | null;
  /**
   * Con cobro online de T5 (`onlineCharge`): su monto. Con el checkout legado (H-TP2): lo cobrado (PAID) o lo que se
   * espera cobrar (`Payment.expectedAmountCents`); antes mostraba `Payment.amountCents`, que vale 0 hasta que el webhook
   * acredita («$ 0» con el pago pendiente). Sin pago online, el precio del servicio (lo que se paga en el consultorio).
   */
  amountCents: number | null;
  /** true si el turno tiene un cobro online (de T5, o una fila `Payment` del checkout legado). false = reservado sin cobro online. */
  onlinePayment?: boolean;
  /**
   * T5 (C-TP8, literal; TP-K1): el cobro online del turnero de este turno, si hay. `remainingCents` = lo que falta pagar
   * en el consultorio (copago − seña; 0 con FULL pagado). Nunca «$ 0» pendiente: sin cobro, null/ausente.
   * `receipt` solo con el cobro PAID/REFUNDED (`approvedAtLabel` en hora AR).
   */
  onlineCharge?: PublicBookingOnlineCharge | null;
};

/** C-TP8: `PublicBookingStatus.onlineCharge`. Endpoint sin auth: sin token, sin cuenta, sin datos del paciente. */
export type PublicBookingOnlineCharge = {
  kind: "FULL" | "DEPOSIT";
  status: ChargeStatus;
  amountCents: number;
  remainingCents: number;
  receipt: { operationId: string; approvedAtLabel: string; methodLabel: string } | null;
};

/**
 * Resultado de `submitPublicBooking` (contrato TP-0a ↔ TP-0b, plan §22.5; ampliado por C-TP8 de T5, literal):
 *   - `next: "checkout"` → `initPoint` es el link de Checkout Pro de la cuenta del vendedor; el wizard redirige
 *     (con el interstitial si `amountCents` difiere de lo cotizado, TP-UI-D6).
 *   - `next: "reserved"` → turno sin cobro online (`initPoint` null): «¡Turno reservado!».
 *   - `amountCents`: lo que se cobra online (null sin cobro).
 *   - `notice: "payment-unavailable"`: OPTIONAL con «Pagar ahora» y Mercado Pago caído → quedó reservado sin cobro
 *     («No pudimos abrir Mercado Pago: lo pagás en el consultorio.»). REQUIRED con MP caído NO llega acá: es un error
 *     y el reintento usa el mismo cobro (TP-D29).
 */
export type SubmitPublicBookingResult = {
  bookingId: string;
  next: "checkout" | "reserved";
  initPoint: string | null;
  amountCents: number | null;
  notice?: "payment-unavailable";
  /**
   * WA-S8 (contrato para WA-U4): qué pasó con la casilla de WhatsApp. AUSENTE si el submit no mandó `waConsent: true`.
   *   - `"saved"`: quedó el consentimiento anclado al celular tipeado (en replay: el del alta original, misma key);
   *   - `"invalid_phone"`: lo tipeado no es un celular argentino (fijo, sin área…): el turno entró igual, sin
   *     consentimiento → la confirmación NO dice «te avisamos por WhatsApp»;
   *   - `"unavailable"`: el consultorio ya no tiene WhatsApp activo (se desconectó entre la carga y el submit) o apagó
   *     los dos avisos automáticos (ZF2);
   *   - `"not_saved"` (ZF2): la reserva usó una ficha EXISTENTE (por DNI) cuyo celular no es el tipeado, o que dio de
   *     baja los avisos (REVOKED): no se escribe nada (un anónimo con el DNI de otro no puede pisar su consentimiento) y
   *     la confirmación NO promete avisos. Es un único valor para los dos casos a propósito: no dice cuál fue.
   * Trade-off (ZF2): antes el flag dependía solo de la cuenta y del número tipeado; `not_saved` deja ver que ese DNI
   * tiene ficha con otro celular o con baja. Se eligió no prometer avisos que no van a salir (decide Martin).
   */
  whatsappConsent?: TurneroWaConsentOutcome;
};

export type TurneroWaConsentOutcome = "saved" | "invalid_phone" | "unavailable" | "not_saved";
// La decisión (`decideTurneroWaConsent`) vive en `lib/public-booking-wa-consent.ts` (server): ZF2 la sacó de acá
// porque este módulo lo carga el wizard y la decisión value-importaba el normalizador de celulares.

export type PrefillPatient = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  documentId: string;
  dateOfBirth: string;
  coverageInsurer: string;
  coveragePlan: string;
  emergencyName: string;
  emergencyPhone: string;
  notes: string;
};

const MIN_DOB = new Date("1900-01-01");

export const PatientHCSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // trim + minúsculas antes de validar, como `patientEmail` (A2a-S08).
  email: z.string().trim().toLowerCase().email().max(120),
  phone: z.string().trim().min(6).max(30),
  documentId: z.string().trim().min(4).max(20),
  // CF-FORM (§28, decisión 5 de Martin, feedback del cliente): opcional; antes era obligatoria. `""` (el
  // `<input type="date">` vacío), ausente o null → null (`Patient.dateOfBirth` ya es nullable). Si viene, la validación
  // 1900..hoy es la de siempre, y `new Date("YYYY-MM-DD")` sigue siendo la medianoche UTC (excepción de `dateOfBirth`,
  // AUDIT §5.11): no se pasa por `lib/datetime-ar.ts`.
  dateOfBirth: z
    .string()
    .nullish()
    .transform((s) => (s == null || s.trim() === "" ? null : s.trim()))
    .refine((s) => {
      if (s === null) return true;
      const t = new Date(s).getTime();
      if (Number.isNaN(t)) return false;
      const d = new Date(t);
      return d >= MIN_DOB && d <= new Date();
    }, "Fecha de nacimiento inválida"),
  coverageInsurer: z.string().trim().max(80).optional().or(z.literal("")),
  coveragePlan: z.string().trim().max(80).optional().or(z.literal("")),
  emergencyName: z.string().trim().max(80).optional().or(z.literal("")),
  emergencyPhone: z.string().trim().max(30).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  title: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
});

// CF-FORM (§28, decisión 5): el «diagnóstico» obligatorio por vertical NO va en `PatientHCSchema` (la vertical no viaja
// en el request; el submit la lee de la fila del consultorio). La regla vive en `lib/public-wizard-state.ts`
// (`missingTurneroReason` / `isTurneroHcComplete`): este módulo value-importa zod y el wizard solo lo importa como tipo.

export const SubmitSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  // Key de idempotencia POR INSTANCIA del wizard (A2b-S-pub), como en la
  // agenda. Antes era determinística (`tenant:prof:slot:paciente`): re-reservar
  // el mismo horario después de cancelar devolvía el turno CANCELLED viejo
  // (el upsert con `update: {}` no lo revivía) y el paciente pagaba un turno
  // cancelado. El wizard la rota cuando cambia el horario elegido.
  idempotencyKey: z.string().uuid(),
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  scheduledFor: z.string().min(1),
  patient: PatientHCSchema,
  // T5 (C-TP8): elección del paciente en OPTIONAL («Pagar ahora con Mercado Pago» = true, «Reservar y pagar en el
  // consultorio» = false). Sin preselección (TP-UI-D5): ausente con OPTIONAL = no eligió, y el server no cobra. Con
  // REQUIRED se ignora (siempre cobra); con OFF también (nunca cobra).
  payNow: z.boolean().optional(),
  // WA-S8 (§26.5, WA-D3): la casilla «Quiero recibir avisos de este turno por WhatsApp» (destildada por defecto). Solo
  // cuenta con `whatsappNotices` true y un celular AR válido; si no, se ignora sin error (ver `whatsappConsent`).
  waConsent: z.boolean().optional(),
});

export type SubmitPublicBookingInput = z.infer<typeof SubmitSchema>;

/**
 * DNI normalizado para matchear fichas (H4): sin puntos, espacios ni guiones,
 * en mayúsculas. "30.123.456", "30 123 456" y "30123456" son la misma persona.
 * El match se hace contra la columna normalizada igual (SQL `regexp_replace`),
 * así que una ficha cargada a mano con puntos también matchea.
 */
export function normalizeDocumentId(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

/** Teléfono comparable: solo dígitos. Para decidir si el contacto "difiere". */
export function normalizePhoneForCompare(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}
