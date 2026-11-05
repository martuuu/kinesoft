/**
 * CF3b PH-U1 (contrato FOTO, `wip-20/cf3-handoffs.md`) — la foto del profesional se reduce en el CLIENTE, con canvas y
 * sin librerías, antes de mandarla a `uploadOwnPhoto` (campo `file` del `FormData`).
 *
 * Por qué en el cliente: el bucket `practice-assets` acepta hasta 1 MB y solo PNG/JPEG (EXTERNAL-CONFIG), y una foto de
 * celular pesa 3-8 MB (y en Android a veces llega como WEBP). El server re-chequea tipo, tamaño y dimensiones (PH-S):
 * esto es para que la foto entre, no la barrera.
 *
 *   1. `checkPhotoInput`: PNG/JPEG/WEBP (por MIME o, si el selector no lo manda, por extensión) y ≤ 20 MB de entrada
 *      (decodificar una imagen enorme en un celular puede tirar la pestaña).
 *   2. `coverCrop`: cuadrado centrado tipo `object-fit: cover` (el lado corto entero), a 512 px o menos: no se agranda
 *      una foto chica (el marco la escala igual y subirla agrandada solo suma bytes).
 *   3. `hasTransparency` sobre el recorte YA dibujado (si la transparencia queda afuera del recorte no cuenta) →
 *      `encodePlan`: con transparencia PNG (el marco de `PractitionerPhoto` la deja recortada sobre blanco); sin ella
 *      JPEG 0,85. Si pasa de 1 MB: PNG → JPEG aplanado sobre blanco (en el marco blanco se ve igual) → calidades más
 *      bajas. WEBP de entrada siempre se re-codifica (el bucket no lo acepta).
 *
 * La parte con navegador (`decode`, `createCanvas`) entra por `deps` para que el test (sin DOM) pruebe el flujo con un
 * canvas falso. `decode` usa `<img>` y no `createImageBitmap`: el `<img>` respeta la orientación EXIF en todos los
 * navegadores actuales (`image-orientation: from-image` por defecto) y `drawImage` la hereda; con `createImageBitmap`
 * el default cambió entre versiones y una foto vertical de iPhone podía subir acostada.
 */

export const PHOTO_SIDE_PX = 512;
/** El límite del bucket `practice-assets` (el mismo `maxBytes` del logo en `lib/file-sniff.ts`). */
export const PHOTO_MAX_BYTES = 1_048_576;
export const PHOTO_INPUT_MAX_BYTES = 20 * 1_048_576;
export const PHOTO_JPEG_QUALITY = 0.85;
export const PHOTO_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PhotoInputType = (typeof PHOTO_INPUT_TYPES)[number];
/** `accept` del `<input type="file">`. Sin HEIC: iOS lo convierte a JPEG solo cuando el `accept` no lo incluye. */
export const PHOTO_ACCEPT = PHOTO_INPUT_TYPES.join(",");
export type PhotoOutputType = "image/png" | "image/jpeg";

export const PHOTO_RESIZE_COPY = {
  badType: "La foto tiene que ser PNG, JPEG o WEBP.",
  empty: "El archivo está vacío. Elegí otra foto.",
  inputTooBig: "La imagen pesa más de 20 MB. Elegí una más liviana.",
  unreadable: "No pudimos abrir la imagen. Probá con otra foto en PNG, JPEG o WEBP.",
  noCanvas: "Este navegador no puede preparar la foto. Probá desde otro navegador.",
  tooBig: "Aun achicada, la foto pesa más de 1 MB. Probá con otra.",
  encodeFailed: "No pudimos preparar la foto. Probá de nuevo o con otra imagen.",
} as const;

const EXT_TYPE: Record<string, PhotoInputType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export type PhotoInputCheck = { ok: true; type: PhotoInputType } | { ok: false; error: string };

/** Tipo y tamaño de lo que eligió el usuario. Algunos selectores de Android mandan `type` vacío: cae a la extensión. */
export function checkPhotoInput(file: { type: string; size: number; name?: string }): PhotoInputCheck {
  const mime = file.type.toLowerCase();
  const ext = (file.name ?? "").toLowerCase().split(".").pop() ?? "";
  const type = (PHOTO_INPUT_TYPES as readonly string[]).includes(mime)
    ? (mime as PhotoInputType)
    : mime === ""
      ? EXT_TYPE[ext]
      : undefined;
  if (!type) return { ok: false, error: PHOTO_RESIZE_COPY.badType };
  if (file.size === 0) return { ok: false, error: PHOTO_RESIZE_COPY.empty };
  if (file.size > PHOTO_INPUT_MAX_BYTES) return { ok: false, error: PHOTO_RESIZE_COPY.inputTooBig };
  return { ok: true, type };
}

/** Rectángulo de origen (`sx, sy, sw, sh`) y lado del cuadrado de destino. */
export type CoverCrop = { sx: number; sy: number; sw: number; sh: number; side: number };

