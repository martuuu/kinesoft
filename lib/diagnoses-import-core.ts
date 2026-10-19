/**
 * Núcleo PURO del importador CIE-11 MMS en español (FC-1d, C-FC11): bytes de la
 * «SimpleTabulation» de la OMS → filas → plan contra lo que ya hay en
 * `DiagnosisCode` (crear / actualizar / retirar / reactivar / sin cambios /
 * conflictos). Sin DB ni fs: el escritor (`scripts/diagnosis-import.ts`) lee el
 * archivo y el estado, llama a `planIcdImport` y aplica el plan en UNA tx.
 *
 * Licencia (CC BY-ND 3.0 IGO, PDF de licencia ICD-11 §1.2.1-1.2.5; brief §24.2
 * hallazgo 1): incorporar la CIE-11 a un software no es adaptación mientras se
 * conserven los códigos; se guarda y se transmite **código + título + URI** y el
 * título NO se modifica. Por eso:
 *  - al título solo se le saca la sangría de profundidad de la tabulación
 *    (`^(?:-\s*)+`, que es formato del archivo, no del título). Nada de trim de
 *    otra cosa, ni acortar, ni «corregir» mayúsculas;
 *  - la URI de la linealización es obligatoria (sin URI la fila es conflicto);
 *  - `searchText` es NUESTRO (campo agregado, «no OMS»): se deriva del código y
 *    del título, nunca se muestra como si fuera de la OMS;
 *  - nunca se borra una fila: lo que deja de venir se RETIRA (`retiredAt` +
 *    `retiredInRelease`). Las fichas guardan un snapshot, pero los favoritos
 *    apuntan por FK (ON DELETE RESTRICT) y un retirado tiene que poder volver.
 *
 * Capítulos (FC-D30): 01-26 y V (funcionamiento). Afuera el X (códigos de
 * extensión: no son diagnósticos por sí solos y su código no cumple el CHECK).
 */

// ─── Constantes del contrato ─────────────────────────────────────────────────

/** Mismos patrones que los CHECK de M14 (`DiagnosisCode_*_check`): lo que no pase acá, la base lo rechazaría. */
export const ICD_CODE_RE = /^[0-9A-Z]{4}(\.[0-9A-Z]{1,3})?$/;
export const ICD_URI_RE = /^https?:\/\/id\.who\.int\/icd\//;
export const ICD_RELEASE_RE = /^[0-9]{4}-[0-9]{2}$/;
export const ICD_TITLE_MAX = 500;
export const ICD_URI_MAX = 300;
export const ICD_SEARCH_TEXT_MAX = 1200;

/** FC-D30. */
export const DEFAULT_ICD_CHAPTERS = "01-26,V";

/** `CatalogImportRun.kind` (C-FC11). */
export const icdImportKind = (release: string) => `icd11-mms-es@${release}`;

/** Encabezados obligatorios, por nombre (el orden de columnas de la OMS cambió entre releases). */
export const ICD_REQUIRED_HEADERS = ["Code", "Title", "ClassKind"] as const;
/** La columna de la URI cambió de nombre entre releases: vale cualquiera de las dos. */
export const ICD_URI_HEADERS = ["Linearization (release) URI", "Linearization URI"] as const;
export const ICD_OPTIONAL_HEADERS = ["Foundation URI", "ChapterNo", "isLeaf", "IsResidual"] as const;

export class IcdImportError extends Error {
  constructor(message: string) {
    super(`[diagnosis-import] ${message}`);
    this.name = "IcdImportError";
  }
}

// ─── Bytes → texto ───────────────────────────────────────────────────────────

export type TabulationEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";

/**
 * La OMS publica la tabulación como .xlsx; exportada desde Excel como «Texto
 * Unicode» sale en UTF-16LE con BOM, y desde otras herramientas en UTF-8 (con o
 * sin BOM). Se detecta por BOM; sin BOM, si hay bytes nulos en posiciones
 * alternas es UTF-16 sin BOM (pasa con algunos exportadores), si no UTF-8.
 * `fatal: true`: un archivo que no decodifica limpio aborta en vez de guardar
 * títulos con «�» (sería modificar el título oficial).
 */
