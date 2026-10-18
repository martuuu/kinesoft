"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Section } from "@/components/patients/profile/ui";
import { createPatient } from "@/lib/patients";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { patientCreatePayload } from "@/components/patients/patient-form-payload";

type InsurerOption = { id: string; name: string };
type PractitionerOption = { id: string; name: string };

/*
 * PF1.1 (C-PF2): el formulario de alta salió de `new-patient-button.tsx` para cargarlo con `next/dynamic` (precarga
 * en hover/foco de «Nuevo paciente»). El código es el mismo; solo cambió de archivo.
 */
export function NewPatientModal({
  insurers,
  assignees,
  onClose,
}: {
  insurers: InsurerOption[];
  /**
   * T3d-1u (plan §23.5): presente = alta de la recepción (`agenda.operateAll` sin `clinical.read`). Son los
   * profesionales reservables (`listPractitioners`, cacheado) y «Profesional a cargo» es obligatorio: `createPatient`
   * exige `assignTo` sin `clinical.read`. Sin notas ni diagnóstico (los carga el profesional). Ausente = el alta del
   * profesional de siempre, que queda a su cargo.
   */
  assignees?: PractitionerOption[];
  onClose: () => void;
}) {
  const mode = assignees ? "admin" : "full";
  const router = useRouter();
  const [pending, start] = useTransition();
  // EV1-C2: Clínica general no tiene `diagnostico` (lib/tenant-modules.ts). Los
  // campos son los mismos (`diagnosisTitle/Note`), rotulados como motivo de consulta.
  const isKine = useTenantModules().has("diagnostico");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  // Coverage (obra social): "particular" | "ins:<id>" | "other".
  const [coverage, setCoverage] = useState("particular");
  const [otherInsurer, setOtherInsurer] = useState("");
  // Sin preselección aunque haya uno solo: la ficha queda a cargo de quien se elija y decide quién ve la HC.
  const [assignTo, setAssignTo] = useState("");
  // Dirty-guard (A2b-S-ui): Esc / fondo / X ya no tiran la ficha a medio cargar.
  const formRef = useRef<HTMLFormElement | null>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, { coverage, otherInsurer, assignTo });

  const submit = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    if (mode === "admin" && !assignTo) {
      setFieldErrors({ assignTo: ["Elegí el profesional a cargo."] });
      return;
    }
    start(async () => {
      const result = await createPatient(
        patientCreatePayload(mode, formData, coverage, otherInsurer),
        mode === "admin" ? { assignTo } : undefined
      );
      if (!result.ok) {
        setError(result.error);
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        return;
      }
      onClose();
      // PF-0d: sin `router.refresh()` antes del push: `createPatient` ya
      // revalidó "/pacientes" (la respuesta trajo la lista) y la navegación
      // renderiza la ficha nueva igual. Eran dos renders de más.
      router.push(`/pacientes/${result.data.id}`);
    });
  };

  return (
    <Drawer open onClose={onClose} width={560} dirty={dirty}>
      <header style={{ marginBottom: 16, paddingRight: 40 }}>
        <EyebrowLabel tone="accent">Nuevo paciente</EyebrowLabel>
        <h2 className="k-display" style={{ fontSize: 22, margin: "6px 0 0", fontWeight: 700 }}>
          Crear ficha
        </h2>
      </header>

      <form
        ref={formRef}
        action={submit}
        onInput={onFormInput}
        onChange={onFormInput}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <FormField label="Nombre" name="firstName" required error={fieldErrors.firstName?.[0]} />
        <FormField label="Apellido" name="lastName" required error={fieldErrors.lastName?.[0]} />
        <FormField label="DNI" name="documentId" required error={fieldErrors.documentId?.[0]} />
        <FormField label="Nacimiento" name="dateOfBirth" type="date" error={fieldErrors.dateOfBirth?.[0]} />
        <FormField label="Email" name="email" type="email" error={fieldErrors.email?.[0]} />
        <FormField label="Teléfono" name="phone" error={fieldErrors.phone?.[0]} />
        <FormField
          as="select"
          label="Obra social"
          value={coverage}
          onChange={(v) => setCoverage(v)}
          options={[
            { value: "particular", label: "Particular (sin cobertura)" },
            ...insurers.map((i) => ({ value: `ins:${i.id}`, label: i.name })),
            { value: "other", label: "Otra (escribir manualmente)" },
          ]}
        />
        {coverage === "other" && (
          <FormField
            label="Nombre de la obra social"
            value={otherInsurer}
            onChange={(v) => setOtherInsurer(v)}
            placeholder="Ej: PAMI, IOSFA…"
          />
        )}

        {assignees && (
          <FormField
            as="select"
            label="Profesional a cargo"
            required
            value={assignTo}
            onChange={(v) => setAssignTo(v)}
            error={fieldErrors.assignTo?.[0]}
            hint={
              assignees.length === 0
                ? "No hay profesionales que atiendan en el consultorio: sumá uno en Configuración para dar de alta pacientes."
                : "Es quien atiende al paciente y carga su historia clínica."
            }
            options={[
              { value: "", label: "Elegí un profesional" },
              ...assignees.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        )}

        {mode === "full" && (
          <>
            <Section title={isKine ? "Diagnóstico (opcional)" : "Motivo de consulta (opcional)"}>
              <FormField
                label="Título"
                name="diagnosisTitle"
                placeholder={isKine ? "ej: Lumbalgia" : "ej: Control anual"}
                error={fieldErrors.diagnosisTitle?.[0]}
                hint="Máx. 80 caracteres."
              />
              <FormField
                as="textarea"
                label="Descripción"
                name="diagnosisNote"
                placeholder="Detalle del cuadro, objetivos, indicaciones…"
                error={fieldErrors.diagnosisNote?.[0]}
                hint="Autocompleta el título y la descripción de los turnos nuevos del paciente."
              />
            </Section>

            <FormField as="textarea" label="Notas generales" name="notes" error={fieldErrors.notes?.[0]} />
          </>
        )}

        {error && (
          <div
            style={{
              padding: "8px 12px",
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
          <Button type="submit" variant="primary" disabled={pending || assignees?.length === 0}>
            {pending ? "Creando…" : "Crear paciente"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
