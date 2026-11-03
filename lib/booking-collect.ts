/**
 * Cobro del copago de un turno: lo puro (T3, C-AS2; plan §23.4). Client-safe, sin DB: lo importan la action
 * (`setBookingCopagoPaid` en `lib/bookings.ts`) y la UI de /sala y del drawer, así el monto que muestra «Marcar
 * pagado · $ 6.000» y lo que valida el server salen de la misma función.
 *
 * Decisión 5 del 19-oct: UN cobro por turno con medio de pago; si hubo seña online (T5), «Pagado» cubre el resto.
 * T5 (TP-P3, C-TP10): las señas reales son `Booking.onlineDepositCents` (Σ de las señas PAID de `OnlineCharge`, la
 * escribe solo el trigger de M18). El caller la pasa como `onlineDepositCents`; `deposits` queda por compatibilidad.
 */
import type { PaymentStatus } from "@prisma/client";
import { canCollectCopago, type Capability } from "@/lib/capabilities";
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import { paymentMethodLabel, type PaymentMethod } from "@/lib/payment-method";

/** Marcar exige el medio (no hay «pagado» sin saber cómo: decisión 5); desmarcar limpia todo y no lleva medio. */
export type CopagoMarkInput = { paid: true; method: PaymentMethod } | { paid: false };

/**
 * Lo que falta cobrar del copago: `resolvedCopagoCents` menos las señas COBRADAS, nunca < 0. Misma regla que
 * `remainingOf` (`lib/online-charge-logic.ts`, la que usan el webhook y el link «lo que falta», C-TP9), fijada con un
 * test de paridad. No se importa de ahí a propósito: este módulo viaja en el bundle de /agenda (drawer, /sala) con un
 * techo de +0,3 kB en T5, y `online-charge-logic` arrastra la decisión del turnero y el saneo del comprobante.
 *
 * Las señas llegan de una de dos formas (el caller pasa UNA; si pasara las dos, se suman):
 * - `onlineDepositCents` (T5): `Booking.onlineDepositCents`, ya es la Σ de las señas PAID. Es la fuente real.
 * - `deposits` (forma de T3): lista con estado; solo resta `status === "PAID"`. Una FAILED nunca entró y una REFUNDED
 *   se devolvió: restarlas haría que la recepción cobre de menos.
 *
 * - Piso 0: si el copago bajó después de la seña (cambio de cobertura), no hay saldo a favor que cobrar acá.
 * - Un monto de seña negativo o no entero se ignora: es un dato corrupto, y sumarlo AUMENTARÍA lo que se cobra al
 *   paciente; ignorarlo falla del lado de cobrar lo que dice el copago. Plata en centavos `Int` (AGENTS.md §4).
 */
export function copagoRemainingCents({
  resolvedCopagoCents,
  deposits = [],
  onlineDepositCents = 0,
}: {
  resolvedCopagoCents: number;
  deposits?: { amountCents: number; status: string }[];
  onlineDepositCents?: number;
}): number {
  let paid = Number.isInteger(onlineDepositCents) && onlineDepositCents > 0 ? onlineDepositCents : 0;
  for (const d of deposits) {
    if (d.status === "PAID" && Number.isInteger(d.amountCents) && d.amountCents > 0) paid += d.amountCents;
  }
  return Math.max(0, resolvedCopagoCents - paid);
}

/** Copy literal de C-AS2 (lo comparten la action y la UI; no se reescribe en cada lado). */
export const COLLECT_COPY = {
  /** `billing.collectOwn` sobre un turno ajeno. */
  ownOnly: "Solo podés registrar el cobro de tus propios turnos.",
  /** Ni `billing.collect` ni `billing.collectOwn`. */
  roleCannotCollect: "Tu rol no registra cobros.",
  /** Gate «insurer» (`canConfirmInsurer`) sin `billing.manage`. */
  // T3-Z (B7): «el titular o el administrador», como en el resto del copy de cobros (antes «administrador/a»).
  insurerOnly: "Solo Facturación, el titular o el administrador confirman pagos de obra social.",
  /** Hay un pago de Mercado Pago de por medio: tocarlo a mano arriesga cobrar dos veces (default del 19-oct). */
  mercadoPagoLocked: "Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.",
  /** Marcar sin medio. */
  methodRequired: "Elegí cómo pagó.",
  /**
   * T3-Z (B3): título ÚNICO del toast de error al cobrar, en /sala, el drawer y Facturación (el detalle del server va
   * en la descripción). Antes /sala mostraba el error pelado y Facturación «No pudimos actualizar el copago».
   */
  collectFailed: "No pudimos registrar el cobro",
  undoFailed: "No pudimos deshacer el cobro",
} as const;

