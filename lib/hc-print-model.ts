/**
 * Modelo imprimible de la historia clínica: lógica PURA (C-FC4, §24.6). Sin Prisma, sin I/O, sin `server-only`: lo
 * usan el server (PDF, Word, snapshot del documento compartido) y la vista web.
 *
 * NEUTRAL: el portal importa módulos `hc-*` y su guard es una regex sobre el archivo entero, comentarios incluidos, así
 * que acá no se nombra el modelo de notas. La fuente (`HcPrintSource`) ya llega con los textos resueltos por el loader
 * (`label` del tipo de entrada, nombre del autor), así este módulo no importa nada del módulo de notas.
 *
 * FC-1b3 implementa lo chico y estable: matrícula, honorífico, línea de firma, versión de la fuente, JSON canónico y
 * código de verificación. `buildHcPrintableContent` y `hcFileBase` quedan como stubs que tiran: los implementa FC-2e.
 */
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { HcPrintableContentV1 } from "@/lib/hc-print-types";

// ─── Fuente (la arma `loadHcPrintSourceInTx` en `lib/hc-print-internal.ts`) ─────────────────────────────────────────

/**
 * Una entrada (raíz o enmienda) tal como la lee el server. Lleva ids y el motivo interno de anulación porque los
 * necesita el armado (firma por autor, `hcSourceVersion`, marca «anulada» solo en `download`), pero NADA de esto pasa
 * al `HcPrintableContentV1`: el contenido sale sin ids, sin el autor por id y sin el enum del tipo.
 */
