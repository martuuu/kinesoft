// BO3-E la reemplaza. Placeholder de BO3-A: existe para que el nav de Plataforma no dé 404 mientras tanto.
import { Card } from "@/components/ui/card";

export const metadata = { title: "Sistema · Plataforma · KineSoft" };

/** El guard de superadmin vive en `app/(platform)/layout.tsx`. */
export default function PlataformaSistemaPlaceholder() {
  return (
    <Card style={{ padding: 24 }}>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
        Sistema
      </h1>
      <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
        Próximamente: qué servicios externos están configurados (correo, pagos, errores, tiempo real, crons), sin mostrar sus valores.
      </p>
    </Card>
  );
}
