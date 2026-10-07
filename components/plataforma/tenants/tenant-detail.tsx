/**
 * [EV0-P3] Detalle de un consultorio en /plataforma (plan §15.4). Todo de solo
 * lectura salvo el Drawer "Editar suscripción" (EV-D6: tipo, plan, estado, trial
 * y turnos online; nombre, contacto y "vista compartida" no se editan desde acá).
 *
 * Solo muestra lo que trae `PlatformTenantDetail`: datos del consultorio,
 * conteos y eventos `platform.*`. Nada de PHI (el DTO es el allowlist, ver
 * `lib/platform-tenants-types.ts`).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { formatDateAR } from "@/lib/format";
import {
  MODULE_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
  auditKeyLabel,
  formatAuditValue,
  formatDayKeyAR,
} from "@/components/plataforma/tenants/labels";
import { TenantEditDrawer } from "@/components/plataforma/tenants/tenant-edit-drawer";

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card style={{ padding: 18, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h2 className="k-display" style={{ fontSize: 17, margin: 0, fontWeight: 700 }}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** Lista definición-valor: dos columnas que en mobile se apilan solas (auto-fit). */
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: "12px 20px" }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <dt>
            <EyebrowLabel as="span">{k}</EyebrowLabel>
          </dt>
          <dd style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const muted = (s: string) => <span style={{ color: "var(--navy-300)" }}>{s}</span>;

export function TenantDetailView({ detail: d }: { detail: PlatformTenantDetail }) {
  const c = d.counts;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 22 }}>
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
            <div style={{ fontSize: 13, color: "var(--navy-300)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
              {d.slug}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <Tag tone="sky">{VERTICAL_LABEL[d.vertical]}</Tag>
              <Tag tone="sky">Plan {PLAN_LABEL[d.plan]}</Tag>
              <Tag tone="soft">{SUBSCRIPTION_STATUS_LABEL[d.subscriptionStatus]}</Tag>
            </div>
          </div>
          <TenantEditDrawer detail={d} />
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 14 }}>
        <Section title="Suscripción">
          <Facts
            items={[
              ["Tipo", VERTICAL_LABEL[d.vertical]],
              ["Plan", PLAN_LABEL[d.plan]],
              ["Estado", SUBSCRIPTION_STATUS_LABEL[d.subscriptionStatus]],
              ["Trial", d.trialEndsOn ? `Hasta el ${formatDayKeyAR(d.trialEndsOn)}` : muted("Sin trial")],
              [
                "Turnos online",
                <span key="t" style={{ display: "grid", gap: 2 }}>
                  <span>{d.publicBookingEnabled ? "Activo" : "Apagado"}</span>
                  <a
                    href={d.publicBookingPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12.5, fontWeight: 600, color: "var(--sky-700)" }}
                  >
                    Ver la página de turnos ↗
                  </a>
                </span>,
              ],
            ]}
          />
        </Section>

        <Section title="Datos del consultorio">
          <Facts
            items={[
              ["Titular", d.ownerEmails.length ? d.ownerEmails.join(", ") : muted("—")],
              ["Email público", d.publicEmail ?? muted("—")],
              ["Teléfono", d.phone ?? muted("—")],
              ["WhatsApp", d.whatsapp ?? muted("—")],
              ["Vista compartida de pacientes", d.sharedPatientView ? "Sí" : "No"],
              ["Onboarding", d.onboardingCompleted ? "Completo" : "Pendiente"],
              ["Creado", formatDateAR(d.createdAt, "short")],
              ["Última actividad", d.lastActivityAt ? formatDateAR(d.lastActivityAt, "compact") : muted("Sin actividad")],
            ]}
          />
          <p style={{ fontSize: 12, color: "var(--navy-300)", margin: "12px 0 0" }}>
            Estos datos los edita el consultorio desde Configuración.
          </p>
        </Section>
      </div>

      <Section title="Módulos activos">
        {d.modules.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-300)" }}>Sin módulos.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {d.modules.map((m) => (
              <li key={m}>
                <Tag tone="sky">{MODULE_LABEL[m]}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Uso">
        <Facts
          items={[
            ["Miembros", `${c.members}${c.pendingInvitations ? ` · ${c.pendingInvitations} invitación(es) pendiente(s)` : ""}`],
            ["Profesionales", String(c.practitioners)],
            ["Pacientes activos", String(c.patients)],
            ["Servicios", String(c.services)],
            ["Sedes", String(c.locations)],
            ["Turnos (total)", String(c.bookingsTotal)],
            ["Turnos últimos 30 días", String(c.bookingsLast30Days)],
            ["Turnos próximos", String(c.bookingsUpcoming)],
          ]}
        />
      </Section>

      <Section title="Cambios desde Plataforma">
        {d.recentPlatformEvents.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-300)" }}>Todavía no hubo cambios desde Plataforma.</p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {d.recentPlatformEvents.map((e) => (
              <li key={e.id} style={{ paddingBottom: 10, borderBottom: "1px solid rgba(15,30,51,0.05)" }}>
                <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                  {formatDateAR(e.createdAt, "compact")} · {e.actorEmail ?? "cuenta eliminada"}
                </div>
                {e.changes.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--navy-300)" }}>{e.action}</div>
                ) : (
                  <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: 2 }}>
                    {e.changes.map((ch) => (
                      <li key={ch.key} style={{ fontSize: 13, color: "var(--navy-900)" }}>
                        <span style={{ fontWeight: 600 }}>{auditKeyLabel(ch.key)}:</span>{" "}
                        <span style={{ color: "var(--navy-500)" }}>{formatAuditValue(ch.key, ch.before)}</span> →{" "}
                        <span style={{ fontWeight: 600 }}>{formatAuditValue(ch.key, ch.after)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
