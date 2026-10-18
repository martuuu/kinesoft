/**
 * T4 FC-2f · magic bytes (`lib/file-sniff.ts`, símbolo real; contratos C-FC9 y C-FC10).
 * Fija: cada familia por sus primeros bytes, que la tabla MIME → familias tenga EXACTAMENTE las claves de
 * `ALLOWED_MIME` de `lib/files.ts` (que no cambia), `readImageInfo` de PNG/JPEG y el chequeo de logo y firma.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PATIENT_FILE_MIME_FAMILIES,
  PRACTICE_ASSET_COPY,
  PRACTICE_ASSET_LIMITS,
  checkPracticeAsset,
  headMatchesMime,
  readImageInfo,
  sniffFileFamily,
} from "@/lib/file-sniff";
import { jpeg, png } from "@/tests/helpers/image-bytes";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...xs: number[]) => new Uint8Array(xs);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ftyp = (brand: string) => cat(bytes(0, 0, 0, 0x18), enc("ftyp"), enc(brand), bytes(0, 0, 0, 0));

describe("[FC-2f] sniffFileFamily", () => {
  it.each([
    ["pdf", enc("%PDF-1.7\n")],
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["png", png(10, 10)],
    ["webp", cat(enc("RIFF"), bytes(1, 2, 3, 4), enc("WEBPVP8 "))],
    ["gif", enc("GIF89a....")],
    ["gif", enc("GIF87a....")],
    ["heif", ftyp("heic")],
    ["heif", ftyp("mif1")],
    ["mp4", ftyp("isom")],
    ["mp4", ftyp("mp42")],
    ["mov", ftyp("qt  ")],
    ["mov", cat(bytes(0, 0, 0, 8), enc("wide"))],
    ["mp3", enc("ID3\x04\0")],
    ["mp3", bytes(0xff, 0xfb, 0x90, 0x00)],
    ["ole2", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
    ["zip", bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0)],
    ["text", enc("Informe de la resonancia: sin lesiones.\n")],
    ["text", cat(bytes(0xef, 0xbb, 0xbf), enc("Ñandú"))],
  ] as const)("%s", (family, head) => {
    expect(sniffFileFamily(head)).toBe(family);
  });

  it("texto con un multibyte cortado al final de la cabeza sigue siendo texto", () => {
    const h = enc("a".repeat(63) + "ñ").slice(0, 64); // la ñ queda por la mitad
    expect(sniffFileFamily(h)).toBe("text");
  });

  it.each([
    ["vacío", new Uint8Array(0)],
    ["NUL", bytes(0x41, 0, 0x42)],
    ["html", enc("<!DOCTYPE html><html><script>alert(1)</script>")],
    ["svg", enc('  <svg xmlns="http://www.w3.org/2000/svg">')],
    ["xml", enc('<?xml version="1.0"?><svg/>')],
    ["UTF-8 inválido", bytes(0x41, 0xc3, 0x28)],
    ["ftyp desconocido", ftyp("avif")],
    ["zip vacío", bytes(0x50, 0x4b, 0x05, 0x06)],
    ["exe", enc("MZ\x90\0\x03\0")],
  ])("%s → null", (_n, head) => {
    expect(sniffFileFamily(head)).toBeNull();
  });
});

describe("[FC-2f] compatibilidad MIME ↔ familia", () => {
  it("PATIENT_FILE_MIME_FAMILIES tiene exactamente las claves de ALLOWED_MIME (que no cambia)", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/files.ts"), "utf8");
    const block = /const ALLOWED_MIME = new Set<string>\(\[([\s\S]*?)\]\);/.exec(src);
    expect(block).not.toBeNull();
    const allowed = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(allowed).toHaveLength(15);
    expect(Object.keys(PATIENT_FILE_MIME_FAMILIES).sort()).toEqual(allowed);
  });

  it("acepta lo que coincide y rechaza el disfraz", () => {
    expect(headMatchesMime("application/pdf", enc("%PDF-1.4"))).toBe(true);
    expect(headMatchesMime("APPLICATION/PDF", enc("%PDF-1.4"))).toBe(true);
    expect(headMatchesMime("application/pdf", enc("<html>"))).toBe(false);
    expect(headMatchesMime("image/png", bytes(0xff, 0xd8, 0xff))).toBe(false);
    expect(headMatchesMime("text/plain", enc("<svg onload=alert(1)>"))).toBe(false);
    expect(headMatchesMime("video/mp4", ftyp("qt  "))).toBe(true);
    expect(headMatchesMime("video/quicktime", ftyp("isom"))).toBe(true);
    expect(headMatchesMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes(0x50, 0x4b, 3, 4))).toBe(true);
    expect(headMatchesMime("application/msword", bytes(0x50, 0x4b, 3, 4))).toBe(false);
    expect(headMatchesMime("image/svg+xml", enc("<svg/>"))).toBe(false);
  });
});

describe("[FC-2f] readImageInfo", () => {
  it("PNG y JPEG con sus dimensiones", () => {
    expect(readImageInfo(png(640, 200))).toEqual({ mime: "image/png", width: 640, height: 200 });
    expect(readImageInfo(jpeg(1200, 300))).toEqual({ mime: "image/jpeg", width: 1200, height: 300 });
  });

  it("JPEG progresivo (SOF2) y con relleno 0xFF entre segmentos", () => {
    const j = jpeg(50, 60);
    const prog = j.slice();
    prog[2 + 18 + 1] = 0xc2; // el SOF0 pasa a SOF2
    expect(readImageInfo(prog)).toEqual({ mime: "image/jpeg", width: 50, height: 60 });
    const padded = cat(j.subarray(0, 20), bytes(0xff, 0xff), j.subarray(20));
    expect(readImageInfo(padded)).toEqual({ mime: "image/jpeg", width: 50, height: 60 });
  });

  it("roto, truncado, sin SOF o de otro formato → null", () => {
    expect(readImageInfo(png(0, 10))).toBeNull();
    expect(readImageInfo(png(10, 10).slice(0, 20))).toBeNull();
    expect(readImageInfo(bytes(0xff, 0xd8, 0xff, 0xda, 0, 2))).toBeNull();
    expect(readImageInfo(jpeg(10, 10).slice(0, 25))).toBeNull();
    expect(readImageInfo(enc("GIF89a"))).toBeNull();
    expect(readImageInfo(enc("<svg/>"))).toBeNull();
    expect(readImageInfo(new Uint8Array(0))).toBeNull();
  });
});

describe("[FC-2f] checkPracticeAsset (logo ≤1 MB, firma ≤512 KB, PNG/JPEG, dimensiones)", () => {
  it("límites del contrato", () => {
    expect(PRACTICE_ASSET_LIMITS).toEqual({
      logo: { maxBytes: 1_048_576, maxPx: 3000 },
      signature: { maxBytes: 524_288, maxPx: 2000 },
    });
  });

  it("PNG y JPEG válidos", () => {
    expect(checkPracticeAsset("logo", png(800, 200), "image/png")).toMatchObject({ ok: true, mime: "image/png", ext: "png" });
    expect(checkPracticeAsset("signature", jpeg(600, 200), "image/jpeg")).toMatchObject({ ok: true, ext: "jpg" });
    // Sin type del navegador: mandan los bytes.
    expect(checkPracticeAsset("logo", jpeg(10, 10), "")).toMatchObject({ ok: true, mime: "image/jpeg" });
  });

  it("WEBP, SVG, HEIC o GIF → copy de formato; tipo falso → «no es lo que dice ser»", () => {
    const webp = cat(enc("RIFF"), bytes(1, 2, 3, 4), enc("WEBPVP8 "));
    expect(checkPracticeAsset("logo", webp, "image/webp")).toEqual({ ok: false, error: PRACTICE_ASSET_COPY.logoFormat });
    expect(checkPracticeAsset("logo", enc("<svg/>"), "image/svg+xml")).toEqual({ ok: false, error: PRACTICE_ASSET_COPY.logoFormat });
    expect(checkPracticeAsset("signature", ftyp("heic"), "image/heic")).toEqual({
      ok: false,
      error: PRACTICE_ASSET_COPY.signatureFormat,
    });
    expect(checkPracticeAsset("logo", enc("<svg/>"), "image/png")).toEqual({ ok: false, error: "El archivo no es lo que dice ser." });
    expect(checkPracticeAsset("logo", jpeg(10, 10), "image/png")).toEqual({ ok: false, error: "El archivo no es lo que dice ser." });
    expect(checkPracticeAsset("logo", webp, "")).toEqual({ ok: false, error: PRACTICE_ASSET_COPY.logoFormat });
  });

  it("pesado o enorme", () => {
    const big = new Uint8Array(1_048_577);
    big.set(png(10, 10));
    expect(checkPracticeAsset("logo", big, "image/png")).toEqual({ ok: false, error: "Subí el logo en PNG o JPG (hasta 1 MB)." });
    const sig = new Uint8Array(524_289);
    sig.set(png(10, 10));
    expect(checkPracticeAsset("signature", sig, "image/png")).toEqual({
      ok: false,
      error: "La firma tiene que ser PNG o JPG (hasta 512 KB). Mejor en PNG con fondo transparente.",
    });
    expect(checkPracticeAsset("logo", png(3001, 10), "image/png")).toEqual({
      ok: false,
      error: "La imagen es demasiado grande (máximo 3000 × 3000 px).",
    });
    expect(checkPracticeAsset("signature", jpeg(10, 2001), "image/jpeg")).toEqual({
      ok: false,
      error: "La imagen es demasiado grande (máximo 2000 × 2000 px).",
    });
  });
});
