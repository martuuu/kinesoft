import { ImageResponse } from "next/og";

/**
 * [MB-0b · C-MB5] Íconos PNG del manifest (`app/manifest.ts`), generados con `next/og` en el build (MB-D15): sin
 * dependencia nueva ni PNG binarios a mano, y el rename de marca no pide regenerar archivos.
 *
 * - `icon-192.png` / `icon-512.png` (`purpose: "any"`): la marca de `KineLogo` (components/ui/kine-logo.tsx) con hex
 *   literales, igual que `app/icon.svg`: `next/og` no lee variables CSS. Las esquinas quedan transparentes.
 * - `maskable-512.png`: fondo lleno `#1F4FBE` y el trazo del logo dentro del 80 % central (zona segura de los íconos maskable:
 *   Android recorta círculo, squircle, etc.; fuera de ese 80 % se puede perder).
 * - Nombre desconocido → 404 (además de `dynamicParams = false`, que hace lo mismo antes de llegar acá).
 * - El middleware no corre sobre `/icons/*` (matcher de `middleware.ts`): con mantenimiento prendido devolvería 503 y
 *   la instalación fallaría.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

const ICONS = {
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "maskable-512.png": { size: 512, maskable: true },
} as const;

type IconName = keyof typeof ICONS;

export async function generateStaticParams(): Promise<{ name: IconName }[]> {
  return (Object.keys(ICONS) as IconName[]).map((name) => ({ name }));
}

function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Trazo del logo en un viewBox de 24 (el mismo de KineLogo); `markPx` = lado del dibujo en px. */
function Mark({ markPx }: { markPx: number }) {
  return (
    <svg width={markPx} height={markPx} viewBox="0 0 24 24" fill="none">
      <circle cx="7" cy="6" r="2.5" fill="#ffffff" />
      <path d="M6 9.5C6 12 7.5 13 8 14.5L6 21" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M9 11.5L13 12.5L16 10.5L19 16"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17.5" cy="6.5" r="1.6" fill="#c8f564" />
    </svg>
  );
}

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  if (!isIconName(params.name)) return new Response("Not found", { status: 404 });
  const { size, maskable } = ICONS[params.name];

  const tile = maskable ? (
    // Fondo a sangre (el SO recorta la forma) y la marca sola, centrada y holgada dentro del 80 % central. Sin el
    // cuadrado redondeado del logo: recortado por la máscara del SO quedaría una forma dentro de otra.
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#1F4FBE",
      }}
    >
      <Mark markPx={size * 0.55} />
    </div>
  ) : (
    // Mismo cuadrado redondeado que KineLogo (radio 0,32 del lado) y que app/icon.svg.
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size * 0.32,
        background: "linear-gradient(135deg, #1f4fbe, #5e92cc)",
      }}
    >
      <Mark markPx={size * 0.6} />
    </div>
  );

  return new ImageResponse(tile, { width: size, height: size });
}
