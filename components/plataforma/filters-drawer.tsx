"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { filtersButtonLabel } from "@/components/plataforma/filters-logic";
import styles from "@/components/plataforma/responsive-table.module.css";

/**
 * Dentro del Drawer de filtros los selects NO aplican al cambiar (`AutoSubmitSelect` lo lee): el form es un GET con
 * navegación completa y cada cambio cerraba el Drawer antes de poder elegir el segundo filtro. Ahí aplica el botón del
 * form («Buscar» / «Filtrar»).
 */
const InFiltersDrawer = createContext(false);
export function useInFiltersDrawer(): boolean {
  return useContext(InFiltersDrawer);
}

/**
 * [MB-1f · C-MB3 Plataforma] Filtros de las listas de Plataforma: en línea desde 768 px (como siempre) y, bajo 768,
 * un botón «Filtros (n)» que abre los mismos filtros en un Drawer (hoja a pantalla completa < 640, C-MB2).
 *
 * Los `children` se montan dos veces solo con el Drawer abierto: la copia en línea queda `display: none` bajo 768
 * (fuera del árbol de accesibilidad y del foco). Los forms de Plataforma son GET sin estado propio (la URL manda), así
 * que las dos copias muestran lo mismo. El Drawer se monta recién al abrir: usa `useConfirm` y las listas también se
 * renderizan en tests estáticos sin provider; sin animación de salida, el estado final es el mismo (reducedMotion).
 */
export function FiltersDrawer({
  count,
  title = "Filtros",
  aside,
  children,
}: {
  /** Filtros activos (`activeFilterCount`). */
  count: number;
  title?: string;
  /** Algo que queda visible junto al botón en el celular (p. ej. «Limpiar»). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={styles.filtersInline}>{children}</div>
      <div className={`${styles.filtersTrigger} ${styles.tapScope}`}>
        <Button type="button" variant="ghost" size="md" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          {filtersButtonLabel(count)}
        </Button>
        {aside}
      </div>
      {open && (
        <Drawer open onClose={() => setOpen(false)} title={title}>
          <InFiltersDrawer.Provider value>
            <div className={styles.tapScope}>{children}</div>
          </InFiltersDrawer.Provider>
        </Drawer>
      )}
    </>
  );
}
