/**
 * PV (§27, TK; contrato de PV-K): tipos, límites y copy de los tickets que se abren desde `/contacto` con sesión
 * (`lib/tickets.ts`, `"use server"`, que solo puede exportar funciones async) y de la página `/contacto`.
 *
 * PURO: solo `import type`. Lo importa la página pública, así que nada de server acá.
 */
import type { ActionResult } from "@/lib/validation";
import type { SupportTicketSourceValue } from "@/lib/support-ticket-sources";

/** Estado de `useFormState` del form de sesión (`SessionTicketForm`). `email` = a dónde le respondemos (el de la sesión). */
export type SessionTicketState = ActionResult<{ received: true; email: string }> | null;

/**
 * Tope por usuario en base: 5 tickets cada 24 h (`createdById`). Es además del rate limit en memoria/Upstash de 5 por
 * hora: un usuario bloqueado que reintenta no puede llenar la bandeja ni mandarle 100 mails a Martin.
 */
export const SESSION_TICKET_LIMIT = { limit: 5, windowMs: 24 * 60 * 60_000 } as const;

/**
 * Título y bajada de `/contacto` por origen. TENANT_SUPPORT y PLAN_CHANGE normalmente no se ven (con consultorio usable
 * `/contacto` redirige a Configuración → Soporte), pero el Record es total para que un caso no previsto tenga copy.
 */
export const TICKET_PAGE_COPY: Record<SupportTicketSourceValue, { title: string; sub: string }> = {
  LANDING: {
    title: "Escribinos",
    sub: "Contanos qué necesitás y te respondemos por mail.",
  },
  PRICING: {
    title: "Pedinos el precio",
    sub: "Contanos cuántos profesionales son y qué usan hoy, y te pasamos el precio por mail.",
  },
  PLAN_LIBRE: {
    title: "Armemos tu plan Libre",
    sub: "Contanos cómo trabaja tu consultorio y armamos juntos el plan a tu medida.",
  },
  SIGNUP_ASSISTED: {
    title: "Sumá tu consultorio",
    sub: "Dejanos tus datos y te ayudamos a dar de alta el consultorio.",
  },
  ONBOARDING: {
    title: "¿Necesitás ayuda con el alta?",
    sub: "Contanos en qué paso estás y te ayudamos a terminarla.",
  },
  TENANT_SUPPORT: {
    title: "Escribinos",
    sub: "Contanos qué pasó y te respondemos por mail.",
  },
  PLAN_CHANGE: {
    title: "Elegí tu plan",
    sub: "Contanos qué plan te interesa y te ayudamos con el cambio.",
  },
  TENANT_SUSPENDED: {
    title: "Escribinos por tu consultorio",
    sub: "Contanos qué pasó y vemos juntos cómo reactivarlo.",
  },
  ACCOUNT_DISABLED: {
    title: "Escribinos por tu cuenta",
    sub: "Contanos qué pasó y lo revisamos.",
  },
  PRIVACY: {
    title: "Tus datos personales",
    sub: "Pedinos acceso, corrección o borrado de tus datos. Si sos paciente de un consultorio, escribile primero a tu consultorio.",
  },
};

/** Bajada del form de sesión: la respuesta va al email de la sesión, nunca a uno que se escriba en el form. */
export function sessionTicketSub(email: string): string {
  return `Te respondemos a ${email}.`;
}

export function sessionTicketReceived(email: string): string {
  return `Recibimos tu mensaje. Te respondemos a ${email}.`;
}

/** Segunda opción, solo si hay `NEXT_PUBLIC_SUPPORT_EMAIL` válido (`supportEmail()` de `lib/support-contact.ts`). */
export function sessionTicketMailFallback(email: string): string {
  return `¿Preferís el mail? Escribinos a ${email}.`;
}

export const TICKET_ERROR_COPY = {
  /** Miembro sin rol de Titular/Administrador/a de un consultorio suspendido (`[TK-7]`). */
  notAdmin:
    "Avisale al titular del consultorio: el Titular o un Administrador/a son quienes nos escriben por el consultorio.",
  /** Con un consultorio que se puede usar, el canal es Configuración → Soporte (`[TK-10]`). */
  usableTenant: "Escribinos desde Configuración → Soporte.",
  /** `SESSION_TICKET_LIMIT` o el rate limit por hora (`[TK-11]`). */
  dailyCap: "Ya recibimos tus mensajes de hoy. Te respondemos por mail; si es otra cosa, escribinos mañana.",
  /** La sesión venció entre que se cargó la página y se mandó (`[TK-9]`). */
  noSession: "Tu sesión se cerró. Ingresá de nuevo para escribirnos.",
} as const;
