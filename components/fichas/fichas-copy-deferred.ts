/**
 * [FC-3i1] Copy de la UI de fichas que solo leen chunks DIFERIDOS. Mismas reglas que `fichas-copy.ts` (literales de
 * §24.7 / Anexo B tal cual, cada bloque es de su sesión); se separa solo por el bundle.
 *
 * Por qué: webpack reparte por MÓDULO, no por export. `fichas-copy.ts` lo importa el first load de /pacientes/[id]
 * (inicio de la HC, composer, tarjeta) y un bloque que únicamente usa un chunk diferido viajaba igual, entero, en el
 * estático (tope de 175 kB, §24.9). Un bloque va acá si NINGÚN archivo estático lo lee; si alguno empieza a leerlo,
 * vuelve a `fichas-copy.ts` (si no, este archivo entero sube al first load).
 */

/** Importar Word (FC-3f). */
export const WORD_IMPORT_COPY = {
  title: "Importar fichas de Word",
  intro: "Elegí uno o más archivos .docx. Cada uno se carga como una ficha nueva con la fecha que indiques.",
  pick: "Elegir archivos",
  limits: "Hasta 50 archivos de 10 MB cada uno.",
  notDocx: "Ese archivo no es un Word .docx.",
  docWarning: "Los .doc (Word viejo) no se pueden leer: abrilo en Word y guardalo como .docx.",
  tooBig: "El archivo pesa más de 10 MB.",
  tooMany: "Podés importar hasta 50 archivos por vez.",
  dateFromName: "Fecha tomada del nombre del archivo",
  dateFromModified: "Fecha tomada de la última modificación del archivo",
  datesReviewed: "Revisé las fechas",
  /** «Dividir en N fichas» (literal de §24.7). */
  split: (n: number) => `Dividir en ${n} fichas`,
  imagesOmitted: (n: number) => `${n === 1 ? "Se omitió 1 imagen" : `Se omitieron ${n} imágenes`}: las fichas guardan solo texto.`,
  confirm: "Importar",
  importing: "Importando…",
  done: (n: number) => (n === 1 ? "Se importó 1 ficha" : `Se importaron ${n} fichas`),
  unavailable: "La importación desde Word todavía no está disponible.",
  close: "Cerrar",
} as const;
