"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS } from "@/lib/format";
import { assignPatientToPractitioner, setPatientCoverage, updatePatient } from "@/lib/patients";
import { listPayerPlans, proposePayerPlan } from "@/lib/catalog";
import type { PayerPlanOption } from "@/lib/catalog-schemas";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { Section, Grid2 } from "./ui";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

/*
 * PF1.1 (C-PF2): el drawer «Editar paciente» salió de `hero.tsx` a su propio módulo para cargarlo con `next/dynamic`
 * (precarga en hover/foco de «Editar»). Son ~400 líneas de formulario (cobertura, planes de la prestadora, profesional
 * a cargo) que la mayoría de las visitas a la ficha no abre. El código es el mismo de antes; solo cambió de archivo.
 */
export function EditPatientModal({
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
