import { ButtonLink } from "@/components/ui/button";
// MB-1e: el mismo ajuste de 44 px < 768 que el muro de módulo (los dos son la pantalla «no podés estar acá» del shell).
import wallStyles from "@/components/ui/access-wall.module.css";

/**
 * 404 dentro del workspace (VX2-b2): lo que muestra un `notFound()` de una página de `(app)` (paciente, plan,
 * sesión o ejercicio que no existe o es de otro consultorio), dentro del shell con el menú, en vez del 404 de
 * pantalla completa de `app/not-found.tsx`. Sin datos del recurso: «no existe» y «no es tuyo» se ven igual.
 */
export default function AppNotFound() {
  return (
    <section
      aria-labelledby="app-not-found-title"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "48px 16px",
        minHeight: 320,
        textAlign: "center",
      }}
    >
      <h1 id="app-not-found-title" className="k-display" style={{ fontSize: 24, margin: 0, color: "var(--navy-900)" }}>
        No encontramos lo que buscás
      </h1>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>
        Puede que se haya borrado o que el enlace esté mal.
      </p>
      <div className={wallStyles.actions}>
        <ButtonLink href="/dashboard" variant="ghost">
          Volver al inicio
        </ButtonLink>
      </div>
    </section>
  );
}
