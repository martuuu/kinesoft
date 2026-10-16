"use client";

/**
 * Barra del workspace bajo 768 px (PF1.0-a, S1 de VX0-b, clase A mobile).
 *
 * Por qué: a 390 px el sidebar flotante de 64 px seguía fijo a la izquierda (~25 % del ancho) y no había menú. Ahora
 * el AppShell esconde sidebar y topbar bajo 768 (`.desktopOnly`) y esta barra aparece (`.mobileBar`, oculta en
 * escritorio): «Menú» → Drawer con el nav (patrón `PlatformShell`), el logo y el buscador ⌘K. Se renderiza siempre y
 * decide el CSS: el server no conoce el ancho y así no hay salto al hidratar.
 *
 * Sin campana de notificaciones a propósito: `NotificationsBell` pide el conteo al montarse, y esta barra está
 * montada también en escritorio (oculta): sería un request extra en cada carga de cada usuario.
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconMenu, IconSearch } from "@/components/ui/icons";
import type { Capability } from "@/lib/capabilities";
import { openCommandPalette, preloadCommandPalette } from "./command-palette-launcher";
import styles from "./shell.module.css";

const loadDrawer = () => import("./mobile-nav-drawer");
const preloadDrawer = () => void loadDrawer();

const MobileNavDrawer = dynamic(() => loadDrawer().then((m) => m.MobileNavDrawer), {
  ssr: false,
  // El Drawer es una capa fija: mientras llega no hay nada que reservar (CLS 0). Se precarga en hover/foco/toque.
  loading: () => null,
});

export function MobileBar({
  isPlatformAdmin,
  caps,
  onOpenAppearance,
}: {
  isPlatformAdmin: boolean;
  caps: readonly Capability[];
  onOpenAppearance?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Una vez abierto queda montado: así el Drawer anima la salida y el segundo toque no vuelve a pedir el chunk.
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  // Navegar (también con atrás/adelante) cierra el menú.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <header className={`k-glass ${styles.mobileBar}`}>
        <button
          type="button"
          className={styles.mobileButton}
          aria-label="Abrir menú"
          aria-expanded={open}
          onClick={() => {
            setMounted(true);
            setOpen(true);
          }}
          onPointerEnter={preloadDrawer}
          onTouchStart={preloadDrawer}
          onFocus={preloadDrawer}
        >
          <IconMenu size={18} />
          <span>Menú</span>
        </button>
        <Link href="/dashboard" aria-label="Inicio" style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}>
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
      </header>
      {mounted && (
        <MobileNavDrawer
          open={open}
          onClose={() => setOpen(false)}
          isPlatformAdmin={isPlatformAdmin}
          caps={caps}
          onOpenAppearance={onOpenAppearance}
        />
      )}
    </>
  );
}
