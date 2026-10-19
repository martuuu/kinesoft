/**
 * [FC-3e2] Lógica pura de la tarjeta de ficha (`components/clinical-notes/note-card.tsx`), su menú «⋯»
 * (`ficha-menu.tsx`), las descargas (`download.ts`) y `ShareFichaDialog`. Sin React ni DOM: la prueba
 * `tests/unit/ficha-card-logic.test.ts` en TZ=UTC. La barrera real son siempre las actions y las rutas (C-FC6/C-FC7):
 * acá solo se decide qué se OFRECE y cómo se dice.
 *
 * Por qué aparte del componente: la tarjeta es estática en el first load de `/pacientes/[id]` (§24.9) y el menú es
 * diferido; las dos necesitan la misma regla de «qué ítems hay» (la tarjeta, para saber si pinta el «⋯»; el panel,
 * para listarlos). Si cada uno la calculara, divergirían.
 */
import { CLINICAL_NOTE_COPY, CLINICAL_NOTE_KIND_LABEL, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { DIAGNOSIS_SOURCE_LABEL, ICD11_SHORT_ATTRIBUTION } from "@/lib/diagnoses-types";
import { HC_EXPORT_COPY, type HcFichaFormat } from "@/lib/hc-export-logic";
import { PATIENT_DOCUMENT_COPY, type DocumentDeliveryOutcome } from "@/lib/patient-documents-types";
import type { FichaBackupStatus, FichaBackupTarget, UseFichaBackupResult } from "@/components/fichas/fichas-ui-types";
import { FICHA_CARD_COPY, SHARE_FICHA_COPY } from "@/components/fichas/fichas-copy";
import { CLINICAL_NOTES_UI_COPY, noteActions, shortDateTime } from "@/components/clinical-notes/clinical-notes-ui";

/**
 * Copy que FALTA en `FICHA_CARD_COPY` / `SHARE_FICHA_COPY` (fichas-copy.ts es compartido y lo edita solo el
 * integrador). Handoff a FC-3i1: mover estas claves a esos bloques y borrar este objeto; los consumidores ya leen
 * `CARD_COPY`/`SHARE_COPY` de abajo, así que el cambio es de un solo archivo.
 */
export const FICHA_CARD_COPY_PENDING = {
  /** FICHA_CARD_COPY */
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
  /** SHARE_FICHA_COPY */
  sharing: "Compartiendo…",
  shareNetwork: "No pudimos compartir la ficha. Revisá la conexión y probá de nuevo.",
  inviting: "Invitando…",
  invited: "Le mandamos la invitación al portal. Cuando entre, va a ver la ficha en «Documentos».",
  inviteFailed: "No pudimos mandar la invitación. Probá de nuevo en un rato.",
  close: "Cerrar",
  cancel: "Cancelar",
} as const;

export const CARD_COPY = { ...FICHA_CARD_COPY, ...pick(FICHA_CARD_COPY_PENDING, [
  "downloading", "downloadUnavailable", "downloadSession", "downloadNetwork", "importedFrom", "sharedOn",
  "sharedStaleHint", "lateEntryHint", "unshareFailed",
] as const) };
export const SHARE_COPY = { ...SHARE_FICHA_COPY, ...pick(FICHA_CARD_COPY_PENDING, [
  "sharing", "shareNetwork", "inviting", "invited", "inviteFailed", "close", "cancel",
] as const) };

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
}

// ─── Raíz, URL y nombres ────────────────────────────────────────────────────────────────────────────────────────

/** La ruta de descarga y el respaldo van SIEMPRE por la raíz (una enmienda da 404, handoff de FC-2g). */
export function fichaRootId(note: Pick<ClinicalNoteDTO, "id" | "amendsNoteId">): string {
  return note.amendsNoteId ?? note.id;
}

/** `/api/pacientes/{id}/fichas/{rootId}/{pdf|docx}` (C-FC7). Mismo armado que `fichaPdfUrl` de use-ficha-backup. */
export function fichaDownloadUrl(patientId: string, rootId: string, format: HcFichaFormat): string {
  return `/api/pacientes/${encodeURIComponent(patientId)}/fichas/${encodeURIComponent(rootId)}/${format}`;
}

