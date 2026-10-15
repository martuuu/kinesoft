import type { Metadata, Viewport } from "next";
import "./globals.css";
import { UIProviders } from "@/components/providers/ui-providers";

export const metadata: Metadata = {
  // EV1-C2: neutral para las dos verticales (Clínica general y Kinesiología): es la metadata de todo el sitio,
  // incluidos el turnero y el portal de un consultorio que no es de kinesiología. La marca queda.
  title: "KineSoft — gestión para consultorios de salud",
  description:
    "Agenda, turnos online, pacientes, historia clínica y cobros para consultorios de salud. Argentina.",
  applicationName: "KineSoft",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1F4FBE",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <UIProviders>{children}</UIProviders>
      </body>
    </html>
  );
}
