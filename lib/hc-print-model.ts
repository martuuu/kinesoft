/**
 * Modelo imprimible de la historia clínica: lógica PURA (C-FC4, §24.6). Sin Prisma, sin I/O, sin `server-only`: lo
 * usan el server (PDF, Word, snapshot del documento compartido) y la vista web.
 *
 * NEUTRAL: el portal importa módulos `hc-*` y su guard es una regex sobre el archivo entero, comentarios incluidos, así
 * que acá no se nombra el modelo de notas. La fuente (`HcPrintSource`) ya llega con los textos resueltos por el loader
 * (`label` del tipo de entrada, nombre del autor), así este módulo no importa nada del módulo de notas.
 *
 * FC-1b3 implementó lo chico y estable (matrícula, honorífico, línea de firma, versión de la fuente, JSON canónico y
 * código de verificación); FC-2e, el armado del contenido (`buildHcPrintableContent`) y el nombre de archivo.
 */
import { isoToARLocalInput, toARDateKey } from "@/lib/datetime-ar";
import type { DiagnosisSnapshot, DiagnosisSource } from "@/lib/diagnoses-types";
import { plainTextToHcDoc, validateHcDoc, type HcDoc } from "@/lib/hc-doc";
import type { HcPrintableContentV1, HcPrintableEntryV1 } from "@/lib/hc-print-types";

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
  /**
   * «Carga tardía», ya resuelta por el loader con `isLateEntry` (FC-2e). Viene calculada y no se calcula acá porque
   * este módulo está en la allow-list del portal y `lib/diagnoses-*` no: importarlo por valor metería un módulo HC
   * fuera de la lista en el grafo del portal (`portal-documents-guard`).
   */
  lateEntry: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
};

export type HcPrintSource = {
  tenant: { name: string; addressLine: string | null; phone: string | null; hasLogo: boolean };
  patient: { firstName: string; lastName: string; documentId: string | null; dateOfBirth: string | null };
  entries: { root: HcPrintSourceEntry; amendments: HcPrintSourceEntry[] }[];
  /** El loader cortó en el tope (300 fichas): el PDF lo dice. */
  truncated: boolean;
  /**
   * Claves de Storage del logo y de las firmas por practitioner, para `loadHcAssets`. Viajan en la FUENTE (server) y
   * nunca en el contenido: `buildHcPrintableContent` no las copia. Opcional para que un fake de test no tenga que
   * inventarlas (sin claves = sin imágenes).
   */
  assetKeys?: { logoKey: string | null; signatureKeys: Readonly<Record<string, string>> };
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


// ─── Contenido imprimible (FC-2e) ──────────────────────────────────────────────────────────────────────────────────

/** Copy de las marcas y etiquetas del documento (voseo; lo ven el profesional y el paciente). */
export const HC_PRINT_COPY = {
  lateEntry: "Carga tardía",
  importedFrom: (fileName: string) => `Importada de ${fileName}`,
  importedPart: (part: number, parts: number) => ` · parte ${part} de ${parts}`,
  revisionOriginal: "Versión original",
  revision: (n: number) => `Versión ${n} (editada)`,
  untitledFile: "Ficha",
  fullRecordFile: "Historia clínica",
  docTitle: "Historia clínica",
  diagnosesTitle: "Diagnósticos",
  principal: "Principal",
  amendment: "Enmienda",
  truncated: "Este documento incluye las fichas más recientes; el resto sale en el export del consultorio.",
} as const;

/** Línea del paciente: «Paciente: Juan Gómez · DNI 30111222 · Nacimiento 02/01/1980». */
export function hcPatientLine(p: HcPrintableContentV1["patient"]): string {
  const parts = [`Paciente: ${p.fullName}`];
  if (p.documentId) parts.push(`DNI ${p.documentId}`);
  const dob = p.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth) ? p.dateOfBirth.split("-").reverse().join("/") : null;
  if (dob) parts.push(`Nacimiento ${dob}`);
  return parts.join(" · ");
}

/** Línea del membrete bajo el nombre: «Av. Siempreviva 742, Springfield · Tel. 11 5555-5555». */
export function hcLetterheadMeta(l: HcPrintableContentV1["letterhead"]): string | null {
  return [l.addressLine, l.phone ? `Tel. ${l.phone}` : null].filter(Boolean).join(" · ") || null;
}

/** Encabezado de la entrada: «Ficha · Control» (sin título → la etiqueta sola). */
export function hcEntryHeading(e: HcPrintableEntryV1): string {
  return e.title ? `${e.label} · ${e.title}` : e.label;
}

/** «10/10/2026 10:00 · Versión original · Carga tardía · Importada de informe.docx». */
export function hcEntryMeta(e: HcPrintableEntryV1): string {
  return [e.dateLabel, e.revisionLabel, e.marks.lateEntry, e.marks.imported].filter(Boolean).join(" · ");
}

