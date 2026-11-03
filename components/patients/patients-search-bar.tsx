"use client";

import { useDebouncedSearchParam } from "@/hooks/use-debounced-search-param";
import { Card } from "@/components/ui/card";
import { IconSearch } from "@/components/ui/icons";
import styles from "./patients-directory.module.css";

/**
 * Buscador del directorio. CF2 (decisión 3 de Martin): las pastillas «Todos / Con plan / Sin plan» salieron para
 * todos (el plan queda en la ficha); el total ya está en el h1 de la página y «Ver archivados» en la fila de orden,
 * así que el componente ya no recibe `filter` ni `totals`.
 */
export function PatientsSearchBar() {
  const [q, setQ, flush] = useDebouncedSearchParam("q", 300, ["page"]);
  return (
    // MB-1d (C-MB3): `.searchBar` la vuelve sticky < 768, debajo de la barra móvil.
    <Card glass className={styles.searchBar} style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {/* PF1.1 (C-PF5.4): el input no tiene borde propio; el anillo de foco lo pinta este contenedor con
          `:focus-within` (antes se apagaba el contorno sin reemplazo: el foco del buscador era invisible). */}
      <div
        className={styles.pill}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 220,
          borderRadius: 12,
          padding: "4px 6px",
        }}
      >
        <span style={{ color: "var(--navy-300)" }}>
          <IconSearch size={15} />
        </span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              flush();
            }
          }}
          placeholder="Buscar por nombre, email o DNI…"
          aria-label="Buscar paciente"
          // DB search — suppress the browser's own name/email autofill (Chrome
          // ignores autoComplete="off" here, so "new-password" is used).
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          className={styles.bareInput}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "transparent",
            fontSize: 14,
            color: "var(--navy-900)",
          }}
        />
      </div>
    </Card>
  );
}
