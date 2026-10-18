/**
 * T3c-1p (plan §23.6) · lógica pura de la tabla «Módulos» de Plataforma → consultorio → Suscripción y de su Drawer.
 * Sin "use client" ni I/O: la usan el server component de la tabla, el Drawer y el render test.
 *
 * Modelo: el form ES el par de listas que se guarda (`moduleGrants` / `moduleRevokes`). Cada fila elige entre
 * «Según el plan» (no está en ninguna lista), «Habilitado a mano» (grant) y «Deshabilitado a mano» (revoke). Por qué
 * tres opciones y no un switch prendido/apagado: con un switch, un revoke de algo que el plan actual no trae (sacado
 * antes de bajar de plan, o a propósito para que no vuelva al subir) se perdía en silencio en el primer guardado; y un
 * grant que quedó redundante después de subir de plan se borraba sin que nadie lo pidiera. El estado que ve el
 * consultorio (`moduleStateRows`) se muestra al lado, recalculado sobre el borrador.
 */
import type { SaasPlan, TenantVertical } from "@prisma/client";
import {
  moduleStateRows,
  modulesFor,
  VERTICAL_LABEL,
  type ModuleState,
  type TenantEntitlements,
  type TenantModule,
} from "@/lib/tenant-modules";
import { moduleDependencyViolations, type ModuleDependencyViolation } from "@/lib/tenant-module-deps";
import { formatARS } from "@/lib/format";
import type { PlatformTenantDetail, PlatformTenantPrice } from "@/lib/platform-tenants-types";
import { moduleName } from "@/components/plataforma/tenants/labels";

export type ModuleChoice = "plan" | "grant" | "revoke";
export type ModuleOverridesForm = { grants: TenantModule[]; revokes: TenantModule[] };
export type ModuleTenantBase = { vertical: TenantVertical; plan: SaasPlan; publicBookingEnabled: boolean };

/** Rótulos de `ModuleState` (literales del brief §23.6). */
export const MODULE_STATE_LABEL: Record<ModuleState, string> = {
  plan: "Del plan",
  granted: "Habilitado a mano",
  revoked: "Deshabilitado a mano",
  absent: "No incluido",
};

/** Tono del Tag de cada estado. El texto es el canal principal (AGENTS §5); el tono solo acompaña. */
export const MODULE_STATE_TONE: Record<ModuleState, "lime" | "sky" | "soft"> = {
  plan: "lime",
  granted: "sky",
  revoked: "soft",
  absent: "soft",
};

/** Fila informativa del turnero: no es un override (lo prende el switch de «Editar suscripción» o Configuración). */
export const TURNERO_ROW_HINT = "Se prende y apaga con su switch, en «Editar suscripción».";

export const CORE_LOCK_HINT = "Básico: lo tiene todo consultorio.";

const sorted = (l: readonly TenantModule[]): TenantModule[] => [...new Set(l)].sort();

export function formFromLists(grants: readonly TenantModule[], revokes: readonly TenantModule[]): ModuleOverridesForm {
  return { grants: sorted(grants), revokes: sorted(revokes) };
}

export function choiceOf(f: ModuleOverridesForm, m: TenantModule): ModuleChoice {
  if (f.grants.includes(m)) return "grant";
  if (f.revokes.includes(m)) return "revoke";
  return "plan";
}

/** Pasa `m` a `c`, sacándolo de la otra lista (nunca queda en las dos: el server lo rechazaría). */
export function setChoice(f: ModuleOverridesForm, m: TenantModule, c: ModuleChoice): ModuleOverridesForm {
  const grants = f.grants.filter((x) => x !== m);
  const revokes = f.revokes.filter((x) => x !== m);
  if (c === "grant") grants.push(m);
  if (c === "revoke") revokes.push(m);
  return { grants: sorted(grants), revokes: sorted(revokes) };
}

export function isOverridesDirty(a: ModuleOverridesForm, b: ModuleOverridesForm): boolean {
  const same = (x: TenantModule[], y: TenantModule[]) => x.length === y.length && x.every((m, i) => m === y[i]);
  return !same(sorted(a.grants), sorted(b.grants)) || !same(sorted(a.revokes), sorted(b.revokes));
}

/** Entitlements guardados del consultorio, desde el DTO del detalle. */
export function entitlementsOf(
  d: Pick<PlatformTenantDetail, "vertical" | "saasPlan" | "publicBookingEnabled" | "moduleGrants" | "moduleRevokes">
): TenantEntitlements {
  return {
    vertical: d.vertical,
    plan: d.saasPlan,
    publicBookingEnabled: d.publicBookingEnabled,
    moduleGrants: d.moduleGrants,
    moduleRevokes: d.moduleRevokes,
  };
}

