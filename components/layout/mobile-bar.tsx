"use client";

/**
 * Barra superior del workspace bajo 768 px (PF1.0-a, S1 de VX0-b, clase A mobile; MB-0c, C-MB1).
 *
 * Por qué: a 390 px el sidebar flotante de 64 px seguía fijo a la izquierda (~25 % del ancho) y no había menú. El
 * AppShell esconde sidebar y topbar bajo 768 (`.desktopOnly`) y esta barra aparece (`.mobileBar`, oculta en
 * escritorio) con el logo, el buscador ⌘K y el avatar del menú de cuenta. Se renderiza siempre y decide el CSS: el
 * server no conoce el ancho y así no hay salto al hidratar.
 *
 * MB-0c: el botón «Menú» se fue. El nav completo lo abre «Más» de la barra inferior (`bottom-nav.tsx`), al alcance del
 * pulgar; arriba quedaba lejos y duplicaba la entrada. El avatar es el mismo `TopbarAccountMenu` del chrome «Barra
 * superior» (Apariencia, Ayuda y soporte, turnero propio, Seguridad, Cambiar de consultorio, Cerrar sesión): ya está en
 * el first-load del shell por el topbar, así que no suma bytes.
 *
 * Campana ([ZF3] A1, CF-ZB): antes no había, a propósito, porque `NotificationsBell` pedía el conteo al montarse y esta
 * barra está montada también en escritorio (oculta): era un request extra en cada carga. Con la «Barra lateral» la
 * campana pasó del dashboard al Sidebar (`.desktopOnly`) y en mobile no quedaba ninguna. Ahora la campana solo pide
 * si se ve (`createBellGate`, lib/notifications-live.ts): la de acá en mobile, la del chrome de escritorio desde 768.
 * Llega por prop (`bell`) como en el Sidebar: la arma el AppShell y esta barra se renderiza suelta en tests sin router.
 *
 * CF3 (BR-L): con logo del consultorio (`useTenantBrand`), el logo va al lado de la marca del producto, que pasa a la
 * baldosa sola: en mobile el nombre del consultorio no está escrito en ningún lado y a 320 px no entran el wordmark
 * (~155 px), el logo, la búsqueda, la campana y el avatar. El logo lleva el nombre como `alt`. Sin logo, lo de hoy.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconSearch } from "@/components/ui/icons";
import { openCommandPalette, preloadCommandPalette } from "./command-palette-launcher";
import { TopbarAccountMenu } from "./topbar-account-menu";
import { useTenantBrand } from "./tenant-brand-context";
import { TenantLogo } from "./tenant-logo";
import styles from "./shell.module.css";

export function MobileBar({
  userName,
  ownPublicBooking = null,
  onOpenAppearance,
  bell,
}: {
  /** [ZF3] A1: campana de la barra móvil (`<NotificationsBell placement="bar" />`, la pasa el AppShell). */
  bell?: ReactNode;
  /** Nombre visible del usuario (ya sin email, `displayUserName`). Sin nombre (tests), sin avatar. */
  userName?: string;
  ownPublicBooking?: { practitionerId: string; enabled: boolean; myMp?: boolean } | null;
  onOpenAppearance?: () => void;
}) {
  const { name, logoUrl } = useTenantBrand();
  return (
    <header className={`k-glass ${styles.mobileBar}`} data-mobile-bar>
      <Link href="/dashboard" aria-label="Inicio" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, paddingLeft: 4 }}>
        {/* PV BR-a: con el wordmark nuevo (~155 px a 22) la barra suma ~275 px con búsqueda y avatar: entra a 320/360. */}
        <KineLogo size={22} markOnly={!!logoUrl} />
      </Link>
      {logoUrl && <TenantLogo src={logoUrl} size={28} alt={name} title={name} />}
      <span className={styles.mobileSpacer} />
      <button
        type="button"
        className={styles.mobileButton}
        aria-label="Abrir búsqueda rápida"
        onClick={openCommandPalette}
        onPointerEnter={preloadCommandPalette}
        onTouchStart={preloadCommandPalette}
        onFocus={preloadCommandPalette}
      >
        <IconSearch size={18} />
      </button>
      {bell && <span className={styles.mobileAccount}>{bell}</span>}
      {userName && (
        <span className={styles.mobileAccount}>
          <TopbarAccountMenu name={userName} onOpenAppearance={onOpenAppearance} ownPublicBooking={ownPublicBooking} />
        </span>
      )}
    </header>
  );
}
