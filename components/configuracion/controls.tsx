"use client";

import type { Role } from "@prisma/client";
import type { TenantModule } from "@/lib/tenant-modules";

export type Tab =
  | "general"
  | "sedes"
  | "profesionales"
  | "servicios"
  | "obras-sociales"
  | "diagnosticos"
  | "usuarios"
  | "plan"
  | "facturacion"
  | "soporte"
  | "exportar";

/**
 * BO3-F: las pestañas se pueden abrir por URL (`/configuracion?tab=soporte`: el mail `support_access` lleva a
 * «Accesos de soporte»). Lo que no sea una pestaña conocida cae en General.
 */
export const CONFIG_TABS: readonly Tab[] = [
  "general",
  "sedes",
  "profesionales",
  "servicios",
  "obras-sociales",
  "diagnosticos",
  "usuarios",
  "plan",
  // PL-3a (PL-D21): `?tab=facturacion` es el link de los mails de cobro (cargo nuevo, vencido, comprobante revisado).
  "facturacion",
  "soporte",
  // BO5-C: `?tab=exportar` es el link del mail `tenant_export_request` (Plataforma le pide el export al titular).
  "exportar",
];

export function parseConfigTab(raw: string | string[] | null | undefined): Tab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CONFIG_TABS as readonly string[]).includes(v ?? "") ? (v as Tab) : "general";
}

/**
 * PL-3a: qué pestañas ve cada uno sale de las CAPACIDADES del miembro (C-PL5), no del rol: desde PL-1 un ADMIN sin
 * «Configuración» delegada no tiene `tenant.admin`, y una Secretaria con «Planes y pagos» (`grantBilling`) sí tiene
 * `account.billing`. Lo arma la página con `getCapabilities()` y lo que el server efectivamente le dejó leer.
 *  - `tenantAdmin` (`tenant.admin` = «Configuración»): General, Sedes, Profesionales, Servicios, Obras Sociales,
 *    Diagnósticos.
 *  - `team`: Usuarios (la página lo prende solo si `listTeamMembers` no la rechazó).
 *  - `billing` (`account.billing` = Titular o «Planes y pagos»): Plan y uso y Facturación.
 *  - Soporte (Mensajes + Accesos de soporte): SIEMPRE, cualquier miembro (PL-F1b, decisión de Martin del 16-oct:
 *    «profesionales también, porque pueden necesitar ayuda con algo»; la misma regla que `lib/support-threads.ts` y
 *    `listSupportSessionsForTenant`). Un Profesional sin delegaciones ve solo esta pestaña.
 *  - `canExport`: Exportar datos (BO5-C: solo el titular, o el de un consultorio suspendido).
 */
export type ConfigTabAccess = { tenantAdmin: boolean; billing: boolean; team: boolean; canExport: boolean };

/**
 * Default por rol en abstracto, para quien todavía no pasa `access` (tests viejos): OWNER = todo; ADMIN = el ADMIN
 * legado con «Configuración» (backfill de M8) sin «Planes y pagos»; el resto, solo Soporte (PL-F1b). Un mapa y no comparaciones de rol
 * (guard `tests/unit/pl-ownership-guard.test.ts`).
 */
const LEGACY_ACCESS: Record<Role, ConfigTabAccess> = {
  OWNER: { tenantAdmin: true, billing: true, team: true, canExport: true },
  ADMIN: { tenantAdmin: true, billing: false, team: true, canExport: false },
  PRACTITIONER: { tenantAdmin: false, billing: false, team: false, canExport: false },
  ASSISTANT: { tenantAdmin: false, billing: false, team: false, canExport: false },
  BILLING: { tenantAdmin: false, billing: false, team: false, canExport: false },
};

export function legacyConfigAccess(role: Role): ConfigTabAccess {
  return LEGACY_ACCESS[role];
}

type TabDef = { key: Tab; label: string; module?: TenantModule; visible: (a: ConfigTabAccess) => boolean };

const admin = (a: ConfigTabAccess) => a.tenantAdmin;

