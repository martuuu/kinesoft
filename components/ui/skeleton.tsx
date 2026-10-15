/**
 * [PF-0c] Primitivas de esqueleto para los `loading.tsx`.
 *
 * Por qué así:
 * - **Server-safe, sin "use client", sin hooks ni framer.** El `loading.tsx` es
 *   lo que Next manda en el primer chunk del stream y lo que guarda el prefetch
 *   de un `<Link>` en rutas dinámicas: si arrastrara framer o un client
 *   component, el click esperaría JS. Acá es HTML + las clases `.k-skel*` de
 *   `app/globals.css` (shimmer en CSS, quieto con reduce motion).
 * - **La forma de la página real** (header + filas / cards), para que al llegar
 *   los datos no salte el layout. Antes los esqueletos eran un «Cargando…»
 *   centrado de 360 px de alto.
 * - Accesibilidad: el contenedor es `role="status"` + `aria-busy="true"` con un
 *   texto solo para lectores de pantalla; los bloques grises van `aria-hidden`.
 */
import type { CSSProperties, ReactNode } from "react";

type Len = number | string;

/** Un bloque gris. `w`/`h` en px o cualquier largo CSS. */
export function Skel({ w = "100%", h = 14, r = 8, style }: { w?: Len; h?: Len; r?: Len; style?: CSSProperties }) {
  return <span className="k-skel" aria-hidden="true" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Contenedor de toda página en carga. `label` = lo que oye el lector de pantalla. */
export function PageSkeleton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
      data-skeleton=""
      style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}
    >
      {children}
      <span className="k-skel-sr">{label}…</span>
    </div>
  );
}

/** Tarjeta de vidrio (misma superficie que `Card`) para agrupar bloques. */
export function SkelCard({ children, pad = 18, style }: { children?: ReactNode; pad?: number; style?: CSSProperties }) {
  return (
    <div
      className="k-glass"
      aria-hidden="true"
      style={{ padding: pad, borderRadius: "var(--r-lg)", display: "flex", flexDirection: "column", gap: 12, ...style }}
    >
      {children}
    </div>
  );
}

/** Título + bajada a la izquierda, `actions` botones a la derecha. */
export function SkelHeader({ actions = 1, titleW = 220 }: { actions?: number; titleW?: number }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <Skel w={titleW} h={26} r={8} />
        <Skel w={Math.round(titleW * 1.4)} h={12} style={{ maxWidth: "70vw" }} />
      </div>
      {actions > 0 && (
        <div style={{ display: "flex", gap: 8 }}>
          {Array.from({ length: actions }, (_, i) => (
            <Skel key={i} w={i === actions - 1 ? 132 : 96} h={36} r={999} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Fila de pestañas / segmentado. */
export function SkelTabs({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {Array.from({ length: count }, (_, i) => (
        <Skel key={i} w={i === 0 ? 108 : 92} h={32} r={999} />
      ))}
    </div>
  );
}

/** Lista en una tarjeta: avatar + dos líneas + chip, `rows` filas. */
export function SkelRows({ rows = 6, avatar = true, toolbar = true }: { rows?: number; avatar?: boolean; toolbar?: boolean }) {
  return (
    <SkelCard pad={14}>
      {toolbar && (
        <div style={{ display: "flex", gap: 8, paddingBottom: 4 }}>
          <Skel w={280} h={36} r={999} style={{ maxWidth: "60%" }} />
          <Skel w={96} h={36} r={999} />
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 44 }}>
          {avatar && <Skel w={36} h={36} r={999} style={{ flexShrink: 0 }} />}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <Skel w={`${55 - (i % 3) * 10}%`} h={13} />
            <Skel w={`${35 - (i % 2) * 8}%`} h={10} />
          </div>
          <Skel w={72} h={22} r={999} style={{ flexShrink: 0 }} />
        </div>
      ))}
    </SkelCard>
  );
}

/** Grilla de tarjetas (KPIs, planes, ejercicios). */
export function SkelCards({ count = 3, min = 220, h = 110 }: { count?: number; min?: number; h?: number }) {
  return (
    <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <SkelCard key={i} pad={16} style={{ minHeight: h }}>
          <Skel w={34} h={34} r={10} />
          <Skel w="60%" h={18} />
          <Skel w="40%" h={10} />
        </SkelCard>
      ))}
    </div>
  );
}

/** Formulario: pares rótulo + campo. */
export function SkelForm({ fields = 5 }: { fields?: number }) {
  return (
    <SkelCard pad={20}>
      <Skel w={180} h={16} />
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Skel w={120} h={10} />
          <Skel w="100%" h={38} r={10} style={{ maxWidth: 520 }} />
        </div>
      ))}
    </SkelCard>
  );
}
