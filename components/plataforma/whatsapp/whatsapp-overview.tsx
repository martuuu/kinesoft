/**
 * WA-U6 · /plataforma/whatsapp. Una Card con el modo y las variables de Meta (presencia, nunca el valor) y otra con
 * una fila por consultorio: estado de la cuenta, calidad y límite que informa Meta, plantillas aprobadas, mensajes de
 * 7 días y los códigos de error más frecuentes. Sin "use client": es una foto del server al cargar.
 *
 * Sin teléfonos: la vista solo puede pintar lo que trae `PlatformWhatsAppOverview`, que no tiene ni el número del
 * consultorio ni los de los pacientes (ver `lib/platform-whatsapp-read.ts`). Del WABA, la cola de 4 dígitos.
 *
 * Los códigos de error se muestran crudos (`rate_limit:131056`): es lo que se busca en la documentación de Meta y en
 * los logs; traducirlos acá duplicaría `lib/whatsapp/logic.ts`.
 */
import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { formatDateTimeAR } from "@/components/plataforma/users/users-logic";
import type { PlatformWhatsAppAccountRow, PlatformWhatsAppOverview, WaMessages7d } from "@/lib/platform-whatsapp-read";
import table from "@/components/plataforma/responsive-table.module.css";

const STATUS_LABEL: Record<PlatformWhatsAppAccountRow["status"], string> = {
  SETUP: "Configurando",
  ACTIVE: "Activa",
  REAUTH_REQUIRED: "Hay que reconectar",
  DISCONNECTED: "Desconectada",
};

const QUALITY_LABEL: Record<string, string> = { GREEN: "Alta", YELLOW: "Media", RED: "Baja" };

/** Meta informa el límite como `TIER_250`, `TIER_1K`… (destinatarios distintos por 24 h) o `TIER_UNLIMITED`. */
function limitLabel(v: string | null): string {
  if (!v) return "—";
  const m = /^TIER_(\w+)$/.exec(v);
  if (!m) return v;
  return m[1] === "UNLIMITED" ? "Sin límite" : `${m[1]} / 24 h`;
}

const COUNTS: Array<{ key: keyof WaMessages7d; label: string }> = [
  { key: "sent", label: "Enviados" },
  { key: "delivered", label: "Entregados" },
  { key: "read", label: "Leídos" },
  { key: "failed", label: "Fallidos" },
  { key: "skipped", label: "Salteados" },
];

const muted = { color: "var(--navy-400)", fontSize: 12.5 } as const;

// Grilla de `responsive-table.module.css` (MB-1f): columnas por variable para que bajo 768 px cada fila sea una card
// con el rótulo de `data-label`, sin scroll horizontal de la página.
const HEADERS = ["Consultorio", "Estado", "Calidad", "Límite", "Plantillas", "Mensajes (7 días)", "Errores", "Último webhook"];
const TABLE_VARS = {
  "--pt-cols": "minmax(160px,1.4fr) minmax(120px,1fr) 70px 100px 90px minmax(200px,1.6fr) minmax(150px,1.2fr) 130px",
  "--pt-min-w": "1100px",
} as CSSProperties;
const HEAD_STYLE = {
  gap: 12,
  padding: "8px 16px",
  fontSize: 11.5,
  fontWeight: 700,
  color: "var(--navy-500)",
  borderBottom: "1px solid rgba(15,30,51,0.08)",
} as const;
const ROW_STYLE = { gap: 12, padding: "12px 16px", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.06)", alignItems: "start" } as const;

function Warn({ children }: { children: ReactNode }) {
  return (
    <span className="k-tag" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)" }}>
      {children}
    </span>
  );
}

function StatusTag({ status }: { status: PlatformWhatsAppAccountRow["status"] }) {
  if (status === "ACTIVE") return <Tag tone="lime">{STATUS_LABEL[status]}</Tag>;
  if (status === "REAUTH_REQUIRED") return <Warn>{STATUS_LABEL[status]}</Warn>;
  return <Tag tone="soft">{STATUS_LABEL[status]}</Tag>;
}

