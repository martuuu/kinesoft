/**
 * [BO3-B] Piezas de presentación compartidas por las pestañas del detalle de un consultorio en /plataforma
 * (Resumen, Suscripción, Ciclo de vida, Actividad). Sin "use client": las usan server components y los paneles
 * cliente. Antes vivían adentro de `tenant-detail.tsx`, que era una sola página.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { EyebrowLabel } from "@/components/ui/eyebrow";

export function Section({
  title,
  children,
  action,
  description,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  description?: string;
}) {
  return (
    <Card style={{ padding: 18, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 className="k-display" style={{ fontSize: 17, margin: 0, fontWeight: 700 }}>
            {title}
          </h2>
          {description && (
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45, maxWidth: 620 }}>
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** Lista definición-valor: dos columnas que en mobile se apilan solas (auto-fit). */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
        gap: "12px 20px",
      }}
    >
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

export const muted = (s: string) => <span style={{ color: "var(--navy-300)" }}>{s}</span>;

/** Caja de error de un form (mismo estilo que el Drawer de suscripción de EV0). */
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: "10px 12px",
        borderRadius: "var(--r-sm)",
        background: "rgba(225,75,75,0.08)",
        border: "1px solid rgba(225,75,75,0.25)",
        color: "#9F1F1F",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

/** Aviso (ámbar): algo salió a medias o requiere atención, sin ser un error. */
export function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: "10px 12px",
        borderRadius: "var(--r-sm)",
        background: "rgba(228,176,32,0.15)",
        color: "#7A4A00",
        fontSize: 12.5,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

/** Checkbox con título y explicación (mismo patrón que «Turnos online» del Drawer de suscripción). */
export function CheckRow({
  checked,
  onChange,
  disabled,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title: string;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: "var(--r-sm)",
        background: "rgba(255,255,255,0.7)",
        border: "1px solid rgba(15,30,51,0.08)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--sky-700)" }}
      />
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{title}</span>
        {hint && <span style={{ fontSize: 12, color: "var(--navy-300)" }}>{hint}</span>}
      </span>
    </label>
  );
}
