import { ImageResponse } from "next/og";

/**
 * [MB-0b · C-MB5 · PV BR-a] Íconos PNG del manifest (`app/manifest.ts`), generados con `next/og` en el build (MB-D15):
 * sin dependencia nueva ni PNG binarios a mano, y un cambio de marca no pide regenerar archivos.
 *
 * - `icon-192.png` / `icon-512.png` (`purpose: "any"`): el logo «A · Sello C» de `KineLogo`
 *   (components/ui/kine-logo.tsx) con hex literales, igual que `app/icon.svg`: `next/og` no lee variables CSS. Misma
 *   baldosa (radio 14/48 del lado, glifo al 80 %); las esquinas quedan transparentes.
 * - `maskable-512.png`: fondo lleno `#1F4FBE` y el glifo al 62 % (la escala «app» del diseño), dentro del 80 % central
 *   (zona segura de los íconos maskable: Android recorta círculo, squircle, etc.; fuera de ese 80 % se puede perder).
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

/**
 * Glifo «A · Sello C» (la C + el punto lima) en su caja de 48; `markPx` = lado del dibujo en px. El viewBox corre 0,6
 * porque el glifo está centrado en x = 24,6 (como en `KineLogo`). Satori pasa el `<svg>` inline a resvg, que soporta
 * el arco (`A`) y `stroke-linecap`.
 */
function Mark({ markPx }: { markPx: number }) {
  return (
    <svg width={markPx} height={markPx} viewBox="0.6 0 48 48" fill="none">
      <path d="M30.88 14.17 A12 12 0 1 0 30.88 33.83" stroke="#ffffff" strokeWidth="6.5" strokeLinecap="round" />
      <circle cx="36" cy="24" r="4.4" fill="#c8f564" />
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
      <Mark markPx={size * 0.62} />
    </div>
  ) : (
    // Misma baldosa que KineLogo (radio 14/48 del lado, glifo al 80 %).
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size * (14 / 48),
        background: "linear-gradient(135deg, #1f4fbe, #5e92cc)",
      }}
    >
      <Mark markPx={size * 0.8} />
    </div>
  );

  return new ImageResponse(tile, { width: size, height: size });
}
