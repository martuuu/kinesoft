"use client";

/**
 * Booking drawer — the right-side panel that opens when you click a
 * booking on the agenda. Shows patient + slot + service + notes, then
 * lets the kine:
 *
 *   - Open the patient HC (or basic view, depending on access tier).
 *   - Reprogram the booking with an inline `datetime-local` form;
 *     conflicts surface as an amber banner with three actions
 *     (use next free / force sobreturno / cancel).
 *   - Switch the booking status (Confirmar / Realizado / Ausente /
 *     Cancelar).
 *   - Delete the booking.
 *
 * Gating (P0-S07u, Planes E1; `bookingDrawerAccess` en `./types`):
 *   - operar (Reprogramar, Editar duración/paciente, Cambiar estado, Cancelar)
 *     = `canOperate` del server (`canOperateBooking` = full || operateAll). Antes
 *     era `patientAccess !== "basic"` y la Secretaria quedaba en solo lectura;
 *   - título, descripción, notas, "Usar como diagnóstico" y "Últimos turnos" =
 *     `clinicalWritable` (`canWriteClinical`). Con los campos ocultos (null),
 *     "Usar como diagnóstico" mandaba vacíos y BORRABA el diagnóstico;
 *   - Eliminar = la regla de siempre (full o guest), sin cambios.
 * Acceso básico sin `agenda.operateAll` sigue siendo solo ver (decisión del
 * dueño, 30-sep; A2a-S06). El server rechaza igual; esto solo lo refleja.
 *
 * Pure UI — every mutation goes through server actions in `lib/bookings.ts`.
 *
 * B1.5b: partido en piezas presentacionales (`./*`). TODO el estado, las
 * llamadas a server actions (lock optimista con `expectedUpdatedAt`, overrides
 * de sobreturno / superposición) y el dirty-guard viven acá; las piezas son
 * controladas y no llaman al server, salvo `ShareActions` (abre una ventana de
 * impresión). Contrato público: `BookingDrawer({ booking, onClose, onSaved })`.
 *
 * B5.7: los avisos blandos de B3.1 (`blocked` = bloqueo de agenda,
 * `outOfHours` = fuera del horario del profesional) se tratan igual que el cupo
 * lleno: banner en reprogramar / editar y `useConfirm` al cambiar estado, con
 * re-llamada acumulando el flag (`lib/booking-force-flags.ts`). Antes caían en
 * el `error` genérico y no había forma de forzarlos desde acá.
 *
 * SR-U5b: fila "Sala" (`./room-row`). Cambiarla = `canOperate` (también la
 * Secretaria con `agenda.operateAll`: la sala es operativa, no clínica), con
 * las salas de la sede del turno (la sede no se cambia desde acá, D9). Sala
 * ocupada o bloqueada → `useConfirm` "Asignar igual" con `allowRoomConflict`
 * (SR-D2: no es sobreturno). Sin `rooms` (o sin salas en la sede y sin sala en
 * el turno) el drawer es el de antes.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/ui/drawer";
import {
  deleteBooking,
  setBookingStatus,
  updateBooking,
} from "@/lib/bookings";
import { getPatientBookingsSummary, setPatientDiagnosis } from "@/lib/patients";
import type { PatientBookingSummary } from "@/lib/patients-types";
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { PickedPatient } from "@/components/patients/patient-picker";
import { recordsDiffer } from "@/lib/form-dirty";
import type { BookingStatus } from "@prisma/client";
import { BillingRows } from "./billing-rows";
import { EditDetailsForm } from "./edit-details-form";
import { EditToggles } from "./edit-toggles";
import { PatientHeader } from "./patient-header";
import { RecentBookings } from "./recent-bookings";
import { RescheduleForm } from "./reschedule-form";
import { ShareActions } from "./share-actions";
import {
  DeleteBookingButton,
  StatusActions,
  bookingHasClinicalNote,
  clinicalNoteRowEligible,
  offersNoteAfterStatus,
  statusToastPayload,
} from "./status-actions";
import type { BookingClinicalNoteView } from "@/lib/clinical-notes-types";
import { sectionCard } from "./styles";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
} from "@/lib/booking-force-flags";
import { capabilitySet } from "@/lib/agenda-client-state";
import { PLAN_PATIENT_CHANGE_ERROR } from "@/lib/bookings-constants";
import { listSchedulablePlanSessions } from "@/lib/plans-read";
import { removeBookingFromPlan } from "@/lib/plans-adopt";
import type { SchedulablePlanSession } from "@/lib/plans-read-types";
import { planSessionLabel } from "@/lib/plan-display";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { planUiPermissions } from "@/components/planes/plan-editor-types";
import { ScheduleSessionModal } from "@/components/seguimiento/schedule-session-modal";
import {
  LinkSessionModal,
  PlanRow,
  drawerPlanModel,
  pickNextPlanSession,
  type PlanRowBooking,
} from "./plan-row";
import { planStatusToastDescription } from "./status-actions";
import { ReceptionInfo } from "./reception-info";
import { NO_ROOM_VALUE, RoomRow, drawerRoomModel, roomChangeOutcome, roomUpdatePayload } from "./room-row";
import type { RoomOption } from "@/lib/rooms-types";
import {
  bookingDrawerAccess,
  type BannerState,
  type BookingDrawerAccess,
  type DrawerBooking,
  type ForceFlags,
} from "./types";

export type { DrawerBooking } from "./types";

// P3.Z (F3a): el diálogo de renovación arrastra todo `plan-edit-dialogs` (los
// diálogos de edición del plan) y en la agenda se abre muy de vez en cuando:
// va en un chunk aparte para no inflar el bundle de /agenda.
const RenewAuthorizationDialog = dynamic(
  () => import("@/components/planes/plan-edit-dialogs").then((m) => m.RenewAuthorizationDialog),
  { ssr: false }
);

// EV2-3b: la fila «Evolución» (con `NoteCard`) y el editor van en chunks
// aparte: solo los usa quien tiene `clinical.read`, y la Secretaria (la que más
// vive en la agenda) no los descarga. La lectura `getBookingClinicalNote` se
// importa al usarla por lo mismo (y para que el drawer no arrastre el módulo de
// actions de evoluciones a quien no lo usa).
const ClinicalNoteRow = dynamic(() => import("./clinical-note-row").then((m) => m.ClinicalNoteRow), {
  ssr: false,
});
const NoteEditorDrawer = dynamic(
  () => import("@/components/clinical-notes/note-editor-drawer").then((m) => m.NoteEditorDrawer),
  { ssr: false }
);
const readBookingClinicalNote = (bookingId: string) =>
  import("@/lib/clinical-notes-read").then((m) => m.getBookingClinicalNote(bookingId));

/** Sin turno abierto no se muestra nada; el valor solo evita nulls abajo. */
const CLOSED: BookingDrawerAccess = {
  canOperate: false,
  clinicalWritable: false,
  notesWritable: false,
  canDelete: false,
};

