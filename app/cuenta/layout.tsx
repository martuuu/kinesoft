import { UIProviders } from "@/components/providers/ui-providers";

/**
 * VX F-d (C-F3): `UIProviders` (motion + toast + confirm) ya no vive en el root. `/cuenta/seguridad` lo necesita:
 * usa `useToast`/`useConfirm` y el `StepUpModal` (`components/account/security-settings.tsx`), y esos hooks tiran
 * sin provider. Sin lógica: los guards siguen en la página.
 */
export default function CuentaLayout({ children }: { children: React.ReactNode }) {
  return <UIProviders>{children}</UIProviders>;
}
