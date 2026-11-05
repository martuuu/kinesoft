"use client";

/**
 * CF3 (BR-L): el logo del consultorio en el chrome (sidebar, selector, barra móvil, menú de cuenta) y en
 * `/elegir-consultorio`. Caja de tamaño FIJO (`width`/`height` + `flex: none`): nada se corre cuando llega la imagen.
 *
 * - `alt` vacío por default: casi siempre el nombre del consultorio ya está escrito al lado (o en el `aria-label` del
 *   botón). Donde no lo está (barra móvil, sidebar contraído con un solo consultorio) se pasa el nombre.
 * - Si la imagen no carga (Storage caído, logo borrado en otra pestaña) se pinta `fallback` (las iniciales de hoy).
 *   Un error ANTES de hidratar no dispara `onError` de React: se mira `complete && naturalWidth === 0` al montar.
 * - Fondo blanco y borde suave: un logo con transparencia sobre el vidrio del sidebar se perdía.
 * - `<img>` y no `next/image`: es una ruta propia con cache privada inmutable por versión (`?v`); el optimizador la
 *   pediría desde el server sin las cookies de la sesión (401).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export function TenantLogo({
  src,
  size,
  alt = "",
  title,
  fallback = null,
}: {
  src: string;
  size: number;
  alt?: string;
  title?: string;
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(src);
  }, [src]);
  if (failed === src) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ruta propia con cookies de sesión y cache inmutable (ver cabecera)
    <img
      ref={ref}
      src={src}
      alt={alt}
      title={title}
      width={size}
      height={size}
      decoding="async"
      onError={() => setFailed(src)}
      data-tenant-logo
      style={{
        width: size,
        height: size,
        flex: "none",
        display: "block",
        boxSizing: "border-box",
        objectFit: "contain",
        borderRadius: "var(--r-md)",
        background: "#fff",
        border: "1px solid rgba(15,30,51,0.08)",
      }}
    />
  );
}