/**
 * Cuadrado centrado, como `object-fit: cover`: el lado corto entero y centrado en el largo. Enteros, así el
 * rectángulo nunca sale de la imagen (el suavizado muestrearía transparente en el borde y una foto opaca daría alfa).
 */
export function coverCrop(width: number, height: number, max: number = PHOTO_SIDE_PX): CoverCrop {
  const w = Math.floor(width);
  const h = Math.floor(height);
  const s = Math.min(w, h);
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), sw: s, sh: s, side: Math.min(max, s) };
}

/** ¿Algún píxel no del todo opaco? RGBA de `getImageData`: el alfa es cada 4.º byte. */
export function hasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

export type EncodeStep = { type: PhotoOutputType; quality?: number };

/** Intentos en orden hasta que uno entre en 1 MB (ver la cabecera). */
export function encodePlan(alpha: boolean): EncodeStep[] {
  const jpeg: EncodeStep[] = [PHOTO_JPEG_QUALITY, 0.72, 0.6].map((quality) => ({ type: "image/jpeg", quality }));
  return alpha ? [{ type: "image/png" }, ...jpeg] : jpeg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución con canvas
// ─────────────────────────────────────────────────────────────────────────────

type Ctx2DLike = {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: string | CanvasGradient | CanvasPattern;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: ArrayLike<number> };
  fillRect(x: number, y: number, w: number, h: number): void;
};
export type CanvasLike = {
  width: number;
  height: number;
  getContext(id: "2d"): Ctx2DLike | null;
  toBlob(cb: (blob: Blob | null) => void, type?: string, quality?: number): void;
};
export type DecodedPhoto = { image: CanvasImageSource; width: number; height: number; release: () => void };
export type PhotoResizeDeps = {
  decode: (file: Blob) => Promise<DecodedPhoto>;
  createCanvas: () => CanvasLike;
};

export type PreparedPhoto =
  | { ok: true; file: File; type: PhotoOutputType; side: number; alpha: boolean }
  | { ok: false; error: string };

function browserDeps(): PhotoResizeDeps {
  return {
    decode: async (file) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      try {
        await img.decode();
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
      return { image: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    },
    createCanvas: () => document.createElement("canvas") as unknown as CanvasLike,
  };
}

function toBlob(canvas: CanvasLike, step: EncodeStep): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), step.type, step.quality);
    } catch {
      resolve(null);
    }
  });
}

/** La foto lista para el `FormData` (`file`), o el error a mostrar. Nunca tira. */
export async function preparePhotoUpload(file: File, deps: PhotoResizeDeps = browserDeps()): Promise<PreparedPhoto> {
  const check = checkPhotoInput(file);
  if (!check.ok) return check;
  let decoded: DecodedPhoto;
  try {
    decoded = await deps.decode(file);
  } catch {
    return { ok: false, error: PHOTO_RESIZE_COPY.unreadable };
  }
  try {
    if (!(decoded.width >= 1 && decoded.height >= 1)) return { ok: false, error: PHOTO_RESIZE_COPY.unreadable };
    const crop = coverCrop(decoded.width, decoded.height);
    const canvas = deps.createCanvas();
    canvas.width = crop.side;
    canvas.height = crop.side;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: PHOTO_RESIZE_COPY.noCanvas };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.side, crop.side);

    // Un JPEG no tiene alfa: no se lee el canvas (512² son ~1 MB de copia). Si leerlo falla (modos anti-huella que lo
    // bloquean), se asume transparencia: PNG primero conserva el recorte y, si pesa de más, igual cae a JPEG.
    let alpha = false;
    if (check.type !== "image/jpeg") {
      try {
        alpha = hasTransparency(ctx.getImageData(0, 0, crop.side, crop.side).data);
      } catch {
        alpha = true;
      }
    }

    let flattened = !alpha;
    let encoded = false;
    for (const step of encodePlan(alpha)) {
      if (step.type === "image/jpeg" && !flattened) {
        // JPEG no tiene alfa: sin esto lo transparente sale NEGRO. `destination-over` pinta el blanco DETRÁS de lo que
        // ya está dibujado (aplanar sin un segundo canvas).
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, crop.side, crop.side);
        ctx.globalCompositeOperation = "source-over";
        flattened = true;
      }
      const blob = await toBlob(canvas, step);
      if (!blob) continue;
      encoded = true;
      if (blob.size > PHOTO_MAX_BYTES) continue;
      const out = new File([blob], step.type === "image/png" ? "foto.png" : "foto.jpg", { type: step.type });
      return { ok: true, file: out, type: step.type, side: crop.side, alpha: step.type === "image/png" };
    }
    return { ok: false, error: encoded ? PHOTO_RESIZE_COPY.tooBig : PHOTO_RESIZE_COPY.encodeFailed };
  } finally {
    decoded.release();
  }
}
