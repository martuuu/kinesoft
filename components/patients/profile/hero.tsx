"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, PhotoSlot } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { Drawer } from "@/components/ui/drawer";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS } from "@/lib/format";
import {
  assignPatientToPractitioner,
  sendPatientPortalInvite,
  setPatientArchived,
  setPatientCoverage,
  updatePatient,
} from "@/lib/patients";
import { listPayerPlans, proposePayerPlan } from "@/lib/catalog";
import type { PayerPlanOption } from "@/lib/catalog-schemas";
import type { PatientAdminCore } from "@/lib/patients-types";
import { SharePatientButton } from "@/components/patients/share-patient-button";
import { Section, Grid2 } from "./ui";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

/**
 * P0-S02u-perfil: estado del chip de plan del hero. Antes era un booleano
 * `active` que llegaba en true con cualquier plan (también terminado), así que
 * el hero decía "Plan activo" a un paciente dado de alta. Lo calcula
 * `pickProfilePrograms` (patient-profile.tsx).
 */
export type HeroPlanState =
  | { kind: "active"; otherActiveCount: number }
  | { kind: "paused" }
  | { kind: "ended" }
  | { kind: "none" };

export function PatientHero({
  patient,
  age,
  coverageLabel,
  plan,
  insurers,
  practitioners,
  canReassign,
}: {
  patient: PatientWithRelations;
  age: number | null;
  coverageLabel: string;
  plan: HeroPlanState;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
}) {
  // Modals lifted here — outside the <Card glass> — so backdrop-filter
  // on the card doesn't create a stacking context that traps position:fixed.
  const [editing, setEditing] = useState(false);

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
            <HeroPlanTag plan={plan} />
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
    </>
  );
}

/**
 * P0-S07v · Hero del perfil administrativo (nivel `admin`, PD-13): lo que ve
 * un rol sin `clinical.read` (Secretaria/ASSISTANT, BILLING).
 *
 * Es un componente aparte, no `PatientHero` con flags, porque recibe otro
 * tipo (`PatientAdminCore`, sin notas ni diagnóstico): así el compilador
 * impide que un campo clínico llegue a este render por error.
 *
 * Qué NO tiene, a propósito:
 *  - chip de plan: el título y el estado del plan son HC;
 *  - "Editar": `updatePatient` y `setPatientCoverage` exigen acceso `full`
 *    (lib/patients.ts) → para `admin` la ficha es de solo lectura;
 *  - Compartir, Archivar y Portal: también exigen `full` en el server.
 * "Agregar turno" solo con `canBook` (`agenda.operateAll`): BILLING no crea turnos.
 */
