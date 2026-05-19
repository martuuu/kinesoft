import { Card } from "@/components/ui/card";

export const metadata = { title: "Reportes · KineSoft" };

export default function ReportesPage() {
  return (
    <Card style={{ padding: 24 }}>
      <h1 className="k-display" style={{ fontSize: 28, margin: 0 }}>
        Reportes
      </h1>
      <p style={{ color: "var(--navy-500)" }}>
        Ingresos, adherencia, evolución promedio. Pendiente para una iteración posterior.
      </p>
    </Card>
  );
}
