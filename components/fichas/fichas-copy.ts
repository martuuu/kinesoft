/**
 * [FC-3k] Copy único de la UI de fichas (voseo rioplatense). Los literales de §24.7 / Anexo B del brief de T4 van
 * TAL CUAL (los busca el QA y el e2e por texto): «Guardar ficha», «Insertar estructura», «Sin formato», «Hacer
 * principal», «Compartida · desactualizada», etc. Lo que dicen las actions (rechazos) vive en `CLINICAL_NOTE_COPY`,
 * `DIAGNOSIS_COPY`, `HC_DOC_ERROR_COPY` y `HC_EXPORT_COPY`: acá no se repite.
 *
 * Por qué un solo archivo para nueve sesiones: el renombre «evolución» → «ficha» (FC-3h) dejó claro que el copy
 * repartido en cada componente diverge («Nueva ficha» en un lado, «Cargar ficha» en otro para lo mismo). Cada sesión
 * de T4d/T4e es dueña de SU bloque (indicado en el comentario); sumar una clave a otro bloque es un handoff.
 * `CLINICAL_NOTE_KIND_LABEL.EVOLUTION` sigue siendo «Evolución» (FC-UI-D1: es el tipo, no el sustantivo genérico).
 */

/** Inicio de la HC (FC-3e1). */
export const HC_HOME_COPY = {
  tabLabel: "Historia clínica",
  print: "Imprimir historia clínica",
  downloadRecord: "Descargar historia clínica completa (PDF)",
  moreActions: "Más acciones de la historia clínica",
  importWord: "Importar fichas de Word",
  backupFolder: "Carpeta de respaldo",
  composerBar: "Nueva ficha",
  loadMore: "Cargar más",
  empty: "Todavía no hay fichas de este paciente.",
  emptyHint: "Escribí la primera arriba o desde el turno en la agenda.",
  draftDot: "Hay una ficha sin guardar",
} as const;

/** Formulario único (FC-3c). */
export const FICHA_FORM_COPY = {
  newTitle: "Nueva ficha",
  editTitle: "Editar ficha",
  amendTitle: "Enmendar",
  patientPrefix: "Paciente:",
  kindLabel: "Tipo",
  titleLabel: "Título (opcional)",
  titlePlaceholder: "Ej.: Control de rodilla",
  bodyLabel: "Ficha",
  amendBodyLabel: "Enmienda",
  bodyPlaceholder: "Escribí la ficha…",
  occurredAtLabel: "Fecha y hora",
  bookingLabel: "Turno",
  noBooking: "Sin turno",
  changeBooking: "Cambiar turno",
  diagnosesLabel: "Diagnósticos",
  setActiveDiagnosis: "Usar como diagnóstico activo del paciente",
  setActiveDiagnosisHint: "Se actualiza el diagnóstico que se ve en el perfil.",
  save: "Guardar ficha",
  saveEdit: "Guardar cambios",
  saveAmend: "Guardar enmienda",
  amendHint: "La enmienda se agrega debajo de la ficha original, que queda como estaba.",
  amendCarriedHint: "Copiamos tu texto: dejá solo lo que agrega o corrige.",
  occurredAtRequired: "Elegí la fecha y la hora.",
  saveShortcut: "Ctrl o ⌘ + Enter",
  saving: "Guardando…",
  cancel: "Cancelar",
  discard: "Descartar",
  discardConfirm: "¿Descartás la ficha? Lo que escribiste se pierde.",
  dirtyMessage: "Tenés una ficha sin guardar. Si cerrás, se pierde.",
  beforeUnload: "Tenés una ficha sin guardar.",
  saved: "Ficha guardada",
  savedEdit: "Cambios guardados",
  savedAmend: "Enmienda guardada",
  amendInstead: "Enmendar",
  network: "No se pudo guardar. Revisá la conexión y probá de nuevo.",
} as const;

/** Editor (FC-3a). */
export const HC_EDITOR_COPY = {
  toolbarLabel: "Formato de la ficha",
  bold: "Negrita",
  italic: "Cursiva",
  underline: "Subrayado",
  heading: "Título",
  subheading: "Subtítulo",
  bulletList: "Lista con viñetas",
  orderedList: "Lista numerada",
  undo: "Deshacer",
  redo: "Rehacer",
  insertStructure: "Insertar estructura",
  insertStructureDone: "La ficha ya tiene todos los títulos.",
  plainMode: "Sin formato",
  plainModeHint: "Escribís en texto simple (útil con algunos teclados de Android).",
  loading: "Cargando el editor…",
  /** `{n}` / `{max}` con separador de miles es-AR. */
  counter: (n: number, max: number) => `${n.toLocaleString("es-AR")} / ${max.toLocaleString("es-AR")}`,
  charsLeft: (n: number) => `Te quedan ${n.toLocaleString("es-AR")} ${n === 1 ? "carácter" : "caracteres"}`,
} as const;

