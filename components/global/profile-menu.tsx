"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { IconBell, IconCheck, IconHome, IconLogout, IconSettings, IconX } from "@/components/ui/icons";
import { updateUserPreferences } from "@/lib/preferences";
import {
  effectivePinnedKpis,
  kpiOptionsFor,
  type KpiKey,
  type KpiRevenueScope,
  type Palette,
  type Preferences,
} from "@/lib/preferences-constants";
import { useTweaks } from "@/components/layout/tweaks-context";
// PL-F: las mismas cuatro paletas y rótulos que «Apariencia» (antes acá decían «Sky/Mint/Violet», en inglés).
import { PALETTE_OPTIONS as PALETTES } from "@/components/layout/tweaks-panel";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { CHOOSE_TENANT_HREF, useTenantChoice } from "@/components/layout/tenant-switcher";
import {
  OWN_TURNERO_OFF_HINT,
  PublicBookingSwitch,
} from "@/components/configuracion/panels/practitioners/public-booking-switch";

/**
 * PL-F1b (decisión de Martin, 16-oct: «profesionales también, porque pueden necesitar ayuda con algo»): Soporte
 * (Mensajes + Accesos de soporte) es de cualquier miembro, pero «Configuración» del nav sigue siendo de `tenant.admin`
 * (a un Profesional le mostraría una pantalla con una sola pestaña bajo un nombre que no es lo suyo). La entrada para
 * todos está acá, en el menú de perfil. Exportado para el test de render.
 */
export const SUPPORT_HELP_HREF = "/configuracion?tab=soporte";


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
              color: "var(--navy-300)",
            }}
          >
            {name}
          </div>
          <MenuItem
            icon={<IconSettings size={14} />}
            label="Ajustes"
            onClick={() => {
              setOpen(false);
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
            <IconCheck size={14} /> Seguridad de la cuenta
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

      {showSettings && (
        <SettingsModal
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
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
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

/** Exportado para el test de render (tests/unit/render/kpi-picker.test.tsx). */
export function SettingsModal({
  preferences,
  onClose,
  revenueScope = "tenant",
}: {
  preferences: Preferences;
  onClose: () => void;
  revenueScope?: KpiRevenueScope;
}) {
  const router = useRouter();
  const { t, set } = useTweaks();
  // EV1-A: el picker de Ajustes ofrece y preselecciona lo mismo que la fila del dashboard
  // (`PinKpiModal`): en Clínica general sin las KPIs de planes y con los rótulos de turnos.
  // Antes ofrecía «Planes en curso»/«Cerca del alta», que en General valen 0 siempre.
  const modules = useTenantModules();
  const kpiOptions = kpiOptionsFor(revenueScope, modules);
  const [palette, setPalette] = useState<Palette>(preferences.palette);
  const [pinned, setPinned] = useState<KpiKey[]>(() =>
    effectivePinnedKpis(preferences.pinnedKpis, revenueScope, modules)
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const togglePinned = (key: KpiKey) => {
    setPinned((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  };

  const save = () => {
    setError(null);
    start(async () => {
      // PL-F: la paleta se guardaba dos veces (acá y otra vez en `set("palette")`, que desde PL-F1c también la
      // persiste). Ahora este guardado lleva solo las KPIs y la paleta la escribe `set` una vez, si cambió.
      const r = await updateUserPreferences({ pinnedKpis: pinned });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Aplica `data-palette` en vivo vía el contexto de Tweaks (y la guarda en el server).
      if (palette !== t.palette) set("palette", palette);
      onClose();
      router.refresh();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong"
        style={{ width: "min(540px, 100%)", borderRadius: 22, padding: 24 }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2 className="k-display" style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
            Ajustes
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 32,
              height: 32,
              borderRadius: 10,
              cursor: "pointer",
              color: "var(--navy-700)",
            }}
          >
            <IconX size={14} />
          </button>
        </header>

        <section style={{ marginBottom: 18 }}>
          <SectionLabel>Paleta</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {PALETTES.map((p) => {
              const on = p.value === palette;
              return (
                <button
                  key={p.value}
                  onClick={() => setPalette(p.value)}
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    cursor: "pointer",
                    border: on
                      ? "2px solid var(--sky-700)"
                      : "1px solid rgba(15,30,51,0.08)",
                    background: "rgba(255,255,255,0.7)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 3 }}>
                    {p.swatch.map((c) => (
                      <span
                        key={c}
                        style={{
                          flex: 1,
                          height: 22,
                          borderRadius: 6,
                          background: c,
                        }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-700)" }}>
                    {p.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section style={{ marginBottom: 14 }}>
          <SectionLabel>KPIs fijados al dashboard</SectionLabel>
          <p style={{ fontSize: 11.5, color: "var(--navy-500)", margin: "0 0 10px" }}>
            Hasta 6. Elegí los que querés ver siempre.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
            }}
          >
            {kpiOptions.map((opt) => {
              const on = pinned.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => togglePinned(opt.key)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: on
                      ? "1px solid var(--sky-700)"
                      : "1px solid rgba(15,30,51,0.08)",
                    background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.6)",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 5,
                      background: on ? "var(--sky-700)" : "rgba(15,30,51,0.06)",
                      color: "#fff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {on && <IconCheck size={10} stroke={3} />}
                  </span>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--navy-300)" }}>
                      {opt.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "var(--danger-bg)",
              color: "var(--danger-fg)",
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-300)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
