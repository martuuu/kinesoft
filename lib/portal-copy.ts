import type { TenantVertical } from "@prisma/client";
import type { PortalSection } from "./portal-nav";

/**
 * [VX2-f · D-VX28] Copy del portal del paciente, por vertical del consultorio. Puro (sin server-only ni React): lo
 * consumen las pages server y los forms cliente del portal, y lo extiende ES4 (portal completo) sin tocar las pages.
 *
 * Por qué existe: el portal le hablaba a todos como si fueran pacientes de kinesiología («Tu recuperación…», «la
 * evolución de tu dolor», «sesión por sesión», «Check-in pre-sesión»), y un paciente de un consultorio de Clínica
 * general no tiene planes ni «sesiones» (lib/tenant-modules.ts). Regla de brief-vx §3: «turno» es el genérico,
 * «sesión» solo en Kinesiología. La vertical es **por ficha** (`PortalPatient.tenantVertical`): el mismo email puede
 * ser paciente de un Kine y de un General, así que nada de esto se decide por usuario.
 *
 * Lo cubre el guard de claims (`tests/unit/public-claims.test.ts`) y `tests/unit/portal-copy.test.ts`.
 */

export function isKinePortal(vertical: TenantVertical): boolean {
  return vertical === "KINESIOLOGY";
}

/** Home y pantalla de ingreso: sin saber de qué consultorio viene, el copy es neutral (vale para las dos verticales). */
export const PORTAL_HOME = {
  title: "Tus turnos y tu tratamiento, en un solo lugar",
  signInLead: "Entrá para ver tus próximos turnos y tu tratamiento.",
  // VX-Z: sin «Nada se publica.» (no decía qué no se publica ni por qué lo preguntaría alguien; sonaba a disclaimer).
  signInFootnote: "Usá el mismo email que tiene tu ficha en el consultorio.",
  upcomingTitle: "Próximos turnos",
  noUpcoming: "No tenés turnos próximos.",
  bookCta: "Sacar un turno",
} as const;

/** «sesión» solo en Kinesiología; en Clínica general, «turno». */
export function portalSessionWord(vertical: TenantVertical): { one: string; many: string } {
  return isKinePortal(vertical) ? { one: "sesión", many: "sesiones" } : { one: "turno", many: "turnos" };
}

/** Progreso del plan: «3 / 10 sesiones» (Kine) o «3 / 10 turnos» (General). */
export function portalPlanProgress(vertical: TenantVertical, completed: number, total: number): string {
  return `${completed} / ${total} ${portalSessionWord(vertical).many}`;
}

/**
 * Tarjeta de la ficha en la home. `noPlan` = null en General: no tiene planes de tratamiento, así que decirle «todavía
 * no tenés un plan» le promete algo que el consultorio no usa.
 */
export function portalPatientCardCopy(vertical: TenantVertical): { planLabel: string; planCta: string; noPlan: string | null } {
  return {
    planLabel: "Tu plan",
    planCta: "Ver tu plan",
    noPlan: isKinePortal(vertical) ? "Todavía no tenés un plan de tratamiento activo en este consultorio." : null,
  };
}

/** Encabezado de `/portal/c/<slug>`. */
export function portalTenantHeader(o: {
  vertical: TenantVertical;
  hasPlan: boolean;
  firstName: string;
}): { title: string; lead: string } {
  if (isKinePortal(o.vertical)) {
    return { title: "Tu plan", lead: `Hola ${o.firstName}. Acá ves cómo viene tu tratamiento, sesión por sesión.` };
  }
  if (o.hasPlan) return { title: "Tu plan", lead: `Hola ${o.firstName}. Acá ves cómo viene tu tratamiento.` };
  return { title: "Tu consultorio", lead: `Hola ${o.firstName}.` };
}

/** Sin plan activo en `/portal/c/<slug>`. En General, `linkToHome` = el texto remite a «Mis consultorios». */
export function portalNoPlanCopy(vertical: TenantVertical): { text: string; linkToHome: boolean } {
  return isKinePortal(vertical)
    ? {
        text: "Todavía no tenés un plan activo en este consultorio. Cuando tu profesional lo arme va a aparecer acá.",
        linkToHome: false,
      }
    : { text: "Este consultorio no usa planes de tratamiento. Tus próximos turnos los ves en", linkToHome: true };
}

