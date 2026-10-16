/**
 * Autorización por rol del tenant (B1.7 AUTHZ, B-pre).
 *
 * El `Actor` no lleva el rol (`lib/session.ts`, tipo Actor): se lee de
 * `Membership` acá, una vez por request (`react` `cache`). Antes de esto el
 * mismo findUnique + `role !== "OWNER" && role !== "ADMIN"` estaba copiado en
 * services, insurers, tenant-settings, configuracion/page y patients; cada
 * copia es un lugar donde olvidarse de un rol nuevo.
 *
 * La matriz rol → capabilities vive en `lib/capabilities.ts` (puro, la usa
 * también la UI). Acá solo se resuelve el rol del actor y se tira
 * `ForbiddenError` si falta la capability.
 *
 * PL-1b (C-PL5): lo que decide es el MIEMBRO (`MemberAccess`: rol + si atiende
 * + delegaciones), no el rol. Desde PL-1e viene en `actor.membership` (sin
 * query); mientras tanto se lee acá, cacheado por request.
 *
 * Tenant: la lectura va por `runWithRls` y por la clave única
 * (userId, tenantId) del actor — en prod la conexión tiene BYPASSRLS y el
 * `tenantId` explícito es la barrera.
 */
import "server-only";
import { cache } from "react";
import type { Role } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { redirect } from "next/navigation";
import { getActor, tryGetActor, ForbiddenError, type Actor } from "@/lib/session";
import { SUPPORT_CAPS, capabilitiesFor, capabilitiesForMember, type Capability } from "@/lib/capabilities";
import type { MemberAccess } from "@/lib/saas-plans-types";
import { modulesFor, MODULE_DENIED_COPY, type TenantModule } from "@/lib/tenant-modules";

// Cacheado por primitivos (no por la identidad del objeto Actor) para que dos
// llamadas con actores equivalentes en el mismo request compartan la query.
// PL-1b: trae también `clinical` y las delegaciones (misma fila, misma query que antes traía solo `role`).
const memberAccessFor = cache(async (tenantId: string, userId: string): Promise<MemberAccess | null> => {
  const m = await runWithRls(tenantId, (tx) =>
    tx.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { role: true, clinical: true, grantSettings: true, grantBilling: true },
    })
  );
  return m ?? null;
});

/**
 * Acceso del miembro (rol + si atiende + delegaciones) en su consultorio activo; `null` sin membresía (falla
 * cerrado) y para el actor de SOPORTE (no es miembro: sus capacidades son `SUPPORT_CAPS`).
 */
export async function getMemberAccess(actor: Actor): Promise<MemberAccess | null> {
  if (actor.support) return null;
  // PL-1e (C-PL5): `buildActor` llena `Actor.membership` con la misma fila de la foto: cero queries. La lectura
  // cacheada queda de red para un Actor armado a mano (tests) que no lo trae: nunca se ADIVINA el acceso, que es
  // la barrera de la HC.
  if (actor.membership != null) return actor.membership;
  return memberAccessFor(actor.tenantId, actor.userId);
}

/**
 * Rol del actor en su tenant activo; `null` si no tiene membresía (falla cerrado).
 *
 * BO2-E: el actor de SOPORTE no tiene membresía en el consultorio destino (`startSupportSession` rechaza al
 * superadmin que es miembro). Para los que deciden por rol (visibilidad del paciente, «propios», el gate) vale como
 * la Secretaria: `ASSISTANT` es el rol sin `clinical.read`, así que todo lo clínico cae en la proyección
 * administrativa (PD-13). Sin query. Sus capacidades NO salen de este rol sino de `SUPPORT_CAPS`
 * (`capabilitiesForActor`): suma `tenant.admin`/`schedule.configure` para las actions de Configuración.
 *
 * PL-1b: el rol solo NO dice si el miembro atiende (un Titular puede no atender). Para capacidades usá
 * `capabilitiesForActor` / `memberCapabilitiesForActor`, nunca `capabilitiesFor(await getMembershipRole(actor))`.
 */