export type HcPrintSourceEntry = {
  id: string;
  revision: number;
  /** Etiqueta ya resuelta del tipo de entrada (la resuelve el loader, que sí puede importar el módulo de notas). */
  label: string;
  title: string | null;
  occurredAt: Date;
  createdAt: Date;
  /** Texto plano (siempre presente: entradas viejas sin formato). */
  body: string;
  /** Doc con formato ya validado; `null` = entrada vieja en texto plano. */
  bodyDoc: unknown | null;
  diagnoses: DiagnosisSnapshot[];
  authorName: string;
  authorHonorific: string | null;
  authorLicense: string | null;
  authorPractitionerId: string | null;
  authorHasSignature: boolean;
  importSource: unknown | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

export type HcPrintSource = {
  tenant: { name: string; addressLine: string | null; phone: string | null; hasLogo: boolean };
  patient: { firstName: string; lastName: string; documentId: string | null; dateOfBirth: string | null };
  entries: { root: HcPrintSourceEntry; amendments: HcPrintSourceEntry[] }[];
  /** El loader cortó en el tope (300 fichas): el PDF lo dice. */
  truncated: boolean;
};

// ─── Matrícula, honorífico y firma ──────────────────────────────────────────────────────────────────────────────────

/** CHECK de `authorLicense` en M14: 1..60 caracteres. */
const LICENSE_MAX = 60;

/**
 * Prefijo de matrícula escrito a mano: «MN», «M.N.», «mn:», «M. P.», «mp55». Se exige que después de la N/P no siga
 * una letra, así «Mendoza 12» o «MNX 3» no se leen como prefijo.
 */
const LICENSE_PREFIX_RE = /^m\s*\.?\s*([np])\s*\.?\s*(?![a-záéíóúñ])[:#-]?\s*/iu;
/** «Matrícula», «Mat.», «Matr.»: ruido que la gente escribe delante del número en `Practitioner.licenseNumber`. */
const LICENSE_WORD_RE = /^mat(?:r(?:[ií]cula)?)?\s*\.?\s*(?:n(?:ro|°|º|\.)\.?\s*)?[:#-]?\s*/iu;
/** «Matrícula provincial 55» / «nacional 1234»: la palabra dice el tipo. */
const LICENSE_KIND_WORD_RE = /^(nacional|provincial)(?![a-záéíóúñ])\s*[:#-]?\s*/iu;

/**
 * `Practitioner.licenseNumber` (texto libre, histórico) → la matrícula con la que firma la ficha: «1234» → «MN 1234»,
 * «m.p. 55» → «MP 55». Vacío → null.
 *
 * Por qué «MN» por defecto: el campo nació como «Matrícula Nacional» (comentario del schema) y es lo que cargó la
 * gente; la provincial se escribe con su prefijo. Es idempotente («MN 1234» queda igual), así enmendar una ficha no
 * cambia la matrícula por re-formatear. Se recorta a 60 para respetar el CHECK de la base: un texto absurdo no tiene
 * que tirar el guardado de la ficha.
 */
export function formatLicense(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.replace(LICENSE_WORD_RE, "");
  let kind = "MN";
  const w = LICENSE_KIND_WORD_RE.exec(s);
  const m = w ? null : LICENSE_PREFIX_RE.exec(s);
  if (w) {
    kind = w[1].toLowerCase() === "provincial" ? "MP" : "MN";
    s = s.slice(w[0].length);
  } else if (m) {
    kind = m[1].toUpperCase() === "P" ? "MP" : "MN";
    s = s.slice(m[0].length);
  }
  s = s.trim();
  if (!s) return null;
  return Array.from(`${kind} ${s}`).slice(0, LICENSE_MAX).join("").trim();
}

/** Mismos códigos que `Practitioner_honorific_check` (M14) y `ProfessionalPublicProfile` (directorio). */
const HONORIFIC_LABEL: Readonly<Record<string, string>> = {
  LIC: "Lic.",
  KLGO: "Klgo.",
  KLGA: "Klga.",
  DR: "Dr.",
  DRA: "Dra.",
};

/** Código de la base → abreviatura de la firma. Desconocido o null → null (la firma sale sin título, nunca rota). */
export function honorificLabel(h: string | null): string | null {
  if (!h) return null;
  return HONORIFIC_LABEL[h.trim().toUpperCase()] ?? null;
}

/**
 * «{Lic.} {nombre} · {matrícula}» (§24.4). `honorific` es el CÓDIGO guardado (LIC, DRA…), no la abreviatura. Cada
 * parte es opcional: sin título → «Ana Pérez · MN 1234»; sin matrícula → «Lic. Ana Pérez».
 */
export function formatSignatureLine(p: { honorific: string | null; name: string; license: string | null }): string {
  const name = p.name.replace(/\s+/g, " ").trim();
  const head = [honorificLabel(p.honorific), name].filter(Boolean).join(" ");
  const license = p.license?.replace(/\s+/g, " ").trim() || null;
  return license ? (head ? `${head} · ${license}` : license) : head;
}

// ─── Versión de la fuente y código de verificación ─────────────────────────────────────────────────────────────────

/**
 * Huella de la versión de una ficha con sus enmiendas. El documento compartido guarda `sha256(hcSourceVersion(…))`
 * como `sourceDigest`; si la ficha se edita (sube `revision`), se enmienda (aparece un id) o se anula una enmienda
 * (cambia `voided`), la huella cambia y la tarjeta muestra «Compartida · desactualizada».
 *
 * Determinista ante el orden: las enmiendas se ordenan por id, así dos lecturas de la misma versión (con otro ORDER BY)
 * no la marcan desactualizada en falso.
 */
export function hcSourceVersion(
  root: { revision: number },
  amendments: { id: string; revision: number; voided: boolean }[],
): string {
  const parts = [...amendments]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => `${a.id}:${a.revision}:${a.voided ? 1 : 0}`);
  return [`v1`, `r${root.revision}`, ...parts].join("|");
}

/**
 * JSON con las claves de cada objeto ordenadas (recursivo) y sin espacios: la base del sha256 del contenido y, de ahí,
 * del código de verificación. Sin esto el mismo contenido con otro orden de claves (Postgres jsonb reordena, un spread
 * agrega al final) daría otro código y el paciente vería dos «versiones» de la misma ficha.
 *
 * Sigue la semántica de `JSON.stringify` en lo demás (`toJSON`/Date, `undefined` y funciones se omiten en objetos y
 * son `null` en arrays, NaN/Infinity → null) y tira con un ciclo o un BigInt, igual que él.
 */
export function canonicalJson(v: unknown): string {
  const seen = new Set<object>();
  const walk = (x: unknown, inArray: boolean): string | undefined => {
    if (x !== null && typeof x === "object" && typeof (x as { toJSON?: unknown }).toJSON === "function") {
      x = (x as { toJSON: () => unknown }).toJSON();
    }
    if (x === null) return "null";
    switch (typeof x) {
      case "string":
        return JSON.stringify(x);
      case "number":
        return Number.isFinite(x) ? JSON.stringify(x) : "null";
      case "boolean":
        return x ? "true" : "false";
      case "bigint":
        throw new TypeError("canonicalJson: BigInt no es serializable.");
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? "null" : undefined;
    }
    const obj = x as object;
    if (seen.has(obj)) throw new TypeError("canonicalJson: estructura circular.");
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((item) => walk(item, true) ?? "null").join(",")}]`;
    } else {
      const rec = obj as Record<string, unknown>;
      const fields: string[] = [];
      for (const k of Object.keys(rec).sort()) {
        const val = walk(rec[k], false);
        if (val !== undefined) fields.push(`${JSON.stringify(k)}:${val}`);
      }
      out = `{${fields.join(",")}}`;
    }
    seen.delete(obj);
    return out;
  };
  return walk(v, false) ?? "null";
}

/**
 * sha256 en hex → «A1B2-C3D4-E5F6» (los primeros 48 bits). Es para que una persona lo dicte o lo compare a ojo
 * contra el PDF, no una firma criptográfica: el sha256 completo queda en la base (`snapshotSha256`).
 */
export function verificationCodeFromSha256(hex: string): string {
  const h = hex.trim();
  if (!/^[0-9a-f]{12,}$/i.test(h)) throw new Error("verificationCodeFromSha256: se esperaba un sha256 en hex.");
  const head = h.slice(0, 12).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}-${head.slice(8, 12)}`;
}

// ─── Stubs (los implementa FC-2e) ────────────────────────────────────────────────────────────────────────────────────

/**
 * Fuente → contenido imprimible. `signatureOwners` mapea cada `imageRef` opaco del contenido al practitioner dueño de
 * la firma (la del AUTOR de cada entrada, nunca la de quien descarga; FC-D26). `shared` excluye enmiendas anuladas.
 */
export function buildHcPrintableContent(
  src: HcPrintSource,
  purpose: "shared" | "download",
): { content: HcPrintableContentV1; signatureOwners: Record<string, string> } {
  void src;
  void purpose;
  throw new Error("buildHcPrintableContent: no implementado (FC-2e).");
}

/** Nombre base del archivo descargado (sin extensión). */
export function hcFileBase(p: {
  lastName: string;
  firstName: string;
  occurredAt: Date | null;
  title: string | null;
  shortId: string;
}): string {
  void p;
  throw new Error("hcFileBase: no implementado (FC-2e).");
}
