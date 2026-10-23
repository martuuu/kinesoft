/**
 * WA-S1 (T6, C-WA6/C-WA9, brief §26.5) · Tipos y copy de la conexión de WhatsApp, client-safe.
 *
 * Por qué un módulo aparte: `lib/whatsapp-actions.ts` es `"use server"` (solo exporta funciones async) y
 * `lib/whatsapp/account-internal.ts` es `server-only`; Configuración → WhatsApp (WA-U1) necesita los tipos de lo que
 * devuelven las actions y el copy de los errores del alta sin arrastrar nada de servidor al bundle.
 *
 * Nada de token, PIN ni ids de credencial acá: lo que cruza al cliente es `WaAccountView` (sin secretos, C-WA6).
 */
import { BRAND_NAME } from "@/lib/brand";
import type { WaAccountMode, WaAccountStatus, WaAccountView, WaMode, WaSetupStep } from "@/lib/whatsapp/types";

/**
 * Por qué no se pudo completar el alta (C-WA6):
 *   - `expired`: la cookie del alta venció o no es de esta sesión/consultorio/intento, o Meta rechazó el `code`
 *     (vive 30 s y es de un solo uso) → hay que volver a abrir la ventana de Meta;
 *   - `app_mismatch`: el token es de OTRA app de Meta (no de la nuestra);
 *   - `scopes`: el WABA elegido no está en los dos permisos (`whatsapp_business_management` y
 *     `whatsapp_business_messaging`): el consultorio destildó algo en la ventana de Meta;
 *   - `phone_not_in_waba`: el número que eligió no es de ese WABA;
 *   - `in_use`: ese número (o ese WABA) ya está conectado en otro consultorio;
 *   - `network`: Meta no respondió (red, timeout, 5xx). Se puede reintentar.
 */
export const WA_SIGNUP_ERRORS = ["expired", "app_mismatch", "scopes", "phone_not_in_waba", "in_use", "network"] as const;
export type WaSignupError = (typeof WA_SIGNUP_ERRORS)[number];

export const WA_SIGNUP_ERROR_COPY: Record<WaSignupError, string> = {
  expired: "La conexión con Meta venció. Volvé a tocar «Conectar WhatsApp» y completá la ventana de Meta de nuevo.",
  app_mismatch: `La autorización no es de ${BRAND_NAME}. Volvé a conectar desde este botón.`,
  scopes: "Faltan permisos sobre la cuenta de WhatsApp Business que elegiste. Volvé a conectar y dejá tildados todos los permisos.",
  phone_not_in_waba: "El número que elegiste no pertenece a esa cuenta de WhatsApp Business. Volvé a conectar y elegí el número de nuevo.",
  in_use: "Ese número de WhatsApp ya está conectado en otro consultorio. Desconectalo allá o usá otro número.",
  network: "Meta no respondió. Probá de nuevo en unos minutos.",
};

/** Prueba de envío (WA-D28): tope por consultorio y por día AR. */
export const WA_TEST_DAILY_LIMIT = 5;

/** Lo que el cliente necesita para abrir el Embedded Signup (`startWhatsAppConnect`). Sin secretos. */
export type WaConnectStart = {
  mode: WaAccountMode;
  appId: string;
  configId: string;
  graphVersion: string;
  /** `extras.featureType` del Embedded Signup (coexistencia), o null. */
  feature: string | null;
  /** Solo con el simulador: la página del popup de Meta falso. */
  fakeDialogUrl?: string;
  /** Vuelve en `completeWhatsAppConnect`: ata el `code` a ESTE intento (cookie `kine_wa_signup`). */
  nonce: string;
};

/** Resultado de los pasos retomables (SUBSCRIBED → REGISTERED → TEMPLATES → DONE). */
export type WaSetupOutcome = {
  status: WaAccountStatus;
  setupStep: WaSetupStep;
  /** true = la cuenta quedó ACTIVE; false = falta retomar (`resumeWhatsAppSetup`). */
  done: boolean;
  /** Último error de Meta del paso que frenó (`clase:código`), nunca el mensaje de Meta. */
  errorCode: string | null;
};

export type WaSettingsInput = {
  autoBookingNotice?: boolean;
  autoReminder?: boolean;
  autoReplyText?: boolean;
};

/** Configuración → WhatsApp (`getWhatsAppPanel`). `null` en la action = el actor no ve la pestaña. */
export type WaPanel = {
  mode: WaMode;
  /** La cuenta viva, o la última desconectada (para «Desconectado el …»), o null (nunca se conectó). */
  account: WaAccountView | null;
  /** Conectar, retomar y desconectar: solo el Titular (`account.owner`), con step-up. */
  canManage: boolean;
  /** Switches y prueba: `tenant.sensitive`. */
  canConfigure: boolean;
  testsLeftToday: number;
};

export type WaTestResult = { status: "SENT" | "FAILED"; errorCode: string | null; testsLeftToday: number };
