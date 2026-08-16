"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, PhotoSlot } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import {
  assignPatientToPractitioner,
  deletePatient,
  sendPatientPortalInvite,
  setPatientArchived,
  setPatientCoverage,
  updatePatient,
} from "@/lib/patients";
import { SharePatientButton } from "@/components/patients/share-patient-button";
import { Section, Grid2 } from "./ui";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

export function PatientHero({
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
        {patient.updatedAt.toLocaleString("es-AR", {
          dateStyle: "short",
          timeStyle: "short",
          // Fixed AR timezone so the server (UTC) and the client format the
          // same string — otherwise it's a hydration mismatch.
          timeZone: "America/Argentina/Buenos_Aires",
        })}
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
        diagnosisTitle: String(formData.get("diagnosisTitle") ?? ""),
        diagnosisNote: String(formData.get("diagnosisNote") ?? ""),
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
    <Drawer open onClose={onClose} title="Editar paciente" width={560}>
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

        <Section title="Diagnóstico (opcional)">
          <FormField
            label="Título"
            name="diagnosisTitle"
            placeholder="ej: Lumbalgia"
            defaultValue={patient.diagnosisTitle ?? ""}
            hint="Máx. 80 caracteres."
          />
          <FormField
            as="textarea"
            label="Descripción"
            name="diagnosisNote"
            placeholder="Detalle del cuadro, objetivos, indicaciones…"
            defaultValue={patient.diagnosisNote ?? ""}
            hint="Autocompleta el título y la descripción de los turnos nuevos del paciente."
          />
        </Section>

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
    </Drawer>
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
