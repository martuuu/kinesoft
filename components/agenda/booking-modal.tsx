"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { BookingStatus } from "@prisma/client";
import { useToast } from "@/components/ui/toast";
import { FormField } from "@/components/ui/form-field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Drawer } from "@/components/ui/drawer";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import {
  createBooking,
  createBookingsBatch,
  deleteBooking,
  setBookingStatus,
} from "@/lib/bookings";
import type { BatchOutcome } from "@/lib/bookings";
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
  // Soft confirm when the patient already has a (non-overlapping) turno today.
  const [samePatient, setSamePatient] = useState<{
    count: number;
    existingISO: string;
    payload: Parameters<typeof createBooking>[0];
  } | null>(null);
  // Soft confirm when the new turno OVERLAPS one the patient already has.
  const [patientOverlap, setPatientOverlap] = useState<{
    existingISO: string;
    payload: Parameters<typeof createBooking>[0];
  } | null>(null);
  // Multi-turno preflight: what the batch would do, awaiting the user's choice.
  const [batchConflict, setBatchConflict] = useState<{
    plan: BatchOutcome;
    payload: Parameters<typeof createBookingsBatch>[0];
  } | null>(null);
  // Every prompt renders below the form fields inside a scrolling drawer, so
  // bring whichever one appears into view instead of leaving it off-screen.
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (conflict || samePatient || patientOverlap || batchConflict) {
      promptRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [conflict, samePatient, patientOverlap, batchConflict]);
  // Stable idempotency key for THIS create attempt (one per modal instance):
  // a double-submit / retry converges to one turno, while a deliberate new
  // turno opens a fresh modal → fresh key → its own row. Guards against the
  // duplicate/overwrite class of bug at the DB's @unique column.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
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
      if (result.samePatientDay) {
        // Soft confirm: the patient already has another turno today (no
        // overlap). Ask before adding a second one; re-call on confirm.
        setSamePatient({
          count: result.samePatientDay.count,
          existingISO: result.samePatientDay.existingISO,
          payload,
        });
        setConflict(null);
        setError(null);
        return;
      }
      if (result.patientOverlap) {
        // The new turno runs over one the patient already has. Confirmable —
        // two services in parallel is normal in kinesiología.
        setPatientOverlap({ existingISO: result.patientOverlap.existingISO, payload });
        setConflict(null);
        setSamePatient(null);
        setError(null);
        return;
      }
      if (result.conflict) {
        setConflict({
          practitionerName: result.conflict.practitionerName,
          nextFreeISO: result.conflict.nextFreeISO,
          payload,
        });
        setSamePatient(null);
        setPatientOverlap(null);
        setError(null);
        return;
      }
      setError(result.error);
      toast.error("No pudimos crear el turno", { description: result.error });
      return;
    }
    setSamePatient(null);
    setPatientOverlap(null);
    // "Ambas opciones": the turno already carries its own copago override;
    // if the kine confirmed the prompt, also make it the patient's default.
    if (updateDefaultCopago && selectedPatient) {
      await setPatientDefaultCopago({ patientId: selectedPatient.id, copagoCents: copagoInput });
    }
    toast.success("Turno creado");
    onSaved();
  };

  /** Execute the batch after the user picked what to do with the conflicts. */
  const runBatch = async (
    payload: Parameters<typeof createBookingsBatch>[0],
    allowOverbooking: boolean
  ) => {
    const r = await createBookingsBatch({ ...payload, allowOverbooking });
    if (!r.ok) {
      setError(r.error);
      toast.error("No pudimos crear los turnos", { description: r.error });
      return;
    }
    const d = r.data;
    const parts = [`${d.created} de ${d.requested} turnos creados`];
    if (d.sobreturnos > 0) parts.push(`${d.sobreturnos} como sobreturno`);
    if (d.omitted > 0) parts.push(`${d.omitted} omitidos`);
    if (d.duplicates > 0) parts.push(`${d.duplicates} ya existían`);
    toast.success(d.created > 0 ? "Turnos creados" : "No se creó ningún turno", {
      description: parts.join(" · "),
    });
    setBatchConflict(null);
    onSaved();
  };

  const submit = (formData: FormData) => {
    setError(null);
    setConflict(null);
    setSamePatient(null);
    setPatientOverlap(null);
    setBatchConflict(null);
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
          idempotencyKey,
          serviceId: String(formData.get("serviceId") ?? ""),
          practitionerId: String(formData.get("practitionerId") ?? ""),
          // AR-tagged: prevents the +3h shift to UTC on the server.
          scheduledFor: localToARIso(String(formData.get("scheduledFor") ?? "")),
          durationMin: Number(formData.get("durationMin")) || 45,
          // Mini-diagnóstico opcional. Vacío → undefined, y el server toma
          // el diagnóstico del paciente. Sirve tanto para createBooking
          // como para createBookingsBatch (ambos reciben este payload).
          title: String(formData.get("title") ?? "").trim() || undefined,
          description: String(formData.get("description") ?? "").trim() || undefined,
          notes: String(formData.get("notes") ?? "") || undefined,
          // Per-turno copago override — only when the kine actually changed
          // it from the patient's pre-established value.
          copagoCents:
            !isGuest && billing && copagoInput !== billing.copagoCents ? copagoInput : undefined,
        };
        // Múltiples turnos: preflight first so the user is TOLD about conflicts
        // and chooses what to do, instead of slots being dropped silently.
        if (multiTurno && count > 1) {
          const batchPayload = {
            ...payload,
            count,
            daysOfWeek: weekdays.length > 0 ? weekdays : undefined,
          };
          const preview = await createBookingsBatch({ ...batchPayload, dryRun: true });
          if (!preview.ok) {
            setError(preview.error);
            toast.error("No pudimos crear los turnos", { description: preview.error });
            return;
          }
          // Nothing in the way → just create.
          if (preview.data.conflicted === 0 && preview.data.duplicates === 0) {
            await runBatch(batchPayload, false);
            return;
          }
          setBatchConflict({ plan: preview.data, payload: batchPayload });
          setConflict(null);
          setSamePatient(null);
          setError(null);
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

  const confirmSamePatientDay = () => {
    if (!samePatient) return;
    start(async () => {
      await finalizeCreate({ ...samePatient.payload, allowSamePatientDay: true });
      setSamePatient(null);
    });
  };

  const confirmPatientOverlap = () => {
    if (!patientOverlap) return;
    start(async () => {
      // Confirming the overlap implies the weaker same-day confirmation too,
      // so the user isn't asked twice for the same turno.
      await finalizeCreate({
        ...patientOverlap.payload,
        allowPatientOverlap: true,
        allowSamePatientDay: true,
      });
      setPatientOverlap(null);
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
    <Drawer
      open={true}
      onClose={onClose}
      title={mode === "create" ? "Nuevo turno" : "Turno"}
      // Wide enough that the form doesn't scroll sideways AND the
      // sobreturno / mismo-día prompts land above the fold.
      width={580}
    >
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

            {/* Mini-diagnóstico opcional: si se dejan vacíos, el server
                completa title/description con el diagnóstico del paciente. */}
            <FormField
              label="Título (diagnóstico)"
              name="title"
              placeholder="Opcional · si se deja vacío se toma el diagnóstico del paciente"
            />

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

            <FormField
              as="textarea"
              label="Descripción (diagnóstico)"
              name="description"
              placeholder="Opcional · si se deja vacío se toma el diagnóstico del paciente"
            />
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
            {batchConflict && (
              <div
                ref={promptRef}
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
                  {batchConflict.plan.conflicted > 0
                    ? `${batchConflict.plan.conflicted} de ${batchConflict.plan.requested} turnos caen como sobreturno`
                    : "Algunos turnos ya existen"}
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
                  {batchConflict.plan.free} se crean sin conflicto
                  {batchConflict.plan.duplicates > 0 &&
                    ` · ${batchConflict.plan.duplicates} ya existen y no se pueden duplicar`}
                  .
                </div>
                <div
                  className="k-mono"
                  style={{
                    fontSize: 11,
                    color: "var(--navy-500)",
                    maxHeight: 96,
                    overflowY: "auto",
                    display: "grid",
                    gap: 2,
                  }}
                >
                  {batchConflict.plan.dates
                    .filter((d) => d.status !== "libre")
                    .map((d) => (
                      <div key={d.iso}>
                        {new Date(d.iso).toLocaleString("es-AR", {
                          weekday: "short",
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                          timeZone: "America/Argentina/Buenos_Aires",
                        })}{" "}
                        · {d.status === "duplicado" ? "ya existe" : "sobreturno"}
                      </div>
                    ))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {batchConflict.plan.conflicted > 0 && (
                    <Button
                      type="button"
                      variant="primary"
                      disabled={pending}
                      onClick={() => start(async () => { await runBatch(batchConflict.payload, true); })}
                    >
                      Crear todos ({batchConflict.plan.free + batchConflict.plan.conflicted})
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending || batchConflict.plan.free === 0}
                    onClick={() => start(async () => { await runBatch(batchConflict.payload, false); })}
                    style={{ color: "#7A4A00", borderColor: "rgba(122,74,0,0.3)" }}
                  >
                    Crear solo los libres ({batchConflict.plan.free})
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setBatchConflict(null)}
                    disabled={pending}
                  >
                    Volver atrás
                  </Button>
                </div>
              </div>
            )}
            {patientOverlap && (
              <div
                ref={promptRef}
                role="alert"
                style={{
                  padding: 14,
                  borderRadius: 12,
                  background: "rgba(31,79,190,0.08)",
                  border: "1px solid rgba(31,79,190,0.28)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, color: "var(--sky-700)", fontWeight: 700 }}>
                  Se superpone con otro turno del paciente
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
                  Ya tiene un turno a las{" "}
                  {new Date(patientOverlap.existingISO).toLocaleString("es-AR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: "America/Argentina/Buenos_Aires",
                  })}{" "}
                  que se cruza con este horario. Puede ser intencional (dos servicios en
                  paralelo). ¿Crear igual?
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button type="button" variant="primary" onClick={confirmPatientOverlap} disabled={pending}>
                    Sí, crear superpuesto
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setPatientOverlap(null)} disabled={pending}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {samePatient && (
              <div
                ref={promptRef}
                role="alert"
                style={{
                  padding: 14,
                  borderRadius: 12,
                  background: "rgba(31,79,190,0.08)",
                  border: "1px solid rgba(31,79,190,0.28)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, color: "var(--sky-700)", fontWeight: 700 }}>
                  Este paciente ya tiene {samePatient.count === 1 ? "un turno" : `${samePatient.count} turnos`} hoy
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
                  El primero es a las{" "}
                  {new Date(samePatient.existingISO).toLocaleString("es-AR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: "America/Argentina/Buenos_Aires",
                  })}
                  . ¿Agregar otro turno para hoy?
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button type="button" variant="primary" onClick={confirmSamePatientDay} disabled={pending}>
                    Sí, agregar otro turno
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setSamePatient(null)} disabled={pending}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {conflict && (
              <div
                ref={promptRef}
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
            {/* Footer apilado y full-width, como el drawer lateral. */}
            <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
              <Button
                type="submit"
                variant="primary"
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                {pending
                  ? "Creando…"
                  : multiTurno && count > 1
                    ? `Crear ${count} turnos`
                    : "Crear turno"}{" "}
                <IconArrow size={12} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={pending}
                style={{ justifyContent: "center" }}
              >
                Cancelar
              </Button>
            </div>
          </form>
      )}
    </Drawer>
  );
}
