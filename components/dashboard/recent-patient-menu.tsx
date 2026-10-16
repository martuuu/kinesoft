"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { IconArrow, IconCheck, IconPlus, IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { setBookingStatus } from "@/lib/bookings";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
  type ForceFlags,
} from "@/lib/booking-force-flags";
import type { DashboardData } from "@/lib/dashboard";
import styles from "./dashboard.module.css";

/**
 * Menú de acciones rápidas de una fila de «Pacientes recientes» (abrir HC, marcar realizado/ausente, nuevo turno).
 * Ver el contrato completo (acceso `basic`, optimistic lock, confirmaciones de forzado) en `recent-patients.tsx`.
 *
 * PF1.1-dashboard (C-PF2): módulo aparte, bajado con `next/dynamic` al abrir el «⋯» (precarga en hover/foco). Trae la
 * action de turnos, `useConfirm` y los flags de forzado, que ninguna carga del tablero necesita hasta el click.
 */
export function QuickMenu({
  patient,
  onClose,
}: {
  patient: DashboardData["recent"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canEdit = patient.access === "full" && !!patient.nextBookingId;

  const setStatus = (
    status: "CONFIRMED" | "COMPLETED" | "NO_SHOW",
    force: ForceFlags = {}
  ) => {
    if (!canEdit) return;
    setError(null);
    start(async () => {
      const r = await setBookingStatus(
        patient.nextBookingId!,
        status,
        patient.nextBookingUpdatedAt ? new Date(patient.nextBookingUpdatedAt).toISOString() : undefined,
        force
      );
      if (!r.ok) {
        // Cupo, superposición y (B5.7) bloqueo / fuera de horario: se confirma
        // y se re-llama acumulando el flag (`lib/booking-force-flags.ts`).
        const prompt = nextForcePrompt(r, force);
        if (prompt) {
          const ok = await confirm(forcePromptConfirm(prompt, "edit"));
          if (ok) setStatus(status, withForce(force, prompt));
          return;
        }
        setError(r.error);
        // Un rechazo por lock ("stale") deja el `updatedAt` viejo en pantalla:
        // refrescamos para que el próximo intento use el valor actual.
        // refresh-ok: el rechazo sale de `updateBooking` antes de cualquier `revalidatePath` (no hay RSC nuevo).
        router.refresh();
        return;
      }
      // C-PF4: el éxito pasa por `updateBooking`, que hace `revalidatePath("/dashboard")`: Next trae el RSC nuevo con
      // la respuesta de la action. El `router.refresh()` que había acá era un segundo render del tablero.
      onClose();
    });
  };

  return (
    // PF1.1-dashboard (C-PF1): entrada por CSS (`.menuPop`), sin animación de salida; antes un componente `motion` de framer +
    // `AnimatePresence`, que metían framer completo en el JS inicial del tablero.
    <div
      role="menu"
      aria-label={`Acciones de ${patient.name}`}
      className={`k-glass-strong ${styles.menuPop}`}
      style={{
        position: "absolute",
        top: 44,
        right: 6,
        width: 220,
        borderRadius: 12,
        padding: 6,
        zIndex: 25,
      }}
    >
      <MenuLink
        href={`/pacientes/${patient.id}`}
        icon={<IconArrow size={12} />}
        label={patient.access === "full" ? "Abrir historia clínica" : "Ver ficha"}
      />
      {patient.nextBookingAt && (
        <>
          <Divider />
          <div
            style={{
              padding: "8px 12px",
              fontSize: 10.5,
              color: "var(--navy-400)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Próximo turno · {new Date(patient.nextBookingAt).toLocaleString("es-AR", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </div>
          {canEdit && (
            <>
              <MenuButton
                disabled={pending}
                icon={<IconCheck size={12} stroke={3} />}
                label="Marcar realizado"
                onClick={() => setStatus("COMPLETED")}
              />
              <MenuButton
                disabled={pending}
                icon={<IconX size={12} style={{ color: "var(--danger-fg)" }} />}
                label="Marcar ausente"
                onClick={() => setStatus("NO_SHOW")}
              />
            </>
          )}
        </>
      )}
      {patient.access === "full" ? (
        <>
          <Divider />
          <MenuLink
            href={`/agenda?new=1&patient=${patient.id}`}
            icon={<IconPlus size={12} />}
            label="Nuevo turno"
          />
        </>
      ) : (
        <div style={{ padding: "6px 12px 8px", fontSize: 11, color: "var(--navy-400)" }}>
          Paciente de otro profesional: solo lectura.
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--danger-fg)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--navy-700)",
        textDecoration: "none",
        fontWeight: 500,
      }}
    >
      {icon} {label}
    </Link>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--navy-700)",
        background: "transparent",
        border: "none",
        fontWeight: 500,
        cursor: disabled ? "wait" : "pointer",
        textAlign: "left",
      }}
    >
      {icon} {label}
    </button>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "rgba(15,30,51,0.06)",
        margin: "4px 0",
      }}
    />
  );
}
