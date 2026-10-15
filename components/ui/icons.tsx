import type { CSSProperties, ReactNode } from "react";

export type IconProps = {
  size?: number;
  stroke?: number;
  fill?: string;
  className?: string;
  style?: CSSProperties;
};

// `decorative`: solo los íconos de VX lo prenden. Ponerle `aria-hidden` a todo el set cambia el markup de cada pantalla
// y rompe los goldens (p. ej. el de SV09 en agenda-client); el resto lo suma PF1 regrabando a conciencia.
type InternalProps = IconProps & { children: ReactNode; decorative?: boolean };

function Icon({
  size = 18,
  stroke = 1.6,
  fill = "none",
  className,
  style,
  children,
  decorative,
}: InternalProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={decorative ? true : undefined}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v10h14V10" />
  </Icon>
);
export const IconCal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);
export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" />
    <circle cx="17.5" cy="9" r="2.8" />
    <path d="M16 14.4c3.2.3 5.5 2.2 5.5 5.6" />
  </Icon>
);
export const IconActivity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </Icon>
);
export const IconDumbbell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 9v6M21 9v6M6 6v12M18 6v12M6 12h12" />
  </Icon>
);
export const IconChart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 21h18" />
    <rect x="5" y="11" width="3" height="8" />
    <rect x="11" y="6" width="3" height="13" />
    <rect x="17" y="14" width="3" height="5" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.18.4.27.85.27 1.31" />
  </Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </Icon>
);
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const IconArrow = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="m7 17 10-10M9 7h8v8" />
  </Icon>
);
export const IconChevR = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
export const IconChevL = (p: IconProps) => (
  <Icon {...p}>
    <path d="m15 6-6 6 6 6" />
  </Icon>
);
export const IconChevD = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const IconHeart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.84 4.6a5.5 5.5 0 0 0-7.78 0L12 5.66l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </Icon>
);
export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h4" />
  </Icon>
);
export const IconLogout = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5 10 17l9-10" />
  </Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const IconStar = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 2 3 7 7 .6-5.3 4.7L18 22l-6-3.6L6 22l1.3-7.7L2 9.6 9 9z" />
  </Icon>
);
export const IconPlay = (p: IconProps) => (
  <Icon {...p} fill="currentColor">
    <polygon points="6 4 20 12 6 20" />
  </Icon>
);
export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 4h18l-7 9v6l-4 2v-8z" />
  </Icon>
);
export const IconBookmark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </Icon>
);
export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Icon>
);
// [P0-S04a] Entrada "Planes" (sidebar, pestañas, puertas de creación):
// portapapeles con lista. Distinto de IconFile (HC/archivos) e IconCal (agenda)
// para que el plan no se confunda con un turno ni con un documento.
export const IconPlans = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z" />
    <path d="M9 10h6M9 14h6M9 18h3" />
  </Icon>
);
// [PL-F1c] «Apariencia» (ex Tweaks) en el pie del sidebar: paleta de pintor, distinta de IconSettings (Configuración)
// para que no haya dos engranajes iguales uno arriba del otro.
export const IconPalette = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" />
    <circle cx="7.5" cy="11" r="1" />
    <circle cx="10" cy="7.5" r="1" />
    <circle cx="14.5" cy="7.5" r="1" />
  </Icon>
);

// [VX F-b2] Íconos de las superficies públicas (C-F5), copiados de `design_source/vx0/shared.js` `I.*`: trazo 1.8 y
// 24 px por defecto (el resto del set usa 1.6/18 por la densidad del workspace; se pueden pisar con `size`/`stroke`).
const VX = { size: 24, stroke: 1.8, decorative: true } as const;
export const IconEye = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const IconEyeOff = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8M6.6 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 7.5v5.5" />
    <circle cx="12" cy="16.5" r=".6" fill="currentColor" />
  </Icon>
);
export const IconCheckCircle = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m8 12.3 2.8 2.7L16.2 9.5" />
  </Icon>
);
export const IconMail = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="m4 7 8 6 8-6" />
  </Icon>
);
// Cierra b-B11 (candado de «Seguridad»): escudo con tilde, no está en el prototipo; mismo trazo que el resto.
export const IconShield = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);
export const IconBuilding = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4" />
  </Icon>
);
export const IconHelp = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9" />
    <circle cx="12" cy="17" r=".6" fill="currentColor" />
  </Icon>
);
export const IconTag = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z" />
    <circle cx="8" cy="8" r="1.5" />
  </Icon>
);
