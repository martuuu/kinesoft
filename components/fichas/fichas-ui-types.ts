/**
 * [FC-3k] Contratos de la UI de fichas (T4d0): tipos y props CONGELADOS que comparten las sesiones de T4d/T4e.
 *
 * Por qué un archivo aparte, antes de la UI: en T4d trabajan en paralelo el editor (FC-3a), los diagnósticos (FC-3b),
 * el formulario (FC-3c), el shell (FC-3d), el inicio de la HC (FC-3e1) y la tarjeta (FC-3e2), y en T4e el import de
 * Word (FC-3f), el respaldo (FC-3g), las entradas (FC-3h) y Configuración (FC-3i). Cada una consume los componentes de
 * otra; si cada sesión inventara la firma, el integrador se encontraría con seis versiones del mismo prop. Acá se fija
 * la forma una vez y cada dueño implementa ADENTRO sin cambiarla. Cambiar un tipo de este archivo es un handoff al
 * integrador, no una edición suelta.
 *
 * Solo tipos (más los de los props): sin React en runtime, sin DOM. Puede importar tipos del modelo de notas porque
 * `components/fichas/*` nunca lo alcanza el portal (`HC_NAMESPACES` en tests/helpers/import-graph.ts lo prohíbe).
 */
import type { BookingStatus, ClinicalNoteKind } from "@prisma/client";
import type { HcDoc } from "@/lib/hc-doc";
import type { DiagnosisOption, DiagnosisPickerHome } from "@/lib/diagnoses-types";
import type { ClinicalNoteDTO, ComposerBookingCandidate, NoteSharedDocument } from "@/lib/clinical-notes-types";

// ─── Editor (FC-3a) · `components/fichas/hc-editor-field.tsx` ──────────────────────────────────────────────────────

/**
 * Lo que emite el editor en cada cambio. `doc` siempre es un HcDoc (con «Sin formato» o antes de hidratar, sale de
 * `plainTextToHcDoc(text)`); `text` es su texto plano (contador y dirty-guard). `rich` = vino de Tiptap (false =
 * textarea: antes de que cargue el editor o con «Sin formato»). El server re-valida igual (`validateHcDoc`).
 */
export type HcEditorChange = { doc: HcDoc; text: string; rich: boolean };

export type HcEditorFieldProps = {
  /** id del control (el `<label htmlFor>` y el `aria-describedby` del contador apuntan acá). */
  id: string;
  label: string;
  /**
   * NO controlado (§24.7 «Editor»): se lee al montar y cuando cambia `resetKey`. Lo tipeado en el `<textarea>` antes de
   * hidratar no se pierde porque nadie le pisa el valor desde React.
   */
  initialDoc: HcDoc | null;
  /** Texto plano inicial (fichas viejas sin `bodyDoc`); se ignora si viene `initialDoc`. */
  initialText?: string;
  /** Cambiarlo re-monta el valor inicial (después de guardar, o al restaurar un borrador). */
  resetKey?: string | number;
  onChange: (change: HcEditorChange) => void;
  /** Ctrl/⌘+Enter («Guardar ficha»). */
  onSubmitShortcut?: () => void;
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  /** Tope del texto plano (default `HC_DOC_MAX_CHARS` = 20.000). */
  maxChars?: number;
  /** Filas del textarea / alto mínimo del editor. */
  rows?: number;
};

// ─── Diagnósticos (FC-3b) · `components/fichas/diagnosis-field.tsx` ────────────────────────────────────────────────

/**
 * Valor del campo: opciones en ORDEN; la primera es la principal (C-FC2: el server congela en ese orden). Se usa
 * `DiagnosisOption` y no `DiagnosisRef` porque el chip necesita código, título, fuente, `retired` y la ★.
 * Para editar una ficha, FC-3b convierte `DiagnosisSnapshot` → `DiagnosisOption` (handoff de FC-2a: en una enmienda NO
 * se precargan los retirados; en una edición quedan, congelados, con `retired: true`).
 */
export type DiagnosisFieldValue = readonly DiagnosisOption[];

export type DiagnosisFieldProps = {
  id: string;
  value: DiagnosisFieldValue;
  onChange: (next: DiagnosisOption[]) => void;
  /** Precarga del picker (favoritos/recientes); undefined = el picker la pide al abrirse (`getDiagnosisPickerHome`). */
  pickerHome?: DiagnosisPickerHome | null;
  disabled?: boolean;
  error?: string | null;
  label?: string;
};

