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
 * Pure UI — every mutation goes through server actions in `lib/bookings.ts`.
 */
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { IconCheck } from "@/components/ui/icons";
import {
  deleteBooking,
  setBookingStatus,
  updateBooking,
} from "@/lib/bookings";
import { getPatientBookingsSummary, setPatientDiagnosis } from "@/lib/patients";
import type { PatientBookingSummary } from "@/lib/patients-types";
import { formatDateAR } from "@/lib/format";
import { localToARIso, isoToARLocalInput, toARDateKey } from "@/lib/datetime-ar";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PatientPicker, type PickedPatient } from "@/components/patients/patient-picker";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { recordatorioHtml } from "@/components/agenda/recordatorio-turno";
import type { BookingStatus } from "@prisma/client";

type BookingDTO = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
  serviceColor: string | null;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  obraSocial: string;
  copagoCents: number;
  /** Row version for optimistic concurrency (Booking.updatedAt, ISO). */
  updatedAt: string;
  notes: string | null;
  title: string | null;
  description: string | null;
  patientAccess: "full" | "basic" | "none";
};

/** Cents → "$1.234" (AR pesos, no decimals). */
function fmtMoney(cents: number) {
  return (cents / 100).toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Obra social name to show, or "" when particular (never prints the
 *  literal "Particular" / "Obra social" words). */
function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

const menuLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  padding: "0 4px 6px",
};

const miniGhostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.1)",
  borderRadius: 999,
  padding: "5px 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

