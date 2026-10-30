"use client";

import { useEffect, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { MobileBar } from "./mobile-bar";
import { BottomNav } from "./bottom-nav";
import { CommandPaletteLauncher } from "./command-palette-launcher";
import { useTweaks } from "./tweaks-context";
import { TenantModulesProvider } from "./tenant-modules-context";
import { loadTweaksPanel, preloadAppearance } from "./appearance-loader";
import styles from "./shell.module.css";
import type { TenantModule } from "@/lib/tenant-modules";
import type { TenantVertical } from "@prisma/client";
import type { Capability } from "@/lib/capabilities";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import type { RealtimeBootstrap } from "@/lib/realtime-events";
import { ArrivalAlerts } from "@/components/providers/arrival-alerts";
import type { AlertPrefs, AlertViewer } from "@/lib/arrival-alert-state";
import type { TenantOption } from "@/lib/tenant-choice";
import { TenantChoiceProvider, type SwitchTenantAction } from "./tenant-switcher";
import { SwRegister } from "@/components/pwa/sw-register";
import { IdleLogout } from "./idle-logout";

/**
 * Authenticated workspace shell. Picks chrome (sidebar vs. topbar) based
 * on the live Tweaks context, applies the active palette via the root
 * effect inside TweaksProvider, and overlays the floating Tweaks panel.
 *
 * EV0 (EV-S): recibe del layout los módulos del consultorio y las
 * capabilities del rol (arrays: cruzan la frontera Server→Client) y monta
 * `TenantModulesProvider` sobre todo el workspace, así sidebar, topbar y
 * cualquier pantalla cliente leen `useTenantModules()` sin props.
 *
 * SV07b: también monta `RealtimeProvider` con el bootstrap del layout, así
 * agenda, Recepción y cualquier vista leen `useRealtime()` sin props. Con
 * `driver:"off"` el provider no carga nada de realtime.
 *
 * SV11b: `ArrivalAlerts` va DENTRO del `RealtimeProvider` (usa `useRealtime`) y
 * envuelve todo el workspace para que la Card de Configuración y el menú de la
 * agenda lean `useAlertPrefs()`. Sin canal (`driver:"off"`) no arranca nada.
 * HF-1b/HF-1c (§22.4): la agenda en vivo pasa a todos los planes (HF-1a saca el gate `salaEspera` del mint), pero los
 * avisos de llegada y de llamado (con sonido) siguen siendo de la Sala de espera, que solo tienen Clínica y Libre:
 * `arrivalAlertsLive` exige canal Y módulo. Sin esto, un consultorio en plan Consultorio empezaría a sonar.
 *
 * IAM-3b (decisión 6: un usuario puede trabajar en varios consultorios): `TenantChoiceProvider` publica los
 * consultorios usables de la sesión y el activo, que el layout ya leyó para el gate. Lo leen el selector del
 * sidebar y el «Cambiar de consultorio» del menú de perfil (que vive en el dashboard, dentro de este árbol).
 *
 * BO3-F: `banner` es la banda de soporte (`SupportBanner`, la arma el layout cuando `actor.support`). Va arriba de la
 * columna de contenido y no arriba de todo: el sidebar es sticky y una banda sticky de ancho completo lo pisaba.
 *
 * PL-F1c: `userName` (= `actor.practitionerName`) es el avatar y el menú de cuenta de la barra superior. El panel
 * «Apariencia» (ex Tweaks) arranca cerrado y ya no deja un engranaje flotante que tapaba el pie de los Drawers: se
 * abre desde el pie del sidebar o desde el menú de cuenta de la barra superior (`openAppearance`).
 *
 * RX-1e: `canReception` habilita la sección «Recepción» de Apariencia (la cara de `/sala`); el módulo lo mira el panel.
 *
 * PF1.0-a (bundle, §0.2 del brief PF): el shell pesaba ~56 kB gz en cada ruta de `(app)` antes de su página. Ahora:
 *   - Apariencia (`tweaks-panel.tsx`) y ⌘K (`command-palette.tsx`) se bajan con `next/dynamic` recién al abrirse
 *     (precarga en hover/foco del disparador y al apretar ⌘/Ctrl). Arrancan cerrados: no pintan en el primer render.
 *   - Sin framer `motion.*` (sidebar, selector de consultorio, campana: `m` dentro del `LazyMotion` de UIProviders).
 *   - Sin zod (el guard de realtime es TS puro; `tweaks-context` y el menú de cuenta ya no tocan
 *     `lib/preferences-constants.ts`).
 * Mobile clase A (S1): bajo 768 px sidebar y topbar se esconden (`.desktopOnly`) y aparece `MobileBar` (logo, ⌘K y
 * avatar). Todo por CSS: el HTML es el mismo en cualquier ancho.
 *
 * MB-0c (C-MB1): bajo 768 px también aparece `BottomNav` (barra inferior fija: 4 destinos + «Más» → Drawer con el nav
 * completo). `.shell` publica su alto en `--k-bottom-nav-h` para que `main`, toast, FAB y Apariencia no queden debajo,
 * y el alto mínimo es `100dvh` (respaldo `100vh`): en Safari iOS y en la PWA standalone `100vh` no es el alto real.
 * `SwRegister` (MB-0a, C-MB5) registra el service worker de instalación solo con sesión (MB-D5).
 *
 * IN (§27): `idle` (lo arma el layout con `idleShellState`) prende el cierre por inactividad (`IdleLogout`) para la
 * sesión «de navegador». null/ausente = sesión persistente: no se monta nada. Este es el ÚNICO lugar que importa
 * `idle-logout.tsx` (guard `[IN-6]`): `/tv`, el portal y `/plataforma` no están bajo `AppShell`.
 *
 * HD-9 (§27): `publicProfile` = el directorio público no está apagado (`directoryMode() !== "off"`, lo calcula el
 * layout). Viaja por `TenantChoiceProvider` hasta el menú de cuenta y el «Más»: con el directorio apagado, «Mi perfil
 * público» llevaba a una página de algo que no existe para nadie.
 */
/** HF-1c: ¿arranca el motor de avisos de llegada? Canal realtime y módulo `salaEspera`, los dos. */
export function arrivalAlertsLive(realtime: Pick<RealtimeBootstrap, "driver">, modules: readonly TenantModule[]): boolean {
  return realtime.driver !== "off" && modules.includes("salaEspera");
}

const TweaksPanel = dynamic(() => loadTweaksPanel().then((m) => m.TweaksPanel), {
  ssr: false,
  // Misma caja y lugar que el panel abierto (fija abajo a la derecha): ni salto ni hueco mientras llega.
  loading: () => (
    <div className={`k-glass-strong ${styles.appearanceSkeleton}`} role="status" aria-label="Cargando Apariencia">
      Cargando…
    </div>
  ),
});
export function AppShell({
  children,
  isPlatformAdmin = false,
  modules,
  vertical,
  caps,
  realtime,
  alertViewer,
  initialAlertPrefs,
  tenantOptions = [],
  activeTenantId = null,
  switchTenantAction = null,
  banner = null,
  userName,
  ownPublicBooking = null,
  idle = null,
  publicProfile = false,
}: {
  /** IN: cierre por inactividad (sesión «de navegador»). null = persistente, sin cierre. */
  idle?: { minutes: number; sessionTag: string; serverNowMs: number } | null;
  /** HD-9: directorio público prendido (preview/public): se ofrece «Mi perfil público». */
  publicProfile?: boolean;
  /** PL-F1c: nombre visible del usuario (ya sin email, `displayUserName`). */
  userName?: string;
  /** PL-F: ficha propia y su `publicBookingEnabled` para el switch del menú de cuenta del topbar. null = no atiende. */
  ownPublicBooking?: { practitionerId: string; enabled: boolean; myMp?: boolean } | null;
  children: ReactNode;
  /** BO3-F: banda de soporte (null fuera de soporte). */
  banner?: ReactNode;
  isPlatformAdmin?: boolean;
  modules: readonly TenantModule[];
  /** EV1: vertical del consultorio para el copy (ver `TenantModulesValue.vertical`). */
  vertical?: TenantVertical;
  caps: readonly Capability[];
  realtime: RealtimeBootstrap;
  alertViewer: AlertViewer;
  initialAlertPrefs: AlertPrefs;
  /** Consultorios usables de la sesión (solo los propios). Vacío = sin selector (actor demo). */
  tenantOptions?: readonly TenantOption[];
  activeTenantId?: string | null;
  /** Server action `switchTenant` (la pasa el layout: un módulo cliente no la importa, ver tenant-switcher). */
  switchTenantAction?: SwitchTenantAction | null;
}) {
  const { t, set } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";
  const openAppearance = () => set("minimised", false);
  // MB-Z (integrador): alto real de la barra superior → `--k-topbar-h` (globals.css, default 94 px). La agenda y `/sala`
  // descontaban un fijo de 112 (94 + 18 de `main`), medido a 1728; a 1366 y 1024 los ítems del menú pasan a dos
  // líneas, la barra mide 135 y el documento scrolleaba 41 px en Recepción y en el Tablero (C-MB4).
  const topbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topbarRef.current;
    const root = document.documentElement;
    if (useSidebar || !el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const h = el.getBoundingClientRect().height;
      // Bajo 768 `.desktopOnly` no se ve (0 px): ahí manda la barra móvil y nadie lee la variable.
      if (h > 0) root.style.setProperty("--k-topbar-h", `${Math.ceil(h)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--k-topbar-h");
    };
  }, [useSidebar]);

  return (
    <TenantChoiceProvider
      options={tenantOptions}
      activeTenantId={activeTenantId}
      switchTenant={switchTenantAction}
      publicProfile={publicProfile}
    >
      <TenantModulesProvider modules={modules} vertical={vertical}>
        <RealtimeProvider bootstrap={realtime}>
          <ArrivalAlerts viewer={alertViewer} initialPrefs={initialAlertPrefs} live={arrivalAlertsLive(realtime, modules)}>
            <div
              className={`k-app ${styles.shell}`}
              style={{
                background: "var(--bg-app)",
                display: useSidebar ? "flex" : "block",
              }}
            >
              {useSidebar && (
                <Sidebar
                  className={styles.desktopOnly}
                  collapsed={t.sidebarCollapsed}
                  isPlatformAdmin={isPlatformAdmin}
                  caps={caps}
                  onOpenAppearance={openAppearance}
                  onPreloadAppearance={preloadAppearance}
                  // [CF-F] Campana también con la barra lateral (antes solo en el dashboard). Panel al costado, por portal.
                  bell={<NotificationsBell placement="side" />}
                />
              )}
              <div className={styles.column}>
                {banner}
                {/* [ZF3] A1: campana también en la barra móvil. Cada campana pide solo si se ve (`createBellGate`): en
                    cualquier ancho hay una visible y un solo poller (la del chrome de escritorio queda en `.desktopOnly`). */}
                <MobileBar
                  userName={userName}
                  ownPublicBooking={ownPublicBooking}
                  onOpenAppearance={openAppearance}
                  bell={<NotificationsBell placement="bar" />}
                />
                {!useSidebar && (
                  <div ref={topbarRef} className={styles.desktopOnly}>
                    <TopBar
                      caps={caps}
                      isPlatformAdmin={isPlatformAdmin}
                      userName={userName}
                      ownPublicBooking={ownPublicBooking}
                      onOpenAppearance={openAppearance}
                    />
                  </div>
                )}
                <main className={styles.main} style={{ flex: 1, minWidth: 0, padding: useSidebar ? 14 : "0 18px 18px" }}>
                  {children}
                </main>
              </div>
              <BottomNav isPlatformAdmin={isPlatformAdmin} caps={caps} onOpenAppearance={openAppearance} />
              {/* Montado solo abierto: cerrado, Apariencia no baja ni un byte (C-PF2). */}
              {!t.minimised && <TweaksPanel canReception={caps.includes("agenda.reception")} />}
              <CommandPaletteLauncher />
              <SwRegister />
              {idle && <IdleLogout minutes={idle.minutes} sessionTag={idle.sessionTag} serverNowMs={idle.serverNowMs} />}
            </div>
          </ArrivalAlerts>
        </RealtimeProvider>
      </TenantModulesProvider>
    </TenantChoiceProvider>
  );
}
