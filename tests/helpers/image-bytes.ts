/**
 * T4 FC-2f · bytes mínimos de PNG y JPEG con dimensiones dadas, para los tests de magic bytes y de logo/firma.
 * Solo la cabecera (PNG: firma + IHDR; JPEG: SOI + APP0 + SOF0 + EOI): `readImageInfo` no decodifica píxeles.
 */
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** PNG mínimo con IHDR de `w`×`h` (sin IDAT: alcanza para la cabecera). */
export function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.set(enc("IHDR"), 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
/** JPEG con un APP0 y un SOF0 de `w`×`h`. */
export function jpeg(w: number, h: number): Uint8Array {
  const app0 = cat(new Uint8Array([0xff, 0xe0, 0, 16]), enc("JFIF\0"), new Uint8Array(9));
  const sof = new Uint8Array([0xff, 0xc0, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  return cat(new Uint8Array([0xff, 0xd8]), app0, sof, new Uint8Array([0xff, 0xd9]));
}

