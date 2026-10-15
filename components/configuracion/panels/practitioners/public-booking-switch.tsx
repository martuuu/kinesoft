"use client";

/**
 * «Aparece en el turnero online» de UN profesional (PL-3b, plan §20.5.12, H-TURN; decisión 20 de Martin).
 *
 * El turnero se prende en el consultorio (Configuración → General) y, si está prendido, por profesional
 * (`Practitioner.publicBookingEnabled`, opt-in: un profesional nuevo nace apagado). Con el del consultorio apagado el
 * switch se ve deshabilitado con «Primero prendé el turnero del consultorio»: el valor del profesional queda guardado
 * y rige cuando se prenda (la action no depende del switch general, `lib/practitioner-public.ts`).
 *
 * Lo usan Configuración → Profesionales (ficha de cada uno), Configuración → Usuarios (fila de quien atiende) y el
 * menú de perfil (PL-Z: el profesional sin Configuración prende/apaga el suyo). Quién
 * puede: `tenant.admin` o el propio profesional; la barrera es la action.
 */
import { useEffect, useState, useTransition } from "react";
import { setPractitionerPublicBooking } from "@/lib/practitioner-public";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { Switch } from "../../controls";

export const TURNERO_OFF_HINT = "Primero prendé el turnero del consultorio.";
/**
 * PL-Z (a): el propio profesional (menú de perfil) no puede prender el turnero del consultorio, así que «Primero
 * prendé…» le pedía algo imposible: se le dice quién tiene que hacerlo.
 */
export const OWN_TURNERO_OFF_HINT = "Primero el consultorio tiene que prender el turnero.";

/** Pura: el copy de abajo del switch (exportada para el test). */
export function publicBookingHint(tenantOpen: boolean, on: boolean, offHint: string = TURNERO_OFF_HINT): string {
  if (!tenantOpen) return offHint;
  return on
    ? "Los pacientes pueden sacarle turno desde el link del consultorio, en los servicios que ofrece online."
    : "No aparece en el turnero: sus turnos se dan solo desde la agenda.";
}

export function PublicBookingSwitch({
  practitionerId,
  name,
  enabled,
  tenantOpen: tenantOpenProp,
  compact = false,
  offHint = TURNERO_OFF_HINT,
}: {
  practitionerId: string;
  /** Nombre a mostrar (nunca el email, decisión 19). */
  name: string;
  enabled: boolean;
  /** Turnero del consultorio prendido. Sin valor, el del contexto (`turneroPublico`). */
  tenantOpen?: boolean;
  /** En la fila de Usuarios: una sola línea, sin el texto largo. */
  compact?: boolean;
  /** Copy con el turnero del consultorio apagado (el menú de perfil usa `OWN_TURNERO_OFF_HINT`). */
  offHint?: string;
}) {
  const modules = useTenantModules();
  const tenantOpen = tenantOpenProp ?? modules.has("turneroPublico");
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Cuando llega el árbol nuevo (la action revalida) manda el server.
  useEffect(() => setOn(enabled), [enabled]);

  const toggle = () => {
    if (!tenantOpen || pending) return;
    const next = !on;
    setOn(next);
    setError(null);
    start(async () => {
      const r = await setPractitionerPublicBooking(practitionerId, next);
      // Sin `router.refresh()`: la action revalida `/configuracion` y su respuesta trae el árbol nuevo (PF-0d).
      if (!r.ok) {
        setOn(!next);
        setError(r.error);
      }
    });
  };

  const hint = publicBookingHint(tenantOpen, on, offHint);
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Switch
          on={tenantOpen && on}
          onChange={toggle}
          disabled={!tenantOpen || pending}
          aria-label={`Aparece en el turnero online: ${name}`}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>Aparece en el turnero online</span>
      </div>
      {(!compact || !tenantOpen) && (
        <div data-public-booking-hint style={{ fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11.5, color: "#9F1F1F" }}>
          {error}
        </div>
      )}
    </div>
  );
}
