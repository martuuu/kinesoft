"use client";

/**
 * Buscador + filtro de tipo del directorio de usuarios (BO3-D). La URL es la fuente de verdad (`?q=&kind=`): la
 * página (server component) vuelve a pedir `searchPlatformUsers` con cada cambio, y un filtro se puede compartir.
 *
 * No usa `useDebouncedSearchParam` a propósito: ese hook conserva los demás params, y acá un `?page=4` viejo con
 * una búsqueda nueva mostraría una página vacía. Cada cambio vuelve a la página 1 (`buildUsersHref`).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlatformUserKindFilter } from "@/lib/platform-health-logic";
import { USER_KIND_FILTER_OPTIONS, buildUsersHref } from "@/components/plataforma/users/users-logic";

const DEBOUNCE_MS = 300;

const fieldStyle: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
  minWidth: 0,
  width: "100%",
};

export function UserSearch({ q, kind }: { q: string; kind: PlatformUserKindFilter }) {
  const router = useRouter();
  const [value, setValue] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPushed = useRef(q);

  // Atrás/adelante del navegador cambia `q` desde afuera: el input lo sigue.
  useEffect(() => {
    if (q !== lastPushed.current) {
      setValue(q);
      lastPushed.current = q;
    }
  }, [q]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  function push(nextQ: string, nextKind: PlatformUserKindFilter) {
    if (timer.current) clearTimeout(timer.current);
    lastPushed.current = nextQ.trim();
    router.replace(buildUsersHref({ q: nextQ, kind: nextKind }), { scroll: false });
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        push(value, kind);
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
        gap: 8,
        alignItems: "center",
      }}
    >
      <input
        type="search"
        name="q"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => push(next, kind), DEBOUNCE_MS);
        }}
        placeholder="Buscar por email o nombre"
        aria-label="Buscar por email o nombre"
        maxLength={200}
        autoComplete="off"
        style={fieldStyle}
      />
      <select
        name="kind"
        value={kind}
        aria-label="Tipo de usuario"
        onChange={(e) => push(value, e.target.value as PlatformUserKindFilter)}
        style={fieldStyle}
      >
        {USER_KIND_FILTER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}
