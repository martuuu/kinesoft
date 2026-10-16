import type { ReactNode } from "react";
import styles from "./page-header.module.css";

/**
 * [PF1.0-b · C-PF6] Encabezado de página: eyebrow + h1 + descripción + acciones (C-PF5.3: sin emoji).
 *
 * Server-safe (sin `"use client"`, sin hooks): lo puede pintar una página server o un client component. Las acciones
 * son nodos que arma quien lo usa (`Button`, links). Un solo `<h1>` por página: es este.
 *
 * Lo adoptan las sesiones de área (PF1.1/PF1.2), no la de primitivas (brief-pf §8).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.root}>
      <div className={styles.text}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={`k-display ${styles.title}`}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
