"use client";

import { IconChevD } from "@/components/ui/icons";

/**
 * [MB-1c · C-MB3] Botón de pliegue de una sección de /sala (columna del Tablero, card de «Lista y panel», carril de
 * «Flujo»). Solo se ve en una columna (celular, o el escritorio angosto en stack): el CSS de cada cara lo esconde en
 * escritorio y la regla que oculta el cuerpo plegado vive DENTRO de la media/container query del stack, así que un
 * pliegue que quedó cerrado al agrandar la ventana no esconde nada en escritorio.
 *
 * Por qué un botón y no `<details>`: el encabezado de cada sección ya tiene su `<h2>` (lo usan `aria-labelledby` y los
 * tests de las caras) y `<summary>` no puede contener un heading sin perder su rol; además el estado abierto tiene
 * que sobrevivir a los re-render del tick de 30 s, cosa que un `useState` en la sección hace sin más.
 *
 * El rótulo lleva la acción y el conteo («Ocultar Sala de espera (3)»): el número visible es el mismo conteo.
 */
export function foldLabel(title: string, count: number, open: boolean): string {
  return `${open ? "Ocultar" : "Mostrar"} ${title} (${count})`;
}

export function FoldButton({
  className,
  title,
  count,
  open,
  controls,
  onToggle,
  showCount = false,
}: {
  className: string;
  title: string;
  count: number;
  open: boolean;
  /** id del cuerpo que se pliega. */
  controls: string;
  onToggle: () => void;
  /** El conteo visible (cuando el encabezado no lo muestra ya). */
  showCount?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={foldLabel(title, count, open)}
      onClick={onToggle}
    >
      {showCount ? (
        <span className="k-mono" aria-hidden="true">
          {count}
        </span>
      ) : null}
      <IconChevD size={18} />
    </button>
  );
}
