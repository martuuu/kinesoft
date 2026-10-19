"use client";

/**
 * [FC-3c] Shim del editor de EV2 (`NoteEditorDrawer`) sobre el formulario ÚNICO `FichaForm` (§24.7).
 *
 * Por qué un shim y no borrar el archivo: lo cargan por `next/dynamic` la agenda (drawer del turno), Seguimiento, la
 * tarjeta de la ficha y la vista de evoluciones, con su firma de EV2 (`NoteEditorMode`). FC-3h pasa esas entradas a
 * `FichaDrawer`; mientras tanto, todas ya abren el MISMO formulario (editor con formato, diagnósticos, casilla del
 * diagnóstico activo, fecha AR) sin que cada caller cambie. Cuando nadie lo importe, se borra.
 *
 * - `booking` de EV2 → `fixedBooking`: desde un turno el chip queda en ese turno. Los campos que el chip no usa
 *   (`status`, `practitionerId`) se rellenan neutros: no se muestran ni viajan (la action solo recibe `bookingId`).
 * - `defaultKind: "FIRST_VISIT"` → `patientHasNotes: false` (FC-UI-D5 da el mismo tipo); sin `defaultKind`, Evolución.
 * - Sin `draftScope`: estos callers no tienen tenant/usuario a mano y el borrador de la HC es del composer; el Drawer
 *   conserva su dirty-guard y el form su `beforeunload`.
 */
import type { ReactElement } from "react";
import { FichaDrawer, FICHA_DRAWER_WIDTH } from "@/components/fichas/ficha-drawer";
import { FichaForm, kindKeyStep } from "@/components/fichas/ficha-form";
import type { FichaFormMode } from "@/components/fichas/fichas-ui-types";
import type { NoteEditorMode } from "@/components/clinical-notes/clinical-notes-ui";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

export { kindKeyStep };
export const NOTE_EDITOR_WIDTH = FICHA_DRAWER_WIDTH;

export type NoteSavedInfo = { type: NoteEditorMode["type"]; replayed: boolean };

/** `NoteEditorMode` (EV2) → `FichaFormMode` (FC). Pura: la prueba el render test del shim. */
export function fichaModeFromNoteEditor(mode: NoteEditorMode): FichaFormMode {
  if (mode.type !== "create") return mode;
  return {
    type: "create",
    patientId: mode.patientId,
    patientName: mode.patientName,
    patientHasNotes: mode.defaultKind !== "FIRST_VISIT",
    fixedBooking: mode.booking
      ? { ...mode.booking, status: "CONFIRMED", practitionerId: null, hasLiveNote: false }
      : null,
  };
}

export function NoteEditorDrawer({
  open,
  onClose,
  mode,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: NoteEditorMode;
  /** El DTO que devolvió la action: el caller reemplaza (editar) o agrega (crear/enmendar) sin recargar. */
  onSaved: (note: ClinicalNoteDTO, info: NoteSavedInfo) => void;
}): ReactElement {
  return (
    <FichaDrawer
      open={open}
      onClose={onClose}
      mode={fichaModeFromNoteEditor(mode)}
      viewerPractitionerId={null}
      onSaved={(note, info) => onSaved(note, { type: info.type, replayed: info.replayed })}
    />
  );
}

/** El formulario sin Drawer (lo usan los tests de EV2). `carryBody` = texto que viene del editor de 24 h vencido. */
export function NoteEditorForm({
  mode,
  onCancel,
  onSaved,
  onDirtyChange,
  carryBody,
  now,
}: {
  mode: NoteEditorMode;
  onCancel: () => void;
  onSaved: (note: ClinicalNoteDTO, replayed: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  carryBody?: string | null;
  now?: Date;
}): ReactElement {
  return (
    <FichaForm
      mode={fichaModeFromNoteEditor(mode)}
      variant="drawer"
      viewerPractitionerId={null}
      onCancel={onCancel}
      onSaved={(note, info) => onSaved(note, info.replayed)}
      onDirtyChange={onDirtyChange}
      carry={carryBody ? { doc: null, text: carryBody } : null}
      now={now}
    />
  );
}
