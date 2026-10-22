/**
 * [TP-K4] Contratos de UI de T5 (cobros online con la cuenta de Mercado Pago del vendedor, ADR-026): las props
 * CONGELADAS de los componentes que T5e (TP-3a/3b/3c/3d) completa en paralelo y que montan el drawer del turno,
 * Facturación del paciente, /cobros, la Sala y Configuración.
 *
 * Por qué un archivo aparte y congelado: en T5e hay ~10 sesiones de UI en paralelo y cada una monta el componente de
 * otra (TP-3c abre el `PaymentLinkDrawer` de TP-3d desde el drawer del turno; TP-3f1/3f2/3g lo abren desde la Sala,
 * Facturación y /cobros; TP-3a registra los paneles de TP-3a/3b). Si las props se decidieran adentro de cada sesión,
 * el integrador tendría que reconciliar cinco formas distintas del mismo drawer. Cambiar una forma acá es cambiar un
 * contrato: se avisa al orquestador, no se toca a mano.
 *
 * Solo tipos (`import type`): este archivo no pesa nada en ningún bundle. Los DTOs NO se redefinen: salen de los tipos
 * de TP-K1 (`lib/online-payments-types.ts`, `lib/mp-connect-types.ts`, `lib/payment-links-types.ts`) y del comprobante
 * de TP-P5 (`lib/mp-receipt.ts`).
 */
import type { MpReceiptView as MpReceiptData } from "@/lib/mp-receipt";
import type { MpAccountView, MpConnectReturn, OnlinePaymentsSettingsView } from "@/lib/mp-connect-types";
import type { CreatePaymentLinkResult } from "@/lib/payment-links-types";

export type { MpReceiptData };

// ── PaymentLinkDrawer (TP-3d) ───────────────────────────────────────────────────────────────────────────────────────

/** Desde dónde se abre el drawer compartido (§25.10: drawer del turno, Facturación, /cobros, Sala). */
export type PaymentLinkSurface = "agenda" | "facturacion" | "cobros" | "sala";

/**
 * El turno del link. Con turno, «¿Cuánto?» sale de `getPaymentLinkSuggestions` (lo que falta / la seña / el total) y el
 * concepto por default es `defaultLinkConcept(startsAt)` («Turno del lun 20/10 a las 10:00», sin el servicio,
 * TP-UI-D12). El profesional es el del turno: la cuenta la resuelve el server.
 */
export type PaymentLinkBookingRef = {
  id: string;
  /** ISO UTC; el concepto lo pasa a hora AR. */
  startsAt: string;
  practitionerId: string;
  practitionerName: string;
};

export type PaymentLinkPractitionerOption = { id: string; name: string };

export type PaymentLinkDrawerProps = {
  open: boolean;
  onClose: () => void;
  surface: PaymentLinkSurface;
  /** Paciente del link (el nombre solo se ve en el staff; nunca viaja al link ni al email, C-TP9). */
  patient: { id: string; name: string };
  /** null = link sin turno (`FREE`): el monto es obligatorio y el profesional se elige de `practitioners`. */
  booking: PaymentLinkBookingRef | null;
  /** Solo sin turno: a qué profesional (y a qué cuenta) va el link. Con turno se ignora. */
  practitioners: PaymentLinkPractitionerOption[];
  /** Solo sin turno: el preseleccionado (el profesional del actor, o el único). */
  defaultPractitionerId?: string | null;
  /** El link quedó creado (paso «Link listo»): el caller refresca su lista. */
  onCreated?: (link: CreatePaymentLinkResult) => void;
};

// ── Comprobante (TP-3d; TP-UI-D11) ──────────────────────────────────────────────────────────────────────────────────

export type MpReceiptViewProps = {
  /**
   * Comprobante ya armado por `buildMpReceipt` (lib/mp-receipt.ts): las filas vienen formateadas en hora AR. Con
   * `account` en la entrada son 7 filas (test 3c); sin `account`, 6.
   */
  receipt: MpReceiptData;
  /** `collapsible`: plegable (drawer del turno). `plain`: la lista sola, para un Modal (Facturación, /cobros). */
  variant: "collapsible" | "plain";
  /** Solo con `collapsible`. */
  defaultOpen?: boolean;
};

// ── Sección de plata del drawer del turno (TP-3c) ───────────────────────────────────────────────────────────────────

/**
 * Lo que la sección necesita del turno. Sale del DTO que ya tiene el drawer más el cable de la agenda (`od`/`po`,
 * C-TP10). `status`/`paymentStatus` como string para no arrastrar los enums de Prisma al cliente.
 */
export type BookingMoneySectionBooking = {
  id: string;
  patientId: string | null;
  patientName: string;
  practitionerId: string;
  practitionerName: string;
  /** ISO UTC. */
  startsAt: string;
  status: string;
  paymentStatus: string;
  /** Copago resuelto (el que cobra el modal); null = sin resolver. */
  copagoCents: number | null;
  /** `od` del cable: Σ de señas PAID (0 si no hay). */
  onlineDepositCents: number;
  /** `po` del cable: el turno se pagó entero por Mercado Pago. */
  paidOnline: boolean;
};

export type BookingMoneySectionProps = {
  booking: BookingMoneySectionBooking;
  /** `billing.collect` (o `collectOwn` sobre su propio turno). Sin esto no hay «Generar link de pago». */
  canCollect: boolean;
  /**
   * Pista extra de que el turno tiene algo online que el cable no dice (p. ej. un link vivo). Sin pistas la sección NO
   * llama a `getBookingOnlineCharges` (test 3c).
   */
  onlineHint?: boolean;
  /** Abre el modal de cobro por lo que falta (copago − seña). */
  onCollectRemaining?: (remainingCents: number) => void;
  /** Se creó o anuló un link: el drawer refresca el turno. */
  onChanged?: () => void;
};

// ── Configuración (TP-3a / TP-3b) ───────────────────────────────────────────────────────────────────────────────────

export type OnlinePaymentsPanelProps = {
  /** `getOnlinePaymentsSettings()` (tenant.sensitive). Las acciones de la cuenta del consultorio: `canManageClinicAccount`. */
  settings: OnlinePaymentsSettingsView;
  /** Precio de referencia para la vista previa de «¿Cuánto se cobra online?»; null = sin vista previa. */
  previewServicePriceCents: number | null;
  /** `?mp=` con el que volvió el callback de la cuenta del consultorio. */
  mpReturn: MpConnectReturn | null;
  /** Sesión de soporte: solo lectura. */
  support?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export type MyMpPanelProps = {
  /** `getMyMpAccount()`; `MP_ACCOUNT_NONE` si nunca conectó. */
  account: MpAccountView;
  /** `?mp=` con el que volvió el callback. */
  mpReturn: MpConnectReturn | null;
  /** Sesión de soporte: solo lectura (conectar se rechaza igual en la action). */
  support?: boolean;
};
