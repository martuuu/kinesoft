"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { Drawer } from "@/components/ui/drawer";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Section } from "@/components/patients/profile/ui";
import { createPatient } from "@/lib/patients";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

type InsurerOption = { id: string; name: string };

export function NewPatientButton({ insurers = [] }: { insurers?: InsurerOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <IconPlus size={14} /> Nuevo paciente
      </Button>
      {open && <NewPatientModal insurers={insurers} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewPatientModal({ insurers, onClose }: { insurers: InsurerOption[]; onClose: () => void }) {
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
  // Dirty-guard (A2b-S-ui): Esc / fondo / X ya no tiran la ficha a medio cargar.
  const formRef = useRef<HTMLFormElement | null>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, { coverage, otherInsurer });

  const submit = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const result = await createPatient({
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        documentId: String(formData.get("documentId") ?? ""),
        dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
        notes: String(formData.get("notes") ?? ""),
        diagnosisTitle: String(formData.get("diagnosisTitle") ?? ""),
        diagnosisNote: String(formData.get("diagnosisNote") ?? ""),
        insurerId: coverage.startsWith("ins:") ? coverage.slice(4) : undefined,
        insurerName: coverage === "other" ? otherInsurer.trim() || undefined : undefined,
      });
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

        <FormField as="textarea" label="Notas" name="notes" error={fieldErrors.notes?.[0]} />

        {error && (
          <div
            style={{
              padding: "8px 12px",
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
            {pending ? "Creando…" : "Crear paciente"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
