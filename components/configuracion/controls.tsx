"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Role } from "@prisma/client";
import styles from "./configuracion.module.css";
import type { TenantModule } from "@/lib/tenant-modules";

export type Tab =
  | "general"
  | "sedes"
  | "profesionales"
  | "servicios"
  | "obras-sociales"
  | "cobros-online"
  | "whatsapp"
  | "diagnosticos"
  | "directorio"
  | "usuarios"
  | "plan"
  | "facturacion"
  | "mi-agenda"
  | "mis-fichas"
  | "mercado-pago"
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
  // TP-3a: `?tab=cobros-online` es la vuelta del callback de Mercado Pago (cuenta del consultorio) y el link de la
  // campana «Reconectá el Mercado Pago del consultorio». Quien no la ve (la Secretaría, Facturación) cae en su primera.
  "cobros-online",
  // WA-U1 (C-WA9): `?tab=whatsapp` es el link de la campana WHATSAPP_ACCOUNT (reconectar, medio de pago en Meta).
  "whatsapp",
  "diagnosticos",
  // DIR-3c: `?tab=directorio` (el link «Configurar» de una futura comunicación del directorio).
  "directorio",
  "usuarios",
  "plan",
  // PL-3a (PL-D21): `?tab=facturacion` es el link de los mails de cobro (cargo nuevo, vencido, comprobante revisado).
  "facturacion",
  // CF2 (T.C): `?tab=mi-agenda` = «Configuración › Mi agenda», adonde manda el pie del mail «Nuevo turno online».
  "mi-agenda",
  // FC-3i: `?tab=mis-fichas` (firma, matrícula y carpeta de respaldo de cada profesional).
  "mis-fichas",
  // TP-3a: `?tab=mercado-pago` = vuelta del callback (cuenta propia) y link de la campana «Reconectá tu Mercado Pago».
  "mercado-pago",
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
 *  - `fichas` (FC-3i, FC-UI-D3): «Mis fichas» = todo miembro CLÍNICO (atiende y tiene `Practitioner`: honorífico,
 *    matrícula, firma, carpeta de respaldo y diagnósticos propios). Es personal: no depende de «Configuración», así
 *    que un Profesional sin delegaciones la ve (junto con Soporte). Opcional; ausente = no se ve.
 *  - `miAgenda` (CF2, T.C): «Mi agenda» = el mismo gate que `fichas` (el loader manda sus datos en null a la
 *    Secretaria, a Facturación y al soporte): switch propio del turnero, anticipación, contacto y avisos. Sin módulo:
 *    un consultorio General o con el turnero apagado también la ve (los avisos y la anticipación quedan listos).
 *    Opcional; ausente = no se ve.
 *  - `canExport`: Exportar datos (BO5-C: solo el titular, o el de un consultorio suspendido).
 *  - `directory` (DIR-3c, C-DIR9): Directorio = `tenant.sensitive` con `DIRECTORY_MODE` ≠ off (lo decide el loader: la
 *    pestaña existe si llegaron sus datos). Opcional: sin él (tests viejos, `legacyConfigAccess`) no se ve.
 *  - `onlinePayments` (TP-3a, §25.10): «Cobros online» = `tenant.sensitive` con los datos de la pestaña (el loader los
 *    manda en null sin él). La Secretaría y Facturación con «Configuración» no la ven, ni con `?tab=cobros-online`.
 *  - `myMp` (TP-3a, TP-UI-D2): «Mi Mercado Pago» = quien tiene profesional propio (el loader manda su cuenta; null sin
 *    profesional o en soporte). Personal como «Mis fichas»: un Profesional sin delegaciones la ve.
 *  - `sensitive` (T3d-1g, C-AS1: `tenant.sensitive`): lo delicado. Usuarios y Directorio lo exigen además de sus datos
 *    (el loader ya los manda en null sin él; la pestaña no depende solo de eso). La Secretaria y Facturación con
 *    «Configuración» no lo tienen (corte de staff): ven lo operativo y no el equipo ni el directorio. Opcional para los
 *    tests viejos; ausente = sin lo delicado (deny por default).
 *  - `whatsapp` (WA-U1, C-WA9): «WhatsApp» = `tenant.sensitive` con `WHATSAPP_MODE` ≠ off (el loader manda sus datos en
 *    null sin eso). Conectar y desconectar adentro son solo del Titular; la pestaña la ve también la administración.
 */
export type ConfigTabAccess = {
  tenantAdmin: boolean;
  billing: boolean;
  team: boolean;
  canExport: boolean;
  directory?: boolean;
  sensitive?: boolean;
  fichas?: boolean;
  miAgenda?: boolean;
  onlinePayments?: boolean;
  myMp?: boolean;
  whatsapp?: boolean;
};

/**
 * Default por rol en abstracto, para quien todavía no pasa `access` (tests viejos): OWNER = todo; ADMIN = el ADMIN
 * legado con «Configuración» (backfill de M8) sin «Planes y pagos»; el resto, solo Soporte (PL-F1b). Un mapa y no comparaciones de rol
 * (guard `tests/unit/pl-ownership-guard.test.ts`).
 */
