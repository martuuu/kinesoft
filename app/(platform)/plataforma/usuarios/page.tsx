// BO3-D la reemplaza. Placeholder de BO3-A: existe para que el nav de Plataforma no dé 404 mientras tanto.
import { Card } from "@/components/ui/card";

export const metadata = { title: "Usuarios · Plataforma · KineSoft" };

/** El guard de superadmin vive en `app/(platform)/layout.tsx`. */
export default function PlataformaUsuariosPlaceholder() {
  return (
    <Card style={{ padding: 24 }}>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
        Usuarios
      </h1>
      <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
        Próximamente: directorio de usuarios de todos los consultorios y pacientes del portal, con su estado de acceso.
      </p>
    </Card>
  );
}