// ─── Turno de la ficha (FC-3c) · chip del turno ───────────────────────────────────────────────────────────────────

/** Mismo shape que `ComposerBookingCandidate` (C-FC3) y `HcComposerBookingCandidate` (lib/hc-composer-logic.ts). */
export type FichaBookingOption = ComposerBookingCandidate;

// ─── Formulario único (FC-3c) · `components/fichas/ficha-form.tsx` ─────────────────────────────────────────────────

/**
 * Crear: inline en la HC, en `FichaDrawer` (mobile), desde la agenda y desde Seguimiento.
 * - `bookings`: candidatos del chip (`PatientClinicalHome.composer.candidates`). El default lo elige
 *   `pickDefaultComposerBooking` (hoy, sin ficha viva, propio primero) y se puede cambiar o dejar «Sin turno».
 * - `fixedBooking`: entrada desde un turno (agenda, toast «Atendido», Seguimiento, deep link): el chip queda en ese
 *   turno y no se ofrece cambiarlo. Gana sobre `bookings`.
 * - `patientHasNotes`: FC-UI-D5 (sin fichas → «Primera consulta»; si no, «Evolución»).
 */
export type FichaFormCreateMode = {
  type: "create";
  patientId: string;
  /** El formulario dice de quién es (desde la agenda el paciente no está a la vista). */
  patientName?: string;
  patientHasNotes: boolean;
  bookings?: readonly FichaBookingOption[];
  fixedBooking?: FichaBookingOption | null;
};
export type FichaFormMode =
  | FichaFormCreateMode
  | { type: "edit"; note: ClinicalNoteDTO }
  | { type: "amend"; note: ClinicalNoteDTO };

/** Alcance del borrador en memoria (§24.7: usuario + consultorio + paciente; TTL 12 h, LRU 20, nunca en disco). */
export type FichaDraftScope = { tenantId: string; userId: string; patientId: string };

/**
 * Borrador en memoria (lo guarda `lib/hc-draft-store.ts`, FC-3c). La clave de idempotencia vive ADENTRO: si el
 * borrador se restaura, el reintento sigue siendo replay; al guardar, el store la rota.
 * `occurredAtLocal` = reloj de pared AR «YYYY-MM-DDTHH:mm» (contrato del picker); `*Touched` = el usuario lo tocó (la
 * fecha sigue al turno salvo que la hayan tocado; sin tocar viaja null y el server pone su default).
 */
export type FichaDraft = {
  kind: ClinicalNoteKind;
  title: string;
  /** null = «Sin turno». */
  bookingId: string | null;
  bookingTouched: boolean;
  occurredAtLocal: string;
  occurredAtTouched: boolean;
  doc: HcDoc | null;
  text: string;
  diagnoses: DiagnosisOption[];
  /** Casilla «diagnóstico activo»: destildada por default, solo habilitada con principal. */
  setActiveDiagnosis: boolean;
  idempotencyKey: string;
};

export type FichaSavedInfo = { type: FichaFormMode["type"]; replayed: boolean };

/** Texto que el editor de 24 h vencido trae a la enmienda (EV2-Z M5). */
export type FichaCarry = { doc: HcDoc | null; text: string };

export type FichaFormProps = {
  mode: FichaFormMode;
  /** `inline` = composer de la HC (≥640 px); `drawer` = adentro de `FichaDrawer` (alto completo en mobile). */
  variant: "inline" | "drawer";
  /** Practitioner del actor: ordena el chip (propio primero). */
  viewerPractitionerId: string | null;
  /** null/undefined = sin borrador en memoria (p. ej. editar o enmendar). */
  draftScope?: FichaDraftScope | null;
  /** El DTO que devolvió la action: el caller agrega/reemplaza sin refrescar la ruta (H-SLOW). */
  onSaved: (note: ClinicalNoteDTO, info: FichaSavedInfo) => void;
  onCancel?: () => void;
  /** Dirty-guard del Drawer y punto de «borrador sin guardar» en la pestaña (FC-3d). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Editar con la ventana de 24 h vencida: el texto pasa a la enmienda (EV2-Z M5). Solo raíces. */
  onSwitchToAmend?: (carry: FichaCarry) => void;
  /**
   * FC-3i1: el texto traído del editor vencido (EV2-Z M5). Lo pasa `FichaDrawer` (al cambiar a enmendar); era un prop
   * interno de `ficha-form.tsx` y se publicó cuando lo usaba también el shim de EV2 (borrado en FC-4i). Con texto, el
   * form arranca «sucio» (cerrar sin guardar lo pierde y el guard avisa).
   */
  carry?: FichaCarry | null;
  /** Precarga del picker, si el caller ya la tiene. */
  pickerHome?: DiagnosisPickerHome | null;
  /** Solo tests: reloj fijo. */
  now?: Date;
};

