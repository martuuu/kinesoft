"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { IconBell, IconCheck, IconHome, IconLogout, IconSettings, IconUsers } from "@/components/ui/icons";
import { SUPPORT_HELP_HREF } from "./shell-links";
import { preloadAppearance } from "./appearance-loader";
import {
  OWN_TURNERO_OFF_HINT,
  PublicBookingSwitch,
} from "@/components/configuracion/panels/practitioners/public-booking-switch";
import { CHOOSE_TENANT_HREF, useTenantChoice } from "./tenant-switcher";
import type { TenantOption } from "@/lib/tenant-choice";

/** DIR-3d (DIR-D11): el perfil del directorio es POR PERSONA y vive fuera de `(app)`, junto a `/cuenta/seguridad`. */
export const PUBLIC_PROFILE_HREF = "/cuenta/perfil-publico";

/**
 * DIR-3d (C-DIR9): «Mi perfil público» solo para quien atiende (es profesional clínico) en algún consultorio. El
 * perfil es por persona y cruza consultorios, pero el chrome solo conoce el consultorio activo, así que la regla es:
 *  - `attendsHere`: atiende en el activo (topbar: tiene ficha propia, `ownPublicBooking`; drawer: `clinical.read` en
 *    sus caps). `actor.practitionerId` ya es null para quien no es clínico (IAM-4a/PL-1e) y para soporte;
 *  - o es «Profesional» (rol PRACTITIONER, clínico siempre) en otro de sus consultorios usables (`TenantChoiceProvider`).
 * Un Titular/Admin que atiende SOLO en otro consultorio no se ve desde acá (la opción no trae el flag `clinical`): lo
 * ve al entrar a ese consultorio. Solo esconde UI: la barrera es `resolveProfileSession` de `lib/public-profile.ts`.
 */
export function showsPublicProfileEntry(attendsHere: boolean, options: readonly Pick<TenantOption, "role">[]): boolean {
  return attendsHere || options.some((o) => o.role === "PRACTITIONER");
}

/**
 * PL-F1c (H3 del barrido de UI muerta): menú de cuenta del chrome «Barra superior».
 *
 * Por qué existe: con ese chrome el sidebar no se monta y el dashboard esconde su `ProfileMenu` (`useSidebar &&`),
 * así que el topbar tenía un avatar hardcodeado («Lucía Méndez») y no quedaba ningún «Cerrar sesión», «Seguridad» ni
 * «Cambiar de consultorio» en toda la app. No se reusa `ProfileMenu` porque pide `preferences`/`revenueScope` del
 * dashboard (y es de otra sesión); este menú repite sus mismas salidas, con los mismos destinos:
 *   - «Seguridad de la cuenta» → `/cuenta/seguridad` (PL-2a, C-PL6);
 *   - «Cambiar de consultorio» → `/elegir-consultorio`, solo con 2+ consultorios (IAM-3b, `useTenantChoice`);
 *   - «Mi perfil público» → `/cuenta/perfil-publico` (DIR-3d), solo para quien atiende (`showsPublicProfileEntry`);
 *   - «Cerrar sesión» → `POST /api/auth/sign-out` (el mismo form del sidebar).
 * `<a>` y no `next/link`: esas pantallas están fuera de `(app)` (navegación dura, como en `ProfileMenu`).
 *
 * PL-F (handoff 8): también «Ayuda y soporte» (`SUPPORT_HELP_HREF`, PL-F1b: Soporte es de cualquier miembro) y el
 * switch «Aparece en el turnero online» del propio profesional (`ownPublicBooking`, lo lee el layout `(app)` una vez):
 * sin esto, con la barra superior no había forma de llegar a ninguno de los dos.
 *
 * `name` es `actor.practitionerName` (ya pasa por `displayUserName`: nunca el email, decisión 19).
 */
export function TopbarAccountMenu({
  name,
  onOpenAppearance,
  defaultOpen = false,
  ownPublicBooking = null,
}: {
  name: string;
  /** Ficha propia del usuario y su `publicBookingEnabled`. null = no atiende (sin switch). */
  ownPublicBooking?: { practitionerId: string; enabled: boolean } | null;
  /** Abre el panel «Apariencia» (sin el sidebar, es la única forma de llegar). */
  onOpenAppearance?: () => void;
  /** Solo para el test de render (sin jsdom no hay click). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { canSwitch, options } = useTenantChoice();
  const showPublicProfile = showsPublicProfileEntry(ownPublicBooking !== null, options);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Menú de cuenta de ${name}`}
        style={{
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          borderRadius: "50%",
          outline: open ? "2px solid var(--sky-700)" : "none",
          outlineOffset: 2,
        }}
      >
        <Avatar name={name} size={36} />
      </button>

      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            width: ownPublicBooking ? 280 : 250,
            borderRadius: 14,
            padding: 6,
            zIndex: 30,
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--navy-300)",
            }}
          >
            {name}
          </div>
          {onOpenAppearance && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenAppearance();
              }}
              onPointerEnter={preloadAppearance}
              onFocus={preloadAppearance}
              style={{ ...itemStyle, width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer" }}
            >
              <IconSettings size={14} /> Apariencia
            </button>
          )}
          <a href={SUPPORT_HELP_HREF} role="menuitem" style={itemStyle}>
            <IconBell size={14} /> Ayuda y soporte
          </a>
          {ownPublicBooking && (
            <div
              role="none"
              data-own-public-booking
              style={{ padding: "10px 12px", margin: "4px 0", borderTop: "1px solid rgba(15,30,51,0.06)", borderBottom: "1px solid rgba(15,30,51,0.06)" }}
            >
              <PublicBookingSwitch
                practitionerId={ownPublicBooking.practitionerId}
                name={name}
                enabled={ownPublicBooking.enabled}
                offHint={OWN_TURNERO_OFF_HINT}
              />
            </div>
          )}
          {canSwitch && (
            <a href={CHOOSE_TENANT_HREF} role="menuitem" style={itemStyle}>
              <IconHome size={14} /> Cambiar de consultorio
            </a>
          )}
          {showPublicProfile && (
            <a href={PUBLIC_PROFILE_HREF} role="menuitem" style={itemStyle}>
              <IconUsers size={14} /> Mi perfil público
            </a>
          )}
          <a href="/cuenta/seguridad" role="menuitem" style={itemStyle}>
            <IconCheck size={14} /> Seguridad de la cuenta
          </a>
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              role="menuitem"
              style={{
                ...itemStyle,
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--danger-fg)",
              }}
            >
              <IconLogout size={14} /> Cerrar sesión
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const itemStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--navy-700)",
  borderRadius: 10,
  display: "flex",
  alignItems: "center",
  gap: 10,
  textDecoration: "none",
};
