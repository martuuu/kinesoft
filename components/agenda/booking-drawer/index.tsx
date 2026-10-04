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
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
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
import { STATUS_TOAST, StatusActions } from "./status-actions";
import { sectionCard } from "./styles";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
} from "@/lib/booking-force-flags";
import { capabilitySet } from "@/lib/agenda-client-state";
import { ReceptionInfo } from "./reception-info";
import {
  bookingDrawerAccess,
  type BannerState,
  type BookingDrawerAccess,
  type DrawerBooking,
  type ForceFlags,
} from "./types";

export type { DrawerBooking } from "./types";

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
}: {
  booking: DrawerBooking | null;
  onClose: () => void;
  onSaved: () => void;
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

  const caps = useMemo(() => capabilitySet(capabilities), [capabilities]);
  const access = booking ? bookingDrawerAccess(booking, caps) : CLOSED;

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
      toast.success(STATUS_TOAST[status] ?? "Turno actualizado");
      onSaved();
    });
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
    if (editPatient && editPatient.id !== booking.patientId) changes.patientId = editPatient.id;
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
      onSaved();
    });
  };

  // Write the current title/description as the patient's default diagnosis, so
  // it auto-fills their future turnos.
  // P0-S07u: solo con `clinicalWritable`. Sin él título y descripción llegan
  // null (ocultos) y esto mandaba "" → borraba el diagnóstico del paciente.
  const applyAsPatientDiagnosis = () => {
    if (!booking?.patientId || !access.clinicalWritable) return;
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
      onSaved();
    });
  };

  // P0-S07u (handoff S02p H7): era `patientAccess !== "basic"`, y la
  // Secretaria con Consultorio común (fila "basic" = nivel admin) perdía la
  // edición. Ahora es `canOperate` (guest sigue operable).
  const { canOperate, clinicalWritable, notesWritable, canDelete } = access;

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
      (editingWhen && newWhenLocal !== isoToARLocalInput(booking.scheduledFor)));


  return (
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
            <ReceptionInfo booking={booking} />
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
              onApplyAsPatientDiagnosis={applyAsPatientDiagnosis}
              onSubmit={() => submitEditDetails()}
              onForce={() => {
                if (editConflict) submitEditDetails(withForce(editConflict.sent, editConflict.prompt));
              }}
              onDismissConflict={() => setEditConflict(null)}
            />
          )}

          {canOperate && editingWhen && (
            <RescheduleForm
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

          {canOperate && <StatusActions pending={pending} onSetStatus={(s) => setStatus(s)} />}

          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {canDelete && (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              border: "none",
              color: "#9F1F1F",
              cursor: "pointer",
              fontSize: 12.5,
              fontWeight: 700,
              padding: 0,
              marginTop: 4,
            }}
          >
            Eliminar turno
          </button>
          )}
        </div>
      )}
    </Drawer>
  );
}
