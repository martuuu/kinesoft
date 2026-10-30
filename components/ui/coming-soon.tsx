import { ButtonLink } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import styles from "./access-wall.module.css";

/**
 * Pantalla «Próximamente» (CF, §28, decisión 8 de Martin): una sección que existe en el menú pero todavía no se usa
 * (hoy, Diagnóstico mientras se termina la guía). Mismo molde que la rama `disabled` de `AccessWall`
 * (`components/ui/access-wall.tsx`): eyebrow, `h1.k-display`, un texto y «Volver al inicio». Server-safe (sin
 * "use client"): es solo copy y un link. No es una barrera: la página que la monta no carga nada más.
 */
export type ComingSoonProps = {
  /** Nombre de la sección (va en el eyebrow). */
  eyebrow: string;
  /** Título; por defecto «Próximamente». */
  title?: string;
  /** Qué hacer mientras tanto. */
  description: string;
};

const wallStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: "48px 16px",
  minHeight: 320,
  textAlign: "center",
} as const;

const titleStyle = { fontSize: 24, margin: 0, color: "var(--navy-900)", maxWidth: 480, overflowWrap: "anywhere" } as const;

export function ComingSoon({ eyebrow, title = "Próximamente", description }: ComingSoonProps) {
  return (
    <section aria-labelledby="coming-soon-title" style={wallStyle}>
      <EyebrowLabel tone="accent">{eyebrow}</EyebrowLabel>
      <h1 id="coming-soon-title" className="k-display" style={titleStyle}>
        {title}
      </h1>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>{description}</p>
      <div className={styles.actions}>
        <ButtonLink href="/dashboard">Volver al inicio</ButtonLink>
      </div>
    </section>
  );
}