/** Lo que el respaldo necesita de la ficha raíz (la ruta del archivo la arma FC-3g con `backupPathFor`). */
export function fichaBackupTarget(
  root: Pick<ClinicalNoteDTO, "id" | "amendsNoteId" | "patientId" | "occurredAt" | "title" | "kind">,
  patient: { lastName: string; firstName: string; dni: string | null },
): FichaBackupTarget {
  return {
    patientId: root.patientId,
    noteId: fichaRootId(root),
    patient: { lastName: patient.lastName, firstName: patient.firstName, dni: patient.dni },
    occurredAt: root.occurredAt,
    title: root.title?.trim() || CLINICAL_NOTE_KIND_LABEL[root.kind],
  };
}

// ─── Chips, autor y diagnósticos ────────────────────────────────────────────────────────────────────────────────

export type FichaChip = { key: "imported" | "lateEntry" | "shared" | "sharedStale"; label: string; title?: string };

/**
 * Chips de §24.7 en orden fijo: origen (Importada, Carga tardía) y después el estado con el paciente. Una importada
 * también es carga tardía (`isLateEntry`, Ley 26.529) y se muestran las dos: el QA 8 busca «Carga tardía» en las
 * importadas. Una anulada no muestra «Compartida» (el trigger de M14 revoca el documento al anular).
 */
export function fichaChips(note: ClinicalNoteDTO): FichaChip[] {
  const out: FichaChip[] = [];
  if (note.importSource) {
    out.push({ key: "imported", label: CARD_COPY.imported, title: CARD_COPY.importedFrom(note.importSource.fileName) });
  }
  if (note.lateEntry) out.push({ key: "lateEntry", label: CARD_COPY.lateEntry, title: CARD_COPY.lateEntryHint });
  const sd = note.sharedDocument;
  if (!note.voided && sd && sd.status !== "none") {
    out.push(
      sd.status === "live"
        ? { key: "shared", label: CARD_COPY.shared, title: CARD_COPY.sharedOn(shortDateTime(sd.sharedAt)) }
        : { key: "sharedStale", label: CARD_COPY.sharedStale, title: CARD_COPY.sharedStaleHint },
    );
  }
  return out;
}

/**
 * «Lic. Pérez · MN 1234 · editada». La matrícula viene congelada en la ficha (`authorLicense`, FC-D24: las previas a
 * T4 no la tienen y no se inventa); sin ella queda como en EV2.
 */
export function fichaAuthorLine(note: Pick<ClinicalNoteDTO, "author" | "authorLicense" | "revision">): string {
  const parts = [note.author.name];
  if (note.authorLicense) parts.push(note.authorLicense);
  if (note.revision > 1) parts.push(CLINICAL_NOTES_UI_COPY.edited.toLowerCase());
  return parts.join(" · ");
}

export type DiagnosisChipView = { key: string; code: string | null; title: string; principal: boolean; hint: string };

/**
 * El primero es el principal (C-FC2: el server congela en ese orden). El título de la CIE-11 se muestra completo
 * (§24.7: nunca se acorta, hace wrap). `hint` = fuente (+ atribución de la OMS si es CIE-11: CC BY-ND pide atribuir
 * donde se muestra el contenido).
 */
export function diagnosisChips(diagnoses: readonly DiagnosisSnapshot[]): DiagnosisChipView[] {
  return diagnoses.map((d, i) => ({
    key: `${i}:${d.source}:${d.refId ?? d.title}`,
    code: d.code,
    title: d.title,
    principal: i === 0,
    hint: d.source === "icd11" ? `${DIAGNOSIS_SOURCE_LABEL.icd11} · ${ICD11_SHORT_ATTRIBUTION}` : DIAGNOSIS_SOURCE_LABEL[d.source],
  }));
}

// ─── Plegado del cuerpo ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Una ficha larga (importada de Word, primera consulta completa) se pliega para que la timeline siga siendo
 * escaneable: 1366×768 tiene que mostrar el composer y la primera tarjeta sin scroll (QA 1). Umbral por caracteres
 * Y por líneas: una ficha corta en caracteres pero con 15 renglones de lista también ocupa la pantalla.
 */
export const FICHA_BODY_FOLD_CHARS = 700;
export const FICHA_BODY_FOLD_LINES = 10;
export function isFoldableBody(text: string): boolean {
  if (text.length > FICHA_BODY_FOLD_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > FICHA_BODY_FOLD_LINES) return true;
  return false;
}

