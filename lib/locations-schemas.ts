/**
 * Zod y tipos de Sedes (B2.4a CFG-api-1). Fuera del archivo `"use server"`
 * (`lib/locations.ts` exporta solo funciones async).
 */
import { z } from "zod";

/** "" / null / undefined → null; el resto, trim + tope. */
const optText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const t = typeof v === "string" ? v.trim() : "";
      return t ? t : null;
    })
    .pipe(z.string().max(max, `Máximo ${max} caracteres`).nullable());

export const LocationId = z.string().trim().min(1).max(64);

export const LocationInput = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(80, "Máximo 80 caracteres"),
  address: optText(160),
  addressLine2: optText(120),
  city: optText(80),
  province: optText(80),
  postalCode: optText(16),
  phone: optText(40),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});
export type LocationInputRaw = z.input<typeof LocationInput>;

export type LocationRow = {
  id: string;
  name: string;
  address: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  isPrimary: boolean;
  active: boolean;
  sortOrder: number;
  /** Franjas semanales cargadas en esta sede (todas, sin mirar vigencia). */
  scheduleCount: number;
};

/** Lo que impide archivar una sede (la UI lo muestra como lista). */
export type LocationArchiveBlockers = {
  /** Franjas vigentes (sin `validUntil` o con `validUntil` >= hoy AR). */
  activeSchedules: number;
  /** Turnos no cancelados desde ahora en adelante en esta sede. */
  futureBookings: number;
  /** Excepciones de horario (CUSTOM_HOURS) de hoy en adelante que la usan. */
  futureExceptions: number;
};

export type ArchiveLocationResult =
  | { ok: true; data: undefined }
  | { ok: false; error: string; blockers?: LocationArchiveBlockers };
