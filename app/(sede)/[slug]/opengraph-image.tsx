import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND_NAME } from "@/lib/brand";
import { getClinicSite } from "@/lib/clinic-site-internal";
import { isSiteSlugShape } from "@/lib/clinic-site-logic";
import { clinicMonogram } from "@/components/sede/sede-copy";
import { sedeOgColors, sedeOgScrim } from "@/components/sede/sede-og";

/**
 * CF3 (SD-U) · imagen para compartir la sede `/<slug>` (WhatsApp, Instagram, Google). Sin esto `/<slug>` heredaba la
 * de la landing (`app/opengraph-image.tsx`): el link del consultorio se veía como una publicidad de la app.
 *
 * Mismo dato que la página (el DTO cerrado de `getClinicSite`, del snapshot cacheado) y el mismo ISR de 10 min. Una
 * sede apagada, inexistente o un alias devuelven la imagen genérica (sin el nombre): la imagen no confirma que un
 * consultorio existe. Sin logo (vendría de Storage por otra request; v1 usa el monograma).
 *
 * BR-H (05-nov): el mismo encabezado que la página: la foto de consultorio con el velo en el color del consultorio, el
 * nombre encima y las «vértebras» a la derecha. Los colores salen de `components/sede/sede-og.ts` (copia de los tokens:
 * `next/og` no lee variables CSS; un test los compara con globals.css).
 */
export const revalidate = 600;
export const alt = "Sacá turno online";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * La foto como data URI (satori no lee webp: va el jpg recortado a 1200×630). La ruta va LITERAL en esta llamada: el
 * trazado de archivos del build (nft) reconoce `join(process.cwd(), "<literal>")` y sube el jpg con la función; desde
 * una constante importada no lo vería. Si igual no está (o no se puede leer), la imagen sale sin foto, sobre el color
 * sólido: el link se comparte igual, nunca un 500.
 */
async function heroPhoto(): Promise<string | null> {
  try {
    const buf = await readFile(join(process.cwd(), "public/sede/hero-consultorio-og.jpg"));
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Las «vértebras» del encabezado (`.dot:nth-child` de sede.module.css), en px sobre una columna de 150 × 440. */
const DOTS: { x: number; y: number; d: number }[] = [
  { x: 78, y: 18, d: 13 },
  { x: 105, y: 66, d: 16 },
  { x: 120, y: 119, d: 19 },
  { x: 108, y: 172, d: 22 },
  { x: 78, y: 224, d: 24 },
  { x: 48, y: 277, d: 23 },
  { x: 33, y: 330, d: 21 },
  { x: 45, y: 383, d: 18 },
  { x: 69, y: 427, d: 14 },
];

export default async function SedeOpengraphImage({ params }: { params: { slug: string } }) {
  let slug: string | null = null;
  try {
    slug = decodeURIComponent(params.slug);
  } catch {
    slug = null;
  }
  const r = slug && isSiteSlugShape(slug.toLowerCase()) ? await getClinicSite(slug) : null;
  const site = r && !("redirectTo" in r) ? r : null;
  const c = sedeOgColors(site?.palette);
  const name = site?.name ?? BRAND_NAME;
  // Genérica: «Sacá turno online» como bajada. Del consultorio: su frase, y el turnero abierto va como botón aparte.
  const line = site ? site.tagline : "Sacá turno online";
  const bookingOpen = site?.online.bookingOpen ?? false;
  const photo = await heroPhoto();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: c.s800,
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori: <img> es la única forma de pintar una imagen (la OG entera lleva su `alt`)
          <img src={photo} alt="" width={1200} height={630} style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630 }} />
        ) : null}
        <div style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630, display: "flex", backgroundImage: sedeOgScrim(c) }} />
        <div style={{ position: "absolute", top: 95, right: 120, width: 150, height: 440, display: "flex" }}>
          {DOTS.map((p, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: p.x - p.d / 2,
                top: p.y - p.d / 2,
                width: p.d,
                height: p.d,
                borderRadius: p.d,
                background: "rgba(255, 255, 255, 0.9)",
                boxShadow: "0 0 0 6px rgba(255, 255, 255, 0.14)",
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: 840,
            height: "100%",
            padding: "72px 80px",
          }}
        >
          <div
            style={{
              width: 112,
              height: 112,
              borderRadius: 30,
              background: "rgba(255, 255, 255, 0.12)",
              border: "1px solid rgba(255, 255, 255, 0.28)",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 40,
              fontWeight: 700,
            }}
          >
            {clinicMonogram(name)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Nombres largos más chicos: a 80 px uno de 50 letras ocupaba 4 renglones y se montaba sobre el botón. */}
            <div style={{ display: "flex", fontSize: name.length > 36 ? 54 : name.length > 20 ? 66 : 80, fontWeight: 700, lineHeight: 1.08, letterSpacing: "-0.035em" }}>
              {name.length > 64 ? `${name.slice(0, 63)}…` : name}
            </div>
            {line ? (
              <div style={{ display: "flex", fontSize: 34, color: c.s200, lineHeight: 1.3 }}>
                {line.length > 80 ? `${line.slice(0, 79)}…` : line}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 24 }}>
            {bookingOpen ? (
              <div style={{ display: "flex", flexShrink: 0, whiteSpace: "nowrap", padding: "12px 26px", borderRadius: 999, background: c.lime300, color: "#0f1e33", fontWeight: 700 }}>
                Sacá turno online
              </div>
            ) : null}
            <div style={{ display: "flex", flexShrink: 0, whiteSpace: "nowrap", color: c.s200 }}>Hecho con {BRAND_NAME}</div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