export function decodeTabulationBytes(bytes: Uint8Array): { text: string; encoding: TabulationEncoding } {
  const decode = (label: string, b: Uint8Array) => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b);
    } catch {
      throw new IcdImportError(`el archivo no es ${label} válido (¿se exportó como «Texto Unicode» o TSV UTF-8?)`);
    }
  };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode("utf-8", bytes.subarray(3)), encoding: "utf-8-bom" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode("utf-16le", bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode("utf-16be", bytes.subarray(2)), encoding: "utf-16be" };
  }
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) {
    return { text: decode("utf-16le", bytes), encoding: "utf-16le" };
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0 && bytes[1] !== 0) {
    return { text: decode("utf-16be", bytes), encoding: "utf-16be" };
  }
  return { text: decode("utf-8", bytes), encoding: "utf-8" };
}

// ─── Texto → filas ───────────────────────────────────────────────────────────

/**
 * TSV con las comillas de Excel: un campo que arranca con `"` va hasta la
 * comilla de cierre (puede tener tabs o saltos de línea) y `""` es una comilla.
 * Devuelve cada registro con la línea física donde empieza (para los reportes).
 */
function splitTsv(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let atCellStart = true;
  let line = 1;
  let recordLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = "";
    atCellStart = true;
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === "")) out.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
    } else if (ch === "\t") endCell();
    else if (ch === "\r" && text[i + 1] === "\n") {
      // CRLF: se procesa en el \n
    } else if (ch === "\n" || ch === "\r") {
      line++;
      endRecord();
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  if (inQuotes) throw new IcdImportError(`comilla sin cerrar en el registro de la línea ${recordLine}`);
  if (cell !== "" || cells.length > 0) endRecord();
  return out;
}

/** Solo la sangría de profundidad («- - Título» → «Título»). El resto del título queda como vino. */
export function stripTabulationDepth(title: string): string {
  return title.replace(/^(?:-\s*)+/, "");
}

/** «1» → «01», «V» → «V». `null` si viene vacío. */
export function normalizeChapter(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "") return null;
  return /^\d{1,2}$/.test(v) ? v.padStart(2, "0") : v;
}

/** «01-26,V» → ["01", …, "26", "V"]. */
export function parseChapterSpec(spec: string): string[] {
  const out = new Set<string>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b > 26 || a > b) throw new IcdImportError(`rango de capítulos inválido «${part}» (01-26)`);
      for (let n = a; n <= b; n++) out.add(String(n).padStart(2, "0"));
      continue;
    }
    const ch = normalizeChapter(part);
    if (!ch || !(/^\d{2}$/.test(ch) ? Number(ch) >= 1 && Number(ch) <= 26 : ch === "V" || ch === "X")) {
      throw new IcdImportError(`capítulo inválido «${part}» (01-26, V o X)`);
    }
    out.add(ch);
  }
  if (out.size === 0) throw new IcdImportError("--chapters vacío");
  return [...out];
}

export type IcdTabulationRow = {
  /** Línea física del archivo (1 = encabezados). */
  line: number;
  code: string;
  /** Título tal como vino, con la sangría. */
  rawTitle: string;
  /** Título oficial sin la sangría. */
  title: string;
  classKind: string;
  uri: string;
  foundationUri: string | null;
  chapter: string | null;
  /** Texto crudo de las columnas booleanas (`null` si la columna no existe). */
  isLeafRaw: string | null;
  isResidualRaw: string | null;
};

export type ParsedTabulation = {
  headers: string[];
  uriHeader: string;
  rows: IcdTabulationRow[];
};

function findHeader(headers: string[], name: string): number {
  // Por nombre y sin distinguir mayúsculas: la OMS alterna `isLeaf`/`IsLeaf` entre releases.
  const n = name.toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === n);
}

/**
 * Encabezados por nombre (C-FC11). Falta un obligatorio → aborta: adivinar
 * columnas sobre un archivo de 17k filas es la forma de cargar títulos en la
 * columna de la URI.
 */
