"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import {
  assignPatientToPractitioner,
  setPatientCoverage,
  setPatientDefaultCopago,
  updatePatient,
} from "@/lib/patients";
import type { PatientAdminCore } from "@/lib/patients-types";
import { copagoFieldFromCents, patientUpdatePayload, type PatientFormMode } from "@/components/patients/patient-form-payload";
import { listPayerPlans, proposePayerPlan } from "@/lib/catalog";
import type { PayerPlanOption } from "@/lib/catalog-schemas";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { Section, Grid2 } from "./ui";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

/**
 * T3d-1u: lo que «Editar datos» necesita de la ficha `admin` (se le pasa `PatientAdminCore` tal cual). T3e-2p (H-1u-1):
 * la proyección trae `insurerId`, `payerPlanId`, `copagoCents` y `updatedAt`, así que el formulario arranca igual que
 * el del perfil completo: la OS del catálogo por id (antes por nombre, que un renombre perdía), el copago propio
 * cargado, el aviso antes de borrarlo al cambiar de OS y `expectedUpdatedAt` en `updatePatient`.
 */
export type AdminEditablePatient = Pick<
  PatientAdminCore,
  "id" | "firstName" | "lastName" | "documentId" | "email" | "phone" | "dateOfBirth" | "updatedAt" | "coverage"
>;

/**
 * Aviso antes de cambiar la OS de un paciente con copago propio (H2, A2a-S08): cambiar la cobertura lo borra
 * (`resetCopago`). `null` = no hay copago propio, no se pregunta. Mismo texto en los dos modos del drawer.
 */
export function coverageChangeConfirm(ownCopagoCents: number | null) {
  if (ownCopagoCents == null) return null;
  return {
    title: "Cambiar la obra social",
    message: `Este paciente tiene un copago propio de ${formatARS(ownCopagoCents)}. Al cambiar la cobertura, el copago propio se va a borrar y los próximos turnos van a cobrar el de la nueva cobertura.`,
    confirmLabel: "Cambiar y borrar el copago",
    tone: "danger" as const,
  };
}

/** La ficha que edita el formulario, igual en los dos modos. */
type EditableCoverage = {
  insurer: string;
  insurerId: string | null;
  planName: string | null;
  payerPlanId: string | null;
  memberId: string | null;
  copagoCents: number | null;
};
type EditablePatient = {
  id: string;
  firstName: string;
  lastName: string;
  documentId: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | string | null;
  updatedAt: string | null;
  coverage: EditableCoverage | null;
  assignedPractitionerId: string | null;
  diagnosisTitle: string | null;
  diagnosisNote: string | null;
  notes: string | null;
};

const toIso = (d: Date | string) => new Date(d).toISOString();

function fromFull(p: PatientWithRelations): EditablePatient {
  const c = p.coverages[0];
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    documentId: p.documentId,
    email: p.email,
    phone: p.phone,
    dateOfBirth: p.dateOfBirth,
    updatedAt: toIso(p.updatedAt),
    coverage: c
      ? {
          insurer: c.insurer,
          insurerId: c.insurerId,
          planName: c.planName,
          payerPlanId: c.payerPlanId ?? null,
          memberId: c.memberId,
          copagoCents: c.copagoCents ?? null,
        }
      : null,
    assignedPractitionerId: p.assignedPractitionerId,
    diagnosisTitle: p.diagnosisTitle,
    diagnosisNote: p.diagnosisNote,
    notes: p.notes,
  };
}

function fromAdmin(p: AdminEditablePatient): EditablePatient {
  const c = p.coverage;
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    documentId: p.documentId,
    email: p.email,
    phone: p.phone,
    dateOfBirth: p.dateOfBirth,
    updatedAt: toIso(p.updatedAt),
    // Texto libre (`insurerId` null) queda como «Otra» con su nombre, igual que en el perfil completo.
    coverage: c
      ? {
          insurer: c.insurer,
          insurerId: c.insurerId,
          planName: c.planName,
          payerPlanId: c.payerPlanId,
          memberId: c.memberId,
          copagoCents: c.copagoCents,
        }
      : null,
    assignedPractitionerId: null,
    diagnosisTitle: null,
    diagnosisNote: null,
    notes: null,
  };
}

type EditPatientModalProps =
  | {
      mode?: "full";
      patient: PatientWithRelations;
      insurers: InsurerOption[];
      practitioners: PractitionerOption[];
      canReassign: boolean;
      onClose: () => void;
    }
  | {
      /**
       * T3d-1u (plan §23.5): «Editar datos» de la ficha `admin` (Secretaria, Admin con `patients.editAdmin`). Datos
       * personales, cobertura y copago propio; NO manda `notes`/`diagnosisTitle`/`diagnosisNote` (ni vacías:
       * `updatePatient` rechaza el pedido entero) ni reasigna.
       */
      mode: "admin";
      patient: AdminEditablePatient;
      insurers: InsurerOption[];
      onClose: () => void;
    };

/*
 * PF1.1 (C-PF2): el drawer «Editar paciente» salió de `hero.tsx` a su propio módulo para cargarlo con `next/dynamic`
 * (precarga en hover/foco de «Editar»). Son ~400 líneas de formulario (cobertura, planes de la prestadora, profesional
 * a cargo) que la mayoría de las visitas a la ficha no abre. El código es el mismo de antes; solo cambió de archivo.
 */