// `module`: la pestaña solo existe si el consultorio tiene ese módulo (EV0). Diagnósticos = condiciones propias del
// catálogo de diagnóstico: un consultorio General no lo tiene. Es UX; cada action tiene su propio gate.
const TAB_DEFS: readonly TabDef[] = [
  { key: "general", label: "General", visible: admin },
  { key: "sedes", label: "Sedes", visible: admin },
  { key: "profesionales", label: "Profesionales", visible: admin },
  { key: "servicios", label: "Servicios", visible: admin },
  { key: "obras-sociales", label: "Obras Sociales", visible: admin },
  { key: "diagnosticos", label: "Diagnósticos", module: "diagnostico", visible: admin },
  { key: "usuarios", label: "Usuarios", visible: (a) => a.team },
  { key: "plan", label: "Plan y uso", visible: (a) => a.billing },
  { key: "facturacion", label: "Facturación", visible: (a) => a.billing },
  // PL-2d: «Soporte» = Mensajes + Accesos de soporte (la key no cambia: los mails ya linkean `?tab=soporte`).
  // PL-F1b: visible para cualquier miembro (antes `tenantAdmin || billing`, PL-D20).
  { key: "soporte", label: "Soporte", visible: () => true },
  // BO5-C (BO-D4): el export completo es SOLO del titular (la route también lo exige), no de ADMIN.
  { key: "exportar", label: "Exportar datos", visible: (a) => a.canExport },
];

/** Pestañas visibles, en orden. */
export function visibleConfigTabs(access: ConfigTabAccess, modules: readonly TenantModule[]): Tab[] {
  return TAB_DEFS.filter((t) => t.visible(access) && (!t.module || modules.includes(t.module))).map((t) => t.key);
}

/**
 * Pestaña inicial: la de `?tab=` si la puede ver; si no, la primera que ve (quien solo tiene «Planes y pagos» no ve
 * General y entra a «Plan y uso»; un Profesional sin delegaciones entra a «Soporte», PL-F1b).
 */
export function initialConfigTab(raw: string | string[] | null | undefined, visible: readonly Tab[]): Tab {
  const t = parseConfigTab(raw);
  if (visible.includes(t)) return t;
  return visible[0] ?? "general";
}

export function TabsBar({
  tab,
  setTab,
  role,
  access,
  modules,
  canExport,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  /** @deprecated PL-3a: pasá `access`. Sin `access`, el default del rol (`legacyConfigAccess`). */
  role?: Role;
  access?: ConfigTabAccess;
  modules: readonly TenantModule[];
  /** BO-Z B6: pisa `access.canExport` (el titular de un consultorio suspendido). */
  canExport?: boolean;
}) {
  const base = access ?? (role ? legacyConfigAccess(role) : LEGACY_ACCESS.PRACTITIONER);
  const eff = canExport === undefined ? base : { ...base, canExport };
  const keys = visibleConfigTabs(eff, modules);
  const tabs = TAB_DEFS.filter((t) => keys.includes(t.key));
  // B3.4: con 7 pestañas (11 desde PL-3a) la píldora no entra en un celular; scrollea en
  // horizontal en vez de desbordar la página (`maxWidth: 100%`).
  return (
    <div
      className="k-glass k-scroll"
      role="tablist"
      style={{
        display: "inline-flex",
        padding: 4,
        borderRadius: 999,
        gap: 2,
        alignSelf: "flex-start",
        maxWidth: "100%",
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              whiteSpace: "nowrap",
              flexShrink: 0,
              borderRadius: 999,
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              background: on ? "var(--navy-900)" : "transparent",
              color: on ? "#fff" : "var(--navy-500)",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * `aria-label`: el switch es un botón sin texto; sin nombre accesible un lector
 * de pantalla anuncia "interruptor, activado" sin decir de qué (revisión EV0).
 * Quien lo usa le pasa el label de la fila.
 */
export function Switch({
  on,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      style={{
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 2px 6px rgba(15,30,51,0.18)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(228,70,70,0.1)",
        color: "#9F1F1F",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}
