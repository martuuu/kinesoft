/**
 * CF3b (BR-H) · encabezado de la sede `/<slug>`: foto de consultorio de fondo, velo en los colores del consultorio y,
 * encima, el logo (protagonista), el nombre, la frase y «Sacar turno». Pedido de Martin (05-nov): el encabezado con un
 * gradiente pelado se veía «muy básico»; quería una imagen de medicina con algo animado encima.
 *
 * Server component puro, sin JS (guard `public-surface-imports`: ni framer ni providers). Todo el movimiento es CSS
 * (`sede.module.css`, bloque «Encabezado»): zoom lento de la foto, «vértebras» que flotan y un barrido de luz al
 * entrar; con `prefers-reduced-motion` no se mueve nada y el estado final se ve completo desde el primer frame.
 *
 * La foto (`public/sede/`, cenital de una notebook y un estetoscopio) es la misma para todos los consultorios y es
 * decorativa (`alt=""`, dentro de un `aria-hidden`): no dice nada del consultorio. Va con `srcset` 960/1600/2400 en
 * webp + jpg de respaldo, `fetchPriority="high"` y sin lazy porque es lo más grande del primer pantallazo (el LCP), y
 * con `position: absolute` dentro del encabezado: no ocupa lugar en el flujo, así que su carga no corre nada (CLS 0).
 * El color NO es de la foto: lo pone el velo con `--sky-*` de la paleta activa (`data-palette` del wrapper), así un
 * consultorio con paleta propia queda en su color sin tocar este archivo.
 */
import type { ReactNode } from "react";
import s from "./sede.module.css";

/** Fuentes de la foto. `sizes` = 100vw: en escritorio cubre todo el ancho y en mobile es la franja de arriba. */
export const SEDE_HERO_PHOTO = {
  webpSrcSet: [960, 1600, 2400].map((w) => `/sede/hero-consultorio-${w}.webp ${w}w`).join(", "),
  jpg: "/sede/hero-consultorio-1600.jpg",
  width: 1600,
  height: 1060,
  sizes: "100vw",
} as const;

/**
 * «Vértebras»: una columna de puntos en S (cuerpo, movimiento) que flota despacio sobre la foto. Decorativa
 * (`aria-hidden`); la posición, el tamaño y el desfase de cada punto viven en el CSS (`:nth-child`), sin estilos
 * inline. Spans y no SVG: animar `transform` de un elemento HTML va por el compositor; el de un `<circle>` repinta.
 */
export const SEDE_HERO_DOTS = 9;

function SedeSpineDots() {
  return (
    <span className={`${s.dots} ${s.heroDots}`} aria-hidden="true">
      {Array.from({ length: SEDE_HERO_DOTS }, (_, i) => (
        <span key={i} className={s.dot} />
      ))}
    </span>
  );
}

/** Capa de fondo del encabezado: foto + velo + barrido de luz. El texto va como `children`, arriba de todo. */
export function SedeHero({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <section className={s.hero} aria-labelledby={labelledBy}>
      <div className={s.heroMedia} aria-hidden="true">
        <picture>
          <source type="image/webp" srcSet={SEDE_HERO_PHOTO.webpSrcSet} sizes={SEDE_HERO_PHOTO.sizes} />
          {/* eslint-disable-next-line @next/next/no-img-element -- los webp ya están en 3 anchos: next/image los regeneraría con el optimizador (cuota de Vercel) sin ganar nada */}
          <img
            className={s.heroImg}
            src={SEDE_HERO_PHOTO.jpg}
            width={SEDE_HERO_PHOTO.width}
            height={SEDE_HERO_PHOTO.height}
            alt=""
            fetchPriority="high"
            decoding="async"
          />
        </picture>
        <span className={s.heroScrim} />
        <span className={s.heroSweep} />
      </div>
      <div className={`k-container ${s.heroIn}`}>
        <div className={s.heroText}>{children}</div>
        <SedeSpineDots />
      </div>
    </section>
  );
}
