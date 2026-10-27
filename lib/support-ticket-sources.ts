/**
 * PV (§27, contrato de PV-K): origen de un ticket de soporte (`SupportThread.source`, M19 `support_tickets`).
 *
 * Decisión de Martin (literal, 27-oct): «que todos los contactos de formularios y consultas a soporte vayan a la parte
 * de /plataforma de Superadmin, y se abran como "tickets" para resolver desde ahi». Cada entrada (la web, el alta, las
 * pantallas de cuenta, Configuración → Soporte) llega a `/contacto?motivo=<slug>` y el slug decide el origen.
 *
 * PURO y SIN imports a propósito: lo importa la página pública `/contacto` y el form de la landing, y el bundle público
 * no puede arrastrar `@prisma/client` ni nada del server (`tests/unit/pv-k-tickets.test.ts` lo fija). Por eso los
 * valores están copiados del enum de Prisma `SupportTicketSource` y del CHECK `SupportThread_source_check` de M19; el
 * mismo test compara las tres listas para que no se desincronicen.
 */

export const SUPPORT_TICKET_SOURCES = [
  "LANDING",
  "PRICING",
  "PLAN_LIBRE",
  "SIGNUP_ASSISTED",
  "ONBOARDING",
  "TENANT_SUPPORT",
  "PLAN_CHANGE",
  "TENANT_SUSPENDED",
  "ACCOUNT_DISABLED",
  "PRIVACY",
] as const;

export type SupportTicketSourceValue = (typeof SUPPORT_TICKET_SOURCES)[number];

/** Orígenes válidos para un hilo TENANT (espejo del CHECK de M19). */
export const TENANT_TICKET_SOURCES = ["TENANT_SUPPORT", "PLAN_CHANGE", "TENANT_SUSPENDED", "PRIVACY"] as const;

/**
 * Orígenes válidos para un hilo LEAD (espejo del CHECK de M19). PRIVACY está en los dos: un pedido ARCO puede venir de
 * alguien sin cuenta (LEAD) o del Titular desde adentro (TENANT).
 */
export const LEAD_TICKET_SOURCES = [
  "LANDING",
  "PRICING",
  "PLAN_LIBRE",
  "SIGNUP_ASSISTED",
  "ONBOARDING",
  "ACCOUNT_DISABLED",
  "PRIVACY",
] as const;

export type TenantTicketSourceValue = (typeof TENANT_TICKET_SOURCES)[number];
export type LeadTicketSourceValue = (typeof LEAD_TICKET_SOURCES)[number];

export const TICKET_SOURCE_LABEL: Record<SupportTicketSourceValue, string> = {
  LANDING: "Web · contacto",
  PRICING: "Web · precios",
  PLAN_LIBRE: "Plan Libre",
  SIGNUP_ASSISTED: "Alta asistida",
  ONBOARDING: "Alta en curso",
  TENANT_SUPPORT: "Soporte del consultorio",
  PLAN_CHANGE: "Elegir plan",
  TENANT_SUSPENDED: "Consultorio suspendido",
  ACCOUNT_DISABLED: "Cuenta desactivada",
  PRIVACY: "Privacidad",
};

/** Slug de `?motivo=` → origen. Biyectivo: cada origen tiene un único slug (`motivoOfSource`). */
export const TICKET_MOTIVO = {
  contacto: "LANDING",
  precio: "PRICING",
  "plan-libre": "PLAN_LIBRE",
  alta: "SIGNUP_ASSISTED",
  onboarding: "ONBOARDING",
  soporte: "TENANT_SUPPORT",
  plan: "PLAN_CHANGE",
  suspendido: "TENANT_SUSPENDED",
  cuenta: "ACCOUNT_DISABLED",
  privacidad: "PRIVACY",
} as const satisfies Record<string, SupportTicketSourceValue>;

export type TicketMotivo = keyof typeof TICKET_MOTIVO;

const SOURCE_TO_MOTIVO = Object.fromEntries(
  Object.entries(TICKET_MOTIVO).map(([slug, source]) => [source, slug])
) as Record<SupportTicketSourceValue, TicketMotivo>;

const SOURCE_SET: ReadonlySet<string> = new Set(SUPPORT_TICKET_SOURCES);

export function isSupportTicketSource(v: unknown): v is SupportTicketSourceValue {
  return typeof v === "string" && SOURCE_SET.has(v);
}

/**
 * `?motivo=` crudo → origen. Desconocido, vacío o de otro tipo → `LANDING`: un link viejo o mal armado nunca le muestra
 * un error a quien quiere escribirnos. `hasOwnProperty` y no `in`: `?motivo=constructor` no puede resolver a
 * `Object.prototype.constructor`.
 */
export function ticketSourceFromMotivo(raw: unknown): SupportTicketSourceValue {
  if (typeof raw !== "string") return "LANDING";
  const slug = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TICKET_MOTIVO, slug) ? TICKET_MOTIVO[slug as TicketMotivo] : "LANDING";
}

export function motivoOfSource(source: SupportTicketSourceValue): TicketMotivo {
  return SOURCE_TO_MOTIVO[source];
}

/**
 * Origen efectivo de un hilo. `source` NULL = fila insertada por el código viejo entre M19 y el deploy (el backfill de
 * M19 cubrió las anteriores): se lee con el mismo default que usó el backfill (TENANT → TENANT_SUPPORT, LEAD →
 * LANDING). Un valor fuera del catálogo (código más nuevo que este bundle) cae al mismo default en vez de romper la UI.
 */
export function ticketSourceOf(
  kind: "TENANT" | "LEAD",
  source: SupportTicketSourceValue | string | null | undefined
): SupportTicketSourceValue {
  if (isSupportTicketSource(source)) return source;
  return kind === "TENANT" ? "TENANT_SUPPORT" : "LANDING";
}

/** ¿El CHECK de M19 acepta este origen para este kind? Para validar ANTES de escribir (y no comerse un 23514). */
export function isTicketSourceAllowed(kind: "TENANT" | "LEAD", source: unknown): boolean {
  const list: readonly string[] = kind === "TENANT" ? TENANT_TICKET_SOURCES : LEAD_TICKET_SOURCES;
  return typeof source === "string" && list.includes(source);
}