/** Diagnósticos (FC-3b). */
export const DIAGNOSIS_FIELD_COPY = {
  label: "Diagnósticos",
  principal: "Principal",
  makePrincipal: "Hacer principal",
  remove: "Quitar",
  favoriteOn: "Agregar a favoritos",
  favoriteOff: "Sacar de favoritos",
  add: "Agregar diagnóstico",
  searchPlaceholder: "Buscá por código o nombre",
  favorites: "Favoritos",
  recents: "Recientes",
  /** «Crear "{texto}" como diagnóstico propio» (literal de §24.7). */
  createOwn: (text: string) => `Crear "${text}" como diagnóstico propio`,
  asFreeText: (text: string) => `Usar "${text}" como texto libre`,
  noResults: "No encontramos diagnósticos con ese texto.",
  retiredChip: "Código no vigente",
  max: "Podés cargar hasta 5 diagnósticos.",
  searching: "Buscando…",
  hint: "Escribí al menos 2 letras o un código.",
  creating: "Creando…",
  favoriteFailed: "No pudimos guardar el favorito. Probá de nuevo.",
} as const;

/** Tarjeta y menú (FC-3e2). */
export const FICHA_CARD_COPY = {
  imported: "Importada",
  lateEntry: "Carga tardía",
  shared: "Compartida",
  sharedStale: "Compartida · desactualizada",
  showMore: "Ver todo",
  showLess: "Ver menos",
  menuLabel: "Acciones de la ficha",
  pdf: "PDF",
  word: "Word",
  saveToFolder: "Guardar en la carpeta",
  share: "Compartir con el paciente",
  shareCurrent: "Compartir la versión actual",
  unshare: "Dejar de compartir",
  amend: "Enmendar",
  versions: "Versiones",
  void: "Anular",
  downloading: "Preparando el archivo…",
  // 503 vacío = el audit de la descarga falló y la ruta no mandó nada a propósito (C-FC7: sin audit no hay bytes).
  downloadUnavailable: "No pudimos registrar la descarga, así que no se hizo. Probá de nuevo en un rato.",
  downloadSession: "Tu sesión se cerró. Volvé a entrar para descargar.",
  downloadNetwork: "No pudimos descargar el archivo. Revisá la conexión y probá de nuevo.",
  importedFrom: (fileName: string) => `Importada de «${fileName}»`,
  sharedOn: (when: string) => `Compartida con el paciente el ${when}`,
  sharedStaleHint: "La ficha cambió después de compartirla: el paciente ve la versión anterior.",
  lateEntryHint: "Cargada más de 24 h después de la atención.",
  unshareFailed: "No pudimos dejar de compartir la ficha. Probá de nuevo.",
} as const;

/** Compartir (FC-3e2, `ShareFichaDialog`). */
export const SHARE_FICHA_COPY = {
  title: "Compartir con el paciente",
  body: "El paciente va a ver esta ficha en su portal, en «Documentos», como PDF.",
  notify: "Avisarle por mail",
  confirm: "Compartir",
  reshareBody: "La ficha cambió desde que la compartiste. Se reemplaza el documento del portal por la versión actual.",
  reshareConfirm: "Compartir la versión actual",
  noPortal: "El paciente todavía no tiene cuenta en el portal.",
  invite: "Invitar al portal y compartir",
  noEmail: "El paciente no tiene email cargado: agregalo en sus datos para invitarlo al portal.",
  shared: "Ficha compartida",
  unshareConfirm: "¿Dejás de compartir la ficha? El paciente deja de verla en el portal.",
  unshared: "La ficha ya no se comparte",
  sharing: "Compartiendo…",
  shareNetwork: "No pudimos compartir la ficha. Revisá la conexión y probá de nuevo.",
  inviting: "Invitando…",
  invited: "Le mandamos la invitación al portal. Cuando entre, va a ver la ficha en «Documentos».",
  inviteFailed: "No pudimos mandar la invitación. Probá de nuevo en un rato.",
  close: "Cerrar",
  cancel: "Cancelar",
} as const;

/**
 * Importar Word (FC-3f): `WORD_IMPORT_COPY` vive en `fichas-copy-deferred.ts` (FC-3i1). Solo lo lee el drawer diferido
 * y webpack reparte por módulo: acá viajaba en el first load de /pacientes/[id] (§24.9).
 */

/** Carpeta de respaldo (FC-3g). */
export const BACKUP_COPY = {
  title: "Carpeta de respaldo",
  intro:
    "Cada ficha que guardes se copia como PDF en una carpeta de esta computadora. Si la editás, enmendás o anulás desde acá, el archivo se reemplaza.",
  soloUser: "Esta computadora la uso solo yo",
  soloUserHint: "Los PDF tienen datos de salud: no elijas una carpeta compartida.",
  choose: "Elegir carpeta",
  change: "Cambiar carpeta",
  forget: "Dejar de usar la carpeta",
  ready: (folder: string) => `Guardando en «${folder}»`,
  needsPermission: "El navegador pide permiso de nuevo: se te va a preguntar al guardar.",
  unsupported:
    "Este navegador no permite elegir una carpeta. Usá Chrome o Edge en una computadora; mientras tanto, el PDF se descarga.",
  savedToFolder: (path: string) => `Guardada en ${path}`,
  downloaded: "Se descargó el PDF",
  failed: "No pudimos guardar el PDF. Probá de nuevo.",
} as const;

/** Configuración (FC-3i). */
export const FICHAS_SETTINGS_COPY = {
  tab: "Mis fichas",
  visibilityQuestion: "¿Quién ve la historia clínica de cada paciente?",
  logo: "Logo del consultorio",
  honorific: "Cómo firmás",
  license: "Matrícula",
  signature: "Firma",
  ownDiagnoses: "Diagnósticos propios",
} as const;
