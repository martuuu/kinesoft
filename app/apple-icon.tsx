import { ImageResponse } from "next/og";

/**
 * [PV BR-a] Ícono de iOS «Agregar a inicio» / Safari macOS «Agregar al Dock» (180×180), generado con `next/og` en vez
 * del PNG a mano que había: un cambio de marca no pide regenerar binarios (mismo criterio que `app/icons/[name]`, MB-D15).
 *
 * - A sangre y sin transparencia: iOS aplica su propia máscara redondeada y pinta de negro lo transparente, así que la
 *   baldosa con esquinas del favicon quedaría con un borde negro.
 * - Glifo «A · Sello C» al 66 %: entre la escala «app» del diseño (62 %, pensada para el recorte en círculo de Android) y
 *   la del lockup (80 %); el squircle de iOS recorta menos que un círculo.
 * - Hex literales (sky-700 → sky-500, lime-300): `next/og` no lee variables CSS.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const markPx = size.width * 0.66;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1f4fbe, #5e92cc)",
        }}
      >
        <svg width={markPx} height={markPx} viewBox="0.6 0 48 48" fill="none">
          <path d="M30.88 14.17 A12 12 0 1 0 30.88 33.83" stroke="#ffffff" strokeWidth="6.5" strokeLinecap="round" />
          <circle cx="36" cy="24" r="4.4" fill="#c8f564" />
        </svg>
      </div>
    ),
    size,
  );
}
