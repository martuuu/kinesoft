"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { IconPlus, IconX } from "@/components/ui/icons";
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
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="k-glass-strong"
        style={{ width: "min(540px, 100%)", borderRadius: 24, padding: 24 }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--sky-700)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Nuevo paciente
            </div>
            <h2 className="k-display" style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
              Crear ficha
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 36,
              height: 36,
              borderRadius: 12,
              cursor: "pointer",
              color: "var(--navy-700)",
            }}
          >
            <IconX size={16} />
          </button>
        </header>

        <form action={submit} style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Nombre" name="firstName" required error={fieldErrors.firstName} />
            <Field label="Apellido" name="lastName" required error={fieldErrors.lastName} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="DNI" name="documentId" error={fieldErrors.documentId} />
            <Field label="Nacimiento" name="dateOfBirth" type="date" error={fieldErrors.dateOfBirth} />
          </div>
          <Field label="Email" name="email" type="email" error={fieldErrors.email} />
          <Field label="Teléfono" name="phone" error={fieldErrors.phone} />
          <Field label="Notas" name="notes" textarea error={fieldErrors.notes} />

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
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  required,
  type = "text",
  textarea,
  error,
}: {
  label: string;
  name: string;
  required?: boolean;
  type?: string;
  textarea?: boolean;
  error?: string[];
}) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
        {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
      </span>
      {textarea ? (
        <textarea
          name={name}
          rows={3}
          style={inputStyle}
        />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          style={inputStyle}
        />
      )}
      {error && (
        <span style={{ fontSize: 11, color: "#9F1F1F" }}>{error.join(", ")}</span>
      )}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};
