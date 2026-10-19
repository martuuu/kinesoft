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
  privacy: "Los archivos se leen en tu navegador: solo se guarda el texto de cada ficha.",
  pick: "Elegir archivos",
  pickMore: "Agregar archivos",
  limits: "Hasta 50 archivos de 10 MB cada uno.",
  notDocx: "Ese archivo no es un Word .docx.",
  docWarning: "Los .doc (Word viejo) no se pueden leer: abrilo en Word y guardalo como .docx.",
  tooBig: "El archivo pesa más de 10 MB: partilo en Word en archivos más chicos.",
  tooMany: "Podés importar hasta 50 archivos por vez.",
  dropped: (n: number) =>
    n === 1 ? "Quedó afuera 1 archivo: podés importar hasta 50 por vez." : `Quedaron afuera ${n} archivos: podés importar hasta 50 por vez.`,
  reading: "Leyendo…",
  unreadable: "No pudimos leer este Word. Abrilo en Word, guardalo de nuevo como .docx y volvé a elegirlo.",
  empty: "El archivo no tiene texto para importar.",
  tooManyParts: "El archivo es demasiado largo: pasaría de 50 fichas. Partilo en Word en archivos más chicos.",
  dateLabel: "Fecha de la consulta",
  dateFromName: "Fecha tomada del nombre del archivo",
  dateFromModified: "Fecha tomada de la última modificación del archivo",
  dateMissing: "No encontramos una fecha en el archivo: elegila.",
  dateInvalid: "Elegí una fecha válida.",
  dateFuture: "La fecha no puede ser posterior a hoy.",
  datesReviewed: "Revisé las fechas",
  reviewHint: "Tildá «Revisé las fechas» para importar.",
  lateEntryHint: "Las fichas importadas quedan marcadas como «Carga tardía», con la fecha de la consulta que elijas.",
  chars: (n: number) => `${n.toLocaleString("es-AR")} caracteres`,
  /** «Dividir en N fichas» (literal de §24.7). */
  split: (n: number) => `Dividir en ${n} fichas`,
  splitHint: "Pasa de 20.000 caracteres: sin dividirlo no se puede importar.",
  imagesOmitted: (n: number) => `${n === 1 ? "Se omitió 1 imagen" : `Se omitieron ${n} imágenes`}: las fichas guardan solo texto.`,
  remove: "Quitar",
  removeLabel: (name: string) => `Quitar ${name}`,
  imported: "Importada",
  network: "No pudimos conectar. Probá de nuevo.",
  confirm: (n: number) => (n === 1 ? "Importar 1 ficha" : `Importar ${n} fichas`),
  confirmEmpty: "Importar",
  importing: (done: number, total: number) => `Importando… ${done} de ${total}`,
  done: (n: number) => (n === 1 ? "Se importó 1 ficha" : `Se importaron ${n} fichas`),
  someFailed: "Algunas no se importaron: revisá los archivos marcados y volvé a intentar.",
  dirty: "Hay archivos sin importar. ¿Cerrar igual?",
  close: "Cerrar",
} as const;
