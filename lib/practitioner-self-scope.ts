import "server-only";

/**
 * CF3 AU-S (§30, D-CF3-7; decisión de Martin del 04-nov: «Todo + crear servicios») — gate «lo propio o el permiso del
 * consultorio» para la agenda del profesional.
 *
 * Por qué: hasta CF2 los servicios, la semana y las excepciones de un profesional pedían `schedule.configure`
 * («Configuración»), así que el kine sin ese permiso no podía cargar ni sus vacaciones (Anexo R: `practitioner-services.ts`
 * :43,111; `practitioner-schedule.ts` :538,791,975). Ahora el propio profesional edita lo SUYO; lo ajeno sigue siendo de
 * quien tiene «Configuración». El tope de turnos por intervalo y las reglas de agenda (pasos) NO pasan por acá: siguen
 * siendo del consultorio (`setPractitionerBookingCap` / `setPractitionerAgendaRules`).
 *
 * Mismo molde que `setPractitionerPublicLead` (`lib/practitioner-self-settings.ts:75-78`): el «propio» se decide con el
 * `practitionerId` del Actor (que `buildActor` solo llena para roles clínicos) y nunca con un dato del input; el permiso
 * se mira PRIMERO, así un Titular con «Configuración» que edita su propia agenda queda como `via: "config"` (no cambia
 * el criterio de audit de PL-A para quien ya podía).
 *
 * Dos pasos, a propósito:
 *   1. `assertSelfOr*` (fuera de la tx): decide `via` o tira `ForbiddenError` (el contrato de 403 de siempre para quien
 *      no tiene ni el permiso ni un profesional que coincida: Secretaria, Facturación, soporte, otro kine).
 *   2. `writablePractitionerWhere` (DENTRO de la tx que escribe): con `via: "self"` exige además que el `Practitioner`
 *      sea del USUARIO del actor, del tenant y reservable (membresía clínica aceptada, sin suspender, usuario no
 *      deshabilitado en Plataforma). Es la misma sentencia que ya hacía `findBookablePractitioner`, con un `userId` más:
 *      0 statements nuevos. Defensa en profundidad: un `practitionerId` de sesión viejo o de otro consultorio no
 *      escribe aunque el paso 1 haya pasado.
 */
import type { Prisma } from "@prisma/client";
import { capabilitiesForActor } from "@/lib/authz";
import type { Capability } from "@/lib/capabilities";
import { ForbiddenError, type Actor } from "@/lib/session";
import { bookablePractitionerWhere, isActorPractitioner } from "@/lib/practitioner-scope";

/** Por dónde pasó el gate: lo lleva el audit (`payload.via`). */
export type SelfScopeVia = "self" | "config";

type ScopeActor = Pick<Actor, "tenantId" | "userId" | "practitionerId">;

const SELF_WRITE_DENIED = "Solo podés cambiar tu propia agenda. Para la de otro profesional hace falta el permiso «Configuración».";
const SELF_READ_DENIED = "No tenés permiso para ver la agenda de ese profesional.";

/**
 * `cap` del consultorio → `"config"`; si no, el profesional del actor → `"self"`; si no, `ForbiddenError(message)`.
 * Devuelve también las capacidades (una query por request; el llamador no las vuelve a pedir).
 */
export async function assertSelfOrCapability(
  actor: Actor,
  practitionerId: string | null | undefined,
  cap: Capability,
  message: string
): Promise<{ via: SelfScopeVia; caps: ReadonlySet<Capability> }> {
  const caps = await capabilitiesForActor(actor);
  if (caps.has(cap)) return { via: "config", caps };
  if (isActorPractitioner(actor, practitionerId)) return { via: "self", caps };
  throw new ForbiddenError(message);
}

/** Escritura de la agenda del profesional: propia o `schedule.configure`. */
export function assertSelfOrScheduleConfigure(
  actor: Actor,
  practitionerId: string | null | undefined,
  message: string = SELF_WRITE_DENIED
): Promise<{ via: SelfScopeVia; caps: ReadonlySet<Capability> }> {
  return assertSelfOrCapability(actor, practitionerId, "schedule.configure", message);
}

/** Lectura de la agenda del profesional: propia o `agenda.viewAll`. */
export function assertSelfOrAgendaViewAll(
  actor: Actor,
  practitionerId: string | null | undefined,
  message: string = SELF_READ_DENIED
): Promise<{ via: SelfScopeVia; caps: ReadonlySet<Capability> }> {
  return assertSelfOrCapability(actor, practitionerId, "agenda.viewAll", message);
}

/**
 * `where` del profesional a escribir, para usar DENTRO de la tx: reservable en el tenant y, con `via: "self"`, además
 * del usuario del actor. Puro (no consulta): el llamador lo pasa a su `findFirst` de siempre.
 */
export function writablePractitionerWhere(
  actor: ScopeActor,
  practitionerId: string,
  via: SelfScopeVia
): Prisma.PractitionerWhereInput {
  return {
    id: practitionerId,
    ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
    ...(via === "self" ? { userId: actor.userId } : {}),
  };
}