/**
 * Confirm de «Deshacer cobro» (T3-Z, A2). Lo usan el drawer y Facturación: antes Facturación deshacía con un toque al
 * chip, sin preguntar, y el drawer pedía confirmación; el mismo cobro se deshacía distinto según la pantalla.
 * Recibe el monto YA formateado (`formatARS`) para que este módulo no dependa del formateo.
 */
export function UNDO_COLLECT_CONFIRM(amountLabel: string) {
  return {
    title: "¿Deshacer el cobro?",
    message: `El turno vuelve a quedar por cobrar (${amountLabel}) y se borra el medio de pago.`,
    confirmLabel: "Deshacer cobro",
    tone: "danger",
  } as const;
}

/**
 * Estado y acción del cobro del copago (T3d-1r, C-AS2; plan §23.4). Vivía en `billing-rows.tsx` (drawer); T3-Z (A3)
 * lo trae acá para que Facturación diga lo mismo: antes Facturación ofrecía tocar un cobro AUTHORIZED de MP como
 * pendiente y una reserva pública pagada por MP como «Pagado · Sin informar» con deshacer.
 *
 * - **Quién cobra:** `can` (en el wrapper, `canCollectCopago` con las capabilities del viewer y SU profesional, el
 *   mismo gate que el server). Quien no cobra ve solo el estado.
 * - **Mercado Pago no se toca a mano** (default del 19-oct): AUTHORIZED (MP retiene el pago), REFUNDED y una reserva
 *   pública PAID sin medio manual (el webhook legado marca PAID sin `copagoPaymentMethod`) quedan sin botones. El server
 *   además mira la fila `Payment` y rechaza con `COLLECT_COPY.mercadoPagoLocked`; esto solo evita ofrecer lo que va a
 *   rebotar.
 * - **Pagado por un cobro online (T5, C-TP10):** el webhook nuevo marca PAID con medio `MERCADO_PAGO` y SIN quién cobró
 *   (`copagoCollectedById` NULL; un cobro a mano siempre lo lleva desde M12) → «Pagado por Mercado Pago», sin deshacer.
 *   Solo con `copagoCollectedById === null` explícito: una proyección que no trae la columna (`undefined`) no adivina y
 *   conserva el comportamiento de T3 (si alguien registró a mano «Mercado Pago» como medio, ese sí se deshace).
 * - **«Cobrar» solo si hay algo que cobrar:** copago > 0 y el turno no está cancelado ni ausente (mismo criterio que
 *   «Cobrar ahora» de /sala). Deshacer el cobro de un cancelado sí se ofrece (cobro previo de un turno de plan, B-M3).
 * - Sin `paymentStatus` (proyección que no lo trae) no se adivina: ni estado ni botones.
 */
export type CopagoCollectView = { label: string | null; action: "collect" | "undo" | null };

export type CopagoCollectBooking = {
  paymentStatus?: PaymentStatus | null;
  copagoPaymentMethod?: PaymentMethod | null;
  /** T5: quién registró el cobro a mano. `null` + medio MERCADO_PAGO = lo pagó un cobro online (webhook). */
  copagoCollectedById?: string | null;
  publicReservation?: boolean;
  practitionerId: string;
  copagoCents: number;
  status: string;
};

export function copagoCollectViewFor(booking: CopagoCollectBooking, can: boolean): CopagoCollectView {
  const ps = booking.paymentStatus;
  if (!ps) return { label: null, action: null };
  if (ps === "AUTHORIZED") return { label: "Pago retenido por Mercado Pago", action: null };
  if (ps === "REFUNDED") return { label: "Reintegrado por Mercado Pago", action: null };
  if (ps === "PAID") {
    if (booking.copagoPaymentMethod == null && booking.publicReservation === true) {
      return { label: "Pagado por Mercado Pago", action: null };
    }
    if (booking.copagoPaymentMethod === "MERCADO_PAGO" && booking.copagoCollectedById === null) {
      return { label: "Pagado por Mercado Pago", action: null };
    }
    return { label: `Pagado · ${paymentMethodLabel(booking.copagoPaymentMethod ?? null)}`, action: can ? "undo" : null };
  }
  if (booking.copagoCents <= 0) return { label: null, action: null };
  const happened = booking.status !== "CANCELLED" && booking.status !== "NO_SHOW";
  return { label: "Por cobrar", action: can && happened ? "collect" : null };
}

