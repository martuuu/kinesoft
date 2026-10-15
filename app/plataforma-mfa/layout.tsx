import { UIProviders } from "@/components/providers/ui-providers";

/**
 * VX F-d (C-F3): `UIProviders` (motion + toast + confirm) ya no vive en el root. `/plataforma-mfa/*` lo necesita:
 * `mfa-forms.tsx` monta `StepUpProvider` (modal de re-verificación). Vive fuera de `(platform)` a propósito (sin
 * bucle de MFA), así que no hereda los providers de ese grupo. Sin lógica: el guard sigue en `guard.ts`/la página.
 */
export default function PlataformaMfaLayout({ children }: { children: React.ReactNode }) {
  return <UIProviders>{children}</UIProviders>;
}
