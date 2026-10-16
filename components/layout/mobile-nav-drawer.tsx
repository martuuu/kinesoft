"use client";

/**
 * Menú del workspace bajo 768 px (PF1.0-a, S1 de VX0-b): el mismo contenido del sidebar (`SidebarBody`, una sola
 * lista) dentro de un `Drawer`, como el «Menú» de `PlatformShell`. Lo carga `MobileBar` con `next/dynamic` recién al
 * abrir: en escritorio nunca se baja. Sin barra inferior ni gestos: eso es del bloque MB (D-PF-D).
 */
import { Drawer } from "@/components/ui/drawer";
import type { Capability } from "@/lib/capabilities";
import { SidebarBody } from "./sidebar";
import styles from "./shell.module.css";

export function MobileNavDrawer({
  open,
  onClose,
  isPlatformAdmin,
  caps,
  onOpenAppearance,
}: {
  open: boolean;
  onClose: () => void;
  isPlatformAdmin: boolean;
  caps: readonly Capability[];
  onOpenAppearance?: () => void;
}) {
  return (
    <Drawer open={open} onClose={onClose} title="Menú" width={300}>
      <div className={styles.drawerNav} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 36 }}>
        <SidebarBody
          collapsed={false}
          isPlatformAdmin={isPlatformAdmin}
          caps={caps}
          onNavigate={onClose}
          animatedPill={false}
          onOpenAppearance={
            onOpenAppearance
              ? () => {
                  // Apariencia es un panel flotante: con el Drawer abierto quedaría debajo de su fondo.
                  onClose();
                  onOpenAppearance();
                }
              : undefined
          }
        />
      </div>
    </Drawer>
  );
}
