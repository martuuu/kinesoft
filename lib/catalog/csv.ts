/**
 * Parser CSV RFC 4180 mínimo para los archivos del catálogo (`prisma/catalog/`,
 * contrato B1.1/B1.2): UTF-8, coma, header obligatorio, comillas dobles con
 * `""` como escape y saltos de línea dentro de comillas. Propio y sin
 * dependencias (regla del repo: nada de paquetes npm nuevos); `lib/csv.ts` es
 * el ESCRITOR del export de pacientes, no parsea.
 *
 * Lógica PURA (sin fs): recibe el texto y devuelve filas con su número de
 * línea física, para que los conflictos del import apunten a la línea exacta
 * del archivo.
 */

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`línea ${line}: ${message}`);
    this.name = "CsvParseError";
  }
}

export type CsvRecord = { line: number; cells: string[] };

/** Tokeniza el texto en registros. Ignora el BOM y los registros vacíos. */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false; // dentro de un campo entre comillas
  let wasQuoted = false; // el campo actual abrió con comillas
  let line = 1;
  let recordLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    // Una línea en blanco (un solo campo vacío sin comillas) no es un registro.
    if (!(cells.length === 1 && cells[0] === "")) out.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell !== "" || wasQuoted) {
        throw new CsvParseError("comilla en medio de un campo sin comillas", line);
      }
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\r" && src[i + 1] === "\n") {
      // CRLF: lo consume el "\n" siguiente.
    } else if (ch === "\n") {
      endRecord();
      line++;
      recordLine = line;
    } else {
      if (wasQuoted) throw new CsvParseError("texto después de cerrar comillas", line);
      cell += ch;
    }
  }
  if (quoted) throw new CsvParseError("comillas sin cerrar", recordLine);
  if (cell !== "" || cells.length > 0 || wasQuoted) endRecord();
  return out;
}

export type CsvTable = {
  header: string[];
  rows: { line: number; values: Record<string, string> }[];
  /** Filas cuyo número de columnas no coincide con el header (no se mapean). */
  malformed: { line: number; got: number; expected: number }[];
};

/** `parseCsv` + mapeo por header (los nombres de columna se trimean). */
export function parseCsvTable(text: string): CsvTable {
  const records = parseCsv(text);
  if (records.length === 0) return { header: [], rows: [], malformed: [] };
  const header = records[0].cells.map((h) => h.trim());
  const rows: CsvTable["rows"] = [];
  const malformed: CsvTable["malformed"] = [];
  for (const r of records.slice(1)) {
    if (r.cells.length !== header.length) {
      malformed.push({ line: r.line, got: r.cells.length, expected: header.length });
      continue;
    }
    const values: Record<string, string> = {};
    header.forEach((h, i) => (values[h] = r.cells[i]));
    rows.push({ line: r.line, values });
  }
  return { header, rows, malformed };
}
