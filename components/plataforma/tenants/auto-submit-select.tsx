"use client";

import type { SelectHTMLAttributes } from "react";
import { useInFiltersDrawer } from "@/components/plataforma/filters-drawer";

/**
 * [PF1.2-plataforma · VX0-b P2] `<select>` de un `<form method="get">` que aplica al cambiar: manda el form con
 * `requestSubmit()` (respeta `action`/`method` y los demás campos). La lista de consultorios es un server component sin
 * JS propio; esto es lo único cliente del filtro, para que no haga falta un botón «Filtrar» en otra fila. Sin JS el
 * form se sigue mandando con Enter desde el buscador o con el botón «Buscar».
 *
 * MB-1f: dentro del Drawer de filtros del celular (`FiltersDrawer`) no aplica al cambiar: la navegación cerraba el
 * Drawer después del primer select. Ahí se aplica con «Buscar».
 */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const inDrawer = useInFiltersDrawer();
  return (
    <select
      {...props}
      onChange={(e) => {
        props.onChange?.(e);
        if (!inDrawer) e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
