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

/**
 * S24d: estado del form «Pedir un cambio» (`useFormState`, anda sin JS). En error vuelven los valores tipeados para
 * re-llenar el form (sin JS la página se re-renderiza con este estado y los inputs arrancan de `values`).
 */
export type PortalProfileFormState =
  | null
  | { status: "sent"; slug: string; fields: string[]; at: number }
  | { status: "error"; slug: string; error: string; values: Record<string, string> };

/** S24d: estado del «Cerrar sesión en todos lados» (`signOut({ scope: "global" })`). Si sale bien, redirige. */
export type PortalSignOutState = null | { status: "error"; error: string };

/** Nombres de campo en castellano para el aviso de pedidos abiertos (sin valores). */
export const PORTAL_PROFILE_FIELD_LABELS: Record<string, string> = {
  phone: "teléfono",
  email: "email",
  emergencyContact: "contacto de emergencia",
  coverage: "obra social",
};
