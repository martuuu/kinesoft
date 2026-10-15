// BO3-D la reemplaza. Placeholder de BO3-A: existe para que el nav de Plataforma no dé 404 mientras tanto.
import { Card } from "@/components/ui/card";

export const metadata = { title: "Salud · Plataforma · KineSoft" };

/** El guard de superadmin vive en `app/(platform)/layout.tsx`. */
export default function PlataformaSaludPlaceholder() {
  return (
    <Card style={{ padding: 24 }}>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
        Salud
      </h1>
      <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
        Próximamente: detectores de problemas (usuarios huérfanos, consultorios sin titular, altas trabadas) y sus reparaciones.
      </p>
    </Card>
  );
}
