/**
 * [CF-UI1 · H] Genera `app/favicon.ico` (16, 32 y 48 px) con el logo «A · Sello C».
 *
 * Por qué existe: el sitio no tenía `/favicon.ico`. Los navegadores (y los lectores de pestañas, marcadores, Google)
 * lo piden igual aunque haya `app/icon.svg`, y el 404 dejaba el ícono genérico en algunos navegadores y en el buscador.
 * Next sirve `app/favicon.ico` tal cual y agrega su `<link rel="icon" sizes="any">`.
 *
 * Cómo: el dibujo es `app/icon.svg` (la fuente única del favicon, misma escala de 16 px: radio 11/48, glifo al 84 %),
 * rasterizado con `next/og` (`ImageResponse`: satori + resvg, ya en el repo; sin `sharp` ni dependencias nuevas). El
 * contenedor `.ico` se arma a mano en node puro: cabecera ICONDIR + una entrada ICONDIRENTRY por tamaño + los PNG
 * embebidos tal cual (formato válido desde Windows Vista y en todos los navegadores actuales).
 *
 * Correr tras un cambio de `app/icon.svg`: `npx tsx scripts/generate-favicon.tsx` (el binario se versiona).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
// JSX clásico: tsx compila los scripts sin el runtime automático de Next.
import * as React from "react";

const ROOT = process.cwd();
const SIZES = [16, 32, 48] as const;

async function renderPng(svg: string, size: number): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const res = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={src} width={size} height={size} />
      </div>
    ),
    { width: size, height: size },
  );
  return Buffer.from(await res.arrayBuffer());
}

/** ICO con PNG embebidos: ICONDIR (6 B) + n × ICONDIRENTRY (16 B) + los PNG. 0 en ancho/alto significa 256. */
export function buildIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // 1 = ícono
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // sin paleta
    e.writeUInt8(0, 3); // reservado
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por píxel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const svg = readFileSync(join(ROOT, "app/icon.svg"), "utf8");
  const images = [];
  for (const size of SIZES) images.push({ size, png: await renderPng(svg, size) });
  const ico = buildIco(images);
  writeFileSync(join(ROOT, "app/favicon.ico"), ico);
  console.log(`app/favicon.ico: ${ico.length} B (${images.map((i) => `${i.size}px=${i.png.length}B`).join(", ")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
