import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import {
  LEAD_CLINIC_MAX,
  LEAD_EMAIL_MAX,
  LEAD_NAME_MAX,
  LEAD_PHONE_MAX,
  SUPPORT_BODY_MAX,
} from "@/lib/support-threads-types";
import type { ContactFormLimits, PlanOption } from "@/components/landing/contact-form";

/**
 * Opciones del form de lead, compartidas por la landing (`LandingContact`, VX2-c2) y `/contacto` (PV §27, TK-U2).
 * Solo server: las etiquetas de plan y los topes de largo se resuelven acá y viajan como props, así el bundle público
 * no arrastra la matriz de módulos ni `lib/support-threads-types` (que importa formato de fechas). Los largos son el
 * espejo de los CHECK de M8 en un solo lugar. Salieron de `components/landing/contact.tsx` para que `/contacto` no
 * importe la sección entera de la landing.
 */
export const CONTACT_PLAN_OPTIONS: PlanOption[] = (["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const).map(
  (value) => ({ value, label: SAAS_PLAN_LABEL[value] })
);

export const CONTACT_LIMITS: ContactFormLimits = {
  name: LEAD_NAME_MAX,
  email: LEAD_EMAIL_MAX,
  phone: LEAD_PHONE_MAX,
  clinicName: LEAD_CLINIC_MAX,
  message: SUPPORT_BODY_MAX,
};

/** `?plan=` crudo → plan del form, o undefined si no es uno de los que ofrece el select (no preselecciona nada). */
export function contactPlanOf(raw: unknown): PlanOption["value"] | undefined {
  return typeof raw === "string" ? CONTACT_PLAN_OPTIONS.find((p) => p.value === raw.trim().toUpperCase())?.value : undefined;
}
