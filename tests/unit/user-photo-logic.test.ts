/**
 * CF3b PH-S · lógica pura de la foto del profesional (`lib/user-photo-logic.ts`): validación por magic bytes, limpieza
 * de metadatos (EXIF/GPS), clave del objeto (espejo del CHECK de M24), URLs con `?v=` y forma de los ids.
 * Símbolos reales, sin mocks: es un módulo puro.
 */
import { describe, expect, it } from "vitest";
import { png, jpeg } from "@/tests/helpers/image-bytes";
import { readImageInfo } from "@/lib/file-sniff";
import {
  USER_PHOTO_COPY,
  USER_PHOTO_LIMITS,
  checkUserPhoto,
  isCanonicalPhotoQuery,
  isPractitionerIdShape,
  isUserPhotoKeyFor,
  nextPhotoStamp,
  ownPhotoUrl,
  ownPhotoUrlFor,
  photoVersion,
  publicProPhotoUrl,
  publicProPhotoUrlFor,
  stripImageMetadata,
  userPhotoKey,
} from "@/lib/user-photo-logic";

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
/** Segmento JPEG `FF <marker> <len> <payload>`. */
const seg = (marker: number, payload: Uint8Array) =>
  cat(new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);
/** Chunk PNG `len type data crc` (CRC en cero: el limpiador copia chunks enteros, no los recalcula). */
const chunk = (type: string, data: Uint8Array) => {
  const b = new Uint8Array(12 + data.length);
  new DataView(b.buffer).setUint32(0, data.length);
  b.set(enc(type), 4);
  b.set(data, 8);
  return b;
};
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, w);
  new DataView(d.buffer).setUint32(4, h);
  return chunk("IHDR", d);
};
const hasBytes = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).includes(Buffer.from(needle));

/** JPEG con EXIF (APP1 con «GPS»), comentario, ICC, SOF, SOS con datos y basura después del EOI. */
function jpegWithMetadata(w: number, h: number) {
  const app0 = seg(0xe0, cat(enc("JFIF\0"), new Uint8Array(9)));
  const exif = seg(0xe1, cat(enc("Exif\0\0"), enc("GPS-34.6037,-58.3816")));
  const xmp = seg(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>casa</x:xmpmeta>"));
  const icc = seg(0xe2, cat(enc("ICC_PROFILE\0"), new Uint8Array([1, 1, 0, 0])));
  const fpxr = seg(0xe2, enc("FPXR\0metadatos"));
  const com = seg(0xfe, enc("comentario con datos"));
  const sof = new Uint8Array([0xff, 0xc0, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  const sos = seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0]));
  const scan = new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]); // relleno FF00 y un RST
  const eoi = new Uint8Array([0xff, 0xd9]);
  const trailer = enc("PK\x03\x04<html>polyglot</html>");
  return cat(new Uint8Array([0xff, 0xd8]), app0, exif, xmp, icc, fpxr, com, sof, sos, scan, eoi, trailer);
}

