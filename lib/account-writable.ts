/**
 * Escrituras de CUENTA permitidas en solo lectura (PL-1e, contrato C-PL10, plan §20.5.6).
 *
 * Un consultorio en solo lectura por su suscripción (`TENANT_ACCESS_ENFORCEMENT=enforce`, prueba vencida o deuda:
 * BO1-A) abre todas sus tx con `transaction_read_only`. Justo ahí es cuando tiene que poder PAGAR, cambiar de plan,
 * subir el comprobante y escribirnos. Estas actions son las únicas que saltan ese candado.
 *
 * Igual que `SUPPORT_WRITABLE_ACTIONS` (lib/support-writable.ts), es una allowlist ESTÁTICA y no una capability: una
 * action nueva nunca queda habilitada en solo lectura por accidente. Nombres `"<archivo>#<export>"`.
 *
 * NUNCA en una sesión de soporte: el superadmin no paga ni cambia el plan desde la app del consultorio (para eso
 * está /plataforma → Facturación). `withAccountWritable` no prende nada si el actor es soporte, y `runWithRls` /
 * `assertWritable` lo ignoran si el request tiene `supportSessionId` (doble red).
 *
 * Lo que NO cambia: la capacidad (`requireAccountBilling` / `tenant.admin`) y el step-up los sigue pidiendo cada
 * action; esto solo levanta el modo lectura.
 */
import { getRequestContext, runWithRequestContext, type RequestContext } from "@/lib/request-context";

export const ACCOUNT_WRITABLE_ACTIONS: ReadonlySet<string> = new Set([
  // Planes y pagos (PL-2b). Sin débito automático ni «Pagar con MP»: Mercado Pago para la suscripción quedó fuera
  // de esta etapa (Martin, 16-oct); cuando vuelva, sus actions se suman acá en la misma tanda que las crea.
  "lib/saas-billing.ts#applyPlanChange",
  "lib/saas-billing.ts#submitPaymentReceipt",
  // Mensajes a soporte (PL-2d)
  "lib/support-threads.ts#createSupportThread",
  "lib/support-threads.ts#replySupportThread",
  "lib/support-threads.ts#markSupportThreadRead",
]);

export function isAccountWritableAction(name: string): boolean {
  return ACCOUNT_WRITABLE_ACTIONS.has(name);
}

/**
 * C-PL10. Corre `fn` (el cuerpo de una action de cuenta) en un marco del request con `accountWritable`, SOLO si hay
 * un actor de consultorio que no es soporte. Sin actor o en soporte: `fn` tal cual (el modo lectura sigue mandando).
 *
 * `als.run` con una COPIA del marco (molde `withSupportWritable`): el flag vive lo que dura `fn` y no se filtra a lo
 * que el request haga después. `tryGetActor` primero: completa el marco (ver `primeRequestContext`). Import dinámico
 * de la sesión: el guard unitario importa este módulo sin arrastrar Prisma ni `next/headers`.
 */
export async function withAccountWritable<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!ACCOUNT_WRITABLE_ACTIONS.has(name)) {
    throw new Error(`[account-writable] "${name}" no está en ACCOUNT_WRITABLE_ACTIONS`);
  }
  const { tryGetActor } = await import("@/lib/session");
  const actor = await tryGetActor();
  if (!actor || actor.support) return fn();
  const current = getRequestContext();
  const frame: RequestContext = {
    // Sin marco previo no debería pasar (`tryGetActor` lo completa). El marco solo lleva tenant/usuario para RLS y
    // logs; el profesional no hace falta acá (y el guard de IAM-4a prohíbe copiar `actor.practitionerId` crudo).
    ...(current ?? { tenantId: actor.tenantId, userId: actor.userId, practitionerId: null }),
    accountWritable: true,
  };
  return runWithRequestContext(frame, fn) as Promise<T>;
}
