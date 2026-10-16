/**
 * P4-C (ES4, brief §3.5): forma de los cambios de datos que el paciente pide desde el portal (`PatientChangeRequest.changes`,
 * M1 `plans_booking_link`). Literal de PLANES §12:
 *   { phone?: string|null; email?: string|null;
 *     emergencyContact?: { name: string; relation?: string|null; phone: string } | null;
 *     coverage?: { insurerName: string; planName?: string|null; memberId?: string|null } }
 *
 * Puro (sin DB ni `server-only`): lo usan la action del portal que escribe la solicitud, la del consultorio que la aplica
 * (S24r) y la UI de los dos lados.
 *
 * - `.strict()` en la raíz Y en los objetos anidados: una clave extra (p. ej. `coverage.insurerId`, `dni`) es rechazo, no se
 *   descarta en silencio. Sin eso, el paciente podría colar campos que el consultorio después aplica sin verlos.
 * - Tope de bytes = espejo de `PatientChangeRequest_changes_check` (`octet_length(changes::text) <= 4096`): rechazar acá con
 *   un error de validación en vez de que el INSERT reviente con una violación de CHECK. Ojo: el texto de `jsonb` agrega un
 *   espacio después de `:` y `,`, así que es algo más largo que `JSON.stringify`; con los topes por campo de abajo (≈500
 *   caracteres en total, ≈3 KB aun si todo fueran escapes `\u00XX`) el tope de bytes no se alcanza, y queda como red por si
 *   un tope por campo se agranda.
 * - «Al menos una clave»: una solicitud vacía no tiene nada que revisar y solo ensucia la bandeja del consultorio.
 */
import { z } from "zod";

/** Espejo de `PatientChangeRequest_changes_check` (M1). */
export const PORTAL_PENDING_CHANGES_MAX_BYTES = 4096;

export const PORTAL_PENDING_CHANGE_FIELDS = ["phone", "email", "emergencyContact", "coverage"] as const;
export type PortalPendingChangeField = (typeof PORTAL_PENDING_CHANGE_FIELDS)[number];

export type PortalPendingChangesT = {
  phone?: string | null;
  email?: string | null;
  emergencyContact?: { name: string; relation?: string | null; phone: string } | null;
  coverage?: { insurerName: string; planName?: string | null; memberId?: string | null };
};

/** Texto obligatorio, recortado, no vacío y con tope (en caracteres). */
const req = (max: number) => z.string().trim().min(1).max(max);
/** Texto opcional: `null` borra el valor; un string vacío no es un valor (se manda `null`). */
const opt = (max: number) => req(max).nullable().optional();

/**
 * Teléfono: 6 a 30 caracteres (ES4-Z B2). Antes alcanzaba con 1 («1» llegaba a la bandeja del consultorio como pedido
 * válido). Mismo rango que el alta del consultorio; no se valida el formato (fijos, celulares, con o sin +54).
 */
const phone = () => z.string().trim().min(6).max(30);

const EmergencyContact = z
  .object({
    name: req(80),
    relation: opt(40),
    phone: phone(),
  })
  .strict();

const Coverage = z
  .object({
    insurerName: req(80),
    planName: opt(80),
    memberId: opt(40),
  })
  .strict();

/** Bytes UTF-8 de `JSON.stringify(value)` (contrato §3.5). */
export function pendingChangesByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/** ¿Entra en el CHECK de la tabla? Exportado para testear el tope solo (los topes por campo no dejan llegar a 4097 B). */
export function fitsPendingChangesBudget(value: unknown): boolean {
  return pendingChangesByteLength(value) <= PORTAL_PENDING_CHANGES_MAX_BYTES;
}

export const PortalPendingChanges: z.ZodType<PortalPendingChangesT> = z
  .object({
    phone: phone().nullable().optional(),
    email: z.string().trim().max(120).email().nullable().optional(),
    emergencyContact: EmergencyContact.nullable().optional(),
    coverage: Coverage.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (changedFieldNames(v).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "La solicitud no tiene ningún cambio." });
    }
    if (!fitsPendingChangesBudget(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "La solicitud es demasiado grande." });
    }
  });

/**
 * Nombres de los campos que la solicitud toca, en orden fijo y SIN valores: es lo que va al audit log y a la bandeja del
 * consultorio / `PortalProfileDTO.pending` (los valores son datos personales y no se copian a otros lados).
 * Una clave presente con `undefined` no cuenta (JSON la descarta al guardar).
 */
export function changedFieldNames(c: PortalPendingChangesT): PortalPendingChangeField[] {
  return PORTAL_PENDING_CHANGE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined);
}
