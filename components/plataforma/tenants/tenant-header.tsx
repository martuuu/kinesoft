/**
 * [BO3-B] Header del detalle de un consultorio (lo monta `consultorios/[id]/layout.tsx` sobre todas las pestañas):
 * nombre, slug, Tags de estado / tipo / plan / suscripción, banda si está suspendido o de baja (con el motivo y desde
 * cuándo), «Entrar como soporte» y las pestañas.
 *
 * Sin "use client": los datos vienen del layout (server) y las partes interactivas (soporte, pestañas) son hijos
 * cliente con props serializables.
 */
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import type { PlatformTenantRow } from "@/lib/platform-tenants-types";
import { formatDateAR } from "@/lib/format";
import {
  ACCESS_MODE_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
  TENANT_STATUS_LABEL,
  TENANT_STATUS_TONE,
  statusReasonText,
} from "@/components/plataforma/tenants/labels";
import { SupportButton } from "@/components/plataforma/tenants/support-button";
import { TenantTabs } from "@/components/plataforma/tenants/tenant-tabs";

/** Texto de la banda roja; null = no hay banda (consultorio activo). */
export function statusBannerText(t: Pick<PlatformTenantRow, "status" | "statusReason" | "statusChangedAt">): string | null {
  if (t.status === "ACTIVE") return null;
  const head = t.status === "SUSPENDED" ? "Consultorio suspendido" : "Consultorio dado de baja";
  const since = t.statusChangedAt ? ` desde el ${formatDateAR(t.statusChangedAt, "short")}` : "";
  const reason = statusReasonText(t.statusReason);
  const tail =
    t.status === "SUSPENDED"
      ? "El equipo no puede entrar y los turnos online están cerrados."
      : "Nadie del equipo puede entrar. No se borró nada: la historia clínica se conserva.";
  return `${head}${since}.${reason ? ` Motivo: ${reason}.` : ""} ${tail}`;
}

export function TenantDetailHeader({ detail: d }: { detail: PlatformTenantRow }) {
  const banner = statusBannerText(d);
  // El modo REAL se muestra solo cuando dice algo que el estado no dice (gracia, solo lectura por trial vencido).
  const showAccess = d.status === "ACTIVE" && d.access.mode !== "full";
  return (
    <Card style={{ padding: 22, display: "grid", gap: 14 }}>
      <div>
        <Link href="/plataforma/consultorios" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--sky-700)" }}>
          ← Consultorios
        </Link>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h1 className="k-display" style={{ fontSize: 26, margin: 0, overflowWrap: "anywhere" }}>
                {d.name}
              </h1>
              {d.isPlatformHome && <Tag tone="lime">Plataforma</Tag>}
            </div>
            {/* PF1.2 (VX0-b P4): tipo y plan son datos, no estados: van en la línea del slug como texto. Los chips
                quedan solo para estados, en dos pesos: el del consultorio relleno (tono por estado) y los secundarios
                (suscripción, acceso) con borde. Antes eran cinco chips en tres estilos y la suscripción, con `soft`
                sobre la card blanca, se leía como texto suelto. */}
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 2, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-mono)" }}>{d.slug}</span>
              <span aria-hidden="true">·</span>
              <span>{VERTICAL_LABEL[d.vertical]}</span>
              <span aria-hidden="true">·</span>
              <span>Plan {SAAS_PLAN_LABEL[d.saasPlan]}</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <Tag tone={TENANT_STATUS_TONE[d.status]}>{TENANT_STATUS_LABEL[d.status]}</Tag>
              <Tag tone="soft" variant="outline">
                Suscripción: {SUBSCRIPTION_STATUS_LABEL[d.subscriptionStatus].toLowerCase()}
              </Tag>
              {showAccess && (
                <Tag tone="soft" variant="outline">
                  Acceso: {ACCESS_MODE_LABEL[d.access.mode].toLowerCase()}
                </Tag>
              )}
            </div>
          </div>
          <SupportButton tenantId={d.id} tenantName={d.name} status={d.status} />
        </div>
      </div>

      {banner && (
        <div
          role="status"
          data-testid="status-banner"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            color: "var(--danger-fg)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {banner}
        </div>
      )}

      <TenantTabs tenantId={d.id} />
    </Card>
  );
}