export function parseIcdTabulation(text: string): ParsedTabulation {
  const records = splitTsv(text.startsWith("﻿") ? text.slice(1) : text);
  if (records.length === 0) throw new IcdImportError("el archivo está vacío");
  const headers = records[0].cells.map((h) => h.trim());
  const missing: string[] = ICD_REQUIRED_HEADERS.filter((h) => findHeader(headers, h) < 0);
  const uriIdx = ICD_URI_HEADERS.map((h) => findHeader(headers, h)).find((i) => i >= 0) ?? -1;
  if (uriIdx < 0) missing.push(ICD_URI_HEADERS.join(" | "));
  if (missing.length > 0) {
    throw new IcdImportError(
      `faltan encabezados obligatorios: ${missing.join(", ")}. Encabezados del archivo: ${headers.join(" · ") || "(ninguno)"}`,
    );
  }
  const idx = {
    code: findHeader(headers, "Code"),
    title: findHeader(headers, "Title"),
    classKind: findHeader(headers, "ClassKind"),
    foundation: findHeader(headers, "Foundation URI"),
    chapter: findHeader(headers, "ChapterNo"),
    isLeaf: findHeader(headers, "isLeaf"),
    isResidual: findHeader(headers, "IsResidual"),
  };
  const at = (cells: string[], i: number) => (i < 0 ? null : (cells[i] ?? ""));
  const rows: IcdTabulationRow[] = records.slice(1).map(({ line, cells }) => {
    const rawTitle = at(cells, idx.title) ?? "";
    const foundation = (at(cells, idx.foundation) ?? "").trim();
    return {
      line,
      code: (at(cells, idx.code) ?? "").trim(),
      rawTitle,
      title: stripTabulationDepth(rawTitle),
      classKind: (at(cells, idx.classKind) ?? "").trim().toLowerCase(),
      uri: (at(cells, uriIdx) ?? "").trim(),
      foundationUri: foundation === "" ? null : foundation,
      chapter: normalizeChapter(at(cells, idx.chapter)),
      isLeafRaw: at(cells, idx.isLeaf),
      isResidualRaw: at(cells, idx.isResidual),
    };
  });
  return { headers, uriHeader: headers[uriIdx], rows };
}

/** Para `--inspect`: encoding, encabezados y las primeras filas, sin planificar nada. */
export function inspectTabulation(bytes: Uint8Array, sample = 5) {
  const { text, encoding } = decodeTabulationBytes(bytes);
  const parsed = parseIcdTabulation(text);
  const categories = parsed.rows.filter((r) => r.classKind === "category" && r.code !== "");
  return {
    encoding,
    headers: parsed.headers,
    uriHeader: parsed.uriHeader,
    totalRows: parsed.rows.length,
    categoryRows: categories.length,
    sample: parsed.rows.slice(0, sample),
  };
}

// ─── searchText (NUESTRO, no OMS) ───────────────────────────────────────────

/**
 * Misma regla que `normalizeDiagnosisText` de C-FC2 (NFD, sin tildes,
 * minúsculas, `[^a-z0-9]` → espacio), más colapsar espacios. Tiene que dar lo
 * mismo que la normalización de la consulta del buscador, o «cuadriceps» no
 * encuentra «cuádriceps». Lleva el código para que «9z10 0» y «fa20» busquen.
 */