export async function getMembershipRole(actor: Actor): Promise<Role | null> {
  if (actor.support) return "ASSISTANT";
  return (await getMemberAccess(actor))?.role ?? null;
}

/**
 * Capabilities de un actor ya resuelto: las de su MIEMBRO (`capabilitiesForMember`: rol, si atiende y
 * delegaciones; PL-1b), o `SUPPORT_CAPS` si es una sesión de soporte (BO2-E). Sin membresía → vacío.
 */
export async function capabilitiesForActor(actor: Actor): Promise<ReadonlySet<Capability>> {
  if (actor.support) return SUPPORT_CAPS;
  const m = await getMemberAccess(actor);
  return m ? capabilitiesForMember(m) : new Set<Capability>();
}

/**
 * Reemplazo 1:1 de `capabilitiesFor(await getMembershipRole(actor))` (el patrón que usan las lecturas clínicas:
 * bookings, planes, pacientes, realtime). Igual que ese patrón, el SOPORTE vale como la Secretaria
 * (`capabilitiesFor("ASSISTANT")`, sin `tenant.admin`), no `SUPPORT_CAPS`; para un miembro es
 * `capabilitiesForMember`, así que un Titular/Admin que no atiende pierde `clinical.read` (H-PL1).
 */
export async function memberCapabilitiesForActor(actor: Actor): Promise<ReadonlySet<Capability>> {
  if (actor.support) return capabilitiesFor("ASSISTANT");
  const m = await getMemberAccess(actor);
  return m ? capabilitiesForMember(m) : new Set<Capability>();
}

/** Capabilities del actor de la sesión. */
export async function getCapabilities(): Promise<ReadonlySet<Capability>> {
  const actor = await getActor();
  return capabilitiesForActor(actor);
}

/**
 * Exige una capability; devuelve el actor para encadenar como `getActor()`.
 * Tira `ForbiddenError` (extiende Error, `message` = `message` recibido).
 */
export async function requireCapability(
  cap: Capability,
  message = "No tenés permiso para hacer esta acción."
): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
  const actor = await getActor();
  const caps = await capabilitiesForActor(actor);
  if (!caps.has(cap)) throw new ForbiddenError(message);
  return { actor, caps };
}

/**
 * `tenant.admin` o tira (PL-1b: el Titular, o cualquier miembro con «Configuración» delegada —`grantSettings`—;
 * un ADMIN sin la delegación ya no pasa). Históricamente: OWNER/ADMIN o tira. Equivalente exacto del `requireAdmin` copiado en
 * `lib/tenant-settings.ts` / `requireAdminActor` de services e insurers: misma
 * query, mismo criterio (OWNER|ADMIN; sin membresía = rechazo), tira un Error
 * con el `message` dado (cada caller conserva su texto). Única diferencia:
 * la clase es `ForbiddenError` (subclase de Error), así que los `catch` que
 * leen `e.message` siguen igual.
 */
export async function requireTenantAdmin(
  message = "Solo OWNER/ADMIN pueden cambiar la configuración del consultorio."
): Promise<Actor> {
  const { actor } = await requireCapability("tenant.admin", message);
  return actor;
}

/**
 * «Planes y pagos» de la cuenta (PL-1b, C-PL5): el Titular o quien tenga `grantBilling`. Soporte nunca
 * (`SUPPORT_CAPS` no tiene `account.*`).
 */
export async function requireAccountBilling(
  message = "Solo el titular o quien tenga permiso de «Planes y pagos» puede hacer esto."
): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
  return requireCapability("account.billing", message);
}

/**
 * Solo el Titular (PL-1b, decisión 7): transferir titularidad y delegar permisos. No se delega.
 */
export async function requireAccountOwner(
  message = "Solo el titular de la cuenta puede hacer esto."
): Promise<{ actor: Actor }> {
  const { actor } = await requireCapability("account.owner", message);
  return { actor };
}