/** Rótulo de la próxima cita del plan y de cada fila del timeline. */
export function portalSessionLabel(vertical: TenantVertical, index: number): string {
  const w = portalSessionWord(vertical).one;
  return `${w.charAt(0).toUpperCase()}${w.slice(1)} ${index}`;
}

export function portalNextSessionLabel(vertical: TenantVertical, index: number): string {
  return `${isKinePortal(vertical) ? "Próxima sesión" : "Próximo turno"} · #${index}`;
}

/** Check-in antes de la cita (`components/portal/check-in-form.tsx`). «Check-in pre-sesión» solo en Kinesiología. */
export function portalCheckInCopy(vertical: TenantVertical): {
  title: string;
  lead: string;
  painLabel: string;
  notesLabel: string;
  notesPlaceholder: string;
  submit: string;
  pending: string;
  done: string;
} {
  const kine = isKinePortal(vertical);
  return {
    title: kine ? "Check-in pre-sesión" : "Antes de tu turno",
    lead: kine
      ? "¿Cómo estás llegando? Tu profesional lo va a ver antes de la sesión."
      : "¿Cómo estás llegando? Tu profesional lo va a ver antes del turno.",
    painLabel: "Dolor ahora",
    notesLabel: "Notas",
    notesPlaceholder: kine
      ? "¿Hubo algo distinto esta semana? ¿Algún ejercicio que te molestó?"
      : "¿Hubo algo distinto desde la última vez?",
    submit: kine ? "Enviar check-in" : "Enviar",
    pending: "Enviando…",
    done: kine ? "Check-in registrado" : "Recibido",
  };
}

// ── ES4 S24 · turnos del plan y navegación ──────────────────────────────────────────────────────────────────────

/**
 * «Sesión 3 de 10» (Kine) / «Turno 3 de 10» (General). Mismo texto que el chip de la agenda y el ICS (V1-D18,
 * `planSessionLabel`), con la palabra por vertical. `ordinal` y `total` son sobre las sesiones VIVAS (M13).
 */
export function portalSessionOfTotal(vertical: TenantVertical, ordinal: number, total: number): string {
  return `${portalSessionLabel(vertical, ordinal)} de ${total}`;
}

/** Fila del recorrido sin turno vigente (sin turno todavía, o el que había se canceló: C4). */
export const PORTAL_PLAN_NO_BOOKING = "Todavía sin turno asignado";

/** Tabs del consultorio (`components/portal/portal-tabs.tsx`). `plan` y `checkin` no son tabs: viven en «inicio». */
export type PortalTab = Extract<PortalSection, "inicio" | "cuenta" | "ejercicios" | "reservar">;

/**
 * Rótulo de cada tab. «inicio» se llama como el encabezado de la página: «Tu plan» si el consultorio usa planes, «Tu
 * consultorio» si no (General no tiene planes: «Tu plan» le prometería algo que no existe). «reservar» usa el mismo
 * texto que el CTA de la home, para que el mismo destino no tenga dos nombres.
 */
export function portalTabLabel(tab: PortalTab, hasPlan: boolean): string {
  switch (tab) {
    case "inicio":
      return hasPlan ? "Tu plan" : "Tu consultorio";
    case "cuenta":
      return "Estado de cuenta";
    case "ejercicios":
      return "Ejercicios";
    case "reservar":
      return PORTAL_HOME.bookCta;
  }
}

/** Nombre accesible del `<nav>` de las tabs. */
export const PORTAL_TABS_LABEL = "Secciones de tu consultorio";

/**
 * Cuenta sin fichas vinculadas. ES4 (S24a/S24v, PD-15): el portal ya no autoriza por coincidencia de email; el vínculo
 * lo hace el auto-vínculo (exactamente una ficha libre con ese email) o la invitación del consultorio. «Cargá tu email
 * exacto» ya no alcanza si hay dos fichas o si la ficha ya está tomada: lo que destraba siempre es la invitación.
 */
export function portalNoLinkCopy(email: string): { tag: string; title: string; text: string } {
  return {
    tag: "Sin fichas vinculadas",
    title: `No encontramos una ficha vinculada a ${email}`,
    text:
      "Pedile a tu consultorio que te invite al portal desde tu ficha: te llega un email con el link para entrar. " +
      "Si todavía no sos paciente, sacá tu primer turno y el consultorio crea tu ficha.",
  };
}
