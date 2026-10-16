/**
 * P4-C (ES4, brief §3.5): DTO de «Mis datos» del portal. Tipos puros.
 *
 * `pending` lleva solo los NOMBRES de los campos con una solicitud de cambio abierta (`changedFieldNames` de
 * `lib/portal-pending-changes.ts`), nunca los valores pedidos: el perfil muestra «Pediste cambiar tu teléfono» y lo que
 * vale es lo que el consultorio apruebe.
 */
export type PortalProfileDTO = {
  email: string;
  fullName: string | null;
  tenants: {
    slug: string;
    name: string;
    patientName: string;
    /** Turnero público abierto (`turneroPublico`): habilita «Reservar turno». */
    canBook: boolean;
  }[];
  pending: { slug: string; fields: string[]; /** ISO 8601. */ updatedAt: string }[];
};