export function PatientAdminHero({
  patient,
  canBook,
}: {
  patient: PatientAdminCore;
  canBook: boolean;
}) {
  const age = patient.dateOfBirth
    ? Math.floor((Date.now() - +new Date(patient.dateOfBirth)) / (365.25 * 86_400_000))
    : null;
  const cov = patient.coverage;
  const coverageLabel = cov ? `${cov.insurer}${cov.planName ? " " + cov.planName : ""}` : "Particular";
  return (
    <Card glass style={{ padding: 18, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <PhotoSlot label="paciente" style={{ width: 88, height: 88, borderRadius: 22, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
          <Tag tone="soft">Ficha administrativa</Tag>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <h1 className="k-display" style={{ fontSize: 28, margin: 0, letterSpacing: "-0.02em" }}>
            {patient.firstName} {patient.lastName}
          </h1>
          <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
            {age != null ? `${age} años` : ""}
            {patient.documentId ? `${age != null ? " · " : ""}DNI ${patient.documentId}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 12, color: "var(--navy-500)", flexWrap: "wrap" }}>
          <HeroFact label="Tel." value={patient.phone ?? "—"} />
          <HeroFact label="Email" value={patient.email ?? "—"} />
          <HeroFact label="Cobertura" value={coverageLabel} />
          <HeroFact label="Kine" value={patient.assignedPractitionerName ?? "Consultorio común"} />
        </div>
      </div>
      {canBook && (
        <Link href={`/agenda?new=1&patient=${patient.id}`} style={{ textDecoration: "none" }}>
          <Button variant="primary" style={{ fontSize: 12, padding: "8px 14px" }}>
            <IconPlus size={12} /> Agregar turno
          </Button>
        </Link>
      )}
    </Card>
  );
}

function PatientHeroActions({
  patient,
  practitioners,
  onEdit,
}: {
  patient: PatientWithRelations;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [archiving, startArchive] = useTransition();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const isArchived = !!patient.archivedAt;

  // A2a-S08 (decisión del dueño 30-sep): se quitó "Eliminar definitivamente"
  // — borraba en cascada turnos, cobros, planes y archivos sin retorno. Queda
  // Archivar: oculta la ficha del listado y se revierte desde "archivados".
  const toggleArchive = async () => {
    const ok = await confirm(
      isArchived
        ? {
            title: "Desarchivar paciente",
            message: `${patient.firstName} ${patient.lastName} vuelve a aparecer en el listado de pacientes.`,
            confirmLabel: "Desarchivar",
          }
        : {
            title: "Archivar paciente",
            message: `${patient.firstName} ${patient.lastName} deja de aparecer en el listado. La ficha, los turnos y el historial se conservan, y lo podés desarchivar cuando quieras.`,
            confirmLabel: "Archivar",
          }
    );
    if (!ok) return;
    setArchiveError(null);
    startArchive(async () => {
      const r = await setPatientArchived({ id: patient.id, archived: !isArchived });
      if (!r.ok) {
        setArchiveError(r.error);
        return;
      }
      router.refresh();
    });
  };

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
          onClick={toggleArchive}
          disabled={archiving}
          title={
            isArchived
              ? "Volver a mostrar el paciente en el listado"
              : "Ocultar del listado sin borrar la ficha ni el historial"
          }
          style={{ fontSize: 12, padding: "8px 14px", color: "#9A5B00" }}
        >
          {archiving ? "Guardando…" : isArchived ? "Desarchivar" : "Archivar"}
        </Button>
      </div>
      {archiveError && (
        <div
          style={{
            maxWidth: 320,
            padding: 8,
            borderRadius: 8,
            fontSize: 11.5,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            textAlign: "right",
          }}
        >
          {archiveError}
        </div>
      )}
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
  const confirm = useConfirm();
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

  // ── Plan del catálogo (B1) ────────────────────────────────────────────
  // Si la OS elegida está vinculada a una prestadora del catálogo, el plan
  // se elige de sus planes (globales + propuestos por este consultorio) y se
  // guarda como `payerPlanId`; "Otro plan…" lo propone (`proposePayerPlan`,
  // idempotente: si ya existe con ese nombre devuelve el mismo). Sin
  // prestadora queda el texto libre de siempre.
  const selectedInsurer = coverageMode.startsWith("ins:")
    ? insurers.find((i) => `ins:${i.id}` === coverageMode)
    : undefined;
  const payerId = selectedInsurer?.payerId ?? null;
  const initialPayerId = insurers.find((i) => `ins:${i.id}` === initialCoverageMode)?.payerId ?? null;
  // Estado inicial del picker, solo con prestadora: plan vinculado → su id;
  // plan escrito a mano antes del catálogo → "Otro plan…" con ese texto (al
  // guardar se propone y queda vinculado); sin plan → "".
  const initialPlanChoice = !initialPayerId
    ? ""
    : currentCoverage?.payerPlanId
      ? currentCoverage.payerPlanId
      : currentCoverage?.planName
        ? OTHER_PLAN
        : "";
  const initialNewPlanName =
    initialPlanChoice === OTHER_PLAN ? (currentCoverage?.planName ?? "") : "";
  const [planChoice, setPlanChoice] = useState(initialPlanChoice);
  const [newPlanName, setNewPlanName] = useState(initialNewPlanName);
  const [plans, setPlans] = useState<PayerPlanOption[] | null>(null);
  useEffect(() => {
    if (!payerId) {
      setPlans(null);
      return;
    }
    let alive = true;
    setPlans(null);
    listPayerPlans(payerId)
      .then((rows) => {
        if (alive) setPlans(rows);
      })
      .catch(() => {
        if (alive) setPlans([]);
      });
    return () => {
      alive = false;
    };
  }, [payerId]);

  const changeCoverageMode = (v: string) => {
    setCoverageMode(v);
    // Volver a la OS original recupera su plan; otra OS arranca sin plan.
    if (v === initialCoverageMode) {
      setPlanChoice(initialPlanChoice);
      setNewPlanName(initialNewPlanName);
    } else {
      setPlanChoice("");
      setNewPlanName("");
    }
  };

  // Optimistic lock (A2a-S08): el `updatedAt` que vio este formulario. Se
  // actualiza tras un guardado OK, así un reintento (p. ej. si falló la
  // cobertura después de guardar los datos) no choca contra sí mismo.
  const expectedUpdatedAt = useRef(patient.updatedAt.toISOString());
  // Dirty-guard (A2b-S-ui): Esc / fondo / X piden confirmación si hay cambios.
  const formRef = useRef<HTMLFormElement | null>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, {
    coverageMode,
    otherInsurerName,
    assignedKine,
    planChoice,
    newPlanName,
  });
  const initialPlan = currentCoverage?.planName ?? "";
  const initialMember = currentCoverage?.memberId ?? "";
  const initialOther = currentCoverage && !currentCoverage.insurerId ? currentCoverage.insurer : "";

  const submit = async (formData: FormData) => {
    setError(null);
    const planName = String(formData.get("coveragePlan") ?? "").trim();
    const memberId = String(formData.get("coverageMember") ?? "").trim();
    // H2 (A2a-S08): dirty-check de la cobertura. Antes se re-guardaba siempre
    // con OS "Otra" (y el server hacía delete+create), borrando el copago
    // propio del paciente sin avisar.
    const norm = (v: string) => v.trim().toLowerCase();
    const osChanged =
      coverageMode !== initialCoverageMode ||
      (coverageMode === "other" && norm(otherInsurerName) !== norm(initialOther));
    const planDirty = payerId
      ? planChoice !== initialPlanChoice ||
        (planChoice === OTHER_PLAN && newPlanName.trim() !== initialNewPlanName.trim())
      : planName !== initialPlan;
    const coverageDirty =
      osChanged || (coverageMode !== "particular" && (planDirty || memberId !== initialMember));
    if (payerId && coverageDirty && planChoice === OTHER_PLAN && !newPlanName.trim()) {
      setError("Escribí el nombre del plan o elegí uno de la lista.");
      return;
    }
    const ownCopago = currentCoverage?.copagoCents ?? null;
    let resetCopago = false;
    if (osChanged && ownCopago != null) {
      const ok = await confirm({
        title: "Cambiar la obra social",
        message: `Este paciente tiene un copago propio de ${formatARS(ownCopago)}. Al cambiar la cobertura, el copago propio se va a borrar y los próximos turnos van a cobrar el de la nueva cobertura.`,
        confirmLabel: "Cambiar y borrar el copago",
        tone: "danger",
      });
      if (!ok) return;
      resetCopago = true;
    }

    start(async () => {
      const updateResult = await updatePatient({
        id: patient.id,
        expectedUpdatedAt: expectedUpdatedAt.current,
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
      expectedUpdatedAt.current = updateResult.data.updatedAt;

      // Coverage update — only when something actually changed.
      if (coverageDirty) {
        let cov;
        if (coverageMode === "particular") {
          cov = await setPatientCoverage({ patientId: patient.id, resetCopago });
        } else if (coverageMode === "other") {
          cov = await setPatientCoverage({
            patientId: patient.id,
            insurerName: otherInsurerName,
            planName,
            memberId,
            resetCopago,
          });
        } else {
          const insurerId = coverageMode.replace("ins:", "");
          let payerPlanId: string | undefined;
          let planText = planName;
          if (payerId) {
            planText = "";
            if (planChoice === OTHER_PLAN) {
              const proposed = await proposePayerPlan(payerId, newPlanName.trim());
              if (!proposed.ok) {
                setError(proposed.error);
                return;
              }
              payerPlanId = proposed.data.id;
            } else if (planChoice && (plans === null || plans.some((p) => p.id === planChoice))) {
              // `plans === null` = todavía cargando: se manda el id y lo valida el server.
              payerPlanId = planChoice;
            } else if (planChoice) {
              // El plan vinculado ya no está en el catálogo (Plataforma lo
              // archivó): se conserva como texto en vez de rechazar el guardado.
              planText = currentCoverage?.planName ?? "";
            }
          }
          cov = await setPatientCoverage({
            patientId: patient.id,
            insurerId,
            planName: planText,
            payerPlanId,
            memberId,
            resetCopago,
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
    <Drawer open onClose={onClose} title="Editar paciente" width={560} dirty={dirty}>
      <form
        ref={formRef}
        action={submit}
        onInput={onFormInput}
        onChange={onFormInput}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
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
            onChange={changeCoverageMode}
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
              {payerId ? (
                <FormField
                  as="select"
                  label="Plan"
                  value={planChoice}
                  onChange={setPlanChoice}
                  disabled={plans === null}
                  options={planOptions({
                    plans,
                    planChoice,
                    fallbackName: currentCoverage?.planName ?? null,
                  })}
                />
              ) : (
                <FormField
                  label="Plan"
                  name="coveragePlan"
                  defaultValue={currentCoverage?.planName ?? ""}
                  placeholder="210, Black, …"
                />
              )}
              <FormField
                label="N° de afiliado"
                name="coverageMember"
                defaultValue={currentCoverage?.memberId ?? ""}
              />
            </Grid2>
          )}
          {coverageMode !== "particular" && payerId && planChoice === OTHER_PLAN && (
            <FormField
              label="Nombre del plan"
              value={newPlanName}
              onChange={setNewPlanName}
              placeholder="Ej: 310, Plan Joven…"
              hint="Si no está en la lista, lo sumamos para este consultorio."
            />
          )}
        </Section>

        {canReassign && (
          <Section title="Asignación - Kinesiólogo asignado">
            <FormField
              as="select"
              label=""
              // A2b: el hint anterior ("visible para todos los kines") era falso —
              // sin asignación, la HC completa la ven OWNER/ADMIN y los demás
              // profesionales solo ven datos básicos (salvo que se la compartan).
              hint="«Consultorio común» = visible para OWNER/ADMIN; los profesionales ven datos básicos."
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

/** Valor del select de plan que abre el campo "Nombre del plan". */
const OTHER_PLAN = "__other";

/**
 * Opciones del select de plan. Mientras cargan, el plan ya vinculado se
 * muestra igual (su nombre está en `Coverage.planName`) para que el select
 * no salte; si después no aparece en la lista (archivado por Plataforma), se
 * mantiene como opción con su nombre.
 */
function planOptions({
  plans,
  planChoice,
  fallbackName,
}: {
  plans: PayerPlanOption[] | null;
  planChoice: string;
  fallbackName: string | null;
}): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [
    { value: "", label: plans === null ? "Cargando planes…" : "Sin plan" },
  ];
  for (const p of plans ?? []) {
    opts.push({ value: p.id, label: p.proposed ? `${p.name} (cargado por el consultorio)` : p.name });
  }
  if (planChoice && planChoice !== OTHER_PLAN && !(plans ?? []).some((p) => p.id === planChoice)) {
    opts.push({ value: planChoice, label: fallbackName ?? "Plan actual" });
  }
  opts.push({ value: OTHER_PLAN, label: "Otro plan…" });
  return opts;
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

function HeroPlanTag({ plan }: { plan: HeroPlanState }) {
  if (plan.kind === "active") {
    const n = plan.otherActiveCount;
    return (
      <>
        <Tag tone="lime">Plan activo</Tag>
        {/* "+N": hay más de un plan ACTIVE (p. ej. Kine y Osteo en paralelo). El
            número solo no se entiende con lector de pantalla: `role="img"` + aria
            (un aria-label en un span genérico se ignora). */}
        {n > 0 && (
          <span
            role="img"
            aria-label={`Y ${n} ${n === 1 ? "plan activo más" : "planes activos más"}`}
            title={`${n} ${n === 1 ? "plan activo más" : "planes activos más"}: miralos en el tab Plan`}
          >
            <Tag tone="lime">+{n}</Tag>
          </span>
        )}
      </>
    );
  }
  if (plan.kind === "paused") return <Tag tone="soft">Plan pausado</Tag>;
  if (plan.kind === "ended") return <Tag tone="soft">Sin plan activo</Tag>;
  return <Tag tone="soft">Sin plan</Tag>;
}
