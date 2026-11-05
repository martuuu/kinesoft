import { describe, it, expect } from "vitest";
import {
  PHOTO_ACCEPT,
  PHOTO_MAX_BYTES,
  PHOTO_RESIZE_COPY,
  checkPhotoInput,
  coverCrop,
  encodePlan,
  hasTransparency,
  preparePhotoUpload,
  type CanvasLike,
  type PhotoResizeDeps,
} from "@/lib/photo-resize";

/**
 * [PH-U1] Foto del profesional (CF3b, contrato FOTO): la reducción en el cliente de `lib/photo-resize.ts`. Símbolos
 * REALES; lo único falso es el navegador (`decode` y el canvas entran por `deps`): el test fija qué recorte se dibuja,
 * qué formato se pide y en qué orden se cae a JPEG cuando el PNG pesa de más.
 */

describe("[PH-U1-1] entrada: PNG/JPEG/WEBP, tamaño", () => {
  it("acepta los tres por MIME y, sin MIME (selectores de Android), por extensión", () => {
    expect(checkPhotoInput({ type: "image/png", size: 10 })).toEqual({ ok: true, type: "image/png" });
    expect(checkPhotoInput({ type: "image/jpeg", size: 10 })).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkPhotoInput({ type: "image/webp", size: 10 })).toEqual({ ok: true, type: "image/webp" });
    expect(checkPhotoInput({ type: "", size: 10, name: "Yo.JPG" })).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkPhotoInput({ type: "", size: 10, name: "yo.webp" })).toEqual({ ok: true, type: "image/webp" });
    expect(PHOTO_ACCEPT).toBe("image/png,image/jpeg,image/webp");
  });

  it("rechaza otro tipo (aunque la extensión mienta), vacío y más de 20 MB", () => {
    expect(checkPhotoInput({ type: "image/heic", size: 10, name: "a.jpg" })).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.badType });
    expect(checkPhotoInput({ type: "image/gif", size: 10 })).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.badType });
    expect(checkPhotoInput({ type: "", size: 10, name: "foto" })).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.badType });
    expect(checkPhotoInput({ type: "image/png", size: 0 })).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.empty });
    expect(checkPhotoInput({ type: "image/png", size: 20 * 1_048_576 + 1 })).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.inputTooBig });
  });
});

describe("[PH-U1-2] recorte centrado tipo cover, sin agrandar", () => {
  it("apaisada: el lado corto entero, centrado en el ancho, a 512", () => {
    expect(coverCrop(4000, 3000)).toEqual({ sx: 500, sy: 0, sw: 3000, sh: 3000, side: 512 });
  });
  it("vertical: centrado en el alto", () => {
    expect(coverCrop(1080, 1920)).toEqual({ sx: 0, sy: 420, sw: 1080, sh: 1080, side: 512 });
  });
  it("chica: no se agranda; impar: enteros dentro de la imagen", () => {
    expect(coverCrop(300, 301)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 300, side: 300 });
    const c = coverCrop(1001, 600);
    expect(c).toEqual({ sx: 200, sy: 0, sw: 600, sh: 600, side: 512 });
    expect(c.sx + c.sw).toBeLessThanOrEqual(1001);
  });
});

describe("[PH-U1-3] PNG si hay transparencia, JPEG si no", () => {
  it("hasTransparency mira solo el canal alfa", () => {
    expect(hasTransparency([0, 0, 0, 255, 10, 20, 30, 255])).toBe(false);
    expect(hasTransparency([255, 255, 255, 255, 0, 0, 0, 254])).toBe(true);
    expect(hasTransparency([0, 0, 0, 0])).toBe(true);
  });
  it("plan: con alfa PNG y después JPEG; sin alfa JPEG 0,85 primero", () => {
    expect(encodePlan(true).map((s) => s.type)).toEqual(["image/png", "image/jpeg", "image/jpeg", "image/jpeg"]);
    expect(encodePlan(false)[0]).toEqual({ type: "image/jpeg", quality: 0.85 });
    expect(encodePlan(false).every((s) => s.type === "image/jpeg")).toBe(true);
  });
});

/** Canvas falso: registra lo que se dibuja y devuelve blobs del tamaño que diga `sizes` (por intento). */
function fakeDeps(opts: { width: number; height: number; alpha?: number; sizes?: number[]; decodeFails?: boolean; noCtx?: boolean }) {
  const log: string[] = [];
  let released = 0;
  let attempt = 0;
  const canvas: CanvasLike & { ops: string[] } = {
    width: 0,
    height: 0,
    ops: log,
    getContext: () =>
      opts.noCtx
        ? null
        : {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
            globalCompositeOperation: "source-over",
            fillStyle: "#000",
            drawImage: (_i, sx, sy, sw, sh, dx, dy, dw, dh) => log.push(`draw ${sx},${sy},${sw},${sh} → ${dx},${dy},${dw},${dh}`),
            getImageData: (_x, _y, w, h) => {
              log.push(`read ${w}x${h}`);
              const data = new Uint8ClampedArray(16).fill(255);
              data[7] = opts.alpha ?? 255;
              return { data };
            },
            fillRect(x, y, w, h) {
              log.push(`fill ${String(this.fillStyle)} ${this.globalCompositeOperation} ${x},${y},${w},${h}`);
            },
          },
    toBlob: (cb, type, quality) => {
      const size = opts.sizes?.[attempt++] ?? 50_000;
      log.push(`encode ${type} ${quality ?? "-"}`);
      cb(new Blob([new Uint8Array(size)], { type }));
    },
  };
  const deps: PhotoResizeDeps = {
    decode: async () => {
      if (opts.decodeFails) throw new Error("decode");
      return { image: {} as CanvasImageSource, width: opts.width, height: opts.height, release: () => void released++ };
    },
    createCanvas: () => canvas,
  };
  return { deps, canvas, log, released: () => released };
}
const fileOf = (type: string, size = 2_000_000, name = "x") => new File([new Uint8Array(size)], name, { type });

