"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, PhotoSlot } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconArrow, IconFile, IconPlus, IconX, IconCheck } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import {
  completeSession,
  createProgram,
  deletePatient,
  recordEvaScore,
  setPatientCoverage,
  setPatientArchived,
  updatePatient,
  getPatientBookingsAll,
} from "@/lib/patients";
import { rescheduleSession } from "@/lib/sessions";
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";
import {
  assignPatientToPractitioner,
  deleteProgram,
  deleteSession,
  getPatientActivity,
  sendPatientPortalInvite,
  setProgramStatus,
  updateProgram,
} from "@/lib/patients";
import type {
  ActivityEvent,
  PatientCore,
  PatientProgramLite,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import type { EvaScore } from "@prisma/client";

type PractitionerOption = { id: string; name: string };

type InsurerOption = { id: string; name: string };
import { PlanTemplateApplyButton } from "@/components/patients/plan-template-apply";
import { SharePatientButton } from "@/components/patients/share-patient-button";
import { ActivityView } from "@/components/patients/activity-view";
import { ArchivosView } from "@/components/patients/archivos-view";
import { addCustomSession } from "@/lib/sessions";

/**
 * Composite patient prop shape consumed by the views. Built from the
 * initial server payload (`patientCore + programsLite + recentBookings
 * + evaScores`) plus lazy slices fetched on tab activation.
 *
 * `programs[].sessions` come pre-loaded (with `_count.exercises` only —
 * no full Exercise rows) because every tab uses session metadata.
 * `bookings` is replaced with the full list after Facturación opens.
 */
type PatientWithRelations = PatientCore & {
  programs: PatientProgramLite[];
  bookings: PatientBookingSummary[] | PatientBookingFull[];
  evaScores: EvaScore[];
};

type Tab = "resumen" | "sesiones" | "plan" | "archivos" | "antec" | "evol" | "fact" | "actividad";

export function PatientProfile({
  patientCore,
  programsLite,
  recentBookings,
  billableCount,
  evaScores,
  insurers = [],
  practitioners = [],
  canReassign = false,
}: {
  patientCore: PatientCore;
  programsLite: PatientProgramLite[];
  recentBookings: PatientBookingSummary[];
  billableCount: number;
  evaScores: EvaScore[];
  insurers?: InsurerOption[];
  practitioners?: PractitionerOption[];
  canReassign?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("resumen");

  // Lazy slice: the full bookings list is only needed for FacturacionView.
  // While not loaded, `recentBookings` (5 rows) covers Resumen's "próxima
  // cita" card. The first time the user opens Facturación we fetch it
  // and cache in component state for the rest of the session.
  const [bookingsAll, setBookingsAll] = useState<PatientBookingFull[] | null>(null);
  const [loadingBookings, setLoadingBookings] = useState(false);

  useEffect(() => {
    if (tab === "fact" && bookingsAll === null && !loadingBookings) {
      setLoadingBookings(true);
      let cancelled = false;
      getPatientBookingsAll(patientCore.id, 100)
        .then((rows) => {
          if (!cancelled) setBookingsAll(rows as PatientBookingFull[]);
        })
        .finally(() => {
          if (!cancelled) setLoadingBookings(false);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [tab, bookingsAll, loadingBookings, patientCore.id]);

  // Synthesize the legacy composite shape used by sub-views. The
  // `bookings` field swaps between recent (initial) and full (after
  // Facturación opens). Both shapes have the scalar fields the views
  // read (paymentStatus, scheduledFor, status, durationMin).
  const patient: PatientWithRelations = useMemo(
    () => ({
      ...patientCore,
      programs: programsLite,
      bookings: bookingsAll ?? recentBookings,
      evaScores,
    }),
    [patientCore, programsLite, bookingsAll, recentBookings, evaScores]
  );

  const activeProgram = patient.programs.find((p) => p.status === "ACTIVE") ?? patient.programs[0];
  const diagnosis = activeProgram?.case?.diagnoses?.[0]?.condition ?? null;
  const sessions = activeProgram?.sessions ?? [];
  const done = sessions.filter((s) => s.completedAt).length;
  const allSessionsCount = patient.programs.reduce(
    (acc, p) => acc + p.sessions.length,
    0
  );
  const age = patient.dateOfBirth
    ? Math.floor((Date.now() - +patient.dateOfBirth) / (365.25 * 86_400_000))
    : null;
  const coverage = patient.coverages[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PatientHero
        patient={patient}
        age={age}
        coverageLabel={coverage ? `${coverage.insurer}${coverage.planName ? " " + coverage.planName : ""}` : "Particular"}
        active={!!activeProgram}
        insurers={insurers}
        practitioners={practitioners}
        canReassign={canReassign}
      />

      <TabsBar
        active={tab}
        onChange={setTab}
        counts={{
          sesiones: allSessionsCount,
          plan: patient.programs.length,
          // Use the cheap aggregate count for the Facturación badge —
          // accurate even before the full bookings list is loaded.
          fact: billableCount,
        }}
      />

      {tab === "resumen" && (
        <ResumenView
          patient={patient}
          activeProgram={activeProgram}
          diagnosisName={diagnosis?.name ?? activeProgram?.title ?? null}
          done={done}
        />
      )}
      {tab === "sesiones" && <SesionesView patient={patient} sessions={sessions} />}
      {tab === "plan" && <PlanView patient={patient} />}
      {tab === "archivos" && <ArchivosView patientId={patient.id} />}
      {tab === "antec" && <AntecedentesView patient={patient} />}
      {tab === "evol" && <EvolucionView patient={patient} />}
      {tab === "fact" && (
        <FacturacionView patient={patient} loading={loadingBookings} loaded={bookingsAll !== null} />
      )}
      {tab === "actividad" && <ActivityView patientId={patient.id} />}
    </div>
  );
}

function PatientHero({
  patient,
  age,
  coverageLabel,
  active,
  insurers,
  practitioners,
  canReassign,
}: {
  patient: PatientWithRelations;
  age: number | null;
  coverageLabel: string;
  active: boolean;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
}) {
  // Modals lifted here — outside the <Card glass> — so backdrop-filter
  // on the card doesn't create a stacking context that traps position:fixed.
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <Card glass style={{ padding: 18, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <PhotoSlot label="paciente" style={{ width: 88, height: 88, borderRadius: 22, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
            <span
              className="k-mono"
              style={{
                padding: "2px 7px",
                borderRadius: 6,
                background: "var(--navy-900)",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              HC-{patient.id.slice(-6).toUpperCase()}
            </span>
            {active ? (
              <Tag tone="lime">Plan activo</Tag>
            ) : (
              <Tag tone="soft">Sin plan</Tag>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 className="k-display" style={{ fontSize: 28, margin: 0, letterSpacing: "-0.02em" }}>
              {patient.firstName} {patient.lastName}
            </h1>
            <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
              {age != null ? `${age} años` : ""}
              {patient.documentId ? ` · DNI ${patient.documentId}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 12, color: "var(--navy-500)", flexWrap: "wrap" }}>
            <HeroFact label="Tel." value={patient.phone ?? "—"} />
            <HeroFact label="Email" value={patient.email ?? "—"} />
            <HeroFact label="Cobertura" value={coverageLabel} />
            <HeroFact
              label="Kine"
              value={
                patient.assignedPractitionerId
                  ? practitioners.find((p) => p.id === patient.assignedPractitionerId)?.name ?? "—"
                  : "Consultorio común"
              }
            />
          </div>
        </div>
        <PatientHeroActions
          patient={patient}
          insurers={insurers}
          practitioners={practitioners}
          canReassign={canReassign}
          onEdit={() => setEditing(true)}
          onDelete={() => setDeleting(true)}
        />
      </Card>

      {/* Modals rendered as siblings of the Card, not inside it.
          This avoids backdrop-filter creating a new stacking context
          that traps position:fixed inside the glass card. */}
      {editing && (
        <EditPatientModal
          patient={patient}
          insurers={insurers}
          practitioners={practitioners}
          canReassign={canReassign}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && <DeletePatientModal patient={patient} onClose={() => setDeleting(false)} />}
    </>
  );
}

function PatientHeroActions({
  patient,
  practitioners,
  onEdit,
  onDelete,
}: {
  patient: PatientWithRelations;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [portalSending, startPortal] = useTransition();
  const [portalResult, setPortalResult] = useState<
    | { ok: true; emailSent: boolean; portalUrl: string }
    | { ok: false; error: string }
    | null
  >(null);

  const sendToPortal = () => {
    setPortalResult(null);
    startPortal(async () => {
      const r = await sendPatientPortalInvite({ patientId: patient.id });
      if (r.ok) setPortalResult({ ok: true, ...r.data });
      else setPortalResult({ ok: false, error: r.error });
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <Link href={`/agenda?new=1&patient=${patient.id}`} style={{ textDecoration: "none" }}>
          <Button variant="primary" style={{ fontSize: 12, padding: "8px 14px" }}>
            <IconPlus size={12} /> Agregar turno
          </Button>
        </Link>
        <SharePatientButton
          patientId={patient.id}
          ownerPractitionerId={patient.assignedPractitionerId}
          practitioners={practitioners}
        />
        <Button
          variant="ghost"
          onClick={sendToPortal}
          disabled={portalSending || !patient.email}
          title={patient.email ? "Invitar al paciente al portal" : "Cargá un email primero"}
          style={{ fontSize: 12, padding: "8px 14px" }}
        >
          {portalSending ? "Enviando…" : patient.userId ? "Reenviar portal" : "Enviar al portal"}
        </Button>
        <Button variant="ghost" onClick={onEdit} style={{ fontSize: 12, padding: "8px 14px" }}>
          Editar
        </Button>
        <Button
          variant="ghost"
          onClick={onDelete}
          style={{ fontSize: 12, padding: "8px 14px", color: "#9F1F1F" }}
        >
          Eliminar
        </Button>
      </div>
      {portalResult && (
        <div
          style={{
            maxWidth: 320,
            padding: 8,
            borderRadius: 8,
            fontSize: 11.5,
            background: portalResult.ok
              ? portalResult.emailSent
                ? "rgba(200,245,100,0.18)"
                : "rgba(255,176,32,0.15)"
              : "rgba(228,70,70,0.1)",
            color: portalResult.ok ? "var(--navy-900)" : "#9F1F1F",
            textAlign: "right",
          }}
        >
          {portalResult.ok
            ? portalResult.emailSent
              ? "✓ Email enviado al paciente."
              : `Email no enviado (server sin SMTP). URL: ${portalResult.portalUrl}`
            : portalResult.error}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
        Última actualización:{" "}
        {patient.updatedAt.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
      </div>
    </div>
  );
}

function EditPatientModal({
  patient,
  insurers,
  practitioners,
  canReassign,
  onClose,
}: {
  patient: PatientWithRelations;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const currentCoverage = patient.coverages[0];
  const initialCoverageMode = currentCoverage
    ? currentCoverage.insurerId
      ? `ins:${currentCoverage.insurerId}`
      : "other"
    : "particular";
  const [coverageMode, setCoverageMode] = useState(initialCoverageMode);
  const [otherInsurerName, setOtherInsurerName] = useState(
    currentCoverage && !currentCoverage.insurerId ? currentCoverage.insurer : ""
  );
  const [assignedKine, setAssignedKine] = useState<string>(
    patient.assignedPractitionerId ?? ""
  );

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const updateResult = await updatePatient({
        id: patient.id,
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        documentId: String(formData.get("documentId") ?? ""),
        dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
        notes: String(formData.get("notes") ?? ""),
      });
      if (!updateResult.ok) {
        setError(updateResult.error);
        return;
      }

      // Coverage update — only when changed.
      if (coverageMode !== initialCoverageMode || coverageMode === "other") {
        const planName = String(formData.get("coveragePlan") ?? "") || undefined;
        const memberId = String(formData.get("coverageMember") ?? "") || undefined;
        let cov;
        if (coverageMode === "particular") {
          cov = await setPatientCoverage({ patientId: patient.id });
        } else if (coverageMode === "other") {
          cov = await setPatientCoverage({
            patientId: patient.id,
            insurerName: otherInsurerName,
            planName,
            memberId,
          });
        } else {
          const insurerId = coverageMode.replace("ins:", "");
          cov = await setPatientCoverage({
            patientId: patient.id,
            insurerId,
            planName,
            memberId,
          });
        }
        if (!cov.ok) {
          setError(cov.error);
          return;
        }
      }

      // Re-assignment (OWNER/ADMIN only).
      if (canReassign && assignedKine !== (patient.assignedPractitionerId ?? "")) {
        const r = await assignPatientToPractitioner({
          patientId: patient.id,
          practitionerId: assignedKine || null,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
      }

      onClose();
      router.refresh();
    });
  };

  const dobIso = patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : "";

  return (
    <Modal onClose={onClose} title="Editar paciente" width={620}>
      <form action={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Section title="Datos personales">
          <Grid2>
            <FormField label="Nombre" name="firstName" required defaultValue={patient.firstName} />
            <FormField label="Apellido" name="lastName" required defaultValue={patient.lastName} />
          </Grid2>
          <Grid2>
            <FormField label="DNI" name="documentId" defaultValue={patient.documentId ?? ""} />
            <FormField label="Fecha de nacimiento" name="dateOfBirth" type="date" defaultValue={dobIso} />
          </Grid2>
          <Grid2>
            <FormField label="Email" name="email" type="email" defaultValue={patient.email ?? ""} />
            <FormField label="Teléfono" name="phone" defaultValue={patient.phone ?? ""} />
          </Grid2>
        </Section>

        <Section title="Cobertura - Obra social">
          <FormField
            as="select"
            label=""
            value={coverageMode}
            onChange={(v) => setCoverageMode(v)}
            options={[
              { value: "particular", label: "Particular (sin cobertura)" },
              ...insurers.map((i) => ({ value: `ins:${i.id}`, label: i.name })),
              { value: "other", label: "Otra (escribir manualmente)" },
            ]}
          />
          {coverageMode === "other" && (
            <FormField
              label="Nombre de la obra social"
              value={otherInsurerName}
              onChange={(v) => setOtherInsurerName(v)}
              placeholder="Ej: PAMI, IOSFA…"
            />
          )}
          {coverageMode !== "particular" && (
            <Grid2>
              <FormField
                label="Plan"
                name="coveragePlan"
                defaultValue={currentCoverage?.planName ?? ""}
                placeholder="210, Black, …"
              />
              <FormField
                label="N° de afiliado"
                name="coverageMember"
                defaultValue={currentCoverage?.memberId ?? ""}
              />
            </Grid2>
          )}
        </Section>

        {canReassign && (
          <Section title="Asignación - Kinesiólogo asignado">
            <FormField
              as="select"
              label=""
              hint="«Consultorio común» = visible para todos los kines del consultorio."
              value={assignedKine}
              onChange={(v) => setAssignedKine(v)}
              options={[
                { value: "", label: "Consultorio común" },
                ...practitioners.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Section>
        )}

        <Section title="Notas">
          <FormField as="textarea" label="" name="notes" defaultValue={patient.notes ?? ""} />
        </Section>

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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 14,
        background: "rgba(246,249,253,0.6)",
        border: "1px solid rgba(15,30,51,0.05)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--navy-300)",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>
  );
}

function DeletePatientModal({
  patient,
  onClose,
}: {
  patient: PatientWithRelations;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const phrase = `${patient.firstName} ${patient.lastName}`.toLowerCase();
  const canConfirm = confirmText.trim().toLowerCase() === phrase;
  const isArchived = !!patient.archivedAt;
  const submit = () => {
    setError(null);
    start(async () => {
      const r = await deletePatient(patient.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push("/pacientes");
    });
  };
  // Soft-delete alternative: archive keeps the ficha + history intact but
  // hides the patient from the default listado. Reversible from the
  // "archivados" filter. Sits between Cancelar and Eliminar.
  const archive = () => {
    setError(null);
    start(async () => {
      const r = await setPatientArchived({ id: patient.id, archived: !isArchived });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };
  return (
    <Modal onClose={onClose} title="Eliminar paciente">
      <p style={{ fontSize: 13, color: "var(--navy-700)", margin: 0, lineHeight: 1.5 }}>
        Esta acción elimina la ficha, todas sus sesiones, planes, archivos y registros
        clínicos. <strong>No se puede deshacer.</strong>
      </p>
      <p style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 6 }}>
        Escribí <code style={{ background: "rgba(15,30,51,0.06)", padding: "1px 6px", borderRadius: 6 }}>{phrase}</code> para confirmar.
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        autoFocus
        style={{
          marginTop: 8,
          padding: "10px 12px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.7)",
          border: "1px solid rgba(15,30,51,0.08)",
          width: "100%",
          fontSize: 14,
        }}
      />
      {error && (
        <div
          style={{
            marginTop: 10,
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancelar
        </Button>
        <Button
          variant="ghost"
          onClick={archive}
          disabled={pending}
          title={
            isArchived
              ? "Volver a mostrar el paciente en el listado"
              : "Ocultar del listado sin borrar la ficha ni el historial"
          }
          style={{
            color: "#9A5B00",
            borderColor: "rgba(255,176,32,0.5)",
            background: "rgba(255,176,32,0.1)",
          }}
        >
          {pending ? "Guardando…" : isArchived ? "Desarchivar" : "Archivar"}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={pending || !canConfirm}
          style={{
            background: canConfirm ? "#9F1F1F" : undefined,
            boxShadow: canConfirm ? "0 4px 14px rgba(159,31,31,0.3)" : undefined,
          }}
        >
          {pending ? "Eliminando…" : "Eliminar definitivamente"}
        </Button>
      </div>
    </Modal>
  );
}

function HeroFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9.5,
          color: "var(--navy-300)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-900)", fontWeight: 500, marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
}

function TabsBar({
  active,
  onChange,
  counts,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  counts: { sesiones: number; plan: number; fact: number };
}) {
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "sesiones", label: "Sesiones", count: counts.sesiones || undefined },
    { id: "plan", label: "Plan", count: counts.plan || undefined },
    { id: "archivos", label: "Archivos" },
    { id: "antec", label: "Antecedentes" },
    { id: "evol", label: "Evolución" },
    { id: "fact", label: "Facturación", count: counts.fact || undefined },
    { id: "actividad", label: "Actividad" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        borderBottom: "1px solid rgba(15,30,51,0.08)",
        paddingLeft: 4,
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              padding: "12px 18px",
              position: "relative",
              fontSize: 13,
              fontWeight: on ? 700 : 500,
              color: on ? "var(--navy-900)" : "var(--navy-500)",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {t.label}
            {t.count != null && (
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  background: on ? "var(--lime-300)" : "rgba(15,30,51,0.08)",
                  color: "var(--navy-900)",
                }}
              >
                {t.count}
              </span>
            )}
            {on && (
              <span
                style={{
                  position: "absolute",
                  bottom: -1,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: "var(--sky-700)",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ResumenView({
  patient,
  activeProgram,
  diagnosisName,
  done,
}: {
  patient: PatientWithRelations;
  activeProgram?: PatientWithRelations["programs"][number];
  diagnosisName: string | null;
  done: number;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 320px", gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
          Plan
        </div>
        {activeProgram ? (
          <>
            <div style={{ fontSize: 13, color: "var(--navy-700)" }}>{activeProgram.title}</div>
            <div className="k-mono" style={{ fontSize: 12, color: "var(--sky-700)", marginTop: 4 }}>
              {done} / {activeProgram.totalSessions}
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "rgba(15,30,51,0.06)",
                overflow: "hidden",
                marginTop: 10,
              }}
            >
              <div
                style={{
                  width: `${activeProgram.totalSessions ? (done / activeProgram.totalSessions) * 100 : 0}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
                }}
              />
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
              Este paciente todavía no tiene un plan de tratamiento.
            </p>
            <Button variant="primary" onClick={() => setCreating(true)} style={{ width: "100%", justifyContent: "center" }}>
              <IconPlus size={14} /> Crear plan
            </Button>
          </>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card style={{ padding: 18 }}>
          <div style={{ fontSize: 10, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase" }}>
            Diagnóstico principal
          </div>
          <div className="k-display" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {diagnosisName ?? "Aún no asignado"}
          </div>
        </Card>
        <Card style={{ padding: 18 }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Notas clínicas
          </div>
          <p style={{ fontSize: 13, color: "var(--navy-700)", margin: 0, whiteSpace: "pre-wrap" }}>
            {patient.notes ?? "Sin notas. Editá el paciente para agregar antecedentes relevantes."}
          </p>
        </Card>
      </div>

      <EvaScoreSide patient={patient} />

      {creating && (
        <CreateProgramModal
          patientId={patient.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EvaScoreSide({ patient }: { patient: PatientWithRelations }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (formData: FormData) => {
    start(async () => {
      const result = await recordEvaScore({
        patientId: patient.id,
        value: Number(formData.get("value")),
        source: "manual",
      });
      if (result.ok) router.refresh();
    });
  };
  const scores = patient.evaScores;
  const max = 10;
  return (
    <Card glass style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        EVA · dolor
      </div>
      <div style={{ height: 90, position: "relative", padding: "4px 0" }}>
        {scores.length ? (
          <svg viewBox="0 0 100 40" width="100%" height="100%" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--sky-700)"
              strokeWidth="1.5"
              points={scores
                .map((s, i) => `${(i / Math.max(scores.length - 1, 1)) * 100},${40 - (s.value / max) * 40}`)
                .join(" ")}
            />
            {scores.map((s, i) => (
              <circle
                key={s.id}
                cx={(i / Math.max(scores.length - 1, 1)) * 100}
                cy={40 - (s.value / max) * 40}
                r="1.6"
                fill="var(--sky-700)"
              />
            ))}
          </svg>
        ) : (
          <div style={{ fontSize: 12, color: "var(--navy-300)", textAlign: "center", paddingTop: 24 }}>
            Sin registros aún
          </div>
        )}
      </div>
      <form action={submit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 600 }}>EVA hoy</label>
        <input
          name="value"
          type="number"
          min={0}
          max={10}
          defaultValue={4}
          style={{
            width: 56,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid rgba(15,30,51,0.08)",
            fontSize: 13,
            textAlign: "center",
          }}
        />
        <Button type="submit" variant="primary" disabled={pending} style={{ fontSize: 12, padding: "8px 12px" }}>
          {pending ? "…" : "Registrar"}
        </Button>
      </form>
    </Card>
  );
}

function SesionesView({
  patient,
  sessions,
}: {
  patient: PatientWithRelations;
  sessions: PatientWithRelations["programs"][number]["sessions"];
}) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: "70px 1fr 120px 1fr 90px",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>#</span>
        <span>Fecha</span>
        <span>Estado</span>
        <span>Notas</span>
        <span style={{ textAlign: "right" }}>Acción</span>
      </div>
      {sessions.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Este paciente todavía no tiene sesiones. Creá un plan desde Resumen.
        </div>
      ) : (
        sessions.map((s) => (
          <SessionRow key={s.id} session={s} patientId={patient.id} />
        ))
      )}
    </Card>
  );
}

function SessionRow({
  session,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
  patientId: string;
}) {
  const completed = !!session.completedAt;
  const exerciseCount = session._count.exercises;
  return (
    <a
      href={`/seguimiento/${session.id}`}
      style={{
        textDecoration: "none",
        color: "inherit",
        padding: "14px 18px",
        display: "grid",
        gridTemplateColumns: "70px 1fr 120px 1fr 110px",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        borderBottom: "1px solid rgba(15,30,51,0.04)",
        opacity: completed ? 0.85 : 1,
      }}
    >
      <span className="k-mono" style={{ fontWeight: 700, color: "var(--sky-700)" }}>
        {String(session.index).padStart(2, "0")}
      </span>
      <span style={{ color: "var(--navy-700)" }}>
        {session.scheduledFor.toLocaleString("es-AR", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </span>
      <span>
        {completed ? (
          <Tag tone="lime">
            <IconCheck size={10} stroke={3} /> Hecho
          </Tag>
        ) : (
          <Tag tone="soft">Programada</Tag>
        )}
      </span>
      <span
        style={{
          color: "var(--navy-500)",
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {session.notes ?? (completed ? "—" : `${exerciseCount} ejercicios asignados`)}
      </span>
      <span
        style={{
          display: "flex",
          justifyContent: "flex-end",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
        }}
      >
        Editar sesión →
      </span>
    </a>
  );
}

function PlanView({ patient }: { patient: PatientWithRelations }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  // Show ALL programs of this patient as separate cards. Pre-Sprint 13
  // only the first ACTIVE program was rendered, which made a second plan
  // look like it had "merged" into the first.
  const programs = patient.programs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {programs.length === 0 ? (
        <Card style={{ padding: 24, textAlign: "center" }}>
          <p style={{ color: "var(--navy-500)" }}>Este paciente no tiene planes todavía.</p>
          <div style={{ display: "inline-flex", gap: 8 }}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={14} /> Crear plan
            </Button>
            <PlanTemplateApplyButton patientId={patient.id} />
          </div>
        </Card>
      ) : (
        <>
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--navy-300)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {programs.length} {programs.length === 1 ? "plan" : "planes"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={() => setCreating(true)} style={{ fontSize: 12 }}>
                <IconPlus size={12} /> Plan nuevo
              </Button>
              <PlanTemplateApplyButton patientId={patient.id} />
            </div>
          </header>
          {programs.map((prog) => (
            <ProgramCard key={prog.id} program={prog} />
          ))}
        </>
      )}
      {creating && (
        <CreateProgramModal
          patientId={patient.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ProgramCard({
  program,
}: {
  program: PatientWithRelations["programs"][number];
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, start] = useTransition();

  const done = program.sessions.filter((s) => s.completedAt).length;
  const pct = program.totalSessions
    ? Math.round((done / program.totalSessions) * 100)
    : 0;
  const status = program.status;
  const statusTag =
    status === "ACTIVE"
      ? <Tag tone="lime">Activo</Tag>
      : status === "COMPLETED"
        ? <Tag tone="soft"><IconCheck size={10} stroke={3} /> Completado</Tag>
        : status === "PAUSED"
          ? <Tag tone="soft">Pausado</Tag>
          : <Tag tone="soft">Cancelado</Tag>;

  const changeStatus = (next: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED") => {
    start(async () => {
      const r = await setProgramStatus({ id: program.id, status: next });
      if (r.ok) router.refresh();
    });
  };

  const confirmDelete = () => {
    start(async () => {
      const r = await deleteProgram(program.id);
      if (r.ok) {
        setDeleting(false);
        router.refresh();
      }
    });
  };

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: 16,
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "inherit",
            padding: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: 8,
              background: "rgba(15,30,51,0.06)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: "var(--navy-500)",
              flexShrink: 0,
              transition: "transform 160ms ease",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ›
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
              {statusTag}
              <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>
                {done}/{program.totalSessions} · {pct}%
              </span>
            </div>
            <div className="k-display" style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {program.title}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
              Inicio {program.startDate.toLocaleDateString("es-AR")} ·{" "}
              {program.frequency}×/semana
            </div>
          </div>
        </button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ProgramStatusMenu
            current={status}
            onChange={changeStatus}
            disabled={pending}
          />
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={pending}
            style={miniBtn}
          >
            Editar
          </button>
          <AddCustomSessionButton programId={program.id} />
          <button
            type="button"
            onClick={() => setDeleting(true)}
            disabled={pending}
            style={{ ...miniBtn, color: "#9F1F1F" }}
          >
            Eliminar
          </button>
        </div>
      </header>
      <div
        style={{
          height: 4,
          background: "rgba(15,30,51,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
          }}
        />
      </div>
      {expanded && (
        <div
          style={{
            padding: 16,
            borderTop: "1px solid rgba(15,30,51,0.05)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 10,
            background: "rgba(246,249,253,0.5)",
          }}
        >
          {program.sessions.length === 0 && (
            <div style={{ gridColumn: "1 / -1", padding: 12, color: "var(--navy-500)", fontSize: 13 }}>
              Este plan todavía no tiene sesiones cargadas.
            </div>
          )}
          {program.sessions.map((s) => (
            <SessionCardRow key={s.id} session={s} />
          ))}
        </div>
      )}
      {editing && (
        <EditProgramModal program={program} onClose={() => setEditing(false)} />
      )}
      {deleting && (
        <ConfirmDeleteProgram
          program={program}
          pending={pending}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.08)",
  borderRadius: 999,
  padding: "5px 10px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

function ProgramStatusMenu({
  current,
  onChange,
  disabled,
}: {
  current: "ACTIVE" | "COMPLETED" | "PAUSED" | "CANCELLED";
  onChange: (s: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED") => void;
  disabled: boolean;
}) {
  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED")}
      style={{
        padding: "5px 8px",
        borderRadius: 999,
        border: "1px solid rgba(15,30,51,0.08)",
        background: "rgba(255,255,255,0.8)",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <option value="ACTIVE">Activo</option>
      <option value="PAUSED">Pausado</option>
      <option value="COMPLETED">Completado</option>
      <option value="CANCELLED">Cancelado</option>
    </select>
  );
}

function EditProgramModal({
  program,
  onClose,
}: {
  program: PatientWithRelations["programs"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await updateProgram({
        id: program.id,
        title: String(formData.get("title") ?? ""),
        totalSessions: Number(formData.get("totalSessions") ?? program.totalSessions),
        frequency: Number(formData.get("frequency") ?? program.frequency),
        startDate: String(formData.get("startDate") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };
  const startDateIso = program.startDate.toISOString().slice(0, 10);
  return (
    <Modal onClose={onClose} title="Editar plan" width={480}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre del plan" name="title" required defaultValue={program.title} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField
            label="Total de sesiones"
            name="totalSessions"
            type="number"
            min={1}
            max={64}
            defaultValue={program.totalSessions}
          />
          <FormField
            label="Frecuencia (× semana)"
            name="frequency"
            type="number"
            min={1}
            max={7}
            defaultValue={program.frequency}
          />
        </div>
        <FormField label="Fecha de inicio" name="startDate" type="date" defaultValue={startDateIso} />
        {error && (
          <div style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDeleteProgram({
  program,
  pending,
  onConfirm,
  onClose,
}: {
  program: PatientWithRelations["programs"][number];
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} title="Eliminar plan" width={440}>
      <p style={{ fontSize: 13, color: "var(--navy-700)", margin: "0 0 8px" }}>
        Vas a eliminar <strong>{program.title}</strong> con sus {program.totalSessions} sesiones cargadas.
        Esta acción no se puede deshacer.
      </p>
      <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "0 0 14px" }}>
        Los turnos creados desde este plan permanecen en la agenda — eliminalos manualmente si querés.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Cancelar
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onConfirm}
          disabled={pending}
          style={{ background: "#9F1F1F" }}
        >
          {pending ? "Eliminando…" : "Eliminar definitivamente"}
        </Button>
      </div>
    </Modal>
  );
}

function SessionCardRow({
  session,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
}) {
  const [editing, setEditing] = useState(false);
  const done = !!session.completedAt;
  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          textAlign: "left",
          padding: 12,
          borderRadius: 12,
          background: done ? "rgba(200,245,100,0.18)" : "rgba(246,249,253,0.7)",
          border: "1px solid rgba(15,30,51,0.06)",
          cursor: "pointer",
          display: "block",
          width: "100%",
          color: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 700 }}>
            Sesión {session.index}
          </span>
          {done && <IconCheck size={12} stroke={3} />}
        </div>
        <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
          {session.scheduledFor.toLocaleString("es-AR", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "America/Argentina/Buenos_Aires",
          })}
        </div>
        <div style={{ fontSize: 11, color: "var(--navy-700)", marginTop: 6 }}>
          {session._count.exercises} ejercicio{session._count.exercises === 1 ? "" : "s"}
        </div>
      </button>
      {editing && (
        <EditSessionModal
          session={session}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function EditSessionModal({
  session,
  onClose,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // AR wall-clock formatting via Intl — works the same on the
  // server (SSR snapshot) and the browser. The old `getFullYear` /
  // `getHours` path read the runtime's local tz, which on a UTC
  // host put sessions on the wrong day.
  const initialLocal = useMemo(
    () => isoToARLocalInput(session.scheduledFor),
    [session.scheduledFor]
  );
  const [when, setWhen] = useState(initialLocal);

  const save = () => {
    setError(null);
    start(async () => {
      const r = await rescheduleSession({
        sessionId: session.id,
        // Tag with AR offset so the server parses 14:00 as 14:00 AR,
        // not 14:00 UTC (which displays back as 11:00 AR).
        scheduledFor: localToARIso(when),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  const remove = () => {
    if (!confirm(`¿Eliminar sesión ${session.index}? Esta acción es definitiva.`)) return;
    setError(null);
    start(async () => {
      const r = await deleteSession(session.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      onClose={onClose}
      title={`Sesión ${session.index}`}
      description={
        session.completedAt
          ? "Esta sesión ya fue realizada. Solo podés revisar su detalle."
          : "Cambiá la fecha/hora si el paciente necesita reprogramar. El turno asociado se mueve automáticamente."
      }
      width={460}
    >
      <div style={{ display: "grid", gap: 12 }}>
        <FormField
          label="Fecha y hora"
          name="scheduledFor"
          type="datetime-local"
          value={when}
          onChange={(v) => setWhen(v)}
          disabled={!!session.completedAt}
        />
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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          <Link
            href={`/seguimiento/${session.id}`}
            style={{
              fontSize: 12.5,
              color: "var(--sky-700)",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Abrir sesión completa →
          </Link>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!session.completedAt && (
              <button
                type="button"
                onClick={remove}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#9F1F1F",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                Eliminar
              </button>
            )}
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            {!session.completedAt && (
              <Button type="button" variant="primary" onClick={save} disabled={pending}>
                {pending ? "Guardando…" : "Guardar"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AddCustomSessionButton({ programId }: { programId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const title = prompt("Título o nota corta de la sesión a medida (opcional):") ?? undefined;
    setError(null);
    start(async () => {
      const r = await addCustomSession({ programId, title });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
      <Button variant="ghost" onClick={add} disabled={pending}>
        <IconPlus size={12} /> {pending ? "Agregando…" : "Sesión a medida"}
      </Button>
      {error && <span style={{ fontSize: 11, color: "#9F1F1F" }}>{error}</span>}
    </div>
  );
}

function AntecedentesView({ patient }: { patient: PatientWithRelations }) {
  return (
    <Card style={{ padding: 18 }}>
      <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
        Antecedentes y contacto
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Detail label="Coberturas">
          {patient.coverages.length ? (
            patient.coverages.map((c) => (
              <div key={c.id} style={{ fontSize: 13 }}>
                {c.insurer} {c.planName ? `· ${c.planName}` : ""}
              </div>
            ))
          ) : (
            <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Sin coberturas cargadas</span>
          )}
        </Detail>
        <Detail label="Contacto de emergencia">
          {patient.emergency.length ? (
            patient.emergency.map((c) => (
              <div key={c.id} style={{ fontSize: 13 }}>
                {c.name} · {c.phone}
              </div>
            ))
          ) : (
            <span style={{ fontSize: 12, color: "var(--navy-300)" }}>No registrado</span>
          )}
        </Detail>
        <Detail label="Notas">
          <span style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
            {patient.notes ?? "Sin notas"}
          </span>
        </Detail>
        <Detail label="Alta del paciente">
          <span style={{ fontSize: 13 }}>
            {patient.createdAt.toLocaleDateString("es-AR", { dateStyle: "long" })}
          </span>
        </Detail>
      </div>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: "var(--navy-300)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function EvolucionView({ patient }: { patient: PatientWithRelations }) {
  const scores = patient.evaScores;
  return (
    <Card style={{ padding: 24 }}>
      <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
        Evolución · EVA dolor 0-10
      </div>
      {scores.length === 0 ? (
        <p style={{ color: "var(--navy-500)" }}>Aún no hay puntajes registrados.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 8 }}>
          {scores.map((s) => (
            <div
              key={s.id}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(246,249,253,0.7)",
                textAlign: "center",
              }}
            >
              <div className="k-mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--sky-700)" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, color: "var(--navy-500)" }}>
                {s.takenAt.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}
              </div>
              {s.source && (
                <div style={{ fontSize: 9, color: "var(--navy-300)" }}>{s.source}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CreateProgramModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    start(async () => {
      const result = await createProgram({
        patientId,
        title: String(formData.get("title") ?? ""),
        totalSessions: Number(formData.get("totalSessions")) || 8,
        frequency: Number(formData.get("frequency")) || 2,
        startDate: new Date(String(formData.get("startDate") ?? "")),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

  return (
    <Modal onClose={onClose} title="Crear plan de tratamiento">
      <form action={submit} style={{ display: "grid", gap: 10 }}>
        <FormField label="Nombre" name="title" required defaultValue="Plan kinésico" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <FormField label="Sesiones" name="totalSessions" type="number" min={1} max={64} defaultValue={8} />
          <FormField label="Freq/sem" name="frequency" type="number" min={1} max={5} defaultValue={2} />
          <FormField label="Inicio" name="startDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creando…" : "Crear plan"} <IconArrow size={12} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Archivos tab
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Facturación tab
// ──────────────────────────────────────────────────────────────────────

/** Fact. table columns: Fecha · Servicio · Obra social · Copago ·
 *  Duración · Estado pago · Estado turno. Shared by header + rows. */
const FACT_COLS = "100px 1.2fr 1fr 90px 80px 110px 100px";

/** Cents → "$1.234" (AR pesos, no decimals). */
function fmtMoneyARS(cents: number) {
  return (cents / 100).toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function FacturacionView({
  patient,
  loading,
  loaded,
}: {
  patient: PatientWithRelations;
  loading: boolean;
  loaded: boolean;
}) {
  // While the full bookings list is in flight, render a lightweight
  // skeleton instead of computing aggregates from the partial 5-row
  // recent slice (which would show misleading numbers in the summary
  // cards). Once loaded, the in-memory aggregates are authoritative.
  if (loading || !loaded) {
    return (
      <Card glass style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        Cargando movimientos…
      </Card>
    );
  }
  const totalPaid = patient.bookings
    .filter((b) => b.paymentStatus === "PAID")
    .length;
  const billable = patient.bookings.filter((b) => b.paymentStatus !== "UNPAID");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card glass style={{ padding: 18, display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <Summary label="Turnos facturados" value={String(billable.length)} />
        <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
        <Summary label="Pagados" value={String(totalPaid)} tone="lime" />
        <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
        <Summary
          label="Pendientes"
          value={String(billable.length - totalPaid)}
          tone="sky"
        />
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            padding: "12px 18px",
            display: "grid",
            gridTemplateColumns: FACT_COLS,
            gap: 14,
            fontSize: 10,
            fontWeight: 700,
            color: "var(--navy-300)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <span>Fecha</span>
          <span>Servicio</span>
          <span>Obra social</span>
          <span>Copago</span>
          <span>Duración</span>
          <span>Estado pago</span>
          <span style={{ textAlign: "right" }}>Estado turno</span>
        </div>
        {billable.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
            Sin movimientos facturables todavía.
          </div>
        ) : (
          billable.map((b) => (
            <div
              key={b.id}
              style={{
                padding: "12px 18px",
                display: "grid",
                gridTemplateColumns: FACT_COLS,
                gap: 14,
                alignItems: "center",
                fontSize: 13,
                borderBottom: "1px solid rgba(15,30,51,0.04)",
              }}
            >
              <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>
                {b.scheduledFor.toLocaleDateString("es-AR", {
                  day: "2-digit",
                  month: "short",
                  year: "2-digit",
                })}
              </span>
              <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {"serviceName" in b ? b.serviceName : "Sesión kinésica"}
              </span>
              <span style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {"obraSocial" in b && b.obraSocial.toLowerCase() !== "particular" ? b.obraSocial : "—"}
              </span>
              <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>
                {"copagoCents" in b ? fmtMoneyARS(b.copagoCents) : "—"}
              </span>
              <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                {b.durationMin} min
              </span>
              <PaymentStatusTag status={b.paymentStatus} />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <BookingStatusTag status={b.status} />
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function Summary({
  label,
  value,
  tone = "navy",
}: {
  label: string;
  value: string;
  tone?: "lime" | "sky" | "navy";
}) {
  const colour =
    tone === "lime" ? "var(--lime-500)" : tone === "sky" ? "var(--sky-700)" : "var(--navy-900)";
  return (
    <div>
      <div
        className="k-display"
        style={{ fontSize: 26, fontWeight: 700, color: colour, letterSpacing: "-0.02em" }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{label}</div>
    </div>
  );
}

function PaymentStatusTag({ status }: { status: PatientWithRelations["bookings"][number]["paymentStatus"] }) {
  const map: Record<string, { tone: "lime" | "sky" | "soft"; label: string }> = {
    PAID: { tone: "lime", label: "Pagado" },
    AUTHORIZED: { tone: "sky", label: "Autorizado" },
    REFUNDED: { tone: "soft", label: "Reintegrado" },
    FAILED: { tone: "soft", label: "Falló" },
    UNPAID: { tone: "soft", label: "Pendiente" },
  };
  const m = map[status] ?? { tone: "soft" as const, label: status };
  return <Tag tone={m.tone}>{m.label}</Tag>;
}

function BookingStatusTag({ status }: { status: PatientWithRelations["bookings"][number]["status"] }) {
  const map: Record<string, { tone: "lime" | "sky" | "soft"; label: string }> = {
    CONFIRMED: { tone: "sky", label: "Confirmado" },
    COMPLETED: { tone: "lime", label: "Hecho" },
    CANCELLED: { tone: "soft", label: "Cancelado" },
    NO_SHOW: { tone: "soft", label: "Ausente" },
    PENDING: { tone: "soft", label: "Pendiente" },
  };
  const m = map[status] ?? { tone: "soft" as const, label: status };
  return <Tag tone={m.tone}>{m.label}</Tag>;
}