// ─── Menú «⋯» ───────────────────────────────────────────────────────────────────────────────────────────────────

export type FichaMenuItemId = "pdf" | "docx" | "saveToFolder" | "share" | "shareCurrent" | "unshare" | "amend" | "versions" | "void";
export type FichaMenuItem = { id: FichaMenuItemId; label: string; danger?: boolean; separatorBefore?: boolean };

export type FichaMenuOptions = {
  now: Date;
  /** false = tarjeta de una enmienda: solo versiones y anular (la descarga y el compartir son de la raíz). */
  isRoot: boolean;
  /** El caller pasó el paciente (nombre/email): sin él no se puede armar `ShareFichaDialog` (agenda, Seguimiento). */
  shareAvailable: boolean;
  /** null = el caller no pasó el respaldo. */
  backupStatus: FichaBackupStatus | null;
};

/**
 * Orden literal de §24.7: PDF · Word · Guardar en la carpeta · Compartir con el paciente / Compartir la versión
 * actual / Dejar de compartir · Enmendar · Versiones · Anular. «Editar» NO está en el menú: dentro de las 24 h es la
 * acción principal del autor y queda a la vista (EV2-D14).
 *
 * - Descargas: cualquiera que ve la tarjeta tiene `canRead` (si no, el server no la manda); anulada → sin descargas
 *   (la tarjeta anulada no tiene menú).
 * - Carpeta: solo si ya está elegida (`ready`) o hay que re-pedir el permiso (`needs-permission`, se pide dentro del
 *   gesto). Sin carpeta o sin soporte, «PDF» ya es la descarga común y repetirla confunde.
 * - Compartir (FC-D8): cualquier profesional con escritura clínica. El DTO no trae `canWrite` suelto; en una raíz
 *   viva `canAmend` = `canWrite && amendDecision` y `amendDecision` solo rechaza anuladas y enmiendas, así que es
 *   exactamente el gate de la action. `sharedDocument: null` = la lectura no lo trae → no se ofrece.
 * - «Dejar de compartir» explícito con el documento vivo o desactualizado (FC-UI-D6).
 * - Enmendar / Versiones / Anular: las reglas de EV2 (`noteActions`, sin tocar).
 */
export function fichaMenuItems(note: ClinicalNoteDTO, o: FichaMenuOptions): FichaMenuItem[] {
  if (note.voided) return [];
  const actions = noteActions(note, o.now);
  const items: FichaMenuItem[] = [];
  if (o.isRoot) {
    items.push({ id: "pdf", label: CARD_COPY.pdf }, { id: "docx", label: CARD_COPY.word });
    if (o.backupStatus === "ready" || o.backupStatus === "needs-permission") {
      items.push({ id: "saveToFolder", label: CARD_COPY.saveToFolder });
    }
    const sd = note.sharedDocument;
    if (o.shareAvailable && sd && note.permissions.canAmend && !note.amendsNoteId) {
      const first = items.length;
      if (sd.status === "none") items.push({ id: "share", label: CARD_COPY.share });
      else {
        if (sd.status === "stale") items.push({ id: "shareCurrent", label: CARD_COPY.shareCurrent });
        items.push({ id: "unshare", label: CARD_COPY.unshare });
      }
      if (items.length > first && first > 0) items[first] = { ...items[first], separatorBefore: true };
    }
  }
  const tail: FichaMenuItem[] = [];
  if (o.isRoot && actions.amend) tail.push({ id: "amend", label: CARD_COPY.amend });
  if (actions.history) tail.push({ id: "versions", label: CARD_COPY.versions });
  if (actions.void) tail.push({ id: "void", label: CARD_COPY.void, danger: true });
  if (tail.length && items.length) tail[0] = { ...tail[0], separatorBefore: true };
  return [...items, ...tail];
}

// ─── Descargas ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Tope del texto del server que se muestra en un toast (es nuestro, pero un proxy podría devolver un HTML entero). */
const SERVER_TEXT_MAX = 300;
function serverText(body: string | null | undefined, fallback: string): string {
  const t = (body ?? "").trim();
  if (!t || t.length > SERVER_TEXT_MAX || t.startsWith("<")) return fallback;
  return t;
}

