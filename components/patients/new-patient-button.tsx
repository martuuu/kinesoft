"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { createPatient } from "@/lib/patients";

export function NewPatientButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <IconPlus size={14} /> Nuevo paciente
      </Button>
      {open && <NewPatientModal onClose={() => setOpen(false)} />}
    </>
  );
}

function NewPatientModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

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
      });
      if (!result.ok) {
        setError(result.error);
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        return;
      }
      onClose();
      router.refresh();
      router.push(`/pacientes/${result.data.id}`);
    });
  };

  return (
    <Modal onClose={onClose} width={540}>
      <header style={{ marginBottom: 16, paddingRight: 40 }}>
        <EyebrowLabel tone="accent">Nuevo paciente</EyebrowLabel>
        <h2 className="k-display" style={{ fontSize: 22, margin: "6px 0 0", fontWeight: 700 }}>
          Crear ficha
        </h2>
      </header>

      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="Nombre" name="firstName" required error={fieldErrors.firstName?.[0]} />
          <FormField label="Apellido" name="lastName" required error={fieldErrors.lastName?.[0]} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="DNI" name="documentId" error={fieldErrors.documentId?.[0]} />
          <FormField label="Nacimiento" name="dateOfBirth" type="date" error={fieldErrors.dateOfBirth?.[0]} />
        </div>
        <FormField label="Email" name="email" type="email" error={fieldErrors.email?.[0]} />
        <FormField label="Teléfono" name="phone" error={fieldErrors.phone?.[0]} />
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
    </Modal>
  );
}
