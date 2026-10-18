/**
 * T3c-1p (plan §23.6) · tabla «Módulos» de Plataforma → consultorio → Suscripción. Server-safe (sin "use client"):
 * es la foto de lo que ve el consultorio (`moduleStateRows` sobre el set efectivo, overrides incluidos) y el botón que
 * abre el Drawer de edición (`TenantModulesDrawer`, cliente).
 *
 * Cada fila: nombre, estado («Del plan», «Habilitado a mano», «Deshabilitado a mano», «No incluido») y candado en lo
 * que no se puede tocar (núcleo y lo que no existe en la vertical). El turnero va como fila informativa: no es un
 * override, se maneja con su switch.
 */
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { Tag } from "@/components/ui/tag";
import { Section } from "@/components/plataforma/tenants/detail-ui";
import {
  MODULE_STATE_TONE,
  TURNERO_ROW_HINT,
  entitlementsOf,
  moduleTableRows,
  type ModuleTableRow,
} from "@/components/plataforma/tenants/module-overrides-form";
import { TenantModulesDrawer } from "@/components/plataforma/tenants/tenant-modules-drawer";

/** Candado de las filas bloqueadas. Decorativo: el texto de la fila dice por qué (`lockHint`). */
export function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  padding: "10px 0",
  borderTop: "1px solid rgba(15,30,51,0.06)",
  minHeight: 44,
} as const;

function ModuleRow({ r }: { r: ModuleTableRow }) {
  return (
    <li style={rowStyle}>
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)", display: "inline-flex", gap: 6, alignItems: "center" }}>
          {r.locked && (
            <span style={{ color: "var(--navy-300)", display: "inline-flex" }}>
              <LockGlyph />
            </span>
          )}
          {r.name}
        </span>
        {r.lockHint && <span style={{ fontSize: 12, color: "var(--navy-300)" }}>{r.lockHint}</span>}
      </span>
      <Tag tone={MODULE_STATE_TONE[r.state]} variant={r.state === "absent" ? "outline" : "fill"}>
        {r.stateLabel}
      </Tag>
    </li>
  );
}

/** Lista de solo lectura (la pestaña). La usa también el render test. */
export function TenantModulesList({ detail: d }: { detail: PlatformTenantDetail }) {
  const rows = moduleTableRows(entitlementsOf(d));
  return (
    <ul aria-label="Módulos del consultorio" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((r) => (
        <ModuleRow key={r.module} r={r} />
      ))}
      <li style={rowStyle}>
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>Turnos online</span>
          <span style={{ fontSize: 12, color: "var(--navy-300)" }}>{TURNERO_ROW_HINT}</span>
        </span>
        <Tag tone={d.publicBookingEnabled ? "lime" : "soft"} variant={d.publicBookingEnabled ? "fill" : "outline"}>
          {d.publicBookingEnabled ? "Activo" : "Apagado"}
        </Tag>
      </li>
    </ul>
  );
}

export function TenantModulesSection({ detail: d }: { detail: PlatformTenantDetail }) {
  return (
    <Section
      title="Módulos"
      description="Lo que ve el consultorio: lo que trae el plan más lo que habilitaste o deshabilitaste a mano. Lo básico no se toca."
      action={<TenantModulesDrawer detail={d} />}
    >
      <TenantModulesList detail={d} />
    </Section>
  );
}