export function copagoCollectView(
  booking: CopagoCollectBooking,
  caps: ReadonlySet<Capability>,
  viewerPractitionerId: string | null
): CopagoCollectView {
  return copagoCollectViewFor(booking, canCollectCopago(caps, viewerPractitionerId, booking.practitionerId));
}

/**
 * [CF2-AD] El turno después de `setBookingCopagoPaid` (brief CF2 A.2): la action no devuelve la fila, solo el
 * `updatedAt` nuevo (la próxima acción lo manda como `expectedUpdatedAt`; con el viejo rebotaría por «cambió en otra
 * sesión») y el medio que quedó. Con medio → PAID; `null` (deshacer) → UNPAID sin medio, lo mismo que escribe
 * `toggleBilling`. Hace falta porque `toggleBilling` no revalida `/agenda`: sin esto, Recepción de la agenda seguiría
 * diciendo «Por cobrar» hasta el próximo refresco.
 *
 * Genérico (no `BookingDTO`) para no atar este módulo a los tipos de `components/`; la paridad con `applyCopagoPaid`
 * de /sala (`desk-pay-modal.tsx`) la fija [CF2-AD12]. `paidOnline` no se toca: un cobro a mano nunca es «pagado
 * online» y a una fila pagada online no se le ofrece cobrar ni deshacer.
 */
export function withCopagoPaid<T extends { updatedAt: string; paymentStatus?: PaymentStatus; copagoPaymentMethod?: PaymentMethod | null }>(
  b: T,
  r: { updatedAt: Date | string; method: PaymentMethod | null }
): T {
  return { ...b, paymentStatus: r.method ? "PAID" : "UNPAID", copagoPaymentMethod: r.method, updatedAt: new Date(r.updatedAt).toISOString() };
}

const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/**
 * Descripción ÚNICA del modal «Registrar cobro» (T3-Z, B2): `paciente · servicio · día y hora`. Antes cada pantalla
 * armaba la suya: /sala «cobertura · profesional · hora», el drawer sin fecha y Facturación sin paciente. T3-Y: el
 * profesional ya no va acá (antes, solo con más de un profesional): lo dice SIEMPRE la línea de imputación
 * (`collectImputationLine`), y repetirlo en la descripción era ruido.
 *
 * Día y hora con `lib/datetime-ar.ts`: con `getDay`/`getHours` del host, en Vercel (UTC) un turno de las 22:00 AR
 * salía al día siguiente a la 01:00.
 */
export function collectModalDescription({
  patientName,
  serviceName,
  scheduledFor,
}: {
  patientName: string;
  serviceName: string;
  scheduledFor: Date | string;
}): string {
  const [, mm, dd] = toARDateKey(scheduledFor).split("-");
  const min = toARMinutes(scheduledFor);
  const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const when = `${DOW_SHORT[toARDow(scheduledFor)]} ${dd}/${mm} ${hhmm}`;
  return [patientName, serviceName, when].filter((s): s is string => !!s).join(" · ");
}

/**
 * Línea «Se imputa a …» de los tres modales de cobro (drawer de la agenda, /sala y Facturación). T3-Y, decisión de
 * Martin del 19-oct: «Estaría bueno que se afirme a quién se le imputa el pago». Con varios profesionales, quien
 * cobra en recepción tiene que ver a quién va la plata antes de confirmar (antes el nombre salía solo en /sala y solo
 * con más de un profesional; el drawer y Facturación no lo decían).
 *
 * - Con profesional y su nombre: `Se imputa a {nombre}`. El nombre es el PÚBLICO (`displayMemberName`): nunca un
 *   email (guard `no-email-as-name`); lo resuelve el caller.
 * - Sin profesional: `Se imputa al consultorio`.
 * - Con profesional pero sin nombre a mano (p. ej. un profesional dado de baja que ya no está en la lista de la
 *   agenda): `Se imputa al profesional del turno`. Decir «al consultorio» ahí sería falso.
 */
export function collectImputationLine({
  practitionerId,
  practitionerName,
}: {
  practitionerId: string | null | undefined;
  practitionerName: string | null | undefined;
}): string {
  if (!practitionerId) return "Se imputa al consultorio";
  const name = practitionerName?.trim();
  return name ? `Se imputa a ${name}` : "Se imputa al profesional del turno";
}
