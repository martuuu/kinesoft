/**
 * CF3b · sesión SV (decisión de Martin del 05-nov, reemplaza D-CF3-6): el alta de un servicio lleva el checkbox «Para
 * todo el consultorio» (`forClinic`). Acá viven el schema del alta y la regla PURA de quién queda como dueño, fuera
 * del archivo `"use server"` (`lib/services.ts`) para poder testearla sola (`tests/unit/services-owner.test.ts`).
 *
 * Por qué un schema aparte y no un campo más de `ServiceInput` (`lib/validation.ts`): `updateService` usa
 * `ServiceInput.partial()`, y en la edición el checkbox no existe (el dueño se cambia con el selector de siempre, solo
 * con «Configuración»). Con el campo en el schema compartido, la edición lo aceptaría y lo ignoraría en silencio.
 */
import { z } from "zod";
import { ServiceInput } from "@/lib/validation";
// Solo el tipo (se borra al compilar): `practitioner-self-scope.ts` es `server-only` y este módulo no.
import type { SelfScopeVia } from "@/lib/practitioner-self-scope";

/**
 * `forClinic`:
 *   • `true`  → del consultorio (`Service.practitionerId = null`), por cualquier vía. En el alta el checkbox GANA: un
 *     `practitionerId` que venga igual se ignora (por la vía propia, uno ajeno sigue siendo `ownOnly`: input armado);
 *   • `false` → de un profesional: por la vía propia, el del Actor; con «Configuración», el elegido en el selector o,
 *     si no eligió, el del propio usuario cuando atiende (sin agenda propia no hay «propio»: queda del consultorio);
 *   • ausente → como antes de CF3b (cliente viejo): por «Configuración», `practitionerId` vacío = del consultorio;
 *     por la vía propia, del Actor.
 * Booleano estricto: un `"true"` armado a mano no decide el alcance (rebota como «Datos inválidos»).
 */
export const ServiceCreateInput = ServiceInput.extend({
  forClinic: z.boolean().optional(),
});
export type ServiceCreateInputType = z.input<typeof ServiceCreateInput>;

/** Alcance del servicio, para el audit (`payload.scope`): del consultorio o de un profesional. */
export type ServiceScope = "clinic" | "own";

export function serviceScopeOf(ownerPractitionerId: string | null): ServiceScope {
  return ownerPractitionerId ? "own" : "clinic";
}

/**
 * Dueño (`Service.practitionerId`) del servicio que se crea. `actor.practitionerId` es null para quien no atiende
 * (Secretaria, Facturación, soporte): ahí nunca hay «propio» y nunca se trata null como un profesional (IAM-4a).
 * La pertenencia del `practitionerId` pedido (vía propia) y que sea reservable (Configuración) las chequea el caller.
 */
export function serviceOwnerFor(
  actor: { practitionerId: string | null },
  input: { via: SelfScopeVia; forClinic?: boolean; practitionerId?: string | null }
): string | null {
  if (input.forClinic === true) return null;
  if (input.via === "self") return actor.practitionerId;
  if (input.practitionerId) return input.practitionerId;
  return input.forClinic === false ? actor.practitionerId : null;
}