export function draftEntitlements(base: ModuleTenantBase, f: ModuleOverridesForm): TenantEntitlements {
  return { ...base, moduleGrants: f.grants, moduleRevokes: f.revokes };
}

/** ¿Lo trae el plan (sin overrides)? Decide qué opciones tienen sentido en la fila. */
export function includedByPlan(base: ModuleTenantBase, m: TenantModule): boolean {
  return modulesFor({ ...base, moduleGrants: [], moduleRevokes: [] }).has(m);
}

export type ModuleTableRow = {
  module: TenantModule;
  name: string;
  state: ModuleState;
  stateLabel: string;
  locked: boolean;
  /** Por qué no se puede tocar (núcleo / no existe en la vertical); null = editable. */
  lockHint: string | null;
};

/** Filas de la tabla (sin el turnero: va aparte como fila informativa), en el orden de `TENANT_MODULES`. */
export function moduleTableRows(e: TenantEntitlements): ModuleTableRow[] {
  const base: ModuleTenantBase = { vertical: e.vertical, plan: e.plan, publicBookingEnabled: e.publicBookingEnabled };
  return moduleStateRows(e).map((r) => ({
    module: r.module,
    name: moduleName(r.module),
    state: r.state,
    stateLabel: MODULE_STATE_LABEL[r.state],
    locked: r.locked,
    lockHint: !r.locked
      ? null
      : includedByPlan(base, r.module)
        ? CORE_LOCK_HINT
        : `No existe para ${VERTICAL_LABEL[e.vertical]}.`,
  }));
}

/**
 * Opciones del select de una fila. «Habilitado a mano» no se ofrece si el plan ya lo trae (sería un no-op), salvo
 * que sea el valor guardado (un grant que quedó redundante tras subir de plan se ve tal cual y se puede limpiar).
 */
export function choiceOptions(byPlan: boolean, current: ModuleChoice): { value: ModuleChoice; label: string }[] {
  const out: { value: ModuleChoice; label: string }[] = [
    { value: "plan", label: byPlan ? "Según el plan (incluido)" : "Según el plan (no incluido)" },
  ];
  if (!byPlan || current === "grant") out.push({ value: "grant", label: "Habilitado a mano" });
  out.push({ value: "revoke", label: byPlan ? "Deshabilitado a mano" : "Deshabilitado a mano (aunque cambie el plan)" });
  return out;
}

/** Violaciones de dependencia del borrador (la misma regla que aplica el escritor, `lib/tenant-module-deps.ts`). */
export function draftViolations(base: ModuleTenantBase, f: ModuleOverridesForm): ModuleDependencyViolation[] {
  return moduleDependencyViolations(draftEntitlements(base, f));
}

/**
 * «Deshabilitar también»: apaga los dependientes de una violación. Si el plan lo trae → revoke; si estaba prendido
 * por un grant → vuelve a «Según el plan» (que para ese módulo es apagado).
 */
export function withDependentsOff(
  base: ModuleTenantBase,
  f: ModuleOverridesForm,
  v: ModuleDependencyViolation
): ModuleOverridesForm {
  let next = f;
  for (const d of v.dependents) next = setChoice(next, d, includedByPlan(base, d) ? "revoke" : "plan");
  return next;
}

/** Lo que viaja a `setTenantModuleOverrides`: siempre las dos listas completas. */
export function buildModuleOverridesPayload(tenantId: string, expectedUpdatedAt: string, f: ModuleOverridesForm) {
  return { tenantId, expectedUpdatedAt, grants: sorted(f.grants), revokes: sorted(f.revokes) };
}

/**
 * Fila «Precio» de Suscripción: «$ 30.000 / mes · a medida (lista: $ 45.000)», «$ 45.000 / mes», o «Consultá» si el
 * plan no tiene precio de lista y no hay uno a medida (PL-D19: no se cobra).
 */
export function priceText(p: PlatformTenantPrice): { text: string; custom: boolean } {
  if (p.customPriceCents != null) {
    const list = p.planPriceCents != null ? ` (lista: ${formatARS(p.planPriceCents)})` : "";
    return { text: `${formatARS(p.customPriceCents)} / mes · a medida${list}`, custom: true };
  }
  if (p.planPriceCents != null) return { text: `${formatARS(p.planPriceCents)} / mes`, custom: false };
  return { text: "Consultá: el plan no tiene precio de lista", custom: false };
}
