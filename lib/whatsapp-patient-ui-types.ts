/**
 * WA-U3 (T6, brief §26.5 «Consentimiento en el paciente» + «Compartir ficha») · Tipos que el server
 * (`lib/whatsapp-patient-ui.ts`, "use server") le devuelve a la UI del paciente. Archivo aparte porque un "use server"
 * exporta solo funciones async, y los componentes cliente no pueden importar tipos desde un módulo que arrastra la
 * sesión.
 */
import type { WaChannelBlockReason, WaConsentSource, WaConsentStatus } from "@/lib/whatsapp/types";

/**
 * Lo que muestra «Editar paciente» en la fila de WhatsApp. Nunca el número consentido (`waPhoneE164`): solo si el
 * teléfono cargado hoy sigue siendo ese (WA-D17).
 */
export type PatientWaConsentState = {
  status: WaConsentStatus | null;
  /** ISO del último cambio de estado (`waConsentAt`); null = nunca se preguntó. */
  at: string | null;
  source: WaConsentSource | null;
  /** El teléfono cargado hoy es un celular válido (si no, no se puede otorgar: el server lo rechaza). */
  phoneValid: boolean;
  /** GRANTED con otro número que el cargado hoy: hay que volver a pedirlo. */
  phoneChanged: boolean;
  /** GRANTED de una versión vieja del texto legal. */
  versionOutdated: boolean;
};

/** Lo que necesita el diálogo de compartir ficha para ofrecer «Enviar también por WhatsApp». */
export type PatientWaShareInfo = { available: true } | { available: false; reason: WaChannelBlockReason };
