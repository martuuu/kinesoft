"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { IconBell, IconHome, IconLogout, IconSettings, IconShield } from "@/components/ui/icons";
import type { KpiRevenueScope, Preferences } from "@/lib/preferences-constants";
import { CHOOSE_TENANT_HREF, useTenantChoice } from "@/components/layout/tenant-switcher";
import {
  OWN_TURNERO_OFF_HINT,
  PublicBookingSwitch,
} from "@/components/configuracion/panels/practitioners/public-booking-switch";

/**
 * PL-F1b (decisión de Martin, 16-oct: «profesionales también, porque pueden necesitar ayuda con algo»): Soporte
 * (Mensajes + Accesos de soporte) es de cualquier miembro, pero «Configuración» del nav sigue siendo de `tenant.admin`.
 * La entrada para todos está acá, en el menú de perfil. PF1.0-a: la constante vive en `shell-links` (sin dependencias:
 * el menú de cuenta del topbar la importaba de acá y arrastraba este módulo al shell); acá queda el re-export.
 */
export { SUPPORT_HELP_HREF } from "@/components/layout/shell-links";
import { SUPPORT_HELP_HREF } from "@/components/layout/shell-links";

/**
 * PF1.1-dashboard (C-PF2): «Ajustes» (paleta + indicadores fijados) se baja al abrirlo. `ssr: false` es seguro: nunca
 * está abierto en el primer render. Lo usan este menú y el botón «Ajustes» del tablero con barra superior.
 */
const loadSettingsModal = () => import("./settings-modal");
export const preloadSettingsModal = (): void => void loadSettingsModal();
export const SettingsModalLazy = dynamic(() => loadSettingsModal().then((m) => m.SettingsModal), {
  ssr: false,
  loading: () => null,
});

/**
 * Profile menu — the avatar in the dashboard top-right.
 *
 * Click → dropdown with the practitioner name + "Ajustes" + "Cerrar
 * sesión". Ajustes opens a modal with palette picker (mirrors Tweaks,
 * but persisted server-side) + pinned KPIs picker.
 *
 * SRZ-FX3 (B8): `revenueScope` (SR-D5I) decide si el picker ofrece la KPI de
 * ingresos y con qué rótulo (`kpiOptionsFor`). Default `tenant` = lo de antes.
 *
 * IAM-3b (decisión 6: un usuario puede trabajar en varios consultorios): con 2+ consultorios usables suma
 * «Cambiar de consultorio» → `/elegir-consultorio`. Es la salida con el chrome «topbar», que no tiene el selector
 * del sidebar. Las opciones salen de `TenantChoiceProvider` (AppShell): sin provider o con uno solo, no aparece.
 *
 * PL-2a (C-PL6): «Seguridad de la cuenta» → `/cuenta/seguridad` (verificación en dos pasos). `<a>` y no `next/link`:
 * la pantalla está fuera de `(app)`, navegación dura como «Cambiar de consultorio».
 *
 * PL-Z (a): el profesional (con ficha, `ownPublicBooking`) prende/apaga su propio «Aparece en el turnero online» desde
 * acá: quien no tiene «Configuración» no llega a Configuración → Profesionales. Mismo switch y misma action
 * (`setPractitionerPublicBooking`, que acepta al propio profesional); con el turnero del consultorio apagado queda
 * deshabilitado con «Primero el consultorio tiene que prender el turnero».
 */
export function ProfileMenu({
  name,
  preferences,
  revenueScope = "tenant",
  ownPublicBooking = null,
  defaultOpen = false,
}: {
  name: string;
  preferences: Preferences;
  revenueScope?: KpiRevenueScope;
  /** Ficha propia del usuario y su `publicBookingEnabled`. null = no atiende (sin switch). */
  ownPublicBooking?: { practitionerId: string; enabled: boolean } | null;
  /** Solo para el test de render (sin jsdom no hay click). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { canSwitch } = useTenantChoice();
  const [showSettings, setShowSettings] = useState(false);
  // Montado desde la primera apertura: el Modal anima la salida y la segunda apertura no vuelve a pedir el chunk.
  const [settingsMounted, setSettingsMounted] = useState(false);
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
        aria-label="Menú de perfil"
        style={{
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          borderRadius: "50%",
          // Abierto = anillo del foco (token). Antes, cerrado, el outline en «none» tapaba el foco del teclado.
          boxShadow: open ? "var(--focus-ring)" : undefined,
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
            width: ownPublicBooking ? 280 : 240,
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
              color: "var(--navy-400)",
            }}
          >
            {name}
          </div>
          <MenuItem
            icon={<IconSettings size={14} />}
            label="Ajustes"
            onPreload={preloadSettingsModal}
            onClick={() => {
              setOpen(false);
              setSettingsMounted(true);
              setShowSettings(true);
            }}
          />
          {canSwitch && (
            // `<a>` y no `next/link`: navegación dura, como el selector del sidebar (la pantalla está fuera de `(app)`).
            <a
              href={CHOOSE_TENANT_HREF}
              role="menuitem"
              style={{
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--navy-700)",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
                textDecoration: "none",
              }}
            >
              <IconHome size={14} /> Cambiar de consultorio
            </a>
          )}
          <a
            href="/cuenta/seguridad"
            role="menuitem"
            style={{
              padding: "10px 12px",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--navy-700)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
            }}
          >
            <IconShield size={14} /> Seguridad de la cuenta
          </a>
          <a
            href={SUPPORT_HELP_HREF}
            role="menuitem"
            style={{
              padding: "10px 12px",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--navy-700)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
            }}
          >
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
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              role="menuitem"
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--danger-fg)",
                cursor: "pointer",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <IconLogout size={14} /> Cerrar sesión
            </button>
          </form>
        </div>
      )}

      {settingsMounted && (
        <SettingsModalLazy
          open={showSettings}
          preferences={preferences}
          revenueScope={revenueScope}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  onPreload,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onPreload?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      style={{
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "10px 12px",
        fontSize: 13,
        fontWeight: 500,
        color: "var(--navy-700)",
        cursor: "pointer",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {icon} {label}
    </button>
  );
}

