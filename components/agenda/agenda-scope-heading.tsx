import type { ScopeHeading } from "@/lib/agenda-client-state";
import { PractitionerBadge } from "./grid/practitioner-badge";
import styles from "./agenda-scope-heading.module.css";

/** Más de 3 círculos apilados ya no se leen: el resto va como «+N» (el título ya los nombra). */
const MAX_BADGES = 3;

/**
 * [CF2 · D-CF2-2] Título de alcance de la agenda: QUÉ agenda se mira («Tu agenda · Laura Pérez», «Agenda de Laura
 * Pérez y Martín Gómez», «Todos los profesionales (5)», «Por sala · todos los profesionales»). Lo pidió el primer
 * cliente: con varios profesionales, la fecha como título no decía de quién era la agenda que estaba mirando.
 *
 * - El h1 es el ÚNICO de la página: el toolbar baja la fecha a subtítulo cuando dibuja esto.
 * - Iniciales (`PractitionerBadge`, canal no cromático de AGENTS §5) solo para «uno» y «algunos»; decorativas porque
 *   el nombre ya está escrito. «Todos» y «Por sala» sin círculos: el número ya está en el título.
 * - Sin hooks ni estado: va en el first load de /agenda (el `PractitionerBadge` ya está ahí por las cards del Día).
 */
export function AgendaScopeHeading({ heading }: { heading: ScopeHeading }) {
  const showBadges = heading.kind === "one" || heading.kind === "some";
  const shown = showBadges ? heading.people.slice(0, MAX_BADGES) : [];
  const rest = showBadges ? heading.people.length - shown.length : 0;
  return (
    <div className={styles.row} data-scope={heading.kind}>
      {shown.length > 0 && (
        <span className={styles.badges} aria-hidden="true">
          {shown.map((p) => (
            <PractitionerBadge key={p.id} initials={p.initials} name={p.name} size={28} decorative />
          ))}
          {rest > 0 && <span className={styles.more}>+{rest}</span>}
        </span>
      )}
      <h1 className={`k-display ${styles.title}`}>{heading.title}</h1>
    </div>
  );
}