export function EditPatientModal(props: EditPatientModalProps) {
  const { insurers, onClose } = props;
  const mode: PatientFormMode = props.mode === "admin" ? "admin" : "full";
  const practitioners = props.mode === "admin" ? [] : props.practitioners;
  const canReassign = props.mode === "admin" ? false : props.canReassign;
  // Se normaliza una vez (la ficha no cambia mientras el drawer está abierto: al guardar se cierra).
  const [patient] = useState<EditablePatient>(() =>
    props.mode === "admin" ? fromAdmin(props.patient) : fromFull(props.patient)
  );
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const currentCoverage = patient.coverage;
  const initialCoverageMode = currentCoverage
    ? currentCoverage.insurerId
      ? `ins:${currentCoverage.insurerId}`
      : "other"
    : "particular";
  const [coverageMode, setCoverageMode] = useState(initialCoverageMode);
  const [otherInsurerName, setOtherInsurerName] = useState(
    currentCoverage && !currentCoverage.insurerId ? currentCoverage.insurer : ""
  );
  // T3-Z B1: copago propio en `MoneyInput` (centavos, teclado numérico en el celular) en vez de texto libre.
  const [ownCopagoCents, setOwnCopagoCents] = useState<number | null>(currentCoverage?.copagoCents ?? null);
  const [ownCopagoInvalid, setOwnCopagoInvalid] = useState(false);
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
  const expectedUpdatedAt = useRef<string | null>(patient.updatedAt);
  // Dirty-guard (A2b-S-ui): Esc / fondo / X piden confirmación si hay cambios.
  const formRef = useRef<HTMLFormElement | null>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, {
    coverageMode,
    otherInsurerName,
    assignedKine,
    planChoice,
    newPlanName,
    ownCopagoCents,
  });
  const initialPlan = currentCoverage?.planName ?? "";
  const initialMember = currentCoverage?.memberId ?? "";
  const initialOther = currentCoverage && !currentCoverage.insurerId ? currentCoverage.insurer : "";

  const submit = async (formData: FormData) => {
    setError(null);
    const planName = String(formData.get("coveragePlan") ?? "").trim();
    const memberId = String(formData.get("coverageMember") ?? "").trim();
    // Copago propio (solo modo admin; el profesional lo cambia desde el modal del turno, como siempre).
    const copago =
      mode === "admin"
        ? copagoFieldFromCents(ownCopagoCents, ownCopagoInvalid, currentCoverage?.copagoCents ?? null)
        : ({ kind: "none" } as const);
    if (copago.kind === "invalid") {
      setError("Revisá el copago propio: tiene que ser un monto en pesos, por ejemplo 6.000.");
      return;
    }
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
    let resetCopago = false;
    const ask = osChanged ? coverageChangeConfirm(currentCoverage?.copagoCents ?? null) : null;
    if (ask) {
      const ok = await confirm(ask);
      if (!ok) return;
      resetCopago = true;
    }

    start(async () => {
      // T3d-1u: en modo admin el payload sale SIN claves clínicas (`patientUpdatePayload`).
      const updateResult = await updatePatient(
        patientUpdatePayload(mode, patient.id, expectedUpdatedAt.current, formData)
      );
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

      // Copago propio, después de la cobertura: si la OS cambió y el copago viejo se borró (`resetCopago`), el monto
      // nuevo queda sobre la cobertura nueva.
      if (copago.kind === "set") {
        const r = await setPatientDefaultCopago({ patientId: patient.id, copagoCents: copago.cents });
        if (!r.ok) {
          setError(r.error);
          return;
        }
      }

      // Reasignar: `tenant.sensitive` (T3-Z M2), lo decide `canReassign` del server.
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

  // `dateOfBirth` es fecha civil (excepción de AGENTS §4): el ISO tal cual, sin TZ.
  const dobIso = patient.dateOfBirth ? toIso(patient.dateOfBirth).slice(0, 10) : "";

  return (
    <Drawer open onClose={onClose} title={mode === "admin" ? "Editar datos" : "Editar paciente"} width={560} dirty={dirty}>
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
            {/* T3-Y (decisión de Martin 19-oct): la recepción carga y corrige el email (se revirtió el bloqueo de
                T3-Z A1). La red del portal es PD-15: auto-vínculo solo con email verificado y una sola ficha. */}
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
          {mode === "admin" && (
            <MoneyInput
              label="Copago propio (opcional)"
              value={ownCopagoCents}
              onChange={setOwnCopagoCents}
              onInvalidChange={setOwnCopagoInvalid}
              placeholder="ej: 6.000"
              hint="Reemplaza el copago de la cobertura en los próximos turnos. Si lo borrás no cambia: para volver al de la obra social, cambiá la cobertura."
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
              hint="«Consultorio común» = la ficha completa la ven el titular o el administrador; los profesionales ven datos básicos."
              value={assignedKine}
              onChange={(v) => setAssignedKine(v)}
              options={[
                { value: "", label: "Consultorio común" },
                ...practitioners.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Section>
        )}

        {/* Modo admin: sin notas ni diagnóstico (los carga el profesional a cargo). */}
        {mode === "full" && (
          <>
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
          </>
        )}

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