describe("[PH-U1-4] preparePhotoUpload con un canvas falso", () => {
  it("JPEG de entrada: recorte a 512, sin leer píxeles, JPEG 0,85 llamado foto.jpg", async () => {
    const f = fakeDeps({ width: 4000, height: 3000 });
    const r = await preparePhotoUpload(fileOf("image/jpeg"), f.deps);
    expect(r.ok && { type: r.type, side: r.side, name: r.file.name, fileType: r.file.type }).toEqual({
      type: "image/jpeg",
      side: 512,
      name: "foto.jpg",
      fileType: "image/jpeg",
    });
    expect(f.canvas.width).toBe(512);
    expect(f.canvas.height).toBe(512);
    expect(f.log).toEqual(["draw 500,0,3000,3000 → 0,0,512,512", "encode image/jpeg 0.85"]);
    expect(f.released()).toBe(1);
  });

  it("PNG con transparencia → PNG (sin aplanar)", async () => {
    const f = fakeDeps({ width: 800, height: 800, alpha: 0 });
    const r = await preparePhotoUpload(fileOf("image/png"), f.deps);
    expect(r.ok && r.type).toBe("image/png");
    expect(r.ok && r.file.name).toBe("foto.png");
    expect(f.log).toEqual(["draw 0,0,800,800 → 0,0,512,512", "read 512x512", "encode image/png -"]);
  });

  it("PNG opaco y WEBP opaco → JPEG (el WEBP siempre se re-codifica)", async () => {
    for (const t of ["image/png", "image/webp"]) {
      const f = fakeDeps({ width: 600, height: 900, alpha: 255 });
      const r = await preparePhotoUpload(fileOf(t), f.deps);
      expect(r.ok && r.type).toBe("image/jpeg");
      expect(f.log.at(-1)).toBe("encode image/jpeg 0.85");
    }
  });

  it("PNG transparente de más de 1 MB → JPEG aplanado sobre blanco DETRÁS del dibujo", async () => {
    const f = fakeDeps({ width: 512, height: 512, alpha: 10, sizes: [PHOTO_MAX_BYTES + 1, 300_000] });
    const r = await preparePhotoUpload(fileOf("image/webp"), f.deps);
    expect(r.ok && r.type).toBe("image/jpeg");
    expect(r.ok && r.file.size).toBe(300_000);
    expect(f.log.slice(2)).toEqual(["encode image/png -", "fill #ffffff destination-over 0,0,512,512", "encode image/jpeg 0.85"]);
  });

  it("todo de más de 1 MB → error «pesa más de 1 MB»; exactamente 1 MB entra", async () => {
    const big = PHOTO_MAX_BYTES + 1;
    const f = fakeDeps({ width: 900, height: 900, sizes: [big, big, big] });
    expect(await preparePhotoUpload(fileOf("image/jpeg"), f.deps)).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.tooBig });
    expect(f.log.filter((l) => l.startsWith("encode"))).toEqual(["encode image/jpeg 0.85", "encode image/jpeg 0.72", "encode image/jpeg 0.6"]);
    const g = fakeDeps({ width: 900, height: 900, sizes: [PHOTO_MAX_BYTES] });
    expect((await preparePhotoUpload(fileOf("image/jpeg"), g.deps)).ok).toBe(true);
  });

  it("errores sin tirar: tipo, imagen ilegible, sin canvas 2d", async () => {
    expect(await preparePhotoUpload(fileOf("application/pdf"), fakeDeps({ width: 1, height: 1 }).deps)).toEqual({
      ok: false,
      error: PHOTO_RESIZE_COPY.badType,
    });
    expect(await preparePhotoUpload(fileOf("image/png"), fakeDeps({ width: 1, height: 1, decodeFails: true }).deps)).toEqual({
      ok: false,
      error: PHOTO_RESIZE_COPY.unreadable,
    });
    const zero = fakeDeps({ width: 0, height: 0 });
    expect(await preparePhotoUpload(fileOf("image/png"), zero.deps)).toEqual({ ok: false, error: PHOTO_RESIZE_COPY.unreadable });
    expect(zero.released()).toBe(1);
    expect(await preparePhotoUpload(fileOf("image/png"), fakeDeps({ width: 10, height: 10, noCtx: true }).deps)).toEqual({
      ok: false,
      error: PHOTO_RESIZE_COPY.noCanvas,
    });
  });
});
