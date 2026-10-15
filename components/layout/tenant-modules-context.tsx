"use client";

/**
 * Módulos del consultorio activo para la UI (EV0, contrato C-EV8, plan §15.3).
 *
 * El layout `(app)` calcula `modulesFor(actor.entitlements)` en el server y el
 * AppShell monta este provider: cualquier componente cliente puede preguntar
 * `useTenantModules().has("diagnostico")` sin volver a la DB ni recibir props.
 *
 * Solo esconde UI. La barrera es `assertModule`/`requireModule` en cada action
 * y `guardModuleSegment` en el layout del segmento (`lib/authz.ts`).
 *
 * Default fuera del provider = set de Kine PRO (todo lo de Kine). Es a
 * propósito y SOLO de UI: los render tests existentes montan pantallas sueltas
 * (agenda, perfil del paciente…) sin el AppShell, y con un default vacío
 * desaparecerían pestañas y acciones que hoy afirman. En la app real el
 * provider siempre está montado (lo pone el AppShell), así que el default no
 * llega a un consultorio General.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TenantVertical } from "@prisma/client";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";

export type TenantModulesValue = {
  has: (m: TenantModule) => boolean;
  list: ReadonlySet<TenantModule>;
  /**
   * EV1 (integrador): tipo de consultorio, para el COPY («Kine»/«Profesional», «por sesión»/«por turno»). Antes
   * los paneles lo deducían de `has("sesiones")`; la vertical real la pasa el layout `(app)` desde
   * `actor.entitlements`. Para decidir si algo existe se sigue usando `has(módulo)`.
   */
  vertical: TenantVertical;
};

/**
 * Sin `vertical` explícita (render tests que montan el provider solo con módulos) se deduce: `sesiones` existe
 * solo en Kinesiología y no depende del plan (lib/tenant-modules.ts). En la app real el layout la pasa siempre.
 */
function valueOf(list: ReadonlySet<TenantModule>, vertical?: TenantVertical): TenantModulesValue {
  return {
    has: (m) => list.has(m),
    list,
    vertical: vertical ?? (list.has("sesiones") ? "KINESIOLOGY" : "GENERAL"),
  };
}

/** Kine Clínica (ex PRO) sin turnero: lo que veía todo consultorio antes de EV0. */
const DEFAULT_VALUE: TenantModulesValue = valueOf(
  modulesFor({
    vertical: "KINESIOLOGY",
    plan: "CLINICA",
    publicBookingEnabled: false,
  }),
  "KINESIOLOGY"
);

const TenantModulesContext = createContext<TenantModulesValue>(DEFAULT_VALUE);

/**
 * `modules` llega como array y no como `Set` porque viene de un Server
 * Component (layout) a través del AppShell cliente: un array serializa sin
 * depender del soporte de `Set` en el protocolo RSC.
 */
export function TenantModulesProvider({
  modules,
  vertical,
  children,
}: {
  modules: readonly TenantModule[] | ReadonlySet<TenantModule>;
  /** EV1: la vertical real del consultorio (`actor.entitlements.vertical`). */
  vertical?: TenantVertical;
  children: ReactNode;
}) {
  // Clave estable: el layout re-renderiza en cada navegación y el array es
  // nuevo cada vez; sin esto todo consumidor del contexto se re-renderiza.
  const key = Array.from(modules).sort().join(",");
  const value = useMemo(
    () => valueOf(new Set<TenantModule>(key ? (key.split(",") as TenantModule[]) : []), vertical),
    [key, vertical]
  );
  return <TenantModulesContext.Provider value={value}>{children}</TenantModulesContext.Provider>;
}

export function useTenantModules(): TenantModulesValue {
  return useContext(TenantModulesContext);
}