function AccountRow({ r }: { r: PlatformWhatsAppAccountRow }) {
  return (
    <div className={table.row} data-wa-account={r.tenantId} style={ROW_STYLE} role="row">
      <div className={table.sticky} style={{ minWidth: 0 }} role="cell">
        <div style={{ fontWeight: 600 }}>{r.tenantName}</div>
        <div style={muted}>
          WABA …{r.wabaIdTail} · {r.mode}
        </div>
      </div>
      <div data-label="Estado" role="cell">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <StatusTag status={r.status} />
          {r.paymentIssue && <Warn>Problema con el medio de pago</Warn>}
        </div>
      </div>
      <div data-label="Calidad" role="cell">{r.qualityRating ? (QUALITY_LABEL[r.qualityRating] ?? r.qualityRating) : "—"}</div>
      <div data-label="Límite" role="cell">{limitLabel(r.messagingLimit)}</div>
      <div data-label="Plantillas" role="cell">
        {r.templatesApproved} de {r.templatesTotal}
      </div>
      <div data-label="Mensajes (7 días)" role="cell">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 12.5 }}>
          {COUNTS.map((c) => (
            <span key={c.key}>
              {c.label}: <strong data-wa-count={c.key}>{r.messages7d[c.key]}</strong>
            </span>
          ))}
        </div>
      </div>
      <div data-label="Errores" role="cell">
        {r.topErrors.length === 0 && !r.lastErrorCode ? (
          <span style={muted}>—</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5 }}>
            {r.topErrors.map((e) => (
              <code key={e.code}>
                {e.code} ×{e.count}
              </code>
            ))}
            {r.lastErrorCode && <span style={muted}>Último: {r.lastErrorCode}</span>}
          </div>
        )}
      </div>
      <div data-label="Último webhook" role="cell">{r.lastWebhookAt ? formatDateTimeAR(r.lastWebhookAt) : <span style={muted}>Nunca</span>}</div>
    </div>
  );
}

export function WhatsAppOverview({ overview }: { overview: PlatformWhatsAppOverview }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Configuración</h2>
          <span style={muted}>Modo</span>
          <Tag tone={overview.mode === "off" ? "soft" : "sky"}>{overview.mode}</Tag>
        </div>
        {overview.mode === "off" && (
          <p style={{ margin: 0 }}>
            WhatsApp está apagado (WHATSAPP_MODE=off). No se manda ningún mensaje y no hay nada que mostrar por
            consultorio.
          </p>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {overview.env.map((e) => (
            <li
              key={e.name}
              data-wa-env={e.name}
              data-present={String(e.present)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
            >
              <code style={{ fontSize: 12.5 }}>{e.name}</code>
              {e.present ? <Tag tone="lime">Cargada</Tag> : <Warn>Falta</Warn>}
            </li>
          ))}
        </ul>
        {overview.mode !== "off" && overview.stats.available && (
          <div style={{ fontSize: 13 }}>
            Último webhook (todos los consultorios):{" "}
            {overview.stats.lastWebhookAt ? formatDateTimeAR(overview.stats.lastWebhookAt) : <span style={muted}>Nunca</span>}
          </div>
        )}
      </Card>

      {overview.mode !== "off" && (
        <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Consultorios</h2>
          {!overview.stats.available ? (
            <p style={{ margin: 0 }}>No se pudieron leer las cuentas de WhatsApp. Revisá los logs del deploy.</p>
          ) : overview.stats.accounts.length === 0 ? (
            <p style={{ margin: 0, ...muted }}>Ningún consultorio conectó WhatsApp todavía.</p>
          ) : (
            <>
              <p style={{ margin: 0, ...muted }}>
                Mensajes de los últimos {overview.windowDays} días. Enviados incluye los entregados y leídos.
              </p>
              <div className={table.scroller} style={TABLE_VARS} role="table" aria-label="Cuentas de WhatsApp por consultorio">
                <div className={table.inner}>
                  <div className={table.head} style={HEAD_STYLE} role="row">
                    {HEADERS.map((h, i) => (
                      <div key={h} className={i === 0 ? table.sticky : undefined} role="columnheader">
                        {h}
                      </div>
                    ))}
                  </div>
                  {overview.stats.accounts.map((r) => (
                    <AccountRow key={r.tenantId} r={r} />
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