/*
 * ── Módulos del consultorio (EV0, contrato C-EV4) ──────────────────────────
 *
 * La vertical y el plan del tenant (`actor.entitlements`, C-EV3) definen qué
 * módulos existen (`modulesFor`, matriz de `lib/tenant-modules.ts`). Es
 * ortogonal a las capabilities del rol: una action clínica exige el módulo Y su
 * capability.
 *
 * Regla (plan §15.3):
 *  - **Lecturas compartidas** (listas que se muestran en pantallas comunes, p. ej.
 *    sesiones abiertas en el dashboard, catálogo de diagnóstico) **devuelven
 *    vacío** sin el módulo: no rompen una pantalla del consultorio General.
 *  - **Escrituras y lecturas de detalle** **tiran** `ForbiddenError` con
 *    `MODULE_DENIED_COPY[m]` (`assertModule` / `requireModule`).
 *  - **El layout es UX; la barrera es la action.** `guardModuleSegment` en el
 *    `layout.tsx` del segmento solo evita mostrar una pantalla inútil: en el App
 *    Router un layout no se re-ejecuta en cada navegación y las server actions se
 *    pueden invocar sin pasar por él, así que cada action chequea igual.
 *
 * No hay cache entre requests: `getActor()` lee la fila de Tenant en cada
 * request (cacheado solo dentro del request), así que un cambio de vertical o
 * plan desde /plataforma lo ven enseguida las actions y el guard de un segmento
 * al entrar a él (su layout se renderiza en ese request). El nav del layout
 * `(app)` NO: en la navegación suave ese layout no se re-renderiza, y el
 * sidebar/topbar siguen con los módulos viejos hasta un refresh o una carga
 * completa. Por eso esconder es UX y la barrera es la action.
 */

/** Módulos del tenant del actor de la sesión (cacheado por request vía `getActor`). */
export async function getTenantModules(): Promise<ReadonlySet<TenantModule>> {
  const actor = await getActor();
  return modulesFor(actor.entitlements);
}

/**
 * Exige un módulo sobre un actor ya resuelto (sync: sirve dentro de un
 * `runWithRls` o de un `assert*InTx`). Tira `ForbiddenError(MODULE_DENIED_COPY[m])`
 * o el `message` dado.
 */
export function assertModule(actor: Actor, m: TenantModule, message?: string): void {
  if (!modulesFor(actor.entitlements).has(m)) {
    throw new ForbiddenError(message ?? MODULE_DENIED_COPY[m]);
  }
}

/** `getActor()` + `assertModule`; devuelve el actor para encadenar. */
export async function requireModule(m: TenantModule, message?: string): Promise<Actor> {
  const actor = await getActor();
  assertModule(actor, m, message);
  return actor;
}

/**
 * SOLO COMPAT/TESTS (VX2.1): desde VX2-b2 (D-VX20) ningún layout lo llama; los segmentos usan `moduleWall`
 * (`lib/module-wall.ts`), que muestra el muro del plan (`AccessWall`) o hace este mismo redirect. Queda porque
 * `tests/integration/module-guards.test.ts` lo ejercita; VX-Z/PF decide retirarlo. No usar en código nuevo.
 *
 * Para el `layout.tsx` de un segmento de un módulo (`/diagnostico`,
 * `/seguimiento`, `/biblioteca`, …): sin el módulo, `redirect("/dashboard")`.
 * Sin actor es no-op: de la sesión se ocupan el middleware y el layout de
 * `(app)`, y tirar acá rompería la pantalla de login/onboarding. Es UX, no
 * barrera (ver la regla arriba).
 */
export async function guardModuleSegment(m: TenantModule): Promise<void> {
  const actor = await tryGetActor();
  if (!actor) return;
  if (!modulesFor(actor.entitlements).has(m)) redirect("/dashboard");
}
