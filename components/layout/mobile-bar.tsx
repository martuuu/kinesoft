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
 * Sin campana de notificaciones a propósito: `NotificationsBell` pide el conteo al montarse, y esta barra está
 * montada también en escritorio (oculta): sería un request extra en cada carga de cada usuario.
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconSearch } from "@/components/ui/icons";
import { openCommandPalette, preloadCommandPalette } from "./command-palette-launcher";
import { TopbarAccountMenu } from "./topbar-account-menu";
import styles from "./shell.module.css";

export function MobileBar({
  userName,
  ownPublicBooking = null,
  onOpenAppearance,
}: {
  /** Nombre visible del usuario (ya sin email, `displayUserName`). Sin nombre (tests), sin avatar. */
  userName?: string;
  ownPublicBooking?: { practitionerId: string; enabled: boolean } | null;
  onOpenAppearance?: () => void;
}) {
  return (
    <header className={`k-glass ${styles.mobileBar}`} data-mobile-bar>
      <Link href="/dashboard" aria-label="Inicio" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, paddingLeft: 4 }}>
        <KineLogo size={22} />
      </Link>
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
      {userName && (
        <span className={styles.mobileAccount}>
          <TopbarAccountMenu name={userName} onOpenAppearance={onOpenAppearance} ownPublicBooking={ownPublicBooking} />
        </span>
      )}
    </header>
  );
}
