/**
 * [BO3-B] Lista de eventos `platform.*` de un consultorio: la pestaña «Actividad» (paginada con cursor) y los
 * últimos cambios del Resumen. Solo lo que trae el DTO: acción, fecha, email del superadmin, before → after de
 * enums/booleanos/números y los NOMBRES de las claves del payload (nunca sus valores: pueden ser texto libre).
 */
import Link from "next/link";
import { formatDateAR } from "@/lib/format";
import type { PlatformActivityPage, PlatformAuditEventRow } from "@/lib/platform-tenants-types";
import {
  auditKeyLabel,
  formatAuditValue,
  platformActionLabel,
  tenantTabHref,
} from "@/components/plataforma/tenants/labels";
import { Section } from "@/components/plataforma/tenants/detail-ui";

/** Claves del payload que ya se ven como cambio before → after, o que son de plomería del registro. */
const HIDDEN_PAYLOAD_KEYS = new Set(["changed", "before", "after"]);

type EventLike = PlatformAuditEventRow & { payloadKeys?: string[] };

function EventItem({ e }: { e: EventLike }) {
  // Un cambio sin valores (p. ej. `platform.tenant.profile`, que audita solo QUÉ cambió) se lista por su nombre.
  const withValues = e.changes.filter((c) => c.before !== null || c.after !== null);
  const keysOnly = e.changes.filter((c) => c.before === null && c.after === null).map((c) => c.key);
  const extraKeys = (e.payloadKeys ?? []).filter((k) => !HIDDEN_PAYLOAD_KEYS.has(k));
  return (
    <li style={{ paddingBottom: 10, borderBottom: "1px solid rgba(15,30,51,0.05)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>{platformActionLabel(e.action)}</span>
        <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
          {formatDateAR(e.createdAt, "compact")} · {e.actorEmail ?? "cuenta eliminada"}
        </span>
      </div>
      {withValues.length > 0 && (
        <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: 2 }}>
          {withValues.map((ch) => (
            <li key={ch.key} style={{ fontSize: 13, color: "var(--navy-900)" }}>
              <span style={{ fontWeight: 600 }}>{auditKeyLabel(ch.key)}:</span>{" "}
              <span style={{ color: "var(--navy-500)" }}>{formatAuditValue(ch.key, ch.before)}</span> →{" "}
              <span style={{ fontWeight: 600 }}>{formatAuditValue(ch.key, ch.after)}</span>
            </li>
          ))}
        </ul>
      )}
      {keysOnly.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 4 }}>
          Cambió: {keysOnly.map(auditKeyLabel).join(", ")}
        </div>
      )}
      {e.changes.length === 0 && extraKeys.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
          {extraKeys.join(" · ")}
        </div>
      )}
    </li>
  );
}

export function ActivityList({ events, empty }: { events: EventLike[]; empty: string }) {
  if (events.length === 0) return <p style={{ margin: 0, fontSize: 13, color: "var(--navy-300)" }}>{empty}</p>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
      {events.map((e) => (
        <EventItem key={e.id} e={e} />
      ))}
    </ol>
  );
}

export function activityHref(tenantId: string, cursor: string | null): string {
  const base = tenantTabHref(tenantId, "actividad");
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

/** Pestaña «Actividad». `fromStart` = primera página (sin cursor): sin link «Volver a lo más nuevo». */
export function TenantActivityView({
  tenantId,
  page,
  fromStart,
}: {
  tenantId: string;
  page: PlatformActivityPage;
  fromStart: boolean;
}) {
  return (
    <Section
      title="Actividad desde Plataforma"
      description="Todo lo que un superadmin hizo sobre este consultorio, de lo más nuevo a lo más viejo. No incluye lo que hace el equipo del consultorio."
    >
      <ActivityList events={page.events} empty={fromStart ? "Todavía no hubo cambios desde Plataforma." : "No hay más eventos."} />
      {(page.nextCursor || !fromStart) && (
        <nav
          aria-label="Paginación de la actividad"
          style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 14, flexWrap: "wrap" }}
        >
          {!fromStart ? (
            <Link href={activityHref(tenantId, null)} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
              ← Lo más nuevo
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor && (
            <Link
              href={activityHref(tenantId, page.nextCursor)}
              style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}
            >
              Más viejos →
            </Link>
          )}
        </nav>
      )}
    </Section>
  );
}