const LEGACY_ACCESS: Record<Role, ConfigTabAccess> = {
  OWNER: { tenantAdmin: true, billing: true, team: true, canExport: true, sensitive: true },
  ADMIN: { tenantAdmin: true, billing: false, team: true, canExport: false, sensitive: true },
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
  // [PF1.1-config · C5] Sentence case en todas («Obras sociales», como «Plan y uso» y «Exportar datos»).
  { key: "obras-sociales", label: "Obras sociales", visible: admin },
  // TP-3a: la plata del turnero es lo delicado (decisión 1 de Martin, 19-oct): nunca la Secretaría ni Facturación.
  { key: "cobros-online", label: "Cobros online", visible: (a) => !!a.sensitive && !!a.onlinePayments },
  // WA-U1: con `WHATSAPP_MODE=off` (default de prod hasta que Meta apruebe) la pestaña no existe.
  { key: "whatsapp", label: "WhatsApp", visible: (a) => !!a.sensitive && !!a.whatsapp },
  { key: "diagnosticos", label: "Diagnósticos", module: "diagnostico", visible: admin },
  // DIR-3c: con el directorio en `off` (default de prod hasta que Martin lo prenda) la pestaña no existe: publicar en
  // algo que el público todavía no ve sería un switch sin efecto.
  // T3d-1g: Directorio y Usuarios son lo delicado (`tenant.sensitive`): la Secretaria con «Configuración» no los ve.
  { key: "directorio", label: "Directorio", visible: (a) => a.tenantAdmin && !!a.sensitive && !!a.directory },
  { key: "usuarios", label: "Usuarios", visible: (a) => a.team && !!a.sensitive },
  { key: "plan", label: "Plan y uso", visible: (a) => a.billing },
  { key: "facturacion", label: "Facturación", visible: (a) => a.billing },
  // CF2 (T.C): lo personal del turnero y los avisos, primera de las personales (antes de «Mis fichas»).
  { key: "mi-agenda", label: "Mi agenda", visible: (a) => !!a.miAgenda },
  // FC-3i: lo personal de las fichas, antes de Soporte (para un Profesional sin delegaciones es la pestaña inicial).
  { key: "mis-fichas", label: "Mis fichas", module: "evoluciones", visible: (a) => !!a.fichas },
  // TP-3a (TP-UI-D2): la cuenta propia de Mercado Pago, personal como «Mis fichas».
  { key: "mercado-pago", label: "Mi Mercado Pago", visible: (a) => !!a.myMp },
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
  onPreload,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  /** @deprecated PL-3a: pasá `access`. Sin `access`, el default del rol (`legacyConfigAccess`). */
  role?: Role;
  access?: ConfigTabAccess;
  modules: readonly TenantModule[];
  /** BO-Z B6: pisa `access.canExport` (el titular de un consultorio suspendido). */
  canExport?: boolean;
  /** [PF1.1-config · C-PF2] Precarga del chunk de la pestaña en hover/foco (cada panel es un `next/dynamic`). */
  onPreload?: (t: Tab) => void;
}) {
  const base = access ?? (role ? legacyConfigAccess(role) : LEGACY_ACCESS.PRACTITIONER);
  const eff = canExport === undefined ? base : { ...base, canExport };
  const keys = visibleConfigTabs(eff, modules);
  const tabs = TAB_DEFS.filter((t) => keys.includes(t.key));
  const listRef = useRef<HTMLDivElement>(null);
  const fade = useScrollFade(listRef);

  // La pestaña activa siempre a la vista (entrar por `?tab=exportar` en un celular la dejaba fuera del scroll).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  // Teclado del patrón tablist (WAI-ARIA): ← → recorren, Inicio/Fin van a los extremos; una sola parada de Tab.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0 || !tabs[next]) return;
    e.preventDefault();
    setTab(tabs[next].key);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  // B3.4: con 11 pestañas la píldora no entra en un celular (ni a 1024 con la barra lateral abierta): scrollea en
  // horizontal con un degradé en el borde que avisa que hay más (C4, configuracion.module.css).
  // MB-1e (C-MB3): < 768 la píldora se esconde y queda un `select` nativo con las mismas secciones. A 390 la píldora
  // mostraba 3 de 12 pestañas y había que adivinar que scrolleaba; el select las lista todas y el picker del sistema
  // es el control táctil que el usuario ya conoce. Los dos se renderizan siempre (el CSS elige): sin `matchMedia`, sin
  // salto de hidratación. Es controlado por `tab`: si el dirty-guard cancela el cambio, vuelve solo a la pestaña actual.
  return (
    <>
      <label className={styles.sectionPicker}>
        <span className={styles.sectionPickerLabel} aria-hidden="true">
          Sección
        </span>
        <select
          className={`k-input ${styles.sectionSelect}`}
          aria-label="Sección de Configuración"
          value={tab}
          onChange={(e) => {
            const t = e.target.value as Tab;
            onPreload?.(t);
            setTab(t);
          }}
        >
          {tabs.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    <div className={styles.tabsWrap} data-fade-start={fade.start || undefined} data-fade-end={fade.end || undefined}>
      <div
        ref={listRef}
        className={`k-glass ${styles.tabs}`}
        role="tablist"
        aria-label="Secciones de Configuración"
        onKeyDown={onKeyDown}
        onScroll={fade.update}
      >
        {tabs.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={styles.tab}
              onClick={() => setTab(t.key)}
              onPointerEnter={onPreload ? () => onPreload(t.key) : undefined}
              onFocus={onPreload ? () => onPreload(t.key) : undefined}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
    </>
  );
}

/** ¿Hay contenido escondido a la izquierda / derecha del scroller? (para el degradé del borde). */
function useScrollFade(ref: React.RefObject<HTMLElement>) {
  const [fade, setFade] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, [ref]);
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, update]);
  return { ...fade, update };
}

// [PF1.0-b · C-PF6] El `Switch` vive en `components/ui/switch.tsx` (área de toque de 44 px); este re-export deja a los
// llamadores de Configuración como estaban.
export { Switch } from "@/components/ui/switch";

// [T4-Z] `role="alert"`: el error aparece después de un guardado (sin cambio de foco) y sin el rol el lector no se
// entera. Todos los usos lo montan condicionalmente, así que se anuncia una vez al aparecer.
export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--danger-bg)",
        color: "var(--danger-fg)",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}
