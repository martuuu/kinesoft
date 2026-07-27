"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { motion } from "framer-motion";
import type { BookingStatus } from "@prisma/client";
import { backdropVariants, modalVariants } from "@/lib/motion";
import { useToast } from "@/components/ui/toast";
import { FormField } from "@/components/ui/form-field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { IconArrow, IconCheck, IconX } from "@/components/ui/icons";
import {
  createBooking,
  createBookingsBatch,
  deleteBooking,
  setBookingStatus,
} from "@/lib/bookings";
import { PatientPicker } from "@/components/patients/patient-picker";
import { createPatient, getPatientBillingPreview, setPatientDefaultCopago } from "@/lib/patients";
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";
import type { BookingDTO } from "./agenda-utils";
import type { Props } from "./agenda-client";
import { CopagoRow, DayOfWeekPicker, Select } from "./controls";

export function BookingModal({
  mode,
  booking,
  defaultISO,
  defaultPatientId,
  services,
  practitioners,
  patients,
  insurers,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  booking?: BookingDTO;
  defaultISO?: string;
  defaultPatientId?: string | null;
  services: Props["services"];
  practitioners: Props["practitioners"];
  patients: Props["patients"];
  insurers: Props["insurers"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [conflict, setConflict] = useState<{
    practitionerName: string;
    nextFreeISO: string | null;
    payload: Parameters<typeof createBooking>[0];
  } | null>(null);
  // "Múltiples turnos" toggle — when on, the modal creates `count` individual
  // turnos on the chosen weekdays (NOT a plan/TreatmentProgram).
  const [multiTurno, setMultiTurno] = useState(false);
  const [count, setCount] = useState(2);
  const [weekdays, setWeekdays] = useState<number[]>([]); // 0=Mon..6=Sun
  const [isGuest, setIsGuest] = useState(false);
  // Coverage (obra social) for the inline "Nuevo paciente" form.
  //   "particular"  → no obra social (default)
  //   "ins:<id>"    → a tenant Insurer row
  //   "other"       → free-form name typed by the kine
  const [newCoverage, setNewCoverage] = useState("particular");
  const [newOtherInsurer, setNewOtherInsurer] = useState("");
  // Existing-patient billing: when a registered patient is picked we load
  // their obra social + pre-established copago and show an editable row.
  const [selectedPatient, setSelectedPatient] = useState<{ id: string; name: string } | null>(null);
  const [billing, setBilling] = useState<{ obraSocial: string; copagoCents: number } | null>(null);
  const [copagoInput, setCopagoInput] = useState(0); // cents
  const [copagoLoading, setCopagoLoading] = useState(false);
  const [updateDefaultCopago, setUpdateDefaultCopago] = useState(false);
  const billingSeq = useRef(0);

  const loadPatientBilling = (p: { id: string; name: string } | null) => {
    setSelectedPatient(p);
    setBilling(null);
    setUpdateDefaultCopago(false);
    if (!p) return;
    const seq = ++billingSeq.current;
    setCopagoLoading(true);
    getPatientBillingPreview(p.id)
      .then((res) => {
        if (seq !== billingSeq.current) return; // stale-response guard
        if (res) {
          setBilling(res);
          setCopagoInput(res.copagoCents);
        }
      })
      .finally(() => {
        if (seq === billingSeq.current) setCopagoLoading(false);
      });
  };

  // Deep-link / pre-selected patient: load their billing on mount.
  useEffect(() => {
    if (mode !== "create" || isGuest || !defaultPatientId) return;
    const p = patients.find((x) => x.id === defaultPatientId);
    if (p) loadPatientBilling(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Service-driven duration: picking a service copies its `durationMin`
  // into the editable duration field. Default 45 only until a service is
  // chosen (kine asked: Osteopatía 60' should auto-fill 60, not stay 45).
  const [serviceId, setServiceId] = useState("");
  const [durationMin, setDurationMin] = useState(45);
  const onServiceChange = (id: string) => {
    setServiceId(id);
    const svc = services.find((s) => s.id === id);
    if (svc) setDurationMin(svc.durationMin);
  };

  const finalizeCreate = async (payload: Parameters<typeof createBooking>[0]) => {
    const result = await createBooking(payload);
    if (!result.ok) {
      if (result.conflict) {
        setConflict({
          practitionerName: result.conflict.practitionerName,
          nextFreeISO: result.conflict.nextFreeISO,
          payload,
        });
        setError(null);
        return;
      }
      setError(result.error);
      toast.error("No pudimos crear el turno", { description: result.error });
      return;
    }
    // "Ambas opciones": the turno already carries its own copago override;
    // if the kine confirmed the prompt, also make it the patient's default.
    if (updateDefaultCopago && selectedPatient) {
      await setPatientDefaultCopago({ patientId: selectedPatient.id, copagoCents: copagoInput });
    }
    toast.success("Turno creado");
    onSaved();
  };

  const submit = (formData: FormData) => {
    setError(null);
    setConflict(null);
    start(async () => {
      if (mode === "create") {
        let patientId = String(formData.get("patientId") ?? "") || undefined;

        // "Nuevo paciente" switch: register the patient first, then book
        // the turno against the freshly-created id. Replaces the old
        // guest/externo path — every booking now links a real Patient.
        if (isGuest) {
          const firstName = String(formData.get("newFirstName") ?? "").trim();
          const lastName = String(formData.get("newLastName") ?? "").trim();
          const documentId = String(formData.get("newDocumentId") ?? "").trim();
          if (!firstName || !lastName) {
            setError("Cargá nombre y apellido del nuevo paciente.");
            return;
          }
          if (documentId.length < 4) {
            setError("El DNI es obligatorio (mín. 4 caracteres).");
            return;
          }
          const created = await createPatient({
            firstName,
            lastName,
            documentId,
            phone: String(formData.get("newPhone") ?? "").trim() || undefined,
            // Obra social chosen in the inline form. "particular" → no
            // coverage; "ins:<id>" → tenant insurer; "other" → free-form.
            insurerId: newCoverage.startsWith("ins:") ? newCoverage.slice(4) : undefined,
            insurerName: newCoverage === "other" ? newOtherInsurer.trim() || undefined : undefined,
          });
          if (!created.ok) {
            setError(created.error);
            return;
          }
          patientId = created.data.id;
        }

        if (!patientId) {
          setError("Elegí un paciente o activá «Nuevo paciente» para registrarlo.");
          return;
        }

        const payload = {
          patientId,
          serviceId: String(formData.get("serviceId") ?? ""),
          practitionerId: String(formData.get("practitionerId") ?? ""),
          // AR-tagged: prevents the +3h shift to UTC on the server.
          scheduledFor: localToARIso(String(formData.get("scheduledFor") ?? "")),
          durationMin: Number(formData.get("durationMin")) || 45,
          notes: String(formData.get("notes") ?? "") || undefined,
          // Per-turno copago override — only when the kine actually changed
          // it from the patient's pre-established value.
          copagoCents:
            !isGuest && billing && copagoInput !== billing.copagoCents ? copagoInput : undefined,
        };
        // Múltiples turnos: create `count` individual turnos on the chosen
        // weekdays. No plan/TreatmentProgram. Single turno keeps the full
        // conflict/sobreturno UX via finalizeCreate.
        if (multiTurno && count > 1) {
          const result = await createBookingsBatch({
            ...payload,
            count,
            daysOfWeek: weekdays.length > 0 ? weekdays : undefined,
          });
          if (!result.ok) {
            setError(result.error);
            toast.error("No pudimos crear los turnos", { description: result.error });
            return;
          }
          toast.success("Turnos creados", {
            description: `${result.data.created} de ${result.data.requested} turnos creados${result.data.skipped ? ` · ${result.data.skipped} omitidos por conflicto` : ""}`,
          });
          onSaved();
          return;
        }
        await finalizeCreate(payload);
        return;
      }
      // edit-only flow: status change handled via the buttons below
      onSaved();
    });
  };

  const useSuggestedSlot = () => {
    if (!conflict || !conflict.nextFreeISO) return;
    start(async () => {
      await finalizeCreate({
        ...conflict.payload,
        scheduledFor: conflict.nextFreeISO!,
      });
      setConflict(null);
    });
  };

  const forceOverbooking = () => {
    if (!conflict) return;
    start(async () => {
      await finalizeCreate({ ...conflict.payload, allowOverbooking: true });
      setConflict(null);
    });
  };

  const setStatus = (status: BookingStatus) => {
    if (!booking) return;
    start(async () => {
      const result = await setBookingStatus(booking.id, status);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  };

  const remove = () => {
    if (!booking) return;
    start(async () => {
      const result = await deleteBooking(booking.id);
      if (!result.ok) {
        setError(result.error);
        toast.error("No pudimos eliminar el turno", { description: result.error });
        return;
      }
      toast.success("Turno eliminado");
      onSaved();
    });
  };

  return (
    <motion.div
      role="dialog"
      aria-modal
      onClick={onClose}
      variants={backdropVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <motion.div
        className="k-glass-strong"
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
        style={{ width: "min(560px, 100%)", borderRadius: 24, padding: 22, maxHeight: "calc(100dvh - 40px)", overflowY: "auto" }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h2 className="k-display" style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
            {mode === "create" ? "Nuevo turno" : "Turno"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 32,
              height: 32,
              borderRadius: 10,
              cursor: "pointer",
              color: "var(--navy-700)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <IconX size={14} />
          </button>
        </header>

        {mode === "edit" && booking ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar name={booking.patientName} size={40} tone="sky" />
                <div>
                  <div style={{ fontWeight: 700 }}>{booking.patientName}</div>
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                    {new Date(booking.scheduledFor).toLocaleString("es-AR", {
                      weekday: "long",
                      day: "2-digit",
                      month: "long",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                      timeZone: "America/Argentina/Buenos_Aires",
                    })}
                    {" · "}
                    {booking.durationMin} min · {booking.serviceName}
                  </div>
                </div>
              </div>
            </Card>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
              <Button variant="primary" onClick={() => setStatus("CONFIRMED")} disabled={pending}>
                Confirmar
              </Button>
              <Button variant="lime" onClick={() => setStatus("COMPLETED")} disabled={pending}>
                <IconCheck size={12} stroke={3} /> Marcar realizado
              </Button>
              <Button variant="ghost" onClick={() => setStatus("NO_SHOW")} disabled={pending}>
                Ausente
              </Button>
              <Button variant="ghost" onClick={() => setStatus("CANCELLED")} disabled={pending}>
                Cancelar turno
              </Button>
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

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
              <button
                onClick={remove}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#9F1F1F",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Eliminar
              </button>
              <Button variant="ghost" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : (
          <form action={submit} style={{ display: "grid", gap: 10 }}>
            <Select label="Profesional" name="practitionerId" required>
              {practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select
              label="Servicio"
              name="serviceId"
              required
              value={serviceId}
              onChange={onServiceChange}
            >
              <option value="" disabled>— Seleccioná un servicio —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMin}m
                </option>
              ))}
            </Select>
            {/* Patient / Guest selector */}
            <div>
              {/* Single row: "Paciente *" label on the left, toggle on the right */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Paciente</span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    color: isGuest ? "var(--sky-700)" : "var(--navy-400)",
                  }}
                >
                  Nuevo paciente
                  <span
                    onClick={() => setIsGuest((v) => !v)}
                    role="switch"
                    aria-checked={isGuest}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === " " && setIsGuest((v) => !v)}
                    style={{
                      display: "inline-flex",
                      width: 36,
                      height: 20,
                      borderRadius: 10,
                      background: isGuest ? "var(--sky-700)" : "rgba(15,30,51,0.15)",
                      position: "relative",
                      cursor: "pointer",
                      transition: "background 0.15s",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: 2,
                        left: isGuest ? 18 : 2,
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: "#fff",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                        transition: "left 0.15s",
                      }}
                    />
                  </span>
                </span>
              </label>
              {isGuest ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <FormField label="Nombre" name="newFirstName" required />
                  <FormField label="Apellido" name="newLastName" required />
                  <FormField label="DNI" name="newDocumentId" required />
                  <FormField label="Teléfono" name="newPhone" />
                  <div style={{ gridColumn: "1 / -1" }}>
                    <FormField
                      as="select"
                      label="Obra social"
                      value={newCoverage}
                      onChange={(v) => setNewCoverage(v)}
                      options={[
                        { value: "particular", label: "Particular (sin cobertura)" },
                        ...insurers.map((i) => ({ value: `ins:${i.id}`, label: i.name })),
                        { value: "other", label: "Otra (escribir manualmente)" },
                      ]}
                    />
                  </div>
                  {newCoverage === "other" && (
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FormField
                        label="Nombre de la obra social"
                        value={newOtherInsurer}
                        onChange={(v) => setNewOtherInsurer(v)}
                        placeholder="Ej: PAMI, IOSFA…"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <PatientPicker
                  name="patientId"
                  label={null}
                  initialPatientId={defaultPatientId ?? null}
                  initialPatients={patients}
                  onChange={loadPatientBilling}
                />
              )}
            </div>

            {/* Cobertura + copago del paciente seleccionado (editable). */}
            {!isGuest && selectedPatient && (billing || copagoLoading) && (
              <CopagoRow
                obraSocial={billing?.obraSocial ?? "—"}
                original={billing?.copagoCents ?? 0}
                valueCents={copagoInput}
                onValueCents={setCopagoInput}
                updateDefault={updateDefaultCopago}
                setUpdateDefault={setUpdateDefaultCopago}
                loading={copagoLoading}
              />
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 86px", gap: 10, alignItems: "end" }}>
              <FormField
                label="Fecha y hora"
                name="scheduledFor"
                type="datetime-local"
                required
                defaultValue={defaultISO ? isoToARLocalInput(defaultISO) : ""}
              />
              <FormField
                label="Duración"
                tooltip="En minutos"
                name="durationMin"
                type="number"
                min={15}
                max={240}
                value={durationMin}
                onChange={(v) => setDurationMin(Math.max(15, Math.min(240, Number(v) || 45)))}
              />
            </div>

            {/* Múltiples turnos toggle — crea N turnos individuales en los
                días elegidos (NO un plan). */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                borderRadius: 12,
                background: multiTurno ? "rgba(31,79,190,0.06)" : "rgba(15,30,51,0.03)",
                border: "1px solid " + (multiTurno ? "rgba(31,79,190,0.2)" : "rgba(15,30,51,0.06)"),
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Múltiples turnos</div>
                <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                  Crea varios turnos sueltos en los días que elijas. Con un solo turno, dejalo apagado.
                </div>
              </div>
              <input
                type="checkbox"
                checked={multiTurno}
                onChange={(e) => setMultiTurno(e.target.checked)}
              />
            </label>

            {multiTurno && (
              <div style={{ display: "grid", gap: 10 }}>
                <FormField
                  label="Cantidad de turnos"
                  name="count"
                  type="number"
                  min={1}
                  max={60}
                  value={count}
                  onChange={(v) => setCount(Math.max(1, Math.min(60, Number(v) || 1)))}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}>
                    Días de la semana
                  </div>
                  <DayOfWeekPicker value={weekdays} onChange={setWeekdays} />
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 6 }}>
                    {weekdays.length > 0
                      ? `${count} turnos en los próximos ${weekdays.length === 1 ? "" : weekdays.length + " "}día${weekdays.length === 1 ? "" : "s"} marcados, a partir de la fecha elegida`
                      : "Sin selección: se repite el mismo día de la semana del turno"}
                  </div>
                </div>
              </div>
            )}

            <FormField as="textarea" label="Notas" name="notes" />
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
            {conflict && (
              <div
                role="alert"
                style={{
                  padding: 14,
                  borderRadius: 12,
                  background: "rgba(255,176,32,0.14)",
                  border: "1px solid rgba(255,176,32,0.45)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
                  ⚠ {conflict.practitionerName} ya tiene un turno en ese horario
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
                  Otros profesionales pueden tener turnos al mismo tiempo (varios kines en
                  paralelo), pero el mismo kine no puede atender dos pacientes en simultáneo.
                  Tenés dos opciones:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {conflict.nextFreeISO && (
                    <Button
                      type="button"
                      variant="primary"
                      onClick={useSuggestedSlot}
                      disabled={pending}
                    >
                      Usar próximo libre ·{" "}
                      {new Date(conflict.nextFreeISO).toLocaleString("es-AR", {
                        weekday: "short",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                        timeZone: "America/Argentina/Buenos_Aires",
                      })}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={forceOverbooking}
                    disabled={pending}
                    style={{ color: "#7A4A00", borderColor: "rgba(122,74,0,0.3)" }}
                  >
                    Forzar sobreturno
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setConflict(null)}
                    disabled={pending}
                  >
                    Volver atrás
                  </Button>
                </div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending
                  ? "Creando…"
                  : multiTurno && count > 1
                    ? `Crear ${count} turnos`
                    : "Crear turno"}{" "}
                <IconArrow size={12} />
              </Button>
            </div>
          </form>
        )}
      </motion.div>
    </motion.div>
  );
}