/** «Anulada el 11/10/2026 07:00 · Motivo: …» (solo existe en `download`). */
export function hcVoidedLine(e: HcPrintableEntryV1): string | null {
  const v = e.marks.voided;
  if (!v) return null;
  const at = hcDateLabel(new Date(v.at));
  return v.reason ? `Anulada el ${at} · Motivo: ${v.reason}` : `Anulada el ${at}`;
}

/** «Principal: FA20.0 Lumbalgia (CIE-11 (OMS))». El título va completo: la licencia de la OMS no deja acortarlo. */
export function hcDiagnosisLine(d: HcPrintableEntryV1["diagnoses"][number]): string {
  const head = d.principal ? `${HC_PRINT_COPY.principal}: ` : "";
  return `${head}${d.code ? `${d.code} ` : ""}${d.title} (${d.sourceLabel})`;
}

/** Pie de cada página: código de verificación, quién y cuándo lo generó. */
export function hcFooterLine(meta: { verificationCode: string; generatedAt: string; generatedByName: string }): string {
  const at = hcDateLabel(new Date(meta.generatedAt));
  return `Código de verificación ${meta.verificationCode} · Generado el ${at} por ${meta.generatedByName}`;
}

/*
 * Copias LITERALES de `ICD11_SHORT_ATTRIBUTION`, `ICD11_ATTRIBUTION` y `DIAGNOSIS_SOURCE_LABEL` de
 * `lib/diagnoses-types.ts`. Por qué copiadas: este módulo está en la allow-list del portal y `lib/diagnoses-*` no
 * (importarlo por valor rompe `portal-documents-guard`). `tests/unit/hc-print-model.test.ts` fija que sean iguales: si
 * la cita de la OMS cambia allá y no acá, el test queda en rojo.
 */
const ICD_SHORT = "CIE-11 © OMS · CC BY-ND 3.0 IGO";
const ICD_LONG =
  "International Classification of Diseases, Eleventh Revision (ICD-11), World Health Organization (WHO) 2019 https://icd.who.int/browse11. Licensed under CC BY-ND 3.0 IGO";
export const HC_DIAGNOSIS_SOURCE_LABEL: Readonly<Record<DiagnosisSource, string>> = {
  icd11: "CIE-11 (OMS)",
  tenant: "Propios del consultorio",
  kine: "Kinesiología",
  text: "Texto libre",
};

/** Atribución de la licencia CC BY-ND 3.0 IGO (§24.2 hallazgo 1): la corta en castellano + la cita literal de la OMS. */
export const HC_ICD_ATTRIBUTION = `${ICD_SHORT}. ${ICD_LONG}`;

/** «DD/MM/AAAA HH:mm» en hora argentina. Por `isoToARLocalInput` (Intl con zona fija): igual en Vercel (UTC) y en AR. */
export function hcDateLabel(d: Date): string {
  const local = isoToARLocalInput(d); // «AAAA-MM-DDTHH:mm»
  if (!local) return "";
  const [date, time] = local.split("T");
  const [y, m, day] = date.split("-");
  return `${day}/${m}/${y} ${time}`;
}

/**
 * `bodyDoc` guardado → `HcDoc`; sin formato (entrada vieja) o inválido → el texto plano como párrafos («Notas viejas:
 * una línea por párrafo», C-FC5). Se re-valida aunque el server ya lo validó al guardar: este contenido se congela en el
 * snapshot que lee el portal, y un JSON fuera de la allow-list ahí no se puede corregir después.
 */
function entryBody(e: HcPrintSourceEntry): HcDoc {
  if (e.bodyDoc !== null && e.bodyDoc !== undefined) {
    const v = validateHcDoc(e.bodyDoc);
    if (v.ok) return v.doc;
  }
  return plainTextToHcDoc(e.body);
}

/** Misma forma que el DTO de import (`kind`/`fileName`/`part`/`parts`); otra forma → sin marca (no un 500). */
function importedMark(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.fileName !== "string" || !o.fileName.trim()) return null;
  const part = typeof o.part === "number" ? o.part : 1;
  const parts = typeof o.parts === "number" ? o.parts : 1;
  return HC_PRINT_COPY.importedFrom(o.fileName.trim()) + (parts > 1 ? HC_PRINT_COPY.importedPart(part, parts) : "");
}

/**
 * Fuente → contenido imprimible. `signatureOwners` mapea cada `imageRef` opaco del contenido al practitioner dueño de
 * la firma: la del AUTOR de cada entrada, nunca la de quien descarga (FC-D26).
 *
 * - `shared` (lo que congela el documento del portal) excluye las enmiendas anuladas y las fichas anuladas; `download`
 *   (el equipo) las conserva con la marca y su motivo, porque la HC del equipo tiene que mostrar qué se anuló y por qué
 *   (Ley 26.529: lo anulado no desaparece del registro). El motivo va como texto en `marks.voided.reason` (C-FC4), sin
 *   la clave de la columna.
 * - Los `imageRef` son «s1», «s2»… por orden de aparición: el mismo source da el mismo contenido (determinista; el
 *   código de verificación es el sha256 de este JSON) y el ref no revela ningún id.
 * - Sin `new Date()`: la fecha de generación va en el meta, no en el contenido.
 */
