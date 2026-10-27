import { ImageResponse } from "next/og";
import { BRAND_NAME } from "@/lib/brand";

/**
 * [VX2-c1 · PV BR-a] Imagen para compartir la landing (Open Graph / Twitter). `next/og` no lee variables CSS: los
 * colores van como hex literales (los mismos tokens de globals.css: navy-900, sky-700/500/300, lime-300). Sin cifras ni
 * claims: el titular y la bajada son los del hero. Logo «A · Sello C» (glifo al 80 % de la baldosa, radio 14/48, como
 * `KineLogo`). Se genera estática en el build (no depende de la request).
 *
 * Límite conocido: sin una fuente cargada, `next/og` usa su sans por defecto en un solo peso, así que el 700/500 del
 * wordmark se ve parejo; el contraste lo da el color de «Online».
 */
const [BRAND_LEAD, ...BRAND_REST] = BRAND_NAME.split(" ");
const BRAND_TAIL = BRAND_REST.join(" ");

export const alt = `${BRAND_NAME}: tu consultorio, ordenado de punta a punta`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #0f1e33 0%, #16305a 55%, #1f4fbe 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 21,
              background: "linear-gradient(135deg, #1f4fbe, #5e92cc)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="58" height="58" viewBox="0.6 0 48 48" fill="none">
              <path d="M30.88 14.17 A12 12 0 1 0 30.88 33.83" stroke="#ffffff" strokeWidth="6.5" strokeLinecap="round" />
              <circle cx="36" cy="24" r="4.4" fill="#c8f564" />
            </svg>
          </div>
          {/* Wordmark como en KineLogo: primera palabra en 700 y el resto en 500 con sky-300 (sobre fondo oscuro). */}
          <div style={{ display: "flex", fontSize: 43, letterSpacing: "-0.025em" }}>
            <span style={{ fontWeight: 700 }}>{BRAND_LEAD}</span>
            {BRAND_TAIL ? <span style={{ fontWeight: 500, color: "#b5cfec", marginLeft: 12 }}>{BRAND_TAIL}</span> : null}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.04em" }}>
            Tu consultorio, ordenado de punta a punta.
          </div>
          <div style={{ display: "flex", fontSize: 32, color: "#c6cfdd", lineHeight: 1.35 }}>
            Agenda, turnos online, historia clínica y cobros. Con herramientas propias para kinesiología.
          </div>
        </div>
        <div style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: "#c8f564" }} />
      </div>
    ),
    size,
  );
}
