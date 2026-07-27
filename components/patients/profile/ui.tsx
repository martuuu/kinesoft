import { Tag } from "@/components/ui/tag";
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
  const colour =
    tone === "lime" ? "var(--lime-500)" : tone === "sky" ? "var(--sky-700)" : "var(--navy-900)";
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

export function BookingStatusTag({ status }: { status: PatientWithRelations["bookings"][number]["status"] }) {
  const map: Record<string, { tone: "lime" | "sky" | "soft"; label: string }> = {
    CONFIRMED: { tone: "sky", label: "Confirmado" },
    COMPLETED: { tone: "lime", label: "Hecho" },
    CANCELLED: { tone: "soft", label: "Cancelado" },
    NO_SHOW: { tone: "soft", label: "Ausente" },
    PENDING: { tone: "soft", label: "Pendiente" },
  };
  const m = map[status] ?? { tone: "soft" as const, label: status };
  return <Tag tone={m.tone}>{m.label}</Tag>;
}
