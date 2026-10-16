/**
 * [EV0-P3 → BO3-B] Pestaña «Resumen» del detalle de un consultorio en /plataforma. Hasta BO3 era la página entera
 * (con el Drawer de suscripción en el header); desde BO3-B el header vive en `consultorios/[id]/layout.tsx`
 * (`TenantDetailHeader`) y la suscripción tiene su pestaña.
 *
 * Muestra: datos del consultorio (editables con «Editar datos», BO2-D revisa EV-D6), slug y sus alias (BO-D9),
 * estado del alta, módulos, uso con los cupos por tipo (PL-1d) y los últimos cambios desde Plataforma.
 *
 * Solo lo que traen `PlatformTenantDetail` y los `seats` de `getTenantTeamForPlatform`: datos del consultorio,
 * conteos y eventos `platform.*`. Nada de PHI (el DTO es el allowlist, ver `lib/platform-tenants-types.ts`).
 */
import Link from "next/link";
import { Tag } from "@/components/ui/tag";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { formatDateAR } from "@/lib/format";
import {
  visibleModuleChips,
  seatFullText,
  seatLimitLabel,
  seatUsageByKindLabel,
  tenantTabHref,
} from "@/components/plataforma/tenants/labels";
import type { SeatUsageByKind } from "@/lib/plan-catalog";
import { Facts, Section, muted } from "@/components/plataforma/tenants/detail-ui";
import { TenantProfileDrawer } from "@/components/plataforma/tenants/tenant-profile-drawer";
import { ActivityList } from "@/components/plataforma/tenants/tenant-activity";

/** PL-1d: cupos por tipo (C-PL3), los de `getTenantTeamForPlatform`. */
export type TenantSeats = SeatUsageByKind;

const linkStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "var(--sky-700)" };

export function TenantSummaryView({ detail: d, seats }: { detail: PlatformTenantDetail; seats: TenantSeats | null }) {
  const c = d.counts;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 14 }}>
        <Section title="Datos del consultorio" action={<TenantProfileDrawer detail={d} />}>
          <Facts
            items={[
              ["Nombre", d.name],
              ["Razón social", d.legalName ?? muted("—")],
              ["CUIT", d.taxId ?? muted("—")],
              // VX0-b (decisión 19): el email nunca como nombre; va en su propia fila, rotulada «Email del titular».
              ["Titular", d.ownerNames.length ? d.ownerNames.join(", ") : muted("Sin titular")],
              ["Email del titular", d.ownerEmails.length ? d.ownerEmails.join(", ") : muted("—")],
              ["Email público", d.publicEmail ?? muted("—")],
              ["Teléfono", d.phone ?? muted("—")],
              ["WhatsApp", d.whatsapp ?? muted("—")],
              ["Vista compartida de pacientes", d.sharedPatientView ? "Sí" : "No"],
              ["Creado", formatDateAR(d.createdAt, "short")],
              ["Última actividad", d.lastActivityAt ? formatDateAR(d.lastActivityAt, "compact") : muted("Sin actividad")],
            ]}
          />
          {d.ownerEmails.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--danger-fg)", margin: "12px 0 0" }}>
              Este consultorio no tiene titular.{" "}
              <Link href={tenantTabHref(d.id, "equipo")} style={linkStyle}>
                Ir al equipo
              </Link>
            </p>
          )}
        </Section>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <Section title="Dirección y alias">
            <Facts
              items={[
                ["Slug", <span key="s" style={{ fontFamily: "var(--font-mono)" }}>{d.slug}</span>],
                [
                  "Turnos online",
                  <span key="t" style={{ display: "grid", gap: 2 }}>
                    <span>{d.publicBookingEnabled ? "Activo" : "Apagado"}</span>
                    <a href={d.publicBookingPath} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                      Ver la página de turnos ↗
                    </a>
                  </span>,
                ],
                [
                  "Slugs anteriores",
                  d.slugAliases.length === 0 ? (
                    muted("Ninguno")
                  ) : (
                    <span key="a" style={{ display: "grid", gap: 2 }}>
                      {d.slugAliases.map((a) => (
                        <span key={a} style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                          {a}
                        </span>
                      ))}
                      <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Redirigen al slug actual.</span>
                    </span>
                  ),
                ],
              ]}
            />
          </Section>

          <Section title="Alta">
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)" }}>
              {d.onboardingCompleted ? "Terminada" : "Sin terminar: el titular todavía no completó los pasos de bienvenida."}
            </p>
            {!d.onboardingCompleted && (
              <Link href={tenantTabHref(d.id, "ciclo-de-vida")} style={{ ...linkStyle, display: "inline-block", marginTop: 6 }}>
                Darla por terminada desde Ciclo de vida
              </Link>
            )}
          </Section>
        </div>
      </div>

      <Section title="Uso">
        <Facts
          items={[
            [
              "Usuarios del plan",
              <span key="c" style={{ display: "grid", gap: 2 }}>
                <span>{seatLimitLabel(d)}</span>
                {seats && <span>{seatUsageByKindLabel(seats)}</span>}
                {seats && seatFullText(seats) && (
                  <span style={{ fontSize: 12, color: "var(--danger-fg)" }}>{seatFullText(seats)}</span>
                )}
              </span>,
            ],
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

      <Section title="Módulos activos">
        {visibleModuleChips(d.modules).length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-300)" }}>Sin módulos.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {visibleModuleChips(d.modules).map((c) => (
              <li key={c.module}>
                <Tag tone="sky">{c.label}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Últimos cambios desde Plataforma"
        action={
          <Link href={tenantTabHref(d.id, "actividad")} style={linkStyle}>
            Ver toda la actividad →
          </Link>
        }
      >
        <ActivityList events={d.recentPlatformEvents} empty="Todavía no hubo cambios desde Plataforma." />
      </Section>
    </div>
  );
}
