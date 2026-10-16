import type { Metadata, Viewport } from "next";
import "./globals.css";
import { jetbrains, onest } from "@/lib/fonts";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  // EV1-C2: neutral para las dos verticales (Clínica general y Kinesiología): es la metadata de todo el sitio,
  // incluidos el turnero y el portal de un consultorio que no es de kinesiología. La marca queda.
  title: `${BRAND_NAME} — gestión para consultorios de salud`,
  description:
    "Agenda, turnos online, pacientes, historia clínica y cobros para consultorios de salud. Argentina.",
  applicationName: BRAND_NAME,
  // MB-0b (C-MB5): iOS «Agregar a inicio» y Safari macOS «Agregar al Dock» abren standalone con este nombre (el ícono
  // es app/apple-icon.png). `default` = iOS no pone contenido debajo de la barra de estado; con `black-translucent`
  // habría que correr todo el layout.
  appleWebApp: { capable: true, title: BRAND_NAME, statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1F4FBE",
};

/**
 * [VX F-a · C-F3.1] El root solo pone fuentes y `lang`: **ningún provider de cliente**.
 *
 * Antes montaba los providers de UI (framer-motion + Toast + Confirm) acá, y eso metía framer y los providers en el
 * bundle de toda superficie, incluidas la landing, el login y el turnero, que no los usan (H-BUNDLE). Ahora los
 * montan (`components/providers/ui-providers.tsx`) los layouts que sí los necesitan (F-d, C-F3.3). Las fuentes
 * llegan por `next/font` (lib/fonts.ts), sin el `<link>` bloqueante a Google Fonts.
 *
 * `suppressHydrationWarning` se queda: el script de paleta sin flash (F-d) escribe `data-palette` antes de hidratar.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" className={`${onest.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
