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
import { CLINICAL_NOTE_KIND_LABEL, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { DIAGNOSIS_SOURCE_LABEL, ICD11_SHORT_ATTRIBUTION } from "@/lib/diagnoses-types";
import type { FichaBackupStatus, FichaBackupTarget, UseFichaBackupResult } from "@/components/fichas/fichas-ui-types";
import { FICHA_CARD_COPY, SHARE_FICHA_COPY } from "@/components/fichas/fichas-copy";
import { CLINICAL_NOTES_UI_COPY, noteActions, shortDateTime } from "@/components/clinical-notes/clinical-notes-ui";

/**
 * Alias de los bloques de `fichas-copy.ts` (FC-3i1 movió ahí lo que faltaba, que vivía en `FICHA_CARD_COPY_PENDING`):
 * los consumidores siguen leyendo `CARD_COPY`/`SHARE_COPY`.
 */
export const CARD_COPY = FICHA_CARD_COPY;
export const SHARE_COPY = SHARE_FICHA_COPY;

// ─── Raíz, URL y nombres ────────────────────────────────────────────────────────────────────────────────────────

/** La ruta de descarga y el respaldo van SIEMPRE por la raíz (una enmienda da 404, handoff de FC-2g). */
export function fichaRootId(note: Pick<ClinicalNoteDTO, "id" | "amendsNoteId">): string {
  return note.amendsNoteId ?? note.id;
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

// ─── Descargas y compartir: en `ficha-share-download-logic.ts` (FC-3i1) ────────────────────────────────────────────
// Los usan `download.ts` y `ShareFichaDialog` (diferido); separados para que el diálogo no viaje con la tarjeta (§24.9).

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
