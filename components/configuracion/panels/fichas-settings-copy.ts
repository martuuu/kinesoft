/**
 * [FC-3i] Copy de la pestaña «Mis fichas» (FC-UI-D3) y del logo de General (que se dibuja desde el chunk de «Mis
 * fichas»). El del radio «¿Quién ve la historia clínica…?» está en `fichas-settings-logic.ts` (`HC_VISIBILITY_COPY`):
 * General no tiene que bajar este archivo, y compartirlo con «Mis fichas» armaba un chunk compartido más.
 *
 * Vive acá y no en `components/fichas/fichas-copy.ts` (donde FC-3k le reservó el bloque) porque ese archivo viaja en el
 * first load de /pacientes/[id] y webpack no saca el bloque que la ruta no usa (medido: ~1,3 kB gz de más). Acá solo
 * lo bajan los chunks diferidos de /configuracion. Mismo motivo que `WORD_IMPORT_COPY` (FC-3i1).
 */
export const FICHAS_SETTINGS_COPY = {
  tab: "Mis fichas",
  logo: "Logo del consultorio",
  logoHint: "Sale en el membrete de las fichas en PDF y en Word.",
  honorific: "Cómo firmás",
  honorificNone: "Sin título",
  /** Label del select: el eyebrow de la Card ya dice «Cómo firmás» y repetirlo no decía qué se elige. */
  honorificLabel: "Título",
  license: "Matrícula",
  licenseHint: "Como la querés ver impresa, por ejemplo «MN 12345» o «MP 4567 (Córdoba)».",
  signatureIntro:
    "Lo que cargues acá sale debajo de cada ficha tuya en el PDF. Es personal: nadie más del consultorio lo puede cambiar.",
  saveInfo: "Guardar",
  savedInfo: "Guardado.",
  signature: "Firma",
  signatureHint: "Tu firma escaneada sale al pie de cada ficha que escribiste.",
  upload: "Subir imagen",
  replace: "Cambiar imagen",
  remove: "Quitar",
  uploading: "Subiendo…",
  removing: "Quitando…",
  noImage: "Todavía no cargaste ninguna imagen.",
  previewAlt: (what: string) => `Vista previa: ${what}`,
  previewUnavailable: "No pudimos mostrar la vista previa.",
  previewLoading: "Cargando vista previa…",
  uploaded: "Imagen guardada.",
  removed: "Imagen quitada.",
  removeLogoTitle: "¿Quitar el logo del consultorio?",
  removeLogoMessage: "Las fichas que se impriman desde ahora salen sin logo. Las que ya se compartieron no cambian.",
  removeSignatureTitle: "¿Quitar tu firma?",
  removeSignatureMessage: "Las fichas que se impriman desde ahora salen sin tu firma escaneada.",
  network: "No pudimos guardar. Revisá la conexión y probá de nuevo.",
  ownDiagnoses: "Diagnósticos propios",
  ownDiagnosesHint:
    "Los que se crearon en el consultorio desde una ficha. Renombrarlos o archivarlos no cambia las fichas que ya los usan.",
  ownDiagnosesEmpty: "Todavía no hay diagnósticos propios. Se crean desde una ficha, con «Crear como diagnóstico propio».",
  ownDiagnosesLoading: "Cargando diagnósticos…",
  ownDiagnosesFailed: "No pudimos cargar los diagnósticos. Probá de nuevo.",
  createdByMe: "Lo creaste vos",
  archived: "Archivado",
  archivedCount: (n: number) => (n === 1 ? "1 archivado" : `${n} archivados`),
  rename: "Renombrar",
  renameTitle: "Renombrar diagnóstico",
  diagnosisTitle: "Nombre",
  diagnosisCode: "Código (opcional)",
  saveRename: "Guardar cambios",
  saving: "Guardando…",
  cancel: "Cancelar",
  archive: "Archivar",
  archiveTitle: (title: string) => `¿Archivar «${title}»?`,
  archiveMessage: "Deja de aparecer al buscar diagnósticos. Las fichas que ya lo usan lo conservan como estaba.",
  archivedDone: "Diagnóstico archivado.",
  renamedDone: "Diagnóstico renombrado.",
  dirty: "Tenés cambios sin guardar en el diagnóstico. Si cerrás, se pierden.",
  discardTitle: "¿Descartar los cambios sin guardar?",
  discard: "Descartar",
  keepEditing: "Seguir editando",
  dirtyTab: "Tenés cambios sin guardar en «Mis fichas». Si cambiás de pestaña, se pierden.",
} as const;