export function BookingDrawer({
  booking,
  onClose,
  onSaved,
  capabilities,
  rooms,
  primaryLocationId,
}: {
  booking: DrawerBooking | null;
  onClose: () => void;
  onSaved: () => void;
  /**
   * SR-U5b: catálogo de salas del bootstrap de la agenda (activas de sedes
   * activas). Sin él (o vacío) no hay fila "Sala": el drawer es el de antes.
   */
  rooms?: readonly RoomOption[] | null;
  /** Sede principal: la de un turno con `locationId` null (para filtrar sus salas). */
  primaryLocationId?: string | null;
  /**
   * P0-S07u: capabilities del actor (array del server). Solo las usa el
   * fallback de `bookingDrawerAccess` cuando la fila no trae
   * `canOperate`/`clinicalWritable`; sin ellas el fallback no habilita clínica.
   */
  capabilities?: readonly string[] | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  // Reschedule sub-flow — opens an inline form that lets the user pick
  // a new datetime. Wires the existing `updateBooking` conflict response
  // (same shape as create-flow) into a sticky amber banner with the
  // "next free slot" suggestion + sobreturno override.
  const [editingWhen, setEditingWhen] = useState(false);
  const [newWhenLocal, setNewWhenLocal] = useState<string>("");
  const [reschConflict, setReschConflict] = useState<BannerState | null>(null);
  // Same sobreturno banner for a duration change that overflows the cupo
  // (A2a-S06: updateBooking now re-checks capacity when durationMin changes).
  const [editConflict, setEditConflict] = useState<BannerState | null>(null);
  // Edit sub-flow — independent of reschedule. Lets the practitioner
  // tweak duration + notes + swap the linked patient without touching
  // the slot. Most common mid-life edits requested by clients.
  const [editingDetails, setEditingDetails] = useState(false);
  const [editDuration, setEditDuration] = useState<number>(45);
  const [editNotes, setEditNotes] = useState<string>("");
  // Mini-diagnosis (Booking.title/.description) editable per turno.
  const [editTitle, setEditTitle] = useState<string>("");
  const [editDescription, setEditDescription] = useState<string>("");
  // The patient's two most recent OTHER turnos, shown as a preview.
  const [recent, setRecent] = useState<PatientBookingSummary[]>([]);
  // Tracks the picker's current selection. Initial state is derived
  // from the booking; `undefined` means "no change pending". `null`
  // means the user cleared the link (booking becomes a guest slot).
  const [editPatient, setEditPatient] = useState<PickedPatient | null | undefined>(undefined);
  // SR-U5b: "Cambiar" sala abierto + valor del select (`NO_ROOM_VALUE` = "Sin sala").
  const [editingRoom, setEditingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState<string>(NO_ROOM_VALUE);

  const caps = useMemo(() => capabilitySet(capabilities), [capabilities]);
  const access = booking ? bookingDrawerAccess(booking, caps) : CLOSED;

  // S19c · fila Plan. Permisos = espejo de UI de `plan-authz-internal` (la
  // barrera es el server); sin el módulo `planes` (General) todo en false y la
  // fila no aparece (enmienda EV0: puerta 4, Agendar y Vincular solo con
  // `has('planes')`). `role` no hace falta: solo decide "restaurar plan".
  const tenantModules = useTenantModules();
  const plansModule = tenantModules.has("planes");
  // EV1-C1: sin `diagnostico` (Clínica general) no hay «Usar como diagnóstico
  // del paciente» ni sus toasts: el formulario no recibe el handler.
  const diagnosisModule = tenantModules.has("diagnostico");
  const planPerms = useMemo(
    () =>
      planUiPermissions({
        caps,
        access: booking?.patientId ? booking.patientAccess : "none",
        role: null,
        plansModule,
        templatesModule: false,
      }),
    [caps, booking?.patientId, booking?.patientAccess, plansModule]
  );
  const planModel = booking ? drawerPlanModel(booking, planPerms, { plansModule }) : null;
  const isPlanBooking = planModel?.kind === "plan";
  const planOrdinal = booking?.plan?.ordinal ?? null;
  const [nextSession, setNextSession] = useState<SchedulablePlanSession | null>(null);
  // Diálogo de la fila Plan. Va FUERA del Drawer y con el drawer cerrado: el
  // Modal del design system está en z-index 40, debajo del panel (46), y
  // adentro del panel animado `position: fixed` queda relativo a él. Por eso
  // guarda su propio blanco y no se resetea al cambiar `booking` (abrirlo
  // cierra el drawer y `booking` pasa a null).
  const [planDialog, setPlanDialog] = useState<PlanDialog | null>(null);

  // EV2-3b · fila «Evolución». Se pide al abrir el turno y solo si vale la pena
  // (`clinicalNoteRowEligible`: paciente + `clinical.read` + módulo); `null`
  // del server = sin acceso / guest → la fila no se renderiza. El editor de
  // «Cargar evolución» va AFUERA del drawer (como `planDialog`: el panel tiene
  // `transform`) y guarda su propio blanco, porque el drawer se cierra antes.
  const evolutionsModule = tenantModules.has("evoluciones");
  const noteRowEligible =
    !!booking && clinicalNoteRowEligible({ patientId: booking.patientId, caps, evolutionsModule });
  const [noteView, setNoteView] = useState<BookingClinicalNoteView | null>(null);
  const [noteEditor, setNoteEditor] = useState<NoteEditorTarget | null>(null);

  // Reset reschedule state every time a different booking opens.
  // Uses AR-formatted Intl output instead of `Date.prototype.getHours()`
  // so the input shows the same wall-clock as the agenda regardless of
  // the runtime's local timezone.
  useEffect(() => {
    setEditingWhen(false);
    setEditingDetails(false);
    setReschConflict(null);
    setEditConflict(null);
    setError(null);
    setEditPatient(undefined);
    setRecent([]);
    setEditingRoom(false);
    setRoomDraft(booking?.roomId ?? NO_ROOM_VALUE);
    if (booking) {
      setNewWhenLocal(isoToARLocalInput(booking.scheduledFor));
      setEditDuration(booking.durationMin);
      setEditNotes(booking.notes ?? "");
      setEditTitle(booking.title ?? "");
      setEditDescription(booking.description ?? "");
    }
    // Preview: the patient's two most recent OTHER turnos. Solo con escritura
    // clínica (P0-S07u): la lista muestra título/notas de otros turnos y el
    // link a la HC; para la Secretaria es historia clínica, no se pide.
    let cancelled = false;
    if (booking?.patientId && bookingDrawerAccess(booking, caps).clinicalWritable) {
      getPatientBookingsSummary(booking.patientId, 4)
        .then((rows) => {
          if (cancelled) return;
          setRecent(rows.filter((r) => r.id !== booking.id).slice(0, 2));
        })
        .catch(() => {});
    }
    // S19c: "Agendar próxima sesión" solo si el plan tiene una sesión "sin
    // turno". UNA lectura (allowlist sin títulos, apta para la Secretaria) y
    // solo en turnos de plan con `plans.schedule`; un error deja el botón
    // oculto (no hay nada que hacer distinto desde acá).
    // EV2-3b: lectura perezosa de la evolución del turno (ver arriba).
    setNoteView(null);
    if (booking && noteRowEligible) {
      readBookingClinicalNote(booking.id)
        .then((v) => {
          if (!cancelled) setNoteView(v);
        })
        .catch(() => {});
    }
    setNextSession(null);
    if (booking?.patientId && drawerPlanModel(booking, planPerms, { plansModule }).canSchedule) {
      listSchedulablePlanSessions({ patientId: booking.patientId })
        .then((r) => {
          if (cancelled || !r.ok) return;
          setNextSession(pickNextPlanSession(r.data, booking));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [booking?.id]);

  const setStatus = (
    status: BookingStatus,
    force: ForceFlags = {}
  ) => {
    if (!booking) return;
    setError(null);
    start(async () => {
      const r = await setBookingStatus(booking.id, status, booking.updatedAt, force);
      if (!r.ok) {
        // Reactivating a CANCELLED turno re-checks the cupo, the patient's own
        // overlap and (B3.1) the agenda: bloqueo / fuera de horario. Offer the
        // explicit override and re-send with the flags accumulated.
        const prompt = nextForcePrompt(r, force);
        if (prompt) {
          const ok = await confirm(forcePromptConfirm(prompt, "reactivate"));
          if (ok) setStatus(status, withForce(force, prompt));
          return;
        }
        setError(r.error);
        toast.error("No pudimos actualizar el turno", { description: r.error });
        return;
      }
      // S19c: en un turno de plan, Ausente / Cancelado avisan que la sesión
      // queda "sin turno" (C13, PQ-05); el `notice` del core (p. ej. "la sesión
      // queda realizada") manda si viene.
      const description =
        r.notice ?? planStatusToastDescription(status, { isPlan: isPlanBooking, ordinal: planOrdinal });
      // EV2-3b: al marcar Realizado, si el actor puede crear la evolución de
      // ESTE turno (se relee después del cambio: `canCreate` depende del estado),
      // el toast ofrece «Cargar evolución». Solo para quien tiene acceso de
      // lectura (la Secretaria no paga el viaje); la barrera es la action.
      let target: NoteEditorTarget | null = null;
      if (status === "COMPLETED" && noteRowEligible && booking.patientId && !noteView?.note) {
        const view = await readBookingClinicalNote(booking.id).catch(() => null);
        if (offersNoteAfterStatus(status, view)) target = noteTargetOf(booking, booking.patientId);
      }
      const payload = statusToastPayload(status, {
        description,
        onCreateNote: target ? () => setNoteEditor(target) : null,
      });
      toast.success(payload.title, payload.options);
      onSaved();
    });
  };

  // S19c · "Sacar del plan" (`plans.manage`): queda suelto, sin la cuota del
  // plan, y su sesión "sin turno". Con cobro el server rechaza (PD-08).
  const removeFromPlan = async () => {
    if (!booking) return;
    const session = planOrdinal != null ? `la sesión ${planOrdinal}` : "su sesión";
    const ok = await confirm({
      title: "¿Sacar este turno del plan?",
      message: `Queda como turno suelto, sin la cuota del plan, y ${session} queda sin turno para reprogramar.`,
      confirmLabel: "Sacar del plan",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await removeBookingFromPlan({ bookingId: booking.id, expectedUpdatedAt: booking.updatedAt });
      if (!r.ok) {
        setError(r.error);
        toast.error("No pudimos sacar el turno del plan", { description: r.error });
        return;
      }
      toast.success("Turno fuera del plan", r.notice ? { description: r.notice } : undefined);
      onSaved();
    });
  };

  // S19c · "Cancelalo" en lugar de "Eliminar" (C13): un turno de plan no se
  // borra (PLAN_DELETE_ERROR del server); se cancela y la sesión queda sin turno.
  const cancelPlanBooking = async () => {
    const session = planOrdinal != null ? `la sesión ${planOrdinal}` : "la sesión";
    const ok = await confirm({
      title: "¿Cancelar este turno?",
      message: `Es de un plan: no se elimina. Lo cancelamos y ${session} queda sin turno para reprogramar.`,
      confirmLabel: "Cancelar turno",
      tone: "danger",
    });
    if (ok) setStatus("CANCELLED");
  };

  const remove = async () => {
    if (!booking) return;
    const ok = await confirm({
      title: "¿Eliminar este turno?",
      message: "Se quitará de la agenda de forma permanente. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await deleteBooking(booking.id, booking.updatedAt);
      if (!r.ok) {
        setError(r.error);
        toast.error("No pudimos eliminar el turno", { description: r.error });
        return;
      }
      toast.success("Turno eliminado");
      onSaved();
    });
  };

  // Back to the booking's values — "Cancelar edición" used to reset only
  // duration + notes, so a half-typed title or a cleared patient survived into
  // the next "Editar".
  const resetEditFields = () => {
    if (!booking) return;
    setEditDuration(booking.durationMin);
    setEditNotes(booking.notes ?? "");
    setEditTitle(booking.title ?? "");
    setEditDescription(booking.description ?? "");
    setEditPatient(undefined);
    setEditConflict(null);
  };

  const submitEditDetails = (
    force: ForceFlags = {}
  ) => {
    if (!booking) return;
    setError(null);
    // "Cambiar" paciente cleared the picker but nothing was picked: saving
    // used to send `""` and silently unlink the patient. Require a choice.
    if (editPatient === null) {
      setError("Elegí el paciente del turno (o cancelá la edición para dejar el actual).");
      return;
    }
    // Send ONLY what changed (A2a-S06). Sending every field made a save
    // overwrite notes/title/description with whatever the form held — e.g.
    // values another session had changed meanwhile.
    const dur = Math.max(15, Math.min(240, Math.floor(editDuration) || 45));
    const changes: {
      durationMin?: number;
      notes?: string;
      title?: string;
      description?: string;
      patientId?: string;
    } = {};
    if (dur !== booking.durationMin) changes.durationMin = dur;
    // Un campo que el actor no puede escribir no viaja nunca (P0-S07u): llega
    // null del server y el form lo tendría como "", así que cualquier
    // comparación rara terminaría pisando el valor real que no ve.
    if (access.notesWritable && editNotes !== (booking.notes ?? "")) changes.notes = editNotes;
    if (access.clinicalWritable && editTitle !== (booking.title ?? "")) changes.title = editTitle;
    if (access.clinicalWritable && editDescription !== (booking.description ?? ""))
      changes.description = editDescription;
    if (editPatient && editPatient.id !== booking.patientId) {
      // S19c · paciente bloqueado en un turno de plan (I1): el core lo rechaza
      // (`plan-patient-change`); se frena acá con el MISMO copy para no hacer
      // un viaje que va a rebotar. Sin C9 (`programId` undefined) decide el server.
      if (typeof booking.programId === "string") {
        setError(PLAN_PATIENT_CHANGE_ERROR);
        return;
      }
      changes.patientId = editPatient.id;
    }
    if (Object.keys(changes).length === 0) {
      setEditingDetails(false);
      resetEditFields();
      return;
    }
    setEditConflict(null);
    start(async () => {
      const r = await updateBooking({
        id: booking.id,
        ...changes,
        ...force,
        expectedUpdatedAt: booking.updatedAt,
      });
      if (!r.ok) {
        const prompt = nextForcePrompt(r, force);
        // The patient's own overlap stays a confirm (no slot to suggest);
        // cupo / bloqueo / fuera de horario → banner (B5.7).
        if (prompt?.kind === "patientOverlap") {
          const ok = await confirm({
            title: "El paciente ya tiene un turno superpuesto",
            message: "Con este cambio el turno se superpone con otro del mismo paciente. ¿Guardar igual?",
            confirmLabel: "Guardar igual",
          });
          if (ok) submitEditDetails(withForce(force, prompt));
          return;
        }
        if (prompt) {
          setEditConflict({ prompt, sent: force });
          return;
        }
        setError(r.error);
        return;
      }
      setEditingDetails(false);
      setEditPatient(undefined);
      if (r.notice) toast.info("Turno actualizado", { description: r.notice });
      onSaved();
    });
  };

  // Write the current title/description as the patient's default diagnosis, so
  // it auto-fills their future turnos.
  // P0-S07u: solo con `clinicalWritable`. Sin él título y descripción llegan
  // null (ocultos) y esto mandaba "" → borraba el diagnóstico del paciente.
  const applyAsPatientDiagnosis = () => {
    if (!booking?.patientId || !access.clinicalWritable || !diagnosisModule) return;
    const pid = booking.patientId;
    setError(null);
    start(async () => {
      const r = await setPatientDiagnosis(pid, editTitle, editDescription);
      if (!r.ok) {
        toast.error("No pudimos guardar el diagnóstico del paciente", { description: r.error });
        return;
      }
      toast.success("Diagnóstico del paciente actualizado");
    });
  };

  // SR-U5b: cambio de sala (payload y lectura de la respuesta, puros en
  // `./room-row`). "Elegir otra" deja el select abierto con lo elegido.
  const submitRoom = (roomId: string | null, force: ForceFlags = {}) => {
    if (!booking) return;
    setError(null);
    start(async () => {
      const r = await updateBooking(roomUpdatePayload(booking, roomId, force));
      const outcome = roomChangeOutcome(r, force);
      if (outcome.kind === "confirm") {
        if (await confirm(outcome.options)) submitRoom(roomId, outcome.next);
        return;
      }
      if (outcome.kind === "error") {
        setError(outcome.error);
        toast.error("No pudimos cambiar la sala", { description: outcome.error });
        return;
      }
      setEditingRoom(false);
      toast.success("Sala cambiada");
      onSaved();
    });
  };

  const submitReschedule = (opts: { iso?: string; force?: ForceFlags } = {}) => {
    if (!booking) return;
    // The datetime-local input is AR wall-clock; tag it with the
    // -03:00 offset before sending so the server parses unambiguously.
    // If a server-suggested slot ISO is passed in, it's already
    // unambiguous and we forward as-is.
    const iso = opts.iso ?? localToARIso(newWhenLocal);
    const force = opts.force ?? {};
    setError(null);
    setReschConflict(null);
    start(async () => {
      const r = await updateBooking({
        id: booking.id,
        scheduledFor: iso,
        ...force,
        expectedUpdatedAt: booking.updatedAt,
      });
      if (!r.ok) {
        const prompt = nextForcePrompt(r, force);
        // The patient's own overlap (A2a-S06: now checked on reschedule too).
        if (prompt?.kind === "patientOverlap") {
          const ok = await confirm({
            title: "El paciente ya tiene un turno superpuesto",
            message: "En ese horario el paciente ya tiene otro turno. ¿Reprogramar igual?",
            confirmLabel: "Reprogramar igual",
          });
          if (ok) submitReschedule({ iso, force: withForce(force, prompt) });
          return;
        }
        // Cupo lleno, bloqueo de agenda o fuera de horario (B5.7): banner con
        // "Usar próximo libre" / forzar / "Volver".
        if (prompt) {
          setReschConflict({ prompt, sent: force });
          // Sync the input so the user sees the slot we just tried.
          setNewWhenLocal(isoToARLocalInput(iso));
          return;
        }
        setError(r.error);
        return;
      }
      setEditingWhen(false);
      if (r.notice) toast.info("Turno reprogramado", { description: r.notice });
      onSaved();
    });
  };

  // P0-S07u (handoff S02p H7): era `patientAccess !== "basic"`, y la
  // Secretaria con Consultorio común (fila "basic" = nivel admin) perdía la
  // edición. Ahora es `canOperate` (guest sigue operable).
  const { canOperate, clinicalWritable, notesWritable, canDelete } = access;
  const roomModel = booking ? drawerRoomModel(booking, rooms, primaryLocationId) : null;

  // Dirty-guard (A2b-S-ui): con "Editar" o "Reprogramar" abiertos y algo
  // cambiado, Esc / fondo / X preguntan antes de tirar la edición. El paciente
  // cuenta como cambio con la misma regla que el guardado (null = desvincular,
  // otro id = re-vincular); el picker avisa su selección inicial al montar.
  const patientChanged =
    !!booking &&
    (editPatient === null || (!!editPatient && editPatient.id !== booking.patientId));
  const dirty =
    !!booking &&
    canOperate &&
    ((editingDetails &&
      (patientChanged ||
        recordsDiffer(
          {
            durationMin: booking.durationMin,
            notes: booking.notes ?? "",
            title: booking.title ?? "",
            description: booking.description ?? "",
          },
          { durationMin: editDuration, notes: editNotes, title: editTitle, description: editDescription }
        ))) ||
      (editingWhen && newWhenLocal !== isoToARLocalInput(booking.scheduledFor)) ||
      (editingRoom && roomDraft !== (booking.roomId ?? NO_ROOM_VALUE)));


  /** Dirty-guard de las salidas de la fila Plan (diálogo o navegación). */
  const confirmDiscard = async () => {
    if (!dirty) return true;
    return confirm({
      title: "¿Descartar los cambios?",
      message: "Tenés cambios del turno sin guardar. Si seguís, se pierden.",
      confirmLabel: "Descartar",
      cancelLabel: "Seguir editando",
      tone: "danger",
    });
  };

  const openPlanDialog = async (d: PlanDialog) => {
    if (!(await confirmDiscard())) return;
    setPlanDialog(d);
    onClose();
  };

  // P3.Z (F3a): "Crear plan desde este turno" / "Ver plan" eran `<Link>` y
  // salían de la agenda sin pasar por el dirty-guard.
  /** EV2-3b: «Cargar evolución» de la fila: cierra el drawer (dirty-guard) y abre el editor afuera. */
  const openNoteEditor = async () => {
    if (!booking?.patientId) return;
    if (!(await confirmDiscard())) return;
    setNoteEditor(noteTargetOf(booking, booking.patientId));
    onClose();
  };

  const navigateFromPlanRow = async (href: string) => {
    if (!(await confirmDiscard())) return;
    onClose();
    router.push(href);
  };

  return (
    <>
    <Drawer
      open={!!booking}
      onClose={onClose}
      title={booking ? "Turno" : undefined}
      dirty={dirty}
      dirtyMessage="Tenés cambios del turno sin guardar. Si cerrás, se pierden."
    >
      {booking && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <PatientHeader booking={booking} />

          <div style={{ ...sectionCard, display: "grid", gap: 8, fontSize: 12.5 }}>
            <BillingRows booking={booking} />
            <ReceptionInfo
              booking={booking}
              room={
                roomModel?.visible ? (
                  <RoomRow
                    model={roomModel}
                    canOperate={canOperate}
                    cancelled={booking.status === "CANCELLED"}
                    pending={pending}
                    editing={editingRoom}
                    draft={roomDraft}
                    onOpen={() => {
                      setRoomDraft(booking.roomId ?? NO_ROOM_VALUE);
                      setEditingRoom(true);
                    }}
                    onCancel={() => {
                      setEditingRoom(false);
                      setRoomDraft(booking.roomId ?? NO_ROOM_VALUE);
                    }}
                    onDraftChange={setRoomDraft}
                    onSubmit={(id) => submitRoom(id)}
                  />
                ) : undefined
              }
            />
            {!canOperate && (
              <div style={{ fontSize: 11.5, color: "var(--navy-500)", marginTop: 4 }}>
                Tenés acceso básico a este paciente: podés ver el turno pero no modificarlo. Pedile al
                profesional a cargo que te lo comparta.
              </div>
            )}
            {canOperate && (
              <EditToggles
                status={booking.status}
                pending={pending}
                editingWhen={editingWhen}
                editingDetails={editingDetails}
                onCancelReschedule={() => {
                  setEditingWhen(false);
                  setReschConflict(null);
                }}
                onOpenReschedule={() => {
                  setEditingWhen(true);
                  setEditingDetails(false);
                }}
                onCancelEdit={() => {
                  setEditingDetails(false);
                  resetEditFields();
                }}
                onOpenEdit={() => {
                  setEditingDetails(true);
                  setEditingWhen(false);
                }}
              />
            )}
          </div>

          {planModel && (
            <PlanRow
              booking={booking}
              model={planModel}
              nextSession={nextSession}
              pending={pending}
              onSchedule={() => {
                if (nextSession && typeof booking.programId === "string")
                  void openPlanDialog({
                    kind: "schedule",
                    programId: booking.programId,
                    sessionId: nextSession.sessionId,
                    sessionLabel: planSessionLabel(nextSession.ordinal, nextSession.totalLive),
                  });
              }}
              onRemove={removeFromPlan}
              onLink={() => void openPlanDialog({ kind: "link", booking })}
              onRenewAuthorization={() => {
                if (booking.patientId && typeof booking.programId === "string")
                  void openPlanDialog({ kind: "renew", programId: booking.programId, patientId: booking.patientId });
              }}
              onNavigate={(href) => void navigateFromPlanRow(href)}
            />
          )}

          {booking.patientId && (
            <ClinicalNoteRow
              view={noteRowEligible ? noteView : null}
              patientId={booking.patientId}
              bookingId={booking.id}
              pending={pending}
              onCreate={() => void openNoteEditor()}
              onNavigate={(href) => void navigateFromPlanRow(href)}
            />
          )}

          {clinicalWritable && <RecentBookings recent={recent} patientId={booking.patientId} />}

          {canOperate && editingDetails && (
            <EditDetailsForm
              booking={booking}
              clinicalWritable={clinicalWritable}
              notesWritable={notesWritable}
              values={{
                duration: editDuration,
                title: editTitle,
                description: editDescription,
                notes: editNotes,
              }}
              pending={pending}
              conflict={editConflict?.prompt ?? null}
              onPatientChange={(p) => setEditPatient(p)}
              onChange={(patch) => {
                if (patch.duration !== undefined) setEditDuration(patch.duration);
                if (patch.title !== undefined) setEditTitle(patch.title);
                if (patch.description !== undefined) setEditDescription(patch.description);
                if (patch.notes !== undefined) setEditNotes(patch.notes);
              }}
              onApplyAsPatientDiagnosis={diagnosisModule ? applyAsPatientDiagnosis : undefined}
              onSubmit={() => submitEditDetails()}
              onForce={() => {
                if (editConflict) submitEditDetails(withForce(editConflict.sent, editConflict.prompt));
              }}
              onDismissConflict={() => setEditConflict(null)}
            />
          )}

          {canOperate && editingWhen && (
            <RescheduleForm
              booking={booking}
              capabilities={caps}
              onSeriesMoved={() => {
                // S19d H1: "Este y los siguientes" movió la serie por el motor.
                setEditingWhen(false);
                setReschConflict(null);
                onSaved();
              }}
              value={newWhenLocal}
              onChange={(v) => {
                setNewWhenLocal(v);
                setReschConflict(null);
              }}
              pending={pending}
              conflict={reschConflict?.prompt ?? null}
              onSubmit={() => submitReschedule()}
              onUseNextFree={(iso) => submitReschedule({ iso })}
              onForce={() => {
                if (!reschConflict) return;
                // Same slot that produced the warning (the input was synced to it).
                submitReschedule({ force: withForce(reschConflict.sent, reschConflict.prompt) });
              }}
              onDismissConflict={() => setReschConflict(null)}
            />
          )}

          {booking.patientId && (
            <Link
              href={`/pacientes/${booking.patientId}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 14px",
                borderRadius: 12,
                background: booking.patientAccess === "basic" ? "rgba(15,30,51,0.08)" : "var(--sky-700)",
                color: booking.patientAccess === "basic" ? "var(--navy-700)" : "#fff",
                fontWeight: 700,
                textDecoration: "none",
                fontSize: 13,
              }}
            >
              {booking.patientAccess === "basic" ? "Ver datos básicos" : "Abrir historia clínica"}
              <span aria-hidden>→</span>
            </Link>
          )}

          <ShareActions booking={booking} />

          {canOperate && (
            <StatusActions
              pending={pending}
              onSetStatus={(s) => setStatus(s)}
              planSession={isPlanBooking ? { ordinal: planOrdinal } : null}
            />
          )}

          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                background: "var(--danger-bg)",
                color: "var(--danger-fg)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {canDelete &&
            typeof booking.programId === "string" &&
            (booking.status === "PENDING" || booking.status === "CONFIRMED") && (
            // S19c · C13 "Cancelalo" en lugar de "Eliminar". Mismo permiso que
            // Eliminar (la regla vigente); sin C9 queda Eliminar y decide el server.
            // P3.Z (F3a): solo en un turno activo. En un Realizado o Ausente
            // ofrecía cancelar un turno que ya pasó (y liberar su sesión).
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>
              <span>Es de un plan: no se elimina.</span>
              <button
                type="button"
                onClick={cancelPlanBooking}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--danger-fg)",
                  cursor: "pointer",
                  fontSize: 12.5,
                  fontWeight: 700,
                  padding: 0,
                }}
              >
                Cancelalo
              </button>
            </div>
          )}

          {canDelete && typeof booking.programId !== "string" && (
            <DeleteBookingButton
              onDelete={remove}
              pending={pending}
              blockedByNote={bookingHasClinicalNote(noteRowEligible ? noteView : null)}
            />
          )}
        </div>
      )}
    </Drawer>
      {/* S19c: diálogos de la fila Plan (cada uno carga lo suyo al abrir; el
          drawer no trae la autorización de la OS, E2). */}
      {planDialog?.kind === "schedule" && (
        <ScheduleSessionModal
          open
          onClose={() => setPlanDialog(null)}
          onScheduled={() => {
            setPlanDialog(null);
            onSaved();
          }}
          programId={planDialog.programId}
          sessionId={planDialog.sessionId}
          sessionLabel={planDialog.sessionLabel}
        />
      )}
      {planDialog?.kind === "link" && (
        <LinkSessionModal
          open
          booking={planDialog.booking}
          onClose={() => setPlanDialog(null)}
          onLinked={() => {
            setPlanDialog(null);
            onSaved();
          }}
        />
      )}
      {noteEditor && (
        <NoteEditorDrawer
          open
          onClose={() => setNoteEditor(null)}
          mode={{
            type: "create",
            patientId: noteEditor.patientId,
            patientName: noteEditor.patientName,
            booking: noteEditor.booking,
          }}
          // El editor ya muestra su toast de guardado; la agenda no cambia.
          onSaved={() => {}}
        />
      )}
      {planDialog?.kind === "renew" && (
        <RenewAuthorizationDialog
          open
          programId={planDialog.programId}
          patientId={planDialog.patientId}
          onClose={() => setPlanDialog(null)}
          onChanged={(done) => {
            setPlanDialog(null);
            // Contrato `PlanEditDone` (S22e): el éxito lo muestra el diálogo;
            // el caller solo el `notice` (si no, salía dos veces).
            if (done.notice) toast.info(done.notice);
          }}
          // Sin `current`, el diálogo se recarga solo y muestra el copy de stale.
        />
      )}
    </>
  );
}

/** EV2-3b: blanco del editor «Cargar evolución» (el drawer ya se cerró). */
export type NoteEditorTarget = {
  patientId: string;
  /** EV2-Z A1: el editor se abre con el drawer ya cerrado: sin esto no decía de qué paciente era. */
  patientName: string;
  booking: { id: string; scheduledFor: string; serviceName: string | null };
};

export function noteTargetOf(booking: DrawerBooking, patientId: string): NoteEditorTarget {
  return {
    patientId,
    patientName: booking.patientName,
    booking: { id: booking.id, scheduledFor: booking.scheduledFor, serviceName: booking.serviceName ?? null },
  };
}

/** Diálogo abierto desde la fila Plan, con su blanco (el drawer ya se cerró). */
type PlanDialog =
  | { kind: "schedule"; programId: string; sessionId: string; sessionLabel: string }
  | { kind: "link"; booking: PlanRowBooking }
  | { kind: "renew"; programId: string; patientId: string };
