"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Prisma } from "@prisma/client";
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
  updatePatient,
} from "@/lib/patients";
import {
  deletePatientFile,
  getDownloadUrl,
  listPatientFiles,
  uploadPatientFile,
} from "@/lib/files";
import type { PatientFileRow } from "@/lib/files-types";
import { PlanTemplateApplyButton } from "@/components/patients/plan-template-apply";
import { addCustomSession } from "@/lib/sessions";

type PatientWithRelations = Prisma.PatientGetPayload<{
  include: {
    coverages: true;
    emergency: true;
    programs: {
      include: {
        sessions: {
          include: { exercises: { include: { exercise: true } } };
        };
        case: { include: { diagnoses: { include: { condition: true } } } };
      };
    };
    bookings: true;
    evaScores: true;
  };
}>;

type Tab = "resumen" | "sesiones" | "plan" | "archivos" | "antec" | "evol" | "fact";

export function PatientProfile({ patient }: { patient: PatientWithRelations }) {
  const [tab, setTab] = useState<Tab>("resumen");
  const activeProgram = patient.programs.find((p) => p.status === "ACTIVE") ?? patient.programs[0];
  const diagnosis = activeProgram?.case?.diagnoses?.[0]?.condition ?? null;
  const sessions = activeProgram?.sessions ?? [];
  const done = sessions.filter((s) => s.completedAt).length;
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
      />

      <TabsBar
        active={tab}
        onChange={setTab}
        counts={{
          sesiones: sessions.length,
          plan: activeProgram?.totalSessions ?? 0,
          fact: patient.bookings.filter((b) => b.paymentStatus !== "UNPAID").length,
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
      {tab === "plan" && <PlanView patient={patient} activeProgram={activeProgram} />}
      {tab === "archivos" && <ArchivosView patientId={patient.id} />}
      {tab === "antec" && <AntecedentesView patient={patient} />}
      {tab === "evol" && <EvolucionView patient={patient} />}
      {tab === "fact" && <FacturacionView patient={patient} />}
    </div>
  );
}

function PatientHero({
  patient,
  age,
  coverageLabel,
  active,
}: {
  patient: PatientWithRelations;
  age: number | null;
  coverageLabel: string;
  active: boolean;
}) {
  return (
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
        </div>
      </div>
      <PatientHeroActions patient={patient} />
    </Card>
  );
}

function PatientHeroActions({ patient }: { patient: PatientWithRelations }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" style={{ fontSize: 12, padding: "8px 14px" }}>
          <IconFile size={12} /> Exportar PDF
        </Button>
        <Button variant="ghost" onClick={() => setEditing(true)} style={{ fontSize: 12, padding: "8px 14px" }}>
          Editar
        </Button>
        <Button
          variant="ghost"
          onClick={() => setDeleting(true)}
          style={{ fontSize: 12, padding: "8px 14px", color: "#9F1F1F" }}
        >
          Eliminar
        </Button>
      </div>
      <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
        Última actualización:{" "}
        {patient.updatedAt.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
      </div>
      {editing && <EditPatientModal patient={patient} onClose={() => setEditing(false)} />}
      {deleting && <DeletePatientModal patient={patient} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function EditPatientModal({
  patient,
  onClose,
}: {
  patient: PatientWithRelations;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await updatePatient({
        id: patient.id,
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        documentId: String(formData.get("documentId") ?? ""),
        dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
        notes: String(formData.get("notes") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };
  const dobIso = patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : "";
  return (
    <Modal onClose={onClose} title="Editar paciente">
      <form action={submit} style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="Nombre" name="firstName" required defaultValue={patient.firstName} />
          <FormField label="Apellido" name="lastName" required defaultValue={patient.lastName} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="DNI" name="documentId" defaultValue={patient.documentId ?? ""} />
          <FormField label="Nacimiento" name="dateOfBirth" type="date" defaultValue={dobIso} />
        </div>
        <FormField label="Email" name="email" type="email" defaultValue={patient.email ?? ""} />
        <FormField label="Teléfono" name="phone" defaultValue={patient.phone ?? ""} />
        <FormField as="textarea" label="Notas" name="notes" defaultValue={patient.notes ?? ""} />
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancelar
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
  const exerciseCount = session.exercises.length;
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

function PlanView({
  patient,
  activeProgram,
}: {
  patient: PatientWithRelations;
  activeProgram?: PatientWithRelations["programs"][number];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  if (!activeProgram) {
    return (
      <Card style={{ padding: 24, textAlign: "center" }}>
        <p style={{ color: "var(--navy-500)" }}>Este paciente no tiene un plan activo.</p>
        <div style={{ display: "inline-flex", gap: 8 }}>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> Crear plan
          </Button>
          <PlanTemplateApplyButton patientId={patient.id} />
        </div>
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
      </Card>
    );
  }
  return (
    <Card style={{ padding: 18 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
            {activeProgram.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            Inicio {activeProgram.startDate.toLocaleDateString("es-AR")} ·{" "}
            {activeProgram.frequency}×/semana · {activeProgram.totalSessions} sesiones
          </div>
        </div>
        <AddCustomSessionButton programId={activeProgram.id} />
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {activeProgram.sessions.map((s) => (
          <a
            key={s.id}
            href={`/seguimiento/${s.id}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              padding: 12,
              borderRadius: 12,
              background: s.completedAt ? "rgba(200,245,100,0.18)" : "rgba(246,249,253,0.7)",
              border: "1px solid rgba(15,30,51,0.06)",
              cursor: "pointer",
              display: "block",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 700 }}>
                Sesión {s.index}
              </span>
              {s.completedAt && <IconCheck size={12} stroke={3} />}
            </div>
            <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
              {s.scheduledFor.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}
            </div>
            <div style={{ fontSize: 11, color: "var(--navy-700)", marginTop: 6 }}>
              {s.exercises.length} ejercicios ·{" "}
              {s.exercises.reduce((a, e) => a + e.sets * e.reps, 0)} repeticiones
            </div>
          </a>
        ))}
      </div>
    </Card>
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

const FILE_CATEGORIES: { value: string; label: string }[] = [
  { value: "REPORT", label: "Informe / estudio" },
  { value: "DERIVATION", label: "Derivación" },
  { value: "CONSENT", label: "Consentimiento" },
  { value: "IMAGE", label: "Imagen / video" },
  { value: "RECEIPT", label: "Recibo" },
  { value: "OTHER", label: "Otro" },
];

function ArchivosView({ patientId }: { patientId: string }) {
  const [files, setFiles] = useState<PatientFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Bumped on every successful mutation so the effect below re-fetches.
  const [bump, setBump] = useState(0);

  // Sequence-guarded fetch: a rapid patientId switch can't have a stale
  // response from the previous patient overwrite the current one.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPatientFiles(patientId)
      .then((r) => {
        if (cancelled) return;
        setFiles(r);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, bump]);

  const refresh = () => setBump((b) => b + 1);

  const onUpload = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await uploadPatientFile(patientId, formData);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      refresh();
    });
  };

  const onDelete = (id: string) => {
    if (!confirm("¿Eliminar este archivo?")) return;
    start(async () => {
      const r = await deletePatientFile(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setFiles((s) => s.filter((f) => f.id !== id));
    });
  };

  const onDownload = (id: string) => {
    start(async () => {
      const r = await getDownloadUrl(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.open(r.data.url, "_blank");
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 14 }}>
      <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
          Subir archivo
        </div>
        <form action={onUpload} style={{ display: "grid", gap: 10 }}>
          <label
            style={{
              padding: "20px 14px",
              border: "1.5px dashed rgba(31,79,190,0.4)",
              borderRadius: 14,
              textAlign: "center",
              cursor: "pointer",
              background: "rgba(31,79,190,0.05)",
              fontSize: 12.5,
              color: "var(--navy-700)",
              display: "block",
            }}
          >
            <input type="file" name="file" required style={{ display: "none" }} />
            <IconFile size={20} />
            <div style={{ marginTop: 6, fontWeight: 600 }}>Elegir archivo</div>
            <div style={{ fontSize: 10.5, color: "var(--navy-300)", marginTop: 2 }}>
              Hasta 25 MB · PDF, jpg, png…
            </div>
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-500)" }}>
            Categoría
            <select
              name="category"
              defaultValue="REPORT"
              style={{
                marginTop: 4,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                fontSize: 13,
              }}
            >
              {FILE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-500)" }}>
            Descripción (opcional)
            <input
              name="description"
              style={{
                marginTop: 4,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                fontSize: 13,
              }}
            />
          </label>
          {error && (
            <div
              style={{
                padding: 8,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 11.5,
              }}
            >
              {error}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Subiendo…" : "Subir"}
          </Button>
        </form>
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            padding: "12px 18px",
            display: "grid",
            gridTemplateColumns: "1.5fr 1fr 80px 90px 100px",
            gap: 14,
            fontSize: 10,
            fontWeight: 700,
            color: "var(--navy-300)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <span>Nombre</span>
          <span>Categoría</span>
          <span>Tamaño</span>
          <span>Subido</span>
          <span style={{ textAlign: "right" }}>Acción</span>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "var(--navy-300)", textAlign: "center", fontSize: 13 }}>
            Cargando archivos…
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: 24, color: "var(--navy-300)", textAlign: "center", fontSize: 13 }}>
            Sin archivos cargados.
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.id}
              style={{
                padding: "12px 18px",
                display: "grid",
                gridTemplateColumns: "1.5fr 1fr 80px 90px 100px",
                gap: 14,
                alignItems: "center",
                fontSize: 13,
                borderBottom: "1px solid rgba(15,30,51,0.04)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{f.name}</div>
                {f.description && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{f.description}</div>
                )}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {FILE_CATEGORIES.find((c) => c.value === f.category)?.label ?? f.category}
              </span>
              <span className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {(f.sizeBytes / 1024).toFixed(0)} KB
              </span>
              <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>
                {f.createdAt.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}
              </span>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                {f.hasDownload && (
                  <button
                    onClick={() => onDownload(f.id)}
                    style={{
                      background: "rgba(31,79,190,0.08)",
                      color: "var(--sky-700)",
                      border: "none",
                      padding: "5px 10px",
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Descargar
                  </button>
                )}
                <button
                  onClick={() => onDelete(f.id)}
                  style={{
                    background: "transparent",
                    color: "#9F1F1F",
                    border: "none",
                    padding: "5px 8px",
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Facturación tab
// ──────────────────────────────────────────────────────────────────────

function FacturacionView({ patient }: { patient: PatientWithRelations }) {
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
            gridTemplateColumns: "120px 1fr 100px 120px 110px",
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
          <span>Concepto</span>
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
                gridTemplateColumns: "120px 1fr 100px 120px 110px",
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
              <span style={{ color: "var(--navy-700)" }}>Sesión kinésica</span>
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

// Modal + FormField primitives are imported from `components/ui/`.
