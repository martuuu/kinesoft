import type { BookingStatus } from "@prisma/client";
import { StatusTag } from "@/components/ui/status-tag";
import type { PatientWithRelations } from "./types";

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 14,
        background: "rgba(246,249,253,0.6)",
        border: "1px solid rgba(15,30,51,0.05)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--navy-300)",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

export function Grid2({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>
  );
}

export function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: "var(--navy-300)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export function Summary({
  label,
  value,
  tone = "navy",
}: {
  label: string;
  value: string;
  tone?: "lime" | "sky" | "navy";
}) {
  // PF1.1 (D8 de VX0-b): `lime` pintaba el monto con `--lime-500` sobre la card celeste (< 3:1). El tono sigue
  // llamándose `lime` (lo usan los llamadores para «percibido»), pero el color es `--success-fg` (AA).
  const colour =
    tone === "lime" ? "var(--success-fg)" : tone === "sky" ? "var(--sky-700)" : "var(--navy-900)";
  return (
    <div>
      <div
        className="k-display"
        style={{ fontSize: 26, fontWeight: 700, color: colour, letterSpacing: "-0.02em" }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{label}</div>
    </div>
  );
}

/**
 * Estado del turno en el perfil (Turnos, Facturación). Firma intacta; adentro
 * es el `StatusTag` único (P0-S04b): antes usaba tonos de `Tag` y "Ausente"
 * salía gris acá y ámbar en la agenda (statustag-tres-paletas).
 */
export function BookingStatusTag({ status }: { status: PatientWithRelations["bookings"][number]["status"] }) {
  // `status` viene tipado `string` en `lib/patients-types.ts:89` (DTO del
  // perfil); en la base es siempre un BookingStatus. Si algún día llega otro
  // valor, StatusTag lo muestra crudo en vez de romper (igual que el map viejo).
  return <StatusTag s={status as BookingStatus} />;
}
