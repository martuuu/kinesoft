"use client";

/**
 * Menú del workspace bajo 768 px (PF1.0-a, S1 de VX0-b): el mismo contenido del sidebar (`SidebarBody`, una sola
 * lista) dentro de un `Drawer`, como el «Menú» de `PlatformShell`: el nav completo (también lo que no entra en la barra
 * inferior), consultorio activo / cambiar de consultorio, Plataforma, Configuración, Apariencia y Cerrar sesión.
 *
 * MB-0c (C-MB1): lo abre «Más» de la barra inferior (`bottom-nav.tsx`, antes el botón «Menú» de `MobileBar`), con
 * `next/dynamic` recién al primer toque: en escritorio nunca se baja. Al cerrarse, el Drawer devuelve el foco a «Más».
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
