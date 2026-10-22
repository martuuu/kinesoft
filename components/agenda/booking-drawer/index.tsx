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
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Drawer, focusFirstField } from "@/components/ui/drawer";
import { Skel } from "@/components/ui/skeleton";
import { buttonClassName } from "@/components/ui/button";
import styles from "./booking-drawer.module.css";
import {
  deleteBooking,
  markReceptionAction,
  setBookingStatus,
  updateBooking,
} from "@/lib/bookings";
import type { ReceptionActionResult } from "@/lib/bookings-types";
import type { ReceptionAction } from "@/lib/reception-state";
import { isStaleError } from "@/lib/reception-view-state";
import { getPatientBookingsSummary, setPatientDiagnosis } from "@/lib/patients";
import type { PatientBookingSummary } from "@/lib/patients-types";
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { PickedPatient } from "@/components/patients/patient-picker";
import { recordsDiffer } from "@/lib/form-dirty";
import type { BookingStatus } from "@prisma/client";
import { BillingRows, type CopagoChange } from "./billing-rows";
import { EditDetailsForm } from "./edit-details-form";
import { EditToggles } from "./edit-toggles";
import { PatientHeader } from "./patient-header";
import { RecentBookings } from "./recent-bookings";
import { ShareActions } from "./share-actions";
import {
  DeleteBookingButton,
  StatusActions,
  cancelBookingConfirm,
  bookingHasClinicalNote,
  clinicalNoteRowEligible,
  offersNoteAfterStatus,
  statusToastPayload,
} from "./status-actions";
import type { BookingClinicalNoteView } from "@/lib/clinical-notes-types";
import type { FichaDrawerProps, FichaFormCreateMode } from "@/components/fichas/fichas-ui-types";
import { sectionCard } from "./styles";
import { successInfoText } from "./force-outcome";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
} from "@/lib/booking-force-flags";
import { capabilitySet } from "@/lib/agenda-client-state";
import { canCollectCopago } from "@/lib/capabilities";
import { PLAN_PATIENT_CHANGE_ERROR } from "@/lib/bookings-constants";
import { listSchedulablePlanSessions } from "@/lib/plans-read";
import { removeBookingFromPlan } from "@/lib/plans-adopt";
import type { SchedulablePlanSession } from "@/lib/plans-read-types";
import { planSessionLabel } from "@/lib/plan-display";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { planUiPermissions } from "@/components/planes/plan-editor-types";
import {
  LinkSessionModal,
  PlanRow,
  drawerPlanModel,
  pickNextPlanSession,
  type PlanRowBooking,
} from "./plan-row";
import { planStatusToastDescription } from "./status-actions";
import { ReceptionInfo } from "./reception-info";
import { ReceptionActions, drawerReceptionActions, receptionToastTitle } from "./reception-actions";
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

// EV2-3b: la fila «Ficha» (con `NoteCard`) y el editor van en chunks
// aparte: solo los usa quien tiene `clinical.read`, y la Secretaria (la que más
// vive en la agenda) no los descarga. La lectura `getBookingClinicalNote` se
// importa al usarla por lo mismo (y para que el drawer no arrastre el módulo de
// actions de la historia clínica a quien no lo usa).
// [PF1.2 · C-PF2] Lo que se abre tras un click (reprogramar, agendar la próxima sesión del plan) va en chunks aparte:
// abrir el turno no los espera. «Reprogramar» se precarga al pasar el puntero o el foco por la fila de acciones
// (`EditToggles`), y su skeleton tiene el alto del form para que el panel no salte.
const loadRescheduleForm = () => import("./reschedule-form");
const RescheduleForm = dynamic(() => loadRescheduleForm().then((m) => m.RescheduleForm), {
  ssr: false,
  loading: () => <Skel h={160} r={12} />,
});
const ScheduleSessionModal = dynamic(
  () => import("@/components/seguimiento/schedule-session-modal").then((m) => m.ScheduleSessionModal),
  { ssr: false }
);

