/**
 * BO3-E · /plataforma/sistema. Una Card por servicio externo con el estado de cada variable: «OK» (está), «Falta»,
 * «Revisar» o el VALOR cuando es un enum no secreto (driver de tiempo real, modo de corte, entorno). La vista solo
 * puede mostrar lo que trae `PlatformSystemStatus`, que nunca contiene un secreto (ver `platform-system-logic.ts`).
 * Sin "use client": es una foto del server al cargar.
 */
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { formatDateAR } from "@/lib/format";
import type { PlatformSystemStatus, SystemCheck } from "@/lib/platform-system-logic";

function StateBadge({ c }: { c: SystemCheck }) {
  if (c.state === "ok") return <Tag tone="lime">{c.value ? `OK · ${c.value}` : "OK"}</Tag>;
  if (c.state === "value") return <Tag tone="sky">{c.value ?? "—"}</Tag>;
  const warn = c.state === "warn";
  return (
    <span
      className="k-tag"
      style={{
        background: warn ? "rgba(214,158,46,0.14)" : "var(--danger-bg)",
        color: warn ? "#7A5410" : "var(--danger-fg)",
      }}
    >
      {warn ? (c.value ? `Revisar · ${c.value}` : "Revisar") : c.value ? `Falta · ${c.value}` : "Falta"}
    </span>
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
          </Card>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--navy-500)", margin: 0 }}>
        Foto de este deploy al {formatDateAR(status.generatedAt, "short")} {formatDateAR(status.generatedAt, "time")}. Los
        secretos nunca se muestran: solo si están cargados.
      </p>
    </div>
  );
}
