/**
 * DIR-0 (decisión 19 de Martin, 15-oct-2026): **el email no se muestra nunca como nombre** de un profesional o
 * usuario, en ninguna superficie.
 *
 * Por qué existe: el repo tenía `fullName ?? email` en ~20 lugares. Un perfil sin nombre (alta por invitación
 * antes de completar el nombre, Google sin `full_name`, cuenta creada desde Plataforma) mostraba su email en el
 * turnero público, en el estado de reserva y en el portal del paciente (dato personal a cualquier visitante), y
 * en la app como si fuera un nombre (agenda, sala, planes, historial, saludo del dashboard).
 *
 * Por qué un solo archivo y no `lib/public-practitioner-name.ts` (nombre del plan §20.4): el mismo criterio vale
 * para la cara pública y para la app, y los textos de reemplazo se eligen acá juntos. Es puro y sin
 * `server-only`: lo importan server components, actions y componentes cliente.
 *
 * Dónde el email SÍ queda: cuando el dato mostrado ES el email (columna «Email» de Configuración → Usuarios,
 * Plataforma → Usuarios/Equipo, «te mandamos un mail a …», invitaciones). El guard
 * `tests/unit/no-email-as-name.test.ts` bloquea los fallbacks `nombre ?? email` / `nombre || email`.
 */

/** Texto público (turnero, estado de reserva, portal) para un profesional sin nombre cargado. */
export const PUBLIC_PRACTITIONER_FALLBACK = "Profesional";
/** Texto de la app para un profesional sin nombre cargado (que se note que falta completarlo). */
export const MEMBER_NO_NAME = "Profesional sin nombre";
/** Texto de la app para un usuario sin nombre que puede no ser profesional (Secretaria, Admin, superadmin). */
export const USER_NO_NAME = "Usuario sin nombre";

function clean(fullName: string | null | undefined): string | null {
  return fullName?.trim() || null;
}

/** Nombre de un profesional en superficies PÚBLICAS: el nombre recortado o «Profesional». Nunca el email. */
export function publicPractitionerName(fullName: string | null | undefined): string {
  return clean(fullName) ?? PUBLIC_PRACTITIONER_FALLBACK;
}

/** Nombre de un profesional dentro de la app: el nombre recortado o «Profesional sin nombre». Nunca el email. */
export function displayMemberName(fullName: string | null | undefined): string {
  return clean(fullName) ?? MEMBER_NO_NAME;
}

/** Nombre de un usuario de cualquier rol dentro de la app: el nombre recortado o «Usuario sin nombre». */
export function displayUserName(fullName: string | null | undefined): string {
  return clean(fullName) ?? USER_NO_NAME;
}

/**
 * Primer nombre para el saludo («Hola, Ana»), o `""` si no hay nombre real: un placeholder como
 * «Usuario sin nombre» no es un nombre de pila («Hola, Usuario» confunde).
 */
export function greetingFirstName(displayName: string | null | undefined): string {
  const name = clean(displayName);
  if (!name || name === USER_NO_NAME || name === MEMBER_NO_NAME) return "";
  return name.split(/\s+/)[0];
}