const ClinicalNoteRow = dynamic(() => import("./clinical-note-row").then((m) => m.ClinicalNoteRow), {
  ssr: false,
});
// [FC-3h] «Cargar ficha» (fila y toast de Realizado) abre el MISMO `FichaDrawer` que la HC del perfil, con el MISMO
// especificador que `evoluciones-view.tsx`: webpack reusa ese chunk y el runtime (que suma ~20 B por chunk diferido en
// TODAS las rutas) no crece; /agenda no tenía margen (FC-3i1). Antes pasaba por el shim de EV2 `note-editor-drawer`.
const FichaDrawer = dynamic<FichaDrawerProps>(
  () => import("@/components/fichas/ficha-drawer").then((m) => m.FichaDrawer),
  { ssr: false }
);
// [TP-3c] Plata online del turno (seña, comprobante, link de pago): chunk aparte (§25.11 «drawer, sección,
// comprobante y link diferidos»). Solo se monta con algo que mostrar (`moneySectionWanted`): un turno sin plata online
// de un consultorio sin cobros online no la baja. El comprobante y el `PaymentLinkDrawer` son a su vez diferidos
// desde la sección (`tests/unit/online-payments-first-load-guard.test.ts`).
const BookingMoneySection = dynamic(
  () => import("@/components/payments/booking-money-section").then((m) => m.BookingMoneySection),
  { ssr: false }
);

/**
 * [TP-3c] ¿Se monta la sección de plata online? Con plata online en el cable (la misma cuenta que `onlineMoneyHint`
 * de la sección, repetida acá porque importarla haría estático el módulo de T5 en el chunk del drawer) o, si el
 * consultorio cobra online (`onlineMoney`), para ofrecer «Generar link de pago» a quien cobra un turno por cobrar con
 * paciente. Puro, para el test.
 */
