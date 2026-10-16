import { ImageResponse } from "next/og";
import { BRAND_NAME } from "@/lib/brand";

/**
 * [VX2-c1] Imagen para compartir la landing (Open Graph / Twitter). `next/og` no lee variables CSS: los colores van como
 * hex literales (los mismos tokens de globals.css: navy-900, sky-700/500, lime-300). Sin cifras ni claims: el titular
 * y la bajada son los del hero. Se genera estática en el build (no depende de la request).
 */
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
              borderRadius: 22,
              background: "linear-gradient(135deg, #1f4fbe, #5e92cc)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
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
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em" }}>{BRAND_NAME}</div>
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
