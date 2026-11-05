"use client";

/**
 * CF3 (BR-L): marca del consultorio ACTIVO para el workspace (contrato con BR-P, la paleta del consultorio).
 *
 * - `name`: `actor.tenantName` (en soporte, el del consultorio que se está mirando).
 * - `logoUrl`: `/api/consultorio/logo?t=&v=` (`tenantLogoUrl`, lib/tenant-logo.ts) o null sin logo. En soporte y con
 *   el actor demo es null: la ruta exige membresía usable y sesión.
 * - `palette`: `Tenant.palette` crudo (default "sky"); quien lo use lo valida contra su lista.
 *
 * Lo arma el layout `(app)` de la MISMA foto de acceso que ya lee para el gate (0 sentencias nuevas; en soporte y demo,
 * del tx de tenant que el layout ya corre) y lo monta el AppShell. Fuera del provider (render suelto, tests) vale
 * `DEFAULT_TENANT_BRAND`: sin logo, el shell se ve como antes.
 *
 * Ojo: el layout es server y este módulo es cliente. Desde el layout solo se importa el TIPO: un valor exportado acá
 * llega al server como *client reference*, no como dato (la lección de `shell-tenant-choice.ts`).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type TenantBrand = { name: string; logoUrl: string | null; palette: string };

export const DEFAULT_TENANT_BRAND: TenantBrand = { name: "", logoUrl: null, palette: "sky" };

const TenantBrandContext = createContext<TenantBrand>(DEFAULT_TENANT_BRAND);

export function TenantBrandProvider({ value, children }: { value: TenantBrand; children: ReactNode }) {
  const { name, logoUrl, palette } = value;
  // El layout re-renderiza en cada navegación y el objeto llega nuevo: memo por valor, no por identidad.
  const v = useMemo<TenantBrand>(() => ({ name, logoUrl, palette }), [name, logoUrl, palette]);
  return <TenantBrandContext.Provider value={v}>{children}</TenantBrandContext.Provider>;
}

export function useTenantBrand(): TenantBrand {
  return useContext(TenantBrandContext);
}