export function buildHcPrintableContent(
  src: HcPrintSource,
  purpose: "shared" | "download",
): { content: HcPrintableContentV1; signatureOwners: Record<string, string> } {
  const signatureOwners: Record<string, string> = {};
  const refByOwner = new Map<string, string>();
  let usesIcd = false;

  const toEntry = (e: HcPrintSourceEntry): HcPrintableEntryV1 => {
    let imageRef: string | null = null;
    if (e.authorHasSignature && e.authorPractitionerId) {
      imageRef = refByOwner.get(e.authorPractitionerId) ?? null;
      if (!imageRef) {
        imageRef = `s${refByOwner.size + 1}`;
        refByOwner.set(e.authorPractitionerId, imageRef);
        signatureOwners[imageRef] = e.authorPractitionerId;
      }
    }
    const diagnoses = e.diagnoses.map((d, i) => {
      if (d.source === "icd11") usesIcd = true;
      return {
        code: d.code,
        title: d.title, // título oficial sin tocar (licencia OMS: nunca acortado)
        uri: d.uri,
        sourceLabel: HC_DIAGNOSIS_SOURCE_LABEL[d.source] ?? HC_DIAGNOSIS_SOURCE_LABEL.text,
        principal: i === 0,
      };
    });
    return {
      label: e.label,
      title: e.title,
      occurredAt: e.occurredAt.toISOString(),
      dateLabel: hcDateLabel(e.occurredAt),
      body: entryBody(e),
      diagnoses,
      signature: {
        line: formatSignatureLine({ honorific: e.authorHonorific, name: e.authorName, license: e.authorLicense }),
        imageRef,
      },
      marks: {
        lateEntry: e.lateEntry ? HC_PRINT_COPY.lateEntry : null,
        imported: importedMark(e.importSource),
        voided:
          purpose === "download" && e.voidedAt
            ? { at: e.voidedAt.toISOString(), reason: (e.voidReason ?? "").trim() }
            : null,
      },
      revisionLabel: e.revision > 1 ? HC_PRINT_COPY.revision(e.revision) : HC_PRINT_COPY.revisionOriginal,
    };
  };

  const fichas: HcPrintableContentV1["fichas"] = [];
  for (const { root, amendments } of src.entries) {
    if (purpose === "shared" && root.voidedAt) continue;
    const main = toEntry(root);
    const kept = amendments.filter((a) => purpose === "download" || !a.voidedAt).map(toEntry);
    fichas.push({ main, amendments: kept });
  }

  const fullName = [src.patient.firstName, src.patient.lastName].map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  const content: HcPrintableContentV1 = {
    letterhead: {
      tenantName: src.tenant.name,
      addressLine: src.tenant.addressLine,
      phone: src.tenant.phone,
      hasLogo: src.tenant.hasLogo,
    },
    patient: { fullName, documentId: src.patient.documentId, dateOfBirth: src.patient.dateOfBirth },
    fichas,
    icdAttribution: usesIcd ? HC_ICD_ATTRIBUTION : null,
  };
  return { content, signatureOwners };
}

/** Caracteres que Windows no acepta en un nombre de archivo (más los de control). */
// eslint-disable-next-line no-control-regex
const FILE_UNSAFE_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
const FILE_BASE_MAX = 120;

/**
 * Nombre base del archivo (sin extensión): «Gómez Juan 2026-10-10 Control [abc123]», o con «Historia clínica» en vez
 * de la fecha y el título cuando es la HC completa (`occurredAt: null`). Mismo esquema que la carpeta de respaldo
 * (`<AAAA-MM-DD> <título> [id6]`, §24.6), así el archivo descargado y el respaldado se reconocen como el mismo.
 *
 * Saneado para Windows (el respaldo escribe en el disco del consultorio): sin `<>:"/\|?*`, sin controles, sin punto ni
 * espacio al final, ≤120 caracteres (el título se recorta antes que el id: el id es lo que lo hace único). La fecha es
 * la del día en Argentina (`toARDateKey`), no la del host.
 */
export function hcFileBase(p: {
  lastName: string;
  firstName: string;
  occurredAt: Date | null;
  title: string | null;
  shortId: string;
}): string {
  const clean = (s: string | null | undefined) => (s ?? "").replace(FILE_UNSAFE_RE, " ").replace(/\s+/g, " ").trim();
  const who = clean(`${p.lastName} ${p.firstName}`);
  const id = clean(p.shortId);
  const tail = id ? ` [${id}]` : "";
  const what =
    p.occurredAt === null
      ? HC_PRINT_COPY.fullRecordFile
      : `${toARDateKey(p.occurredAt)} ${clean(p.title) || HC_PRINT_COPY.untitledFile}`;
  const head = Array.from([who, what].filter(Boolean).join(" "))
    .slice(0, Math.max(1, FILE_BASE_MAX - Array.from(tail).length))
    .join("");
  return `${head.replace(/[.\s]+$/u, "")}${tail}`.replace(/^[.\s]+/u, "") || HC_PRINT_COPY.untitledFile;
}
