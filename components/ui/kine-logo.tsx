import { BRAND_NAME } from "@/lib/brand";

type Props = { size?: number; light?: boolean; markOnly?: boolean };

/**
 * [PV BR-a · OPS-D4] Logo «A · Sello C» (design_source/brand/index.html): la C del consultorio que se cierra con el
 * punto lima del «online», sobre la misma baldosa sky con degradé del logo anterior (continuidad: quien ya usa la app
 * reconoce el ícono). El símbolo y el archivo conservan el nombre `KineLogo` / `kine-logo.tsx` (D-BR2): renombrarlos
 * era tocar ~20 importadores sin cambio visible.
 *
 * - Baldosa: radio 14/48 del lado y glifo al 80 % (las proporciones del lockup del diseño). El glifo está centrado en
 *   x = 24,6 de su caja de 48 (la C + el punto pesan a la derecha), por eso el viewBox corre 0,6.
 * - Colores con tokens (`--sky-*`, `--lime-300`): siguen a la paleta elegida en Apariencia, como el logo anterior.
 * - Wordmark: primera palabra de `BRAND_NAME` en 700 y el resto en 500 con el sky de acento («**Consultorio** Online»).
 *   Se parte el nombre en vez de escribir el literal: la marca vive solo en `lib/brand.ts`. El espacio entre los dos
 *   spans es real, así el texto accesible y el que se copia leen el nombre completo.
 * - `markOnly`: solo la baldosa (sidebar colapsado, mobile, landing); sin texto.
 */
export function KineLogo({ size = 28, light = false, markOnly = false }: Props) {
  const [lead, ...rest] = BRAND_NAME.split(" ");
  const tail = rest.join(" ");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.34), whiteSpace: "nowrap" }}>
      <span
        style={{
          width: size,
          height: size,
          flex: "none",
          borderRadius: size * (14 / 48),
          background: "linear-gradient(135deg, var(--sky-700), var(--sky-500))",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 12px rgba(31,79,190,0.35), inset 0 1px 0 rgba(255,255,255,0.4)",
        }}
      >
        <svg width={size * 0.8} height={size * 0.8} viewBox="0.6 0 48 48" fill="none" aria-hidden="true">
          <path
            d="M30.88 14.17 A12 12 0 1 0 30.88 33.83"
            stroke="#fff"
            strokeWidth="6.5"
            strokeLinecap="round"
          />
          <circle cx="36" cy="24" r="4.4" fill="var(--lime-300)" />
        </svg>
      </span>
      {!markOnly && (
        <span
          style={{
            fontWeight: 700,
            fontSize: size * 0.6,
            lineHeight: 1,
            letterSpacing: "-0.025em",
            color: light ? "#fff" : "var(--navy-900)",
          }}
        >
          {lead}
          {tail && (
            <>
              {" "}
              <span style={{ fontWeight: 500, color: light ? "var(--sky-300)" : "var(--sky-700)" }}>{tail}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