export function moneySectionWanted(
  b: Pick<DrawerBooking, "onlineDepositCents" | "paidOnline" | "paymentStatus" | "patientId" | "status">,
  o: { canCollect: boolean; onlineMoney: boolean }
): boolean {
  const hinted =
    (b.onlineDepositCents ?? 0) > 0 || b.paidOnline === true || b.paymentStatus === "AUTHORIZED" || b.paymentStatus === "REFUNDED";
  if (hinted) return true;
  return o.onlineMoney && o.canCollect && !!b.patientId && (b.paymentStatus === "UNPAID" || b.paymentStatus === "FAILED") && b.status !== "CANCELLED";
}

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
  booking: bookingProp,
  onClose,
  onSaved,
  capabilities,
  viewerPractitionerId,
  practitionerName = null,
  rooms,
  primaryLocationId,
  onlineMoney = false,
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
  /** T3d-1r: profesional del actor, para `canCollectCopago` (el profesional cobra solo sus turnos). */
  viewerPractitionerId?: string | null;
  /**
   * T3-Y: nombre público del profesional DEL TURNO (no del actor), para «Se imputa a …» del modal de cobro. Lo
   * resuelve la agenda con su lista de profesionales; null = no está en la lista.
   */
  practitionerName?: string | null;
  /**
   * [TP-3c] El consultorio cobra online (Mercado Pago conectable): habilita «Generar link de pago» en el turno. Sin él
   * (false, el default) la sección solo aparece si el turno ya tiene plata online: con `MP_CONNECT_MODE=off` (prod al
   * arrancar T5) nadie ve un botón que rebota con «no disponible».
   */
  onlineMoney?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // HF-2c: lo que devolvió `markReceptionAction` para el turno abierto. Las acciones de recepción NO cierran el
  // drawer (la Secretaria marca «Llegó» y sigue con el turno), así que hasta que la agenda traiga la fila nueva
  // (la action revalida /agenda) el drawer se ve con la respuesta del server. Sin esto, el próximo click (otra
  // acción de recepción, Cambiar estado, Reprogramar) salía con el `updatedAt` viejo y rebotaba por stale. Se
  // descarta solo cuando la fila del padre es igual o más nueva (mismo criterio que `mergeReceptionOverrides`).
  const [receptionResult, setReceptionResult] = useState<{ id: string; result: ReceptionActionResult } | null>(null);
  // T3d-1r: lo mismo para un cobro hecho desde el drawer: sin esto, Cambiar estado / Reprogramar después de cobrar
  // salían con el `updatedAt` viejo y rebotaban por stale.
  const [copagoResult, setCopagoResult] = useState<CopagoChange | null>(null);
  const booking: DrawerBooking | null = useMemo(() => {
    if (!bookingProp) return bookingProp;
    let b: DrawerBooking = bookingProp;
    if (receptionResult && receptionResult.id === bookingProp.id) {
      const r = receptionResult.result;
      if (new Date(b.updatedAt).getTime() < new Date(r.updatedAt).getTime()) {
        b = { ...b, status: r.status, arrivedAt: r.arrivedAt, calledAt: r.calledAt, attendingAt: r.attendingAt, updatedAt: r.updatedAt };
      }
    }
    if (copagoResult && copagoResult.id === bookingProp.id && new Date(b.updatedAt).getTime() < new Date(copagoResult.updatedAt).getTime()) {
      b = { ...b, paymentStatus: copagoResult.paymentStatus, copagoPaymentMethod: copagoResult.copagoPaymentMethod, updatedAt: copagoResult.updatedAt };
    }
    return b;
  }, [bookingProp, receptionResult, copagoResult]);
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
  // PF1-Z-F1 (#4): «Reprogramar» abre el form debajo de la tarjeta, fuera de la vista del panel. Al abrir, foco al
  // primer campo + scroll. El form es un chunk aparte (`dynamic`): si todavía no llegó, se espera a que aparezca.
  const rescheduleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!editingWhen) return;
    const box = rescheduleRef.current;
    if (!box || focusFirstField(box) || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => {
      if (focusFirstField(box)) mo.disconnect();
    });
    mo.observe(box, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [editingWhen]);
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
  // [TP-3c] Mismo gate que «Cobrar» de la fila Copago y que `createPaymentLink` en el server (`canCollectCopago`).
  const collectsThis = booking ? canCollectCopago(caps, viewerPractitionerId ?? null, booking.practitionerId) : false;

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

  // EV2-3b · fila «Ficha». Se pide al abrir el turno y solo si vale la pena
  // (`clinicalNoteRowEligible`: paciente + `clinical.read` + módulo); `null`
  // del server = sin acceso / guest → la fila no se renderiza. El editor de
  // «Cargar ficha» va AFUERA del drawer (como `planDialog`: el panel tiene
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
    // EV2-3b: lectura perezosa de la ficha del turno (ver arriba).
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
      // T3e-2u2: al reactivar, el 2.º turno del intervalo bajo el tope suma el aviso informativo de C-AS3.
      const description =
        successInfoText(r) ?? planStatusToastDescription(status, { isPlan: isPlanBooking, ordinal: planOrdinal });
      // EV2-3b: al marcar Realizado, si el actor puede crear la ficha de
      // ESTE turno (se relee después del cambio: `canCreate` depende del estado),
      // el toast ofrece «Cargar ficha». Solo para quien tiene acceso de
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

  // PF1-Z-F1 (#6): «Cancelar turno» de «Cambiar estado» pasa por confirmación (antes un click). El «Cancelalo» de
  // un turno de plan ya confirma por su lado (`cancelPlanBooking`).
  const confirmCancel = async () => {
    if (!booking) return;
    if (await confirm(cancelBookingConfirm(booking))) setStatus("CANCELLED");
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
      const info = successInfoText(r);
      if (info) toast.info("Turno actualizado", { description: info });
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
      // T3e-2u2 (C-AS3): «Ya hay 1 turno de Ana a las 10:00.» es informativo (no se confirma ni manda flag).
      const info = successInfoText(r);
      if (info) toast.info("Turno reprogramado", { description: info });
      onSaved();
    });
  };

  // P0-S07u (handoff S02p H7): era `patientAccess !== "basic"`, y la
  // Secretaria con Consultorio común (fila "basic" = nivel admin) perdía la
  // edición. Ahora es `canOperate` (guest sigue operable).
  const { canOperate, clinicalWritable, notesWritable, canDelete } = access;
  const roomModel = booking ? drawerRoomModel(booking, rooms, primaryLocationId) : null;

  // HF-2c: «Llegó» · «En atención» · «Deshacer» (y «Llamar» con Sala de Espera). Reglas en `./reception-actions`.
  // El reloj se toma en el render: el drawer se abre con un click (nunca en el SSR) y la única decisión que
  // depende de él es «¿es de hoy?» / demorado, que el server vuelve a validar.
  const receptionNow = new Date();
  const receptionActions = booking
    ? drawerReceptionActions(booking, {
        caps,
        canOperate,
        waitingRoom: tenantModules.has("salaEspera"),
        now: receptionNow,
      })
    : [];

  /**
   * `markReceptionAction` con el lock optimista (`expectedUpdatedAt`). `from` = la versión sobre la que se actúa:
   * la del drawer, o la que devolvió la acción anterior (el «Deshacer» del toast, que puede llegar con el drawer ya
   * cerrado o con otro turno abierto: actúa sobre ESA versión y, si alguien la cambió en el medio, es stale).
   */
  const runReception = (
    action: ReceptionAction,
    from: { id: string; updatedAt: string; patientName: string } | null = booking
  ) => {
    if (!from) return;
    setError(null);
    start(async () => {
      const r = await markReceptionAction(from.id, action, from.updatedAt);
      if (!r.ok) {
        if (isStaleError(r.error)) {
          toast.error("El turno cambió en otra sesión", {
            description: "Traemos la versión nueva de la agenda: revisalo y probá de nuevo.",
          });
          // refresh-ok: con «cambió en otra sesión» la action NO revalida; hay que traer la fila vigente.
          router.refresh();
        } else {
          toast.error("No pudimos actualizar la recepción", { description: r.error });
        }
        return;
      }
      setReceptionResult({ id: from.id, result: r.data });
      const next = { id: from.id, updatedAt: r.data.updatedAt, patientName: from.patientName };
      toast.success(receptionToastTitle(action, from.patientName), {
        ...(r.data.notice ? { description: r.data.notice } : {}),
        ...(action === "deshacer"
          ? {}
          : { action: { label: "Deshacer", onClick: () => runReception("deshacer", next) } }),
      });
    });
  };

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
  /** EV2-3b: «Cargar ficha» de la fila: cierra el drawer (dirty-guard) y abre el editor afuera. */
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
        // MB-1b: `sheet` = targets de 44 px y campos de 16 px en el celular (booking-drawer.module.css).
        <div className={styles.sheet} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <PatientHeader booking={booking} />

          <div style={{ ...sectionCard, display: "grid", gap: 8, fontSize: 12.5 }}>
            <BillingRows
              booking={booking}
              caps={caps}
              viewerPractitionerId={viewerPractitionerId ?? null}
              practitionerName={practitionerName}
              onCopagoChanged={setCopagoResult}
              money={
                moneySectionWanted(booking, { canCollect: collectsThis, onlineMoney }) ? (
                  <BookingMoneySection
                    // Otro turno = otra sección: lo leído (cobros, pista, link) no vale para el siguiente.
                    key={booking.id}
                    booking={{
                      id: booking.id,
                      patientId: booking.patientId,
                      patientName: booking.patientName,
                      practitionerId: booking.practitionerId,
                      practitionerName: practitionerName ?? "",
                      startsAt: booking.scheduledFor,
                      status: booking.status,
                      paymentStatus: booking.paymentStatus ?? "",
                      copagoCents: booking.copagoCents,
                      onlineDepositCents: booking.onlineDepositCents ?? 0,
                      paidOnline: booking.paidOnline === true,
                    }}
                    canCollect={collectsThis && onlineMoney}
                  />
                ) : null
              }
            />
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
            <ReceptionActions
              booking={booking}
              actions={receptionActions}
              pending={pending}
              now={receptionNow}
              onAction={(a) => runReception(a)}
            />
            {!canOperate && (
              <div style={{ fontSize: 11.5, color: "var(--navy-500)", marginTop: 4 }}>
                Tenés acceso básico a este paciente: podés ver el turno pero no modificarlo. Pedile al
                profesional a cargo que te lo comparta.
              </div>
            )}
            {canOperate && (
              <div onPointerEnter={() => void loadRescheduleForm()} onFocus={() => void loadRescheduleForm()}>
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
              </div>
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
            <div ref={rescheduleRef}>
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
            </div>
          )}

          {booking.patientId && (
            <Link
              href={`/pacientes/${booking.patientId}`}
              className={buttonClassName({ variant: "ghost", block: true, className: styles.hcLink })}
            >
              {booking.patientAccess === "basic" ? "Ver datos básicos" : "Abrir historia clínica"}
              <span aria-hidden>→</span>
            </Link>
          )}

          <ShareActions booking={booking} />


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

          {/* G7: «Cambiar estado» + el error, pegados al pie (sticky) con separador. Eliminar/Cancelalo quedan
              arriba, en el cuerpo: son destructivos y no van al lado de la primaria. */}
          {(canOperate || error) && (
            <div className={styles.footer} data-drawer-footer="">
              {error && (
                <div
                  role="alert"
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
              {canOperate && (
                <StatusActions
                  pending={pending}
                  onSetStatus={(s) => (s === "CANCELLED" ? void confirmCancel() : setStatus(s))}
                  planSession={isPlanBooking ? { ordinal: planOrdinal } : null}
                  current={booking.status}
                />
              )}
            </div>
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
        <FichaDrawer
          open
          onClose={() => setNoteEditor(null)}
          mode={noteEditor}
          // Ordena el chip y la autoría como en la HC; sin `draftScope`: la agenda no tiene tenant/usuario a mano y el
          // borrador en memoria es del composer del perfil (el Drawer conserva su dirty-guard).
          viewerPractitionerId={viewerPractitionerId ?? null}
          // El form ya muestra su toast de guardado; la agenda no cambia.
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

/**
 * EV2-3b · blanco del editor «Cargar ficha» (el drawer ya se cerró). [FC-3h] Es directamente el `mode` de `FichaDrawer`:
 * - `fixedBooking`: desde un turno el chip queda en ESE turno (no se ofrece cambiarlo). `hasLiveNote: false` porque
 *   solo se llega acá con `canCreate` del server (sin raíz viva); la barrera es `createClinicalNote`.
 * - `patientName` (EV2-Z A1): el editor se abre con el drawer ya cerrado; sin esto no decía de qué paciente era.
 * - `patientHasNotes: true` → arranca en «Evolución»: la agenda no sabe si el paciente tiene fichas (pedirlo sería
 *   otro viaje por turno) y es el caso común de un turno; el tipo se cambia en el radio. Mismo default que el shim.
 */
export type NoteEditorTarget = FichaFormCreateMode & { patientName: string };

export function noteTargetOf(booking: DrawerBooking, patientId: string): NoteEditorTarget {
  return {
    type: "create",
    patientId,
    patientName: booking.patientName,
    patientHasNotes: true,
    fixedBooking: {
      id: booking.id,
      scheduledFor: booking.scheduledFor,
      serviceName: booking.serviceName ?? null,
      status: booking.status,
      practitionerId: booking.practitionerId,
      hasLiveNote: false,
    },
  };
}

/** Diálogo abierto desde la fila Plan, con su blanco (el drawer ya se cerró). */
type PlanDialog =
  | { kind: "schedule"; programId: string; sessionId: string; sessionLabel: string }
  | { kind: "link"; booking: PlanRowBooking }
  | { kind: "renew"; programId: string; patientId: string };