describe("[PH-S] lib/user-photo-logic", () => {
  it("[PH-S-u1] checkUserPhoto: PNG y JPEG reales pasan con su MIME y extensión", () => {
    expect(checkUserPhoto(png(512, 512), "image/png")).toMatchObject({ ok: true, mime: "image/png", ext: "png" });
    expect(checkUserPhoto(jpeg(512, 400), "image/jpeg")).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg", width: 512, height: 400 });
    // Sin `type` (algunos navegadores no lo mandan): mandan los bytes.
    expect(checkUserPhoto(png(10, 10), "")).toMatchObject({ ok: true, mime: "image/png" });
  });

  it("[PH-S-u2] checkUserPhoto: tipo falso, formato no admitido, vacío, > 1 MB y dimensiones exageradas → rechazo", () => {
    const html = enc("<!doctype html><script>alert(1)</script>");
    expect(checkUserPhoto(html, "image/png")).toEqual({ ok: false, error: USER_PHOTO_COPY.fake });
    expect(checkUserPhoto(html, "")).toEqual({ ok: false, error: USER_PHOTO_COPY.format });
    // PNG que dice ser JPEG (y al revés): «no es lo que dice ser».
    expect(checkUserPhoto(png(10, 10), "image/jpeg")).toEqual({ ok: false, error: USER_PHOTO_COPY.fake });
    expect(checkUserPhoto(jpeg(10, 10), "image/png")).toEqual({ ok: false, error: USER_PHOTO_COPY.fake });
    // SVG/WEBP/HEIC declarados: fuera sin mirar más.
    for (const t of ["image/svg+xml", "image/webp", "image/heic", "text/html"]) {
      expect(checkUserPhoto(png(10, 10), t), t).toEqual({ ok: false, error: USER_PHOTO_COPY.format });
    }
    expect(checkUserPhoto(new Uint8Array(0), "image/png")).toEqual({ ok: false, error: USER_PHOTO_COPY.format });
    const big = new Uint8Array(USER_PHOTO_LIMITS.maxBytes + 1);
    big.set(png(10, 10));
    expect(checkUserPhoto(big, "image/png")).toEqual({ ok: false, error: USER_PHOTO_COPY.format });
    // Bomba de descompresión: 1 MB de PNG puede declarar 20000 × 20000 (1,6 GB al decodificar en cada visitante).
    expect(checkUserPhoto(png(20_000, 20_000), "image/png")).toEqual({ ok: false, error: USER_PHOTO_COPY.tooBig });
    expect(checkUserPhoto(png(USER_PHOTO_LIMITS.maxPx, USER_PHOTO_LIMITS.maxPx), "image/png").ok).toBe(true);
  });

  it("[PH-S-u3] stripImageMetadata JPEG: saca EXIF/XMP/COM/FPXR y lo que sigue al EOI; deja JFIF, ICC, SOF y el scan", () => {
    const raw = jpegWithMetadata(300, 200);
    const out = stripImageMetadata(raw, "image/jpeg");
    expect(out).not.toBeNull();
    for (const leak of ["GPS", "Exif", "xmpmeta", "comentario", "FPXR", "polyglot", "PK"]) {
      expect(hasBytes(out!, enc(leak)), leak).toBe(false);
    }
    expect(hasBytes(out!, enc("JFIF"))).toBe(true);
    expect(hasBytes(out!, enc("ICC_PROFILE"))).toBe(true);
    expect(hasBytes(out!, new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]))).toBe(true);
    expect(Array.from(out!.slice(-2))).toEqual([0xff, 0xd9]);
    expect(readImageInfo(out!)).toEqual({ mime: "image/jpeg", width: 300, height: 200 });
    // Lo que ya está limpio sale igual.
    expect(stripImageMetadata(jpeg(10, 10), "image/jpeg")).toEqual(jpeg(10, 10));
  });

  it("[PH-S-u4] stripImageMetadata PNG: saca eXIf/tEXt/zTXt/iTXt/tIME y lo que sigue al IEND; deja IHDR, PLTE, IDAT", () => {
    const raw = cat(
      PNG_SIG,
      ihdr(64, 32),
      chunk("eXIf", enc("GPS-34.6")),
      chunk("tEXt", enc("Author\0Juan")),
      chunk("iTXt", enc("XML:com.adobe.xmp\0casa")),
      chunk("zTXt", enc("Comment\0z")),
      chunk("tIME", new Uint8Array(7)),
      chunk("PLTE", new Uint8Array([1, 2, 3])),
      chunk("IDAT", enc("pixeles")),
      chunk("IEND", new Uint8Array(0)),
      enc("<html>polyglot</html>")
    );
    const out = stripImageMetadata(raw, "image/png");
    expect(out).not.toBeNull();
    for (const leak of ["GPS", "Juan", "xmp", "tEXt", "zTXt", "tIME", "polyglot"]) {
      expect(hasBytes(out!, enc(leak)), leak).toBe(false);
    }
    for (const keep of ["IHDR", "PLTE", "IDAT", "pixeles", "IEND"]) expect(hasBytes(out!, enc(keep)), keep).toBe(true);
    expect(readImageInfo(out!)).toEqual({ mime: "image/png", width: 64, height: 32 });
  });

  it("[PH-S-u5] stripImageMetadata: estructura rota → null (la subida se rechaza, no se sube a medias)", () => {
    expect(stripImageMetadata(cat(PNG_SIG, ihdr(10, 10), enc("\x00\x00\xff\xffIDAT")), "image/png")).toBeNull(); // largo imposible
    expect(stripImageMetadata(cat(PNG_SIG, ihdr(10, 10)), "image/png")).toBeNull(); // sin IEND
    expect(stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), "image/jpeg")).toBeNull();
    expect(stripImageMetadata(new Uint8Array([0xff, 0xd8, 0x00]), "image/jpeg")).toBeNull();
  });

  it("[PH-S-u6] userPhotoKey / isUserPhotoKeyFor: espejo del CHECK de M24 (prefijo del propio id, segmentos seguros, ≤ 200)", () => {
    const uid = "0b7c3a52-1f2e-4c1d-9e8a-123456789abc";
    const key = userPhotoKey(uid, "a".repeat(24), "png");
    expect(key).toBe(`users/${uid}/photo/${"a".repeat(24)}.png`);
    expect(isUserPhotoKeyFor(uid, key!)).toBe(true);
    expect(isUserPhotoKeyFor("otro-usuario", key!)).toBe(false);
    // Lo que el CHECK rechaza, la app tampoco lo arma ni lo sirve.
    for (const bad of ["../x", ".oculto", "a/b", "", "con espacio", "x".repeat(190)]) {
      expect(userPhotoKey(bad, "a".repeat(24), "jpg"), bad).toBeNull();
    }
    expect(userPhotoKey(uid, "no-hex!", "png")).toBeNull();
    expect(isUserPhotoKeyFor(uid, `users/${uid}/../x/signature.png`)).toBe(false);
    expect(isUserPhotoKeyFor(uid, `users/${uid}/photo/.png`)).toBe(false);
    expect(isUserPhotoKeyFor(uid, `tenant-1/signature/pro-1/abc.png`)).toBe(false);
    expect(isUserPhotoKeyFor(uid, `users/${uid}/`)).toBe(false);
  });

  it("[PH-S-u7] URLs: propia y pública con ?v=<ms>; sin foto o sin opt-in → null (nunca avatarUrl)", () => {
    const at = new Date("2026-11-05T13:00:00.000Z");
    expect(photoVersion(at)).toBe(String(at.getTime()));
    expect(photoVersion(null)).toBeNull();
    expect(photoVersion(new Date(Number.NaN))).toBeNull();
    expect(ownPhotoUrl(at)).toBe(`/api/me/photo?v=${at.getTime()}`);
    expect(ownPhotoUrlFor({ photoStorageKey: "users/u/photo/x.png", photoUpdatedAt: at })).toBe(`/api/me/photo?v=${at.getTime()}`);
    expect(ownPhotoUrlFor({ photoUpdatedAt: at })).toBe(`/api/me/photo?v=${at.getTime()}`);
    expect(ownPhotoUrlFor({ photoStorageKey: null, photoUpdatedAt: at })).toBeNull();
    expect(ownPhotoUrlFor({ photoStorageKey: null, photoUpdatedAt: null })).toBeNull();
    expect(ownPhotoUrlFor(null)).toBeNull();
    expect(publicProPhotoUrl("cpro123456789", at)).toBe(`/api/public/pro-photo/cpro123456789?v=${at.getTime()}`);
    expect(publicProPhotoUrlFor({ id: "cpro123456789", showPhotoPublic: true, photoUpdatedAt: at })).toBe(
      `/api/public/pro-photo/cpro123456789?v=${at.getTime()}`
    );
    expect(publicProPhotoUrlFor({ id: "cpro123456789", showPhotoPublic: false, photoUpdatedAt: at })).toBeNull();
    expect(publicProPhotoUrlFor({ id: "cpro123456789", showPhotoPublic: true, photoUpdatedAt: null })).toBeNull();
    expect(publicProPhotoUrlFor({ id: "../x", showPhotoPublic: true, photoUpdatedAt: at })).toBeNull();
  });

  it("[PH-S-u8] isPractitionerIdShape e isCanonicalPhotoQuery: basura fuera antes de la base; solo `?v=<vigente>` baja bytes", () => {
    expect(isPractitionerIdShape("clz1x2y3z0000abcd1234efgh")).toBe(true);
    for (const bad of ["", "a/b", "../x", "%27--", "x".repeat(65), "short", "con espacio"]) {
      expect(isPractitionerIdShape(bad), bad).toBe(false);
    }
    const q = (s: string) => new URLSearchParams(s);
    expect(isCanonicalPhotoQuery(q("v=123"), "123")).toBe(true);
    expect(isCanonicalPhotoQuery(q("v=12"), "123")).toBe(false);
    expect(isCanonicalPhotoQuery(q(""), "123")).toBe(false);
    // Un parámetro de más es otra clave de CDN: bajaría el objeto en cada request (egress gratis).
    expect(isCanonicalPhotoQuery(q("v=123&x=1"), "123")).toBe(false);
    expect(isCanonicalPhotoQuery(q("v=123&v=123"), "123")).toBe(false);
  });

  it("[PH-S-u9] nextPhotoStamp: siempre después de la anterior (la URL immutable cambia aunque el reloj vuelva atrás)", () => {
    const now = new Date("2026-11-05T13:00:00.000Z");
    expect(nextPhotoStamp(null, now)).toEqual(now);
    expect(nextPhotoStamp(new Date(now.getTime() - 5), now)).toEqual(now);
    expect(nextPhotoStamp(now, now).getTime()).toBe(now.getTime() + 1);
    expect(nextPhotoStamp(new Date(now.getTime() + 60_000), now).getTime()).toBe(now.getTime() + 60_001);
  });
});
