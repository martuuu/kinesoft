/**
 * T3c-1p (plan §23.6): input de `setTenantModuleOverrides` (lib/platform-tenant-modules.ts). Puro (zod + constantes),
 * fuera del archivo `"use server"` para que el Drawer y los tests lo importen.
 *
 * Las DOS listas viajan siempre (no un diff): el Drawer edita el estado completo de los overrides y el escritor
 * compara por contenido (mismo contenido = no-op, ni UPDATE ni audit). Con un diff, dos superadmins podían sumar
 * cada uno «su» módulo sobre una foto vieja; con las listas completas + CAS el segundo recibe `stale`.
 */
import { z } from "zod";
import { TENANT_MODULES, isCoreModule, type TenantModule } from "@/lib/tenant-modules";

/** Mismo tope que el CHECK `Tenant_moduleOverrides_check` de M12 (cardinalidad ≤ 32 por lista). */
export const MODULE_OVERRIDES_MAX = 32;

/** Copy de los rechazos que se pueden decidir sin la fila (núcleo, turnero, repetidos, las dos listas a la vez). */
export const MODULE_OVERRIDE_COPY = {
  core: "Los módulos básicos (agenda, pacientes, facturación, obras sociales e historia clínica) los tiene todo consultorio: no se habilitan ni se deshabilitan a mano.",
  turnero: "Los turnos online se prenden y apagan con su switch, en «Editar suscripción».",
  duplicate: "Un módulo aparece repetido. Recargá y probá de nuevo.",
  both: "Un módulo no puede estar habilitado y deshabilitado a mano a la vez.",
  vertical: "Ese módulo no existe para este tipo de consultorio.",
  stale: "Otro cambio se guardó antes. Recargá y revisá.",
  notFound: "No encontramos ese consultorio. Puede que se haya dado de baja: volvé a la lista.",
} as const;

const moduleList = z
  .array(z.enum(TENANT_MODULES))
  .max(MODULE_OVERRIDES_MAX)
  .superRefine((l, ctx) => {
    if (new Set(l).size !== l.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MODULE_OVERRIDE_COPY.duplicate });
    if (l.some((m) => isCoreModule(m))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MODULE_OVERRIDE_COPY.core });
    if (l.includes("turneroPublico")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MODULE_OVERRIDE_COPY.turnero });
  });

export const SetTenantModuleOverrides = z
  .object({
    tenantId: z.string().trim().min(1).max(64),
    /** ISO de `Tenant.updatedAt` que vio el Drawer (CAS). */
    expectedUpdatedAt: z.string().datetime({ offset: true, message: "Versión inválida. Recargá la página." }),
    grants: moduleList,
    revokes: moduleList,
  })
  .strict()
  .superRefine((v, ctx) => {
    const revokes = new Set<TenantModule>(v.revokes);
    if (v.grants.some((m) => revokes.has(m))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grants"], message: MODULE_OVERRIDE_COPY.both });
    }
  });

export type SetTenantModuleOverridesInput = z.input<typeof SetTenantModuleOverrides>;
