/**
 * BO3-E · /plataforma/sistema. Una Card por servicio externo con el estado de cada variable: «OK» (está), «Falta»,
 * «Revisar» o el VALOR cuando es un enum no secreto (driver de tiempo real, modo de corte, entorno). La vista solo
 * puede mostrar lo que trae `PlatformSystemStatus`, que nunca contiene un secreto (ver `platform-system-logic.ts`).
 * Sin "use client": es una foto del server al cargar.
 *
 * HF-1a: la Card «Tiempo real» suma «Probar desde el servidor» (`RealtimeProbe`, isla cliente): la foto dice qué hay
 * cargado; el botón dice si con eso Supabase deja suscribirse.
 *
 * OPS-1a: la Card «Últimos mails que no salieron» (EmailLog fallidos, `EmailFailuresInfo`): fecha, tipo, motivo en
 * castellano con el código crudo al lado (`provider_error:validation_error:403`, lo que se busca en Resend) y el
 * dominio del destinatario. Nunca la dirección ni el cuerpo: el DTO no los trae.
 *
 * TP-3j (T5, brief §25.10 / C-TP13): el grupo «Cobros online (Mercado Pago)» (modo, presencias, huellas, firma, claves
 * del secret box, cuentas por estado, último webhook y última renovación) y el renombre del token de la plataforma a
 * «Token de la plataforma (legado)» los arma `buildSystemStatus` (TP-2h); acá se pintan como cualquier otro grupo, así
 * que la regla «presencia y huella, nunca el valor» la sigue garantizando el builder. Lo único propio del grupo es el
 * link al panel del simulador (`/api/mp/fake/panel`, «Forzar reconexión» y los últimos pagos) cuando el modo
 * APLICADO es `fake`: sale del valor ya validado del check (no de `process.env`), así que en Vercel, donde
 * `mpConnectMode()` baja `fake` a `off`, nunca aparece. Es un `<a>` y no un `next/link`: es un route handler, sin
 * prefetch ni navegación cliente.
 */
import { Card } from "@/components/ui/card";
import { buttonClassName } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { formatDateAR } from "@/lib/format";
import type { EmailFailuresInfo, PlatformSystemStatus, SystemCheck, SystemGroup } from "@/lib/platform-system-logic";
import { RealtimeProbe } from "@/components/plataforma/system/realtime-probe";

function StateBadge({ c }: { c: SystemCheck }) {
  if (c.state === "ok") return <Tag tone="lime">{c.value ? `OK · ${c.value}` : "OK"}</Tag>;
  if (c.state === "value") return <Tag tone="sky">{c.value ?? "—"}</Tag>;
  const warn = c.state === "warn";
  return (
    <span
      className="k-tag"
      style={{
        background: warn ? "var(--warn-bg)" : "var(--danger-bg)",
        color: warn ? "var(--warn-fg)" : "var(--danger-fg)",
      }}
    >
      {warn ? (c.value ? `Revisar · ${c.value}` : "Revisar") : c.value ? `Falta · ${c.value}` : "Falta"}
    </span>
  );
}

/** El panel del simulador (lib/mp-connect/fake-mp.ts). Solo con el modo aplicado `fake` (ver la cabecera). */
const MP_FAKE_PANEL_HREF = "/api/mp/fake/panel";

function isFakeMpGroup(g: SystemGroup): boolean {
  return g.id === "mp-connect" && g.checks.some((c) => c.key === "MP_CONNECT_MODE" && c.state === "value" && c.value === "fake");
}

function EmailFailuresCard({ info }: { info: EmailFailuresInfo }) {
  return (
    <Card style={{ padding: 16, display: "grid", gap: 10 }} data-testid="system-email-failures">
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--navy-900)" }}>Últimos mails que no salieron</h2>
      {!info.available ? (
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>No se pudo leer el registro de mails con esta conexión.</p>
      ) : info.items.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>Ninguno: todos los mails registrados salieron.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {info.items.map((f, i) => (
            <li key={`${f.at}-${i}`} style={{ display: "grid", gap: 3 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>
                  {formatDateAR(f.at, "short")} {formatDateAR(f.at, "time")} · <code style={{ fontSize: 12 }}>{f.kind}</code>
                </span>
                <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{f.recipientDomain ? `a @${f.recipientDomain}` : "destinatario sin dominio"}</span>
              </div>
              <span style={{ fontSize: 12, color: "var(--navy-500)", lineHeight: 1.4, overflowWrap: "anywhere" }}>
                <code style={{ fontSize: 11.5, color: "var(--navy-300)" }}>{f.reason}</code> · {f.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SystemView({ status }: { status: PlatformSystemStatus }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))",
          alignItems: "start",
        }}
      >
        {status.groups.map((g) => (
          <Card key={g.id} style={{ padding: 16, display: "grid", gap: 10 }} data-testid={`system-group-${g.id}`}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--navy-900)" }}>{g.title}</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {g.checks.map((c) => (
                <li key={c.key} style={{ display: "grid", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>{c.label}</span>
                    <StateBadge c={c} />
                  </div>
                  <span style={{ fontSize: 12, color: "var(--navy-500)", lineHeight: 1.4, overflowWrap: "anywhere" }}>
                    <code style={{ fontSize: 11.5, color: "var(--navy-300)" }}>{c.key}</code> · {c.detail}
                  </span>
                </li>
              ))}
            </ul>
            {g.id === "realtime" ? <RealtimeProbe /> : null}
            {isFakeMpGroup(g) ? (
              <a href={MP_FAKE_PANEL_HREF} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost", size: "sm" })} style={{ justifySelf: "start" }}>
                Abrir el simulador
              </a>
            ) : null}
          </Card>
        ))}
      </div>
      <EmailFailuresCard info={status.emailFailures} />
      <p style={{ fontSize: 12, color: "var(--navy-500)", margin: 0 }}>
        Foto de este deploy al {formatDateAR(status.generatedAt, "short")} {formatDateAR(status.generatedAt, "time")}. Los
        secretos nunca se muestran: solo si están cargados.
      </p>
    </div>
  );
}