/**
 * Status de la ruta (C-FC7) → mensaje. 413, 429 y 500 traen el copy en texto plano (FC-2g); 503 viene vacío a
 * propósito (falló el audit y no salió ni un byte). 404 no distingue ajeno de inexistente (igual que la ruta).
 */
export function downloadErrorMessage(status: number, body: string | null): string {
  switch (status) {
    case 401:
      return CARD_COPY.downloadSession;
    case 403:
      return CLINICAL_NOTE_COPY.forbidden;
    case 404:
      return CLINICAL_NOTE_COPY.notFound;
    case 413:
      return serverText(body, HC_EXPORT_COPY.fichaTooLarge);
    case 429:
      return serverText(body, HC_EXPORT_COPY.rateLimited);
    case 503:
      return CARD_COPY.downloadUnavailable;
    default:
      return serverText(body, HC_EXPORT_COPY.renderFailed);
  }
}

/**
 * Nombre del archivo desde el `Content-Disposition` de la ruta (`attachmentDisposition`: `filename*=UTF-8''…` con el
 * nombre real y `filename="…"` ASCII de respaldo). Se saca cualquier separador de ruta: el nombre lo arma el server,
 * pero el atributo `download` es una frontera igual.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (header) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try {
        const v = decodeURIComponent(star[1].trim());
        if (v) return sanitizeFilename(v);
      } catch {
        // `filename*` mal codificado: se prueba el ASCII.
      }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header);
    if (plain && plain[1].trim()) return sanitizeFilename(plain[1].trim());
  }
  return fallback;
}
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, "_");
}

// ─── Compartir ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `first` = nunca compartida (o revocada); `reshare` = el documento vivo quedó viejo (la ficha cambió después). */
export function shareDialogVariant(note: Pick<ClinicalNoteDTO, "sharedDocument">): "first" | "reshare" {
  return note.sharedDocument?.status === "stale" ? "reshare" : "first";
}

export type ShareOutcomeView =
  | { kind: "linked"; message: string; warning: string | null }
  | { kind: "not-linked"; message: string; canInvite: boolean; noEmail: string | null };

/**
 * Qué muestra el diálogo después de compartir.
 * - Con portal: «Listo: el paciente ya lo ve…»; si se pidió aviso y el mail falló, el aviso aparte (`emailFailed`):
 *   el documento SÍ quedó compartido y no hay que reintentar.
 * - Sin portal (`patientPortal: "not-linked"`, `delivery.status: "no-portal-user"`): se ofrece «Invitar al portal y
 *   compartir» con `sendPatientPortalInvite` (§24.5); sin email cargado no hay a quién invitar → se dice cómo seguir.
 */
export function shareOutcomeView(
  data: { patientPortal: "linked" | "not-linked"; delivery: DocumentDeliveryOutcome | null },
  patientEmail: string | null,
): ShareOutcomeView {
  if (data.patientPortal === "not-linked") {
    const hasEmail = Boolean(patientEmail && patientEmail.trim());
    return {
      kind: "not-linked",
      message: PATIENT_DOCUMENT_COPY.sharedNoPortal,
      canInvite: hasEmail,
      noEmail: hasEmail ? null : SHARE_COPY.noEmail,
    };
  }
  return {
    kind: "linked",
    message: PATIENT_DOCUMENT_COPY.shared,
    warning: data.delivery?.status === "failed" ? PATIENT_DOCUMENT_COPY.emailFailed : null,
  };
}

/** El estado nuevo de la tarjeta después de compartir (C-FC6 no devuelve la nota). */
export function sharedDocumentAfterShare(doc: { id: string; sharedAt: string }) {
  return { status: "live" as const, documentId: doc.id, sharedAt: doc.sharedAt };
}

/** Lo mínimo de `useFichaBackup` que usa la tarjeta (el caller monta el hook UNA vez para toda la HC). */
export type FichaCardBackup = Pick<UseFichaBackupResult, "status" | "save">;

/**
 * Contexto opcional de la tarjeta. Sin él (drawer del turno, Seguimiento) la tarjeta ofrece descargas, versiones y
 * las acciones de EV2, pero no compartir ni la carpeta: no tiene el nombre, el email ni el DNI del paciente.
 */
export type FichaCardContext = {
  patient: { id: string; name: string; email: string | null; firstName: string; lastName: string; dni: string | null };
  backup?: FichaCardBackup | null;
};
