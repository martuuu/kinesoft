/**
 * FC-2g (T4, C-FC7, §24.6) · Lógica pura de las descargas del equipo: formatos, topes, copy y el `Content-Disposition`.
 * Sin `server-only` ni Prisma para que el unit la pruebe sin base (`tests/unit/hc-export-logic.test.ts`); la usan las
 * rutas `app/api/pacientes/[id]/fichas/[noteId]/[format]` y `…/historia-clinica/[format]` y `lib/hc-export-internal.ts`.
 * NEUTRAL: no nombra el modelo de notas (no hace falta y así la puede importar el respaldo de FC-3g sin arrastrar nada).
 */

export type HcFichaFormat = "pdf" | "docx";

export const HC_EXPORT_CONTENT_TYPE: Readonly<Record<HcFichaFormat, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** `[format]` de la URL → formato. Cualquier otra cosa (mayúsculas, `.pdf`, vacío) → null → 404. */
export function parseFichaFormat(raw: unknown): HcFichaFormat | null {
  return raw === "pdf" || raw === "docx" ? raw : null;
}

/** La HC completa sale SOLO en PDF (FC-D31): un Word de 300 fichas no se edita y duplicaría la superficie. */
export function parseRecordFormat(raw: unknown): "pdf" | null {
  return raw === "pdf" ? "pdf" : null;
}

/**
 * Ids de la URL: cuid / hex de la base. Se rechaza todo lo demás ANTES de tocar la base (404, igual que un id ajeno):
 * no es una barrera de seguridad (Prisma parametriza), pero corta basura larga antes de abrir una tx.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isRouteId(raw: unknown): raw is string {
  return typeof raw === "string" && ID_RE.test(raw);
}

/**
 * Rate limit por usuario. La ficha es barata y el respaldo de FC-3g la vuelve a bajar en cada guardado del mismo
 * dispositivo (§24.6): 60 / 10 min cubre una tarde de carga sin dejar raspar la HC ficha por ficha a ritmo de script.
 * La HC completa son hasta 300 fichas y 6-7 s de render (medido en FC-1c): 5 / 10 min, que nadie necesita más de eso.
 */
export const HC_EXPORT_RATE_LIMIT = {
  ficha: { limit: 60, windowMs: 10 * 60_000 },
  record: { limit: 5, windowMs: 10 * 60_000 },
} as const;

export const HC_EXPORT_COPY = {
  // FC-D31 (literal): si la HC completa pasa de 4 MB → «Usá Imprimir historia clínica».
  recordTooLarge:
    "La historia clínica completa es demasiado pesada para un PDF. Usá Imprimir historia clínica.",
  fichaTooLarge: "La ficha es demasiado pesada para un PDF. Descargala en Word o usá Imprimir historia clínica.",
  renderFailed: "No pudimos armar el archivo. Probá de nuevo en un rato.",
  rateLimited: "Descargaste muchos archivos seguidos. Esperá unos minutos y probá de nuevo.",
} as const;

/**
 * Sufijo corto del id para el nombre del archivo (`[id6]` de §24.6). Los ÚLTIMOS 6: un cuid arranca con el timestamp
 * (las fichas del mismo día compartirían el principio) y termina en el contador/aleatorio.
 */
export function hcShortId(id: string): string {
  return id.slice(-6);
}

/** RFC 5987 `attr-char`: encodeURIComponent deja pasar `'()*!`, que en `filename*` tienen que ir codificados. */
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<utf8>`. El `filename*` lleva el nombre real («Gómez Juan …»);
 * el `filename` ASCII es el fallback de clientes viejos: sin diacríticos (NFD), sin comillas ni barras y sin nada
 * fuera de 0x20-0x7E, así no se puede cerrar la comilla ni inyectar otro parámetro en el header. `base` ya viene
 * saneado por `hcFileBase`; esto se repite igual porque el header es la frontera.
 */
export function attachmentDisposition(base: string, ext: HcFichaFormat): string {
  const name = `${base}.${ext}`;
  const ascii =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;%]/g, "_")
      .trim() || `documento.${ext}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}