export function BookingDrawer({
  booking,
  onClose,
  onSaved,
}: {
  booking: BookingDTO | null;
  onClose: () => void;
  onSaved: () => void;
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
  const [reschConflict, setReschConflict] = useState<
    { practitionerName: string; nextFreeISO: string | null } | null
  >(null);
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

  // Reset reschedule state every time a different booking opens.
  // Uses AR-formatted Intl output instead of `Date.prototype.getHours()`
  // so the input shows the same wall-clock as the agenda regardless of
  // the runtime's local timezone.
  useEffect(() => {
    setEditingWhen(false);
    setEditingDetails(false);
    setReschConflict(null);
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
    // Preview: the patient's two most recent OTHER turnos.
    let cancelled = false;
    if (booking?.patientId) {
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

  const STATUS_TOAST: Partial<Record<BookingStatus, string>> = {
    CONFIRMED: "Turno confirmado",
    COMPLETED: "Turno marcado como realizado",
    NO_SHOW: "Turno marcado como ausente",
    CANCELLED: "Turno cancelado",
  };

  const setStatus = (status: BookingStatus) => {
    if (!booking) return;
    setError(null);
    start(async () => {
      const r = await setBookingStatus(booking.id, status, booking.updatedAt);
      if (!r.ok) {
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

  const submitEditDetails = () => {
    if (!booking) return;
    setError(null);
    start(async () => {
      const dur = Math.max(15, Math.min(240, Math.floor(editDuration) || 45));
      // `editPatient === undefined` → don't include patientId in the
      // patch (server keeps the current link).
      // `editPatient === null` → user cleared the link explicitly.
      // `editPatient.id` → server validates tenant + relinks.
      const patientId =
        editPatient === undefined
          ? undefined
          : editPatient === null
            ? ""
            : editPatient.id;
      const r = await updateBooking({
        id: booking.id,
        durationMin: dur,
        notes: editNotes,
        title: editTitle,
        description: editDescription,
        expectedUpdatedAt: booking.updatedAt,
        ...(patientId !== undefined ? { patientId } : {}),
      });
      if (!r.ok) {
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
  const applyAsPatientDiagnosis = () => {
    if (!booking?.patientId) return;
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

  const submitReschedule = (opts: { iso?: string; force?: boolean } = {}) => {
    if (!booking) return;
    // The datetime-local input is AR wall-clock; tag it with the
    // -03:00 offset before sending so the server parses unambiguously.
    // If a server-suggested slot ISO is passed in, it's already
    // unambiguous and we forward as-is.
    const iso = opts.iso ?? localToARIso(newWhenLocal);
    setError(null);
    setReschConflict(null);
    start(async () => {
      const r = await updateBooking({
        id: booking.id,
        scheduledFor: iso,
        allowOverbooking: opts.force ?? false,
        expectedUpdatedAt: booking.updatedAt,
      });
      if (!r.ok) {
        if (r.conflict) {
          setReschConflict(r.conflict);
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

  // Recordatorio imprimible / PDF — abre una ventana nueva con el HTML
  // autocontenido y dispara el diálogo de impresión del navegador (que
  // ofrece "Guardar como PDF"). Evitamos `window.print()` sobre la página
  // actual para no imprimir toda la app.
  const printRecordatorio = () => {
    if (!booking) return;
    const w = window.open("", "_blank", "width=480,height=640");
    if (w) {
      w.document.write(recordatorioHtml(booking));
      w.document.close();
      w.focus();
      w.print();
    }
  };

  return (
    <Drawer open={!!booking} onClose={onClose} title={booking ? "Turno" : undefined}>
      {booking && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: "rgba(255,255,255,0.6)",
              border: "1px solid rgba(15,30,51,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Avatar name={booking.patientName} size={44} tone="sky" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--navy-900)" }}>
                {booking.patientName}
              </div>
              {booking.patientCondition && (
                <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{booking.patientCondition}</div>
              )}
            </div>
            <StatusTag s={booking.status} />
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: "rgba(246,249,253,0.7)",
              border: "1px solid rgba(15,30,51,0.06)",
              display: "grid",
              gap: 8,
              fontSize: 12.5,
            }}
          >
            <Row label="Cuándo">
              {new Date(booking.scheduledFor).toLocaleString("es-AR", {
                weekday: "long",
                day: "2-digit",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "America/Argentina/Buenos_Aires",
              })}
            </Row>
            <Row label="Duración">{booking.durationMin} min</Row>
            <Row label="Servicio">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: booking.serviceColor ?? SERVICE_COLOR_FALLBACK,
                    flexShrink: 0,
                  }}
                />
                {booking.serviceName}
              </span>
            </Row>
            {osLabel(booking.obraSocial) && (
              <Row label="Obra social">{osLabel(booking.obraSocial)}</Row>
            )}
            <Row label="Copago">
              <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>
                {fmtMoney(booking.copagoCents)}
              </span>
            </Row>
            {booking.title && <Row label="Diagnóstico">{booking.title}</Row>}
            {booking.description && <Row label="Descripción">{booking.description}</Row>}
            {booking.notes && <Row label="Notas">{booking.notes}</Row>}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4, gap: 6, flexWrap: "wrap" }}>
              {editingWhen ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditingWhen(false);
                    setReschConflict(null);
                  }}
                  disabled={pending}
                  style={miniGhostBtn}
                >
                  Cancelar reprogramación
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingWhen(true);
                    setEditingDetails(false);
                  }}
                  style={miniGhostBtn}
                  disabled={booking.status === "CANCELLED"}
                  title={booking.status === "CANCELLED" ? "El turno está cancelado" : "Mover este turno a otro horario"}
                >
                  Reprogramar
                </button>
              )}
              {editingDetails ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditingDetails(false);
                    setEditDuration(booking.durationMin);
                    setEditNotes(booking.notes ?? "");
                  }}
                  disabled={pending}
                  style={miniGhostBtn}
                >
                  Cancelar edición
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingDetails(true);
                    setEditingWhen(false);
                  }}
                  style={miniGhostBtn}
                  disabled={booking.status === "CANCELLED"}
                  title="Editar duración + notas del turno"
                >
                  Editar
                </button>
              )}
            </div>
          </div>

          {recent.length > 0 && (
            <div
              style={{
                padding: 14,
                borderRadius: 14,
                background: "rgba(246,249,253,0.7)",
                border: "1px solid rgba(15,30,51,0.06)",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--navy-300)" }}>
                Últimos turnos
              </div>
              {recent.map((r) => (
                <Link
                  key={r.id}
                  href={`/agenda?view=timeline&date=${toARDateKey(r.scheduledFor)}`}
                  style={{
                    display: "block",
                    padding: "8px 10px",
                    borderRadius: 10,
                    background: "#fff",
                    border: "1px solid rgba(15,30,51,0.06)",
                    textDecoration: "none",
                    color: "var(--navy-900)",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {formatDateAR(r.scheduledFor, "weekdayDayMonth")}
                    <span style={{ color: "var(--navy-300)", fontWeight: 500 }}> · {r.serviceName}</span>
                  </div>
                  {(r.title || r.notes) && (
                    <div style={{ fontSize: 11, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.title || r.notes}
                    </div>
                  )}
                </Link>
              ))}
              {booking.patientId && (
                <Link
                  href={`/pacientes/${booking.patientId}`}
                  style={{ fontSize: 11.5, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none" }}
                >
                  Ver historia clínica completa →
                </Link>
              )}
            </div>
          )}

          {editingDetails && (
            <div
              style={{
                padding: 14,
                borderRadius: 14,
                background: "rgba(200,245,100,0.08)",
                border: "1px solid rgba(200,245,100,0.4)",
                display: "grid",
                gap: 10,
              }}
            >
              {/* Patient picker — initialPatientId comes from the
                  current booking so the row shows "selected" first.
                  Clearing replaces with a search input; user can pick
                  a different patient or create one inline (firstName +
                  lastName fields). */}
              <PatientPicker
                label="Paciente del turno"
                initialPatientId={booking.patientId ?? null}
                initialPatients={
                  booking.patientId
                    ? [{ id: booking.patientId, name: booking.patientName }]
                    : []
                }
                onChange={(p) => setEditPatient(p)}
              />
              <label style={{ display: "block", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Duración (min)
              </label>
              <input
                type="number"
                min={15}
                max={240}
                step={15}
                value={editDuration}
                onChange={(e) => setEditDuration(Number(e.target.value))}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(15,30,51,0.1)",
                  background: "#fff",
                  fontSize: 13,
                  width: 120,
                }}
              />
              <label style={{ display: "block", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Título (diagnóstico)
              </label>
              <input
                type="text"
                maxLength={80}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="ej: Lumbalgia — se autocompleta del paciente"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(15,30,51,0.1)",
                  background: "#fff",
                  fontSize: 13,
                }}
              />
              <label style={{ display: "block", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Descripción
              </label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
                placeholder="Detalle del diagnóstico para este turno…"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(15,30,51,0.1)",
                  background: "#fff",
                  fontSize: 13,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
              {booking.patientId && (
                <button
                  type="button"
                  onClick={applyAsPatientDiagnosis}
                  disabled={pending}
                  style={{ ...miniGhostBtn, alignSelf: "flex-start" }}
                  title="Guardar este título y descripción como el diagnóstico del paciente (se aplica a sus turnos futuros)"
                >
                  Usar como diagnóstico del paciente
                </button>
              )}
              <label style={{ display: "block", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Notas
              </label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={3}
                placeholder="Observaciones del turno…"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(15,30,51,0.1)",
                  background: "#fff",
                  fontSize: 13,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  variant="primary"
                  onClick={submitEditDetails}
                  disabled={pending}
                  style={{ fontSize: 12, padding: "8px 14px" }}
                >
                  {pending ? "Guardando…" : "Guardar cambios"}
                </Button>
              </div>
            </div>
          )}

          {editingWhen && (
            <div
              style={{
                padding: 14,
                borderRadius: 14,
                background: "rgba(31,79,190,0.05)",
                border: "1px solid rgba(31,79,190,0.15)",
                display: "grid",
                gap: 10,
              }}
            >
              <label style={{ display: "block", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Nueva fecha y hora
              </label>
              <DateTime24Picker
                value={newWhenLocal}
                onChange={(v) => {
                  setNewWhenLocal(v);
                  setReschConflict(null);
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  variant="primary"
                  onClick={() => submitReschedule()}
                  disabled={pending}
                  style={{ fontSize: 12, padding: "8px 14px" }}
                >
                  {pending ? "Guardando…" : "Guardar nuevo horario"}
                </Button>
              </div>

              {reschConflict && (
                <div
                  role="alert"
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    background: "rgba(255,176,32,0.12)",
                    border: "1px solid rgba(255,176,32,0.4)",
                    fontSize: 12,
                    color: "var(--navy-700)",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ fontWeight: 700, color: "var(--navy-900)" }}>
                    ⚠ {reschConflict.practitionerName} ya tiene un turno en ese horario.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {reschConflict.nextFreeISO && (
                      <button
                        type="button"
                        onClick={() => submitReschedule({ iso: reschConflict.nextFreeISO! })}
                        disabled={pending}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 999,
                          background: "var(--sky-700)",
                          color: "#fff",
                          fontSize: 11.5,
                          fontWeight: 600,
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Usar próximo libre ·{" "}
                        {new Date(reschConflict.nextFreeISO).toLocaleString("es-AR", {
                          weekday: "short",
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                          timeZone: "America/Argentina/Buenos_Aires",
                        })}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => submitReschedule({ force: true })}
                      disabled={pending}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 999,
                        background: "rgba(255,176,32,0.9)",
                        color: "var(--navy-900)",
                        fontSize: 11.5,
                        fontWeight: 600,
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Forzar sobreturno
                    </button>
                    <button
                      type="button"
                      onClick={() => setReschConflict(null)}
                      disabled={pending}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 999,
                        background: "transparent",
                        color: "var(--navy-500)",
                        fontSize: 11.5,
                        fontWeight: 600,
                        border: "1px solid rgba(15,30,51,0.12)",
                        cursor: "pointer",
                      }}
                    >
                      Volver atrás
                    </button>
                  </div>
                </div>
              )}
            </div>
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

          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: "rgba(246,249,253,0.7)",
              border: "1px solid rgba(15,30,51,0.06)",
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ display: "grid", gap: 2 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--navy-300)",
                }}
              >
                Compartir
              </div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                Enviale al paciente un recordatorio de este turno.
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(
                  `Hola ${booking.patientName}, te recordamos tu turno para ${booking.serviceName} el ${formatDateAR(
                    booking.scheduledFor,
                    "longDateTime"
                  )} (duración ${booking.durationMin} min). ¡Te esperamos!`
                )}`}
                target="_blank"
                rel="noopener"
                style={{
                  ...miniGhostBtn,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  textDecoration: "none",
                }}
              >
                Compartir por WhatsApp
              </a>
              <button
                type="button"
                onClick={printRecordatorio}
                style={{ ...miniGhostBtn, display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Abre el recordatorio en una ventana para imprimir o guardar como PDF"
              >
                Imprimir / Guardar PDF
              </button>
            </div>
          </div>

          <div>
            <div style={menuLabel}>Cambiar estado</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <Button
                variant="primary"
                onClick={() => setStatus("CONFIRMED")}
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                Confirmar
              </Button>
              <Button
                variant="lime"
                onClick={() => setStatus("COMPLETED")}
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                <IconCheck size={12} stroke={3} /> Realizado
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStatus("NO_SHOW")}
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                Ausente
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStatus("CANCELLED")}
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                Cancelar
              </Button>
            </div>
          </div>

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
        </div>
      )}
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div
        style={{
          width: 80,
          fontSize: 10.5,
          color: "var(--navy-300)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, color: "var(--navy-900)", fontWeight: 500 }}>{children}</div>
    </div>
  );
}

function StatusTag({ s }: { s: BookingStatus }) {
  const map: Record<BookingStatus, { label: string; bg: string; color: string }> = {
    PENDING: { label: "Pendiente", bg: "rgba(15,30,51,0.06)", color: "var(--navy-700)" },
    CONFIRMED: { label: "Confirmado", bg: "rgba(31,79,190,0.12)", color: "var(--sky-700)" },
    COMPLETED: { label: "Hecho", bg: "rgba(200,245,100,0.3)", color: "var(--navy-900)" },
    NO_SHOW: { label: "Ausente", bg: "rgba(228,70,70,0.12)", color: "#9F1F1F" },
    CANCELLED: { label: "Cancelado", bg: "rgba(15,30,51,0.06)", color: "var(--navy-300)" },
  };
  const m = map[s];
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: 999,
        background: m.bg,
        color: m.color,
      }}
    >
      {m.label}
    </span>
  );
}