export function normalizeIcdSearchText(code: string, title: string): string {
  return `${code} ${title}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, ICD_SEARCH_TEXT_MAX)
    .trim();
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/** Lo que el escritor lee de `DiagnosisCode` (system = ICD11_MMS). */
export type ExistingDiagnosisCode = {
  id: string;
  code: string;
  title: string;
  uri: string;
  foundationUri: string | null;
  chapter: string | null;
  isLeaf: boolean;
  isResidual: boolean;
  release: string;
  searchText: string;
  retiredAt: Date | null;
  retiredInRelease: string | null;
};

/** Valores finales de una fila vigente (lo que se escribe al crear, actualizar o reactivar). */
export type IcdTarget = {
  code: string;
  title: string;
  uri: string;
  foundationUri: string | null;
  chapter: string | null;
  isLeaf: boolean;
  isResidual: boolean;
  release: string;
  searchText: string;
};

export const ICD_COMPARED_FIELDS = [
  "title",
  "uri",
  "foundationUri",
  "chapter",
  "isLeaf",
  "isResidual",
  "release",
  "searchText",
] as const satisfies readonly (keyof IcdTarget)[];
export type IcdComparedField = (typeof ICD_COMPARED_FIELDS)[number];

export type IcdUpdate = { id: string; code: string; target: IcdTarget; changedFields: IcdComparedField[] };
export type IcdRetire = { id: string; code: string; title: string };

export type IcdConflictReason =
  | "codigo-invalido"
  | "titulo-invalido"
  | "uri-invalida"
  | "booleano-invalido"
  | "codigo-duplicado";
export type IcdConflict = { line: number; code: string; reason: IcdConflictReason; detail: string };

export type IcdImportPlan = {
  release: string;
  chapters: string[];
  create: IcdTarget[];
  update: IcdUpdate[];
  retire: IcdRetire[];
  /** Retiradas que vuelven a venir: se limpian `retiredAt`/`retiredInRelease` (y los campos que cambiaron). */
  unretire: IcdUpdate[];
  unchanged: number;
  /** Filas que no son categorías con código, o de capítulos fuera de `chapters` (X incluido). */
  excluded: number;
  conflicts: IcdConflict[];
  retiredAt: Date;
};

const TRUE_RE = /^(true|verdadero|1|yes|si|sí)$/i;
const FALSE_RE = /^(false|falso|0|no)?$/i;
function parseBool(raw: string | null, fallback: boolean): boolean | "invalid" {
  if (raw === null) return fallback;
  const v = raw.trim();
  if (TRUE_RE.test(v)) return true;
  if (FALSE_RE.test(v)) return v === "" ? fallback : false;
  return "invalid";
}

export type PlanIcdOptions = {
  release: string;
  /** Capítulos que entran (ver `parseChapterSpec`). */
  chapters: readonly string[];
  /** Marca de `retiredAt` para lo que se retira en esta corrida. */
  now: Date;
  /** Un release más viejo que el de la base se rechaza salvo esto (volver atrás un import equivocado). */
  allowDowngrade?: boolean;
};

/** Fila en alcance de esta corrida: categoría con código y de un capítulo elegido. */
function inScope(chapter: string | null, code: string, chapters: ReadonlySet<string>): boolean {
  // Sin ChapterNo no se puede filtrar por capítulo; las extensiones igual se
  // reconocen porque su código empieza con X (y no cumplirían el CHECK).
  if (chapter === null) return !(code.startsWith("X") && !chapters.has("X"));
  return chapters.has(chapter);
}

export function planIcdImport(
  rows: readonly IcdTabulationRow[],
  existing: readonly ExistingDiagnosisCode[],
  opts: PlanIcdOptions,
): IcdImportPlan {
  const { release } = opts;
  if (!ICD_RELEASE_RE.test(release)) throw new IcdImportError(`--release inválido «${release}» (AAAA-MM, p. ej. 2025-01)`);
  const chapters = new Set(opts.chapters);

  // Downgrade: un archivo viejo retiraría los códigos nuevos y pisaría títulos vigentes.
  const newest = existing.reduce<string | null>((m, e) => (m === null || e.release > m ? e.release : m), null);
  if (newest !== null && release < newest && !opts.allowDowngrade) {
    throw new IcdImportError(
      `la base ya tiene la release ${newest} y el archivo es ${release}: downgrade rechazado (si es a propósito: --allow-downgrade)`,
    );
  }

  const byCode = new Map(existing.map((e) => [e.code, e]));
  const plan: IcdImportPlan = {
    release,
    chapters: [...chapters],
    create: [],
    update: [],
    retire: [],
    unretire: [],
    unchanged: 0,
    excluded: 0,
    conflicts: [],
    retiredAt: opts.now,
  };
  // Códigos que el archivo trae (válidos o en conflicto): ninguno se retira. Una
  // fila rota no es «el código dejó de existir».
  const seen = new Set<string>();
  const accepted = new Set<string>();

  for (const r of rows) {
    if (r.classKind !== "category" || r.code === "" || !inScope(r.chapter, r.code, chapters)) {
      plan.excluded++;
      continue;
    }
    seen.add(r.code);
    const conflict = (reason: IcdConflictReason, detail: string) =>
      plan.conflicts.push({ line: r.line, code: r.code, reason, detail });
    if (!ICD_CODE_RE.test(r.code)) {
      conflict("codigo-invalido", `«${r.code}» no es un código CIE-11 MMS`);
      continue;
    }
    if (accepted.has(r.code)) {
      conflict("codigo-duplicado", "el código ya vino en una línea anterior; se queda la primera");
      continue;
    }
    const titleLen = r.title.trim().length;
    if (titleLen < 1 || titleLen > ICD_TITLE_MAX) {
      conflict("titulo-invalido", `título vacío o de más de ${ICD_TITLE_MAX} caracteres (no se acorta: licencia)`);
      continue;
    }
    if (!ICD_URI_RE.test(r.uri) || r.uri.length > ICD_URI_MAX) {
      conflict("uri-invalida", `«${r.uri || "(vacía)"}» no es una URI de id.who.int/icd/`);
      continue;
    }
    // La URI de linealización trae la release: si no coincide con --release, el
    // archivo no es el que se dice (se cargaría una release con la etiqueta de otra).
    const uriRelease = r.uri.match(/\/release\/11\/(\d{4}-\d{2})\//)?.[1];
    if (uriRelease && uriRelease !== release) {
      throw new IcdImportError(`la línea ${r.line} es de la release ${uriRelease} y --release dice ${release}: abortado`);
    }
    const isLeaf = parseBool(r.isLeafRaw, true);
    const isResidual = parseBool(r.isResidualRaw, false);
    if (isLeaf === "invalid" || isResidual === "invalid") {
      conflict("booleano-invalido", `isLeaf «${r.isLeafRaw}» / IsResidual «${r.isResidualRaw}»`);
      continue;
    }
    accepted.add(r.code);

    const target: IcdTarget = {
      code: r.code,
      title: r.title,
      uri: r.uri,
      foundationUri: r.foundationUri,
      chapter: r.chapter,
      isLeaf,
      isResidual,
      release,
      searchText: normalizeIcdSearchText(r.code, r.title),
    };
    const prev = byCode.get(r.code);
    if (!prev) {
      plan.create.push(target);
      continue;
    }
    const changedFields = ICD_COMPARED_FIELDS.filter((f) => prev[f] !== target[f]);
    if (prev.retiredAt !== null) plan.unretire.push({ id: prev.id, code: r.code, target, changedFields });
    else if (changedFields.length > 0) plan.update.push({ id: prev.id, code: r.code, target, changedFields });
    else plan.unchanged++;
  }

  for (const e of existing) {
    if (e.retiredAt !== null || seen.has(e.code)) continue;
    // Un import parcial (--chapters=15) no retira lo de los otros capítulos.
    if (!inScope(e.chapter, e.code, chapters)) continue;
    plan.retire.push({ id: e.id, code: e.code, title: e.title });
  }
  return plan;
}

/**
 * T4Z-B4 · Freno de retiro masivo. El import retira todo lo vigente del alcance que no viene en el archivo: un archivo
 * truncado (Excel que cortó la exportación, una hoja equivocada, `--chapters` mal escrito) retiraba miles de códigos de
 * un saque y el buscador de diagnósticos de todos los consultorios quedaba vacío. Entre releases de la OMS el recambio
 * real es chico. Límite = máx(25, 5 % de los vigentes del alcance): el piso de 25 deja pasar las bases chicas (los
 * fixtures, un capítulo suelto) donde un solo retiro ya es más del 5 %. Pasarse aborta salvo `--allow-mass-retire`.
 */
export const ICD_MASS_RETIRE_RATIO = 0.05;
export const ICD_MASS_RETIRE_FLOOR = 25;

export function icdMassRetireCheck(
  p: Pick<IcdImportPlan, "chapters" | "retire">,
  existing: readonly ExistingDiagnosisCode[],
): { activeInScope: number; retire: number; limit: number; exceeded: boolean } {
  const chapters = new Set(p.chapters);
  const activeInScope = existing.filter((e) => e.retiredAt === null && inScope(e.chapter, e.code, chapters)).length;
  const limit = Math.max(ICD_MASS_RETIRE_FLOOR, Math.floor(activeInScope * ICD_MASS_RETIRE_RATIO));
  return { activeInScope, retire: p.retire.length, limit, exceeded: p.retire.length > limit };
}

export function assertIcdRetireWithinLimit(
  p: Pick<IcdImportPlan, "chapters" | "retire">,
  existing: readonly ExistingDiagnosisCode[],
  opts: { allowMassRetire?: boolean },
): void {
  const c = icdMassRetireCheck(p, existing);
  if (c.exceeded && !opts.allowMassRetire) {
    throw new IcdImportError(
      `el import retiraría ${c.retire} de ${c.activeInScope} códigos vigentes (tope ${c.limit}): ¿el archivo está completo? Si es a propósito: --allow-mass-retire`,
    );
  }
}

export function icdPlanHasChanges(p: IcdImportPlan): boolean {
  return p.create.length + p.update.length + p.retire.length + p.unretire.length > 0;
}

export function summarizeIcdPlan(p: IcdImportPlan) {
  return {
    create: p.create.length,
    update: p.update.length,
    retire: p.retire.length,
    unretire: p.unretire.length,
    unchanged: p.unchanged,
    excluded: p.excluded,
    conflicts: p.conflicts.length,
  };
}
