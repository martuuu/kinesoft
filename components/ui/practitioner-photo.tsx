/**
 * CF3b (PH-U2, pedido de Martin del 05-nov) · foto del profesional con un marco «muy profesional», el MISMO para todos
 * los consultorios: disco blanco con borde sutil, sombra difusa teñida con el color del consultorio, un anillo fino
 * alrededor de la foto y, si hay `logoUrl`, el logo del consultorio chico en una insignia blanca abajo a la derecha
 * (~32 % del tamaño). La usan la selección de profesional del turnero, las tarjetas de la sede y (PH-U1) el avatar de la
 * app y «Mi agenda». Contrato FOTO (cf3-handoffs, literal): `PractitionerPhoto({ src, name, logoUrl, size = 96,
 * className })`.
 *
 * Color: SOLO --sky-* (el CSS module). La superficie que lo monta lleva `data-palette` (`Tenant.palette`), que reasigna
 * --sky-*: TMP queda en su azul/turquesa sin un hex de TMP en el código.
 *
 * Server-safe a propósito: sin "use client", sin framer, sin estado ni handlers (por eso una foto que no carga no cae
 * a las iniciales, ver abajo). La sede es un server component puro (guard `public-surface-imports`) y el turnero es
 * cliente: en los dos es markup + CSS y no suma JS al bundle público. Las iniciales salen de `lib/person-initials.ts`
 * (puro y sin imports, CF3 ZF4b), no de `lib/clinic-site-logic.ts`: ese módulo arrastra `lib/copago.ts` y los links del
 * turnero, y esto va en el bundle del turnero.
 *
 * Decisiones:
 *   - Círculo y no squircle: es el lenguaje del resto del design system para personas (`Avatar`, las iniciales de la
 *     sede y del directorio); los squircles (`--r-*`) quedan para objetos (logo, tarjetas). Un retrato en círculo es lo
 *     que el paciente reconoce como «foto de perfil».
 *   - Sin foto → iniciales en el mismo marco (y la misma insignia), sobre --sky-50 con --sky-700 (AA con todas las
 *     paletas, lo mide BR-H-10). Una foto que no carga (Storage caído, la sede ISR con una URL que se acaba de apagar)
 *     deja el disco blanco con el anillo: degradación aceptada a cambio de no ser componente de cliente.
 *   - Tamaños en px inline: el guard `design-tokens` no admite variables CSS locales; el passe-partout y el logo van con
 *     `inset` en % (que se mide contra el marco; un `padding` en % se mediría contra el padre).
 */
import { personInitials } from "@/lib/person-initials";
import s from "./practitioner-photo.module.css";

/** La insignia mide ~32 % del marco (pedido); con piso, para que en un avatar chico el logo siga siendo un logo. */
const BADGE_RATIO = 0.32;
const BADGE_MIN_PX = 14;
/** Debajo de esto, sombra compacta: la difusa del tamaño grande ensucia un avatar de 40 px. */
const COMPACT_BELOW_PX = 72;
/** Iniciales a ~1/3 del marco (el disco interior es el 90 %). */
const INITIALS_RATIO = 0.3;

export type PractitionerPhotoProps = {
  /** URL de la foto (`/api/public/pro-photo/<id>?v=` en público, `/api/me/photo?v=` en la app). null/"" = iniciales. */
  src: string | null | undefined;
  /** Nombre visible del profesional: `alt` de la foto, label de las iniciales y de dónde salen las iniciales. */
  name: string;
  /** Logo del consultorio para la insignia. null/"" = sin insignia. */
  logoUrl?: string | null;
  /** Lado del marco en px (foto + passe-partout). */
  size?: number;
  className?: string;
  /**
   * El nombre ya se ve al lado (tarjeta del turnero, h3 de la sede): la foto es decorativa (`alt=""`) y el marco sale del
   * árbol de accesibilidad, así el lector de pantalla no lee el nombre dos veces.
   */
  nameShown?: boolean;
  /** `lazy` por default (las tarjetas suelen estar debajo del pliegue); `eager` para una foto arriba de todo. */
  loading?: "lazy" | "eager";
};

export function PractitionerPhoto({
  src,
  name,
  logoUrl = null,
  size = 96,
  className,
  nameShown = false,
  loading = "lazy",
}: PractitionerPhotoProps) {
  const px = Math.max(1, Math.round(size));
  const badgePx = Math.max(BADGE_MIN_PX, Math.round(px * BADGE_RATIO));
  const label = name.trim();
  const photo = src ? src : null;
  const cls = [s.frame, px < COMPACT_BELOW_PX ? s.compact : null, className].filter(Boolean).join(" ");
  // Nombre al lado → todo decorativo. Si no: con foto, el `alt` lo dice; sin foto, el marco ES la imagen (si no, el
  // lector leería «AP»).
  const a11y = nameShown
    ? ({ "aria-hidden": true } as const)
    : photo
      ? {}
      : ({ role: "img", "aria-label": label } as const);

  return (
    <span className={cls} style={{ width: px, height: px }} {...a11y}>
      <span className={s.inner}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- ruta propia cacheable con ?v (inmutable); next/image la re-optimizaría por request y sumaría JS al turnero
          <img
            src={photo}
            alt={nameShown ? "" : label}
            width={px}
            height={px}
            loading={loading}
            decoding="async"
            className={s.photo}
          />
        ) : (
          <span className={s.initials} style={{ fontSize: Math.max(11, Math.round(px * INITIALS_RATIO)) }} aria-hidden="true">
            {/* CF3 (ZF4b): la misma regla que el `Avatar` del shell, la sede y el directorio («Lic. Ana Pérez» → «AP»). */}
            {personInitials(name)}
          </span>
        )}
      </span>
      {logoUrl ? (
        <span className={s.badge} style={{ width: badgePx, height: badgePx }} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- logo del consultorio por su ruta propia con ?v (inmutable) */}
          <img src={logoUrl} alt="" width={badgePx} height={badgePx} loading={loading} decoding="async" className={s.badgeImg} />
        </span>
      ) : null}
    </span>
  );
}
