"use client";

/**
 * [BO3-B] «Entrar como soporte» del header del detalle (BO2-E, C-BO9; decisión 3 de Martin). Modal con motivo
 * obligatorio y el aviso literal del brief → `startSupport(tenantId, reason)` → `router.push("/dashboard")`.
 *
 * Por qué Modal y no Drawer: es una confirmación con un solo campo, no un formulario de carga (AGENTS §5).
 * Por qué deshabilitado en baja: un consultorio CLOSED no tiene acceso (`tenantAccessFor` → `closed`); entrar como
 * soporte mostraría la pantalla de cuenta dada de baja y dejaría una sesión de soporte abierta sin sentido.
 *
 * El soporte no se despliega sin BO4 (MFA): el botón existe, pero el gate del deploy lo decide BO4.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { TenantStatus } from "@prisma/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { startSupport } from "@/lib/platform-support";
import {
  SUPPORT_REASON_MAX,
  SUPPORT_REASON_MIN,
  SUPPORT_WARNING_COPY,
} from "@/components/plataforma/tenants/labels";
import { ErrorBox, WarnBox } from "@/components/plataforma/tenants/detail-ui";

/** null = se puede entrar; si no, por qué no (va como texto al lado del botón). */
export function supportDisabledReason(status: TenantStatus): string | null {
  if (status === "CLOSED") return "El consultorio está de baja: no se puede entrar como soporte.";
  return null;
}

export function isSupportReasonValid(reason: string): boolean {
  const n = reason.trim().length;
  return n >= SUPPORT_REASON_MIN && n <= SUPPORT_REASON_MAX;
}

export function SupportForm({
  tenantName,
  reason,
  pending,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  tenantName: string;
  reason: string;
  pending: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const n = reason.trim().length;
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <WarnBox>{SUPPORT_WARNING_COPY}</WarnBox>
      <FormField
        as="textarea"
        rows={3}
        label="Motivo"
        required
        value={reason}
        onChange={onChange}
        placeholder={`Ej.: el titular de ${tenantName} pidió ayuda con la configuración de turnos online`}
        hint={`Lo ve el dueño en el mail y en Configuración. Sin datos de pacientes. ${n}/${SUPPORT_REASON_MAX}${
          n < SUPPORT_REASON_MIN ? ` (mínimo ${SUPPORT_REASON_MIN})` : ""
        }`}
        disabled={pending}
        autoFocus
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !isSupportReasonValid(reason)}>
          {pending ? "Entrando…" : "Entrar como soporte"}
        </Button>
      </div>
    </form>
  );
}

export function SupportButton({
  tenantId,
  tenantName,
  status,
}: {
  tenantId: string;
  tenantName: string;
  status: TenantStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = supportDisabledReason(status);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || !isSupportReasonValid(reason)) return;
    setPending(true);
    setError(null);
    try {
      const res = await startSupport(tenantId, reason.trim());
      if (!res.ok) {
        setError(res.error);
        setPending(false);
        return;
      }
      // Sin `setPending(false)`: la navegación desmonta el Modal; así no se puede mandar dos veces.
      router.push(res.data.redirectTo || "/dashboard");
    } catch {
      setError("No se pudo abrir el soporte. Revisá la conexión y probá de nuevo.");
      setPending(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
      <Button
        type="button"
        variant="ghost"
        disabled={!!blocked}
        title={blocked ?? undefined}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Entrar como soporte
      </Button>
      {blocked && <span style={{ fontSize: 11.5, color: "var(--navy-300)", maxWidth: 240, textAlign: "right" }}>{blocked}</span>}
      <Modal
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title={`Entrar como soporte a ${tenantName}`}
        lockBackdrop={pending}
      >
        <SupportForm
          tenantName={tenantName}
          reason={reason}
          pending={pending}
          error={error}
          onChange={setReason}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Modal>
    </div>
  );
}
