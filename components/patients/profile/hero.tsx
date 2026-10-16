"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
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
import {
  ArchivePatientDialog,
  shouldAskArchivePlans,
  type ArchivePatientResult,
} from "@/components/patients/archive-patient-dialog";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import type { HeroPlanChip, PatientHeroProps } from "@/components/planes/plan-editor-types";
import { disciplineLabel } from "@/lib/plan-display";
import type { PatientArchivePlansAction } from "@/lib/plans-lifecycle-state";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { Section, Grid2 } from "./ui";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

/**
 * Hero del perfil `full`. S22h (ES3): el chip único de plan
 * (`HeroPlanState`, P0-S02u-perfil) pasa a un chip POR PLAN VIVO con su
 * disciplina (`heroPlanChips`: ACTIVE antes que PAUSED). Un paciente puede
 * tener Kine y Osteo en paralelo, y "Plan activo +1" no decía cuál.
 * "Plan" significa tres cosas: el plan de la OBRA SOCIAL sigue siendo
 * `coverageLabel` (fact "Cobertura"), nunca un chip de acá.
 * Los chips no llevan título (PHI, PD-11): `HeroPlanChip` no lo trae.
 */
export function PatientHero({
  patient,
  age,
  coverageLabel,
  plans,
  insurers,
  practitioners,
  canReassign,
  plansEnabled,
  onOpenPlan,
}: PatientHeroProps) {
  // Modals lifted here — outside the <Card glass> — so backdrop-filter
  // on the card doesn't create a stacking context that traps position:fixed.
  const [editing, setEditing] = useState(false);
  const [askPlans, setAskPlans] = useState(false);
  const livePlanCount = plansEnabled ? plans.length : 0;
  const practitionerFact = usePractitionerFactLabel();

  // L9: el diálogo junta la elección; la action va acá (single, no bulk).
  const archiveWithPlans = async (plansAction: PatientArchivePlansAction): Promise<ArchivePatientResult> => {
    const r = await setPatientArchived({ id: patient.id, archived: true, plansAction });
    if (!r.ok) return { ok: false, error: r.error };
    // PF-0d: sin `router.refresh()`; `setPatientArchived` revalida la ficha.
    return { ok: true };
  };

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
            {plansEnabled && <HeroPlanChips plans={plans} onOpenPlan={onOpenPlan} />}
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
              label={practitionerFact}
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
          livePlanCount={livePlanCount}
          plansEnabled={plansEnabled}
          onAskArchivePlans={() => setAskPlans(true)}
          onEdit={() => setEditing(true)}
        />
      </Card>

      <ArchivePatientDialog
        open={askPlans}
        onClose={() => setAskPlans(false)}
        patientName={`${patient.firstName} ${patient.lastName}`}
        livePlanCount={livePlanCount}
        onConfirm={archiveWithPlans}
      />

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
  const practitionerFact = usePractitionerFactLabel();
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
          <HeroFact label={practitionerFact} value={patient.assignedPractitionerName ?? "Consultorio común"} />
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
  livePlanCount,
  plansEnabled,
  onAskArchivePlans,
  onEdit,
}: {
  patient: PatientWithRelations;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  /** Planes vivos (ACTIVE/PAUSED) del paciente: decide si archivar pregunta L9. */
  livePlanCount: number;
  plansEnabled: boolean;
  /** Abre el diálogo L9 (vive fuera del Card glass, como el de Editar). */
  onAskArchivePlans: () => void;
  onEdit: () => void;
}) {
  const confirm = useConfirm();
  const [archiving, startArchive] = useTransition();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const isArchived = !!patient.archivedAt;

  // A2a-S08 (decisión del dueño 30-sep): se quitó "Eliminar definitivamente"
  // — borraba en cascada turnos, cobros, planes y archivos sin retorno. Queda
  // Archivar: oculta la ficha del listado y se revierte desde "archivados".
  const toggleArchive = async () => {
    // L9 (PD-10): con planes vivos, archivar pregunta qué hacer con ellos
    // (pausar por default o cancelar los turnos futuros). Sin planes sigue el
    // confirm de siempre, y el server aplica su default (`pause`, no-op).
    if (!isArchived && shouldAskArchivePlans({ plansEnabled, livePlanCount })) {
      setArchiveError(null);
      onAskArchivePlans();
      return;
    }
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
      // PF-0d: sin `router.refresh()`; `setPatientArchived` revalida la ficha
      // y la respuesta de la action ya trae el árbol nuevo.
    });
  };

  const [portalSending, startPortal] = useTransition();
  const [portalResult, setPortalResult] = useState<
    | { ok: true; emailSent: boolean; portalUrl: string; emailStatus?: string }
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
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
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
              : "var(--danger-bg)",
            color: portalResult.ok ? "var(--navy-900)" : "var(--danger-fg)",
            textAlign: "right",
          }}
        >
          {portalResult.ok
            ? portalResult.emailSent
              ? "✓ Email enviado al paciente."
              : portalResult.emailStatus === "skipped"
                ? `Este entorno no manda mails: compartile el link del portal. ${portalResult.portalUrl}`
                : `No pudimos mandar el mail. Probá de nuevo en un rato. Link del portal: ${portalResult.portalUrl}`
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
  // EV1-C2: en Clínica general no hay «diagnóstico» de kinesiología; los campos
  // (`diagnosisTitle/Note`) son los mismos, pero se rotulan como motivo de consulta.
  const isKine = useTenantModules().has("diagnostico");

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
      // PF-0d: sin `router.refresh()`. `updatePatient`, `setPatientCoverage` y
      // `assignPatientToPractitioner` revalidan `/pacientes/<id>` en su OK:
      // cada respuesta trae la ficha nueva (la última, el estado final).
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
          <Section title={isKine ? "Asignación - Kinesiólogo asignado" : "Asignación - Profesional asignado"}>
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

        <Section title={isKine ? "Diagnóstico (opcional)" : "Motivo de consulta (opcional)"}>
          <FormField
            label="Título"
            name="diagnosisTitle"
            placeholder={isKine ? "ej: Lumbalgia" : "ej: Control anual"}
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

        <Section title="Notas generales">
          <FormField as="textarea" label="" name="notes" defaultValue={patient.notes ?? ""} />
        </Section>

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

/**
 * EV1-C2: rótulo del profesional asignado en el hero. «Kine» es de kinesiología;
 * un consultorio de Clínica general dice «Profesional». Vertical real del
 * contexto (EV1; antes se deducía de `has("sesiones")`).
 */
function usePractitionerFactLabel(): string {
  return useTenantModules().vertical === "KINESIOLOGY" ? "Kine" : "Profesional";
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

/**
 * Texto del chip de un plan vivo en el hero (puro, lo usa el render test).
 * "3/10" = realizadas / sesiones vivas (`done`/`totalLive`), NO "Sesión 3 de
 * 10": por eso no se usa el modo contador de `DisciplineChip` (ese es el
 * ordinal de UNA sesión). El aria lo dice entero, con la disciplina, porque el
 * color no puede ser el único canal (AGENTS §5).
 */
export function heroPlanChipText(chip: HeroPlanChip): { progress: string; ariaLabel: string } {
  const disc = chip.discipline ? `Plan de ${disciplineLabel(chip.discipline)}` : "Plan";
  const paused = chip.status === "PAUSED" ? ", pausado" : "";
  return {
    progress: `${chip.done}/${chip.totalLive}`,
    ariaLabel: `${disc}: ${chip.done} de ${chip.totalLive} ${chip.totalLive === 1 ? "sesión realizada" : "sesiones realizadas"}${paused}`,
  };
}

function HeroPlanChips({
  plans,
  onOpenPlan,
}: {
  plans: HeroPlanChip[];
  onOpenPlan?: (programId: string) => void;
}) {
  if (plans.length === 0) return <Tag tone="soft">Sin plan activo</Tag>;
  return (
    <ul
      aria-label="Planes en curso"
      style={{ display: "flex", gap: 6, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}
    >
      {plans.map((p) => {
        const { progress, ariaLabel } = heroPlanChipText(p);
        const paused = p.status === "PAUSED";
        const body = (
          <>
            <DisciplineChip discipline={p.discipline} />
            <span className="k-mono" aria-hidden style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-700)" }}>
              {progress}
            </span>
            {paused && (
              <span aria-hidden style={{ fontSize: 10.5, fontWeight: 600, color: "var(--navy-500)" }}>
                Pausado
              </span>
            )}
          </>
        );
        const boxStyle: React.CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 8px 2px 3px",
          borderRadius: 999,
          background: paused ? "rgba(15,30,51,0.04)" : "#fff",
          border: "1px solid rgba(15,30,51,0.08)",
          opacity: paused ? 0.85 : 1,
          font: "inherit",
        };
        return (
          <li key={p.programId} data-testid="hero-plan-chip" data-status={p.status}>
            {onOpenPlan ? (
              <button
                type="button"
                onClick={() => onOpenPlan(p.programId)}
                aria-label={`${ariaLabel}. Ver el plan`}
                style={{ ...boxStyle, cursor: "pointer" }}
              >
                {body}
              </button>
            ) : (
              <span role="group" aria-label={ariaLabel} style={boxStyle}>
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