/** `FichaDrawer` (FC-3c, diferido): el mismo formulario en un Drawer. */
export type FichaDrawerProps = Omit<FichaFormProps, "variant" | "onCancel" | "carry"> & { open: boolean; onClose: () => void };

// ─── Importar Word (FC-3f) · `components/fichas/word-import-drawer.tsx` ────────────────────────────────────────────

export type WordImportDrawerProps = {
  open: boolean;
  onClose: () => void;
  patientId: string;
  patientName: string;
  /** Las fichas creadas (una action por archivo/parte). Se llama una vez al terminar, aunque algunas fallen. */
  onImported: (notes: ClinicalNoteDTO[]) => void;
};

// ─── Carpeta de respaldo (FC-3g) · `backup-setup.tsx` + `use-ficha-backup.ts` ──────────────────────────────────────

/** Clave del handle en IndexedDB (`hc-backup`, `{tenant}:{user}`, §24.6). */
export type FichaBackupScope = { tenantId: string; userId: string };

/**
 * - `checking`: todavía no se miró (SSR y primer render: nunca se ofrece la carpeta antes de saber).
 * - `unsupported`: sin File System Access (Safari, Firefox, mobile) → descarga común.
 * - `unconfigured`: soportado pero sin carpeta elegida.
 * - `needs-permission`: hay carpeta pero el permiso caducó (se pide dentro del gesto de «Guardar»).
 * - `ready`.
 */
export type FichaBackupStatus = "checking" | "unsupported" | "unconfigured" | "needs-permission" | "ready";

/** Lo que hace falta para armar la ruta `Pacientes/<Apellido Nombre> (DNI n)/<AAAA-MM-DD> <título> [id6].pdf`. */
export type FichaBackupTarget = {
  patientId: string;
  /** Id de la RAÍZ (la ruta de descarga devuelve 404 con una enmienda; handoff de FC-2g). */
  noteId: string;
  patient: { lastName: string; firstName: string; dni: string | null };
  occurredAt: string;
  /** Título de la ficha o, si no tiene, la etiqueta del tipo. */
  title: string;
};

export type FichaBackupOutcome =
  | { ok: true; via: "folder"; path: string }
  | { ok: true; via: "download" }
  | { ok: false; error: string };

export type UseFichaBackupResult = {
  status: FichaBackupStatus;
  /**
   * Guarda (o sobrescribe) el PDF auditado. IMPORTANTE (§24.6): llamarlo DIRECTO desde el handler del click, sin
   * ningún `await` antes: el permiso se pide al principio del gesto o el navegador lo rechaza.
   */
  save: (target: FichaBackupTarget) => Promise<FichaBackupOutcome>;
  /** Re-lee el estado (después de configurar la carpeta en `BackupSetup`). */
  refresh: () => void;
};

export type BackupSetupProps = {
  scope: FichaBackupScope;
  /** `panel` = «Mis fichas» en Configuración; `dialog` = desde el menú «⋯» de la HC. */
  variant: "panel" | "dialog";
  onClose?: () => void;
  onConfigured?: () => void;
};

// ─── Compartir (FC-3e2) · `share-ficha-dialog.tsx` (diferido) ──────────────────────────────────────────────────────

export type ShareFichaDialogProps = {
  open: boolean;
  onClose: () => void;
  note: ClinicalNoteDTO;
  patient: { id: string; name: string; email: string | null };
  /**
   * Cambió el documento compartido (compartida, re-compartida o revocada): el caller actualiza `note.sharedDocument`
   * de la tarjeta. Las actions de C-FC6 no devuelven la nota, por eso viaja solo el estado nuevo.
   */
  onChanged: (sharedDocument: NoteSharedDocument) => void;
};

/** Re-export para que los consumidores no importen `@prisma/client` solo por esto. */
export type { BookingStatus, ClinicalNoteKind };
