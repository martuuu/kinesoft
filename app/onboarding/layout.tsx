import { UIProviders } from "@/components/providers/ui-providers";

/**
 * VX F-d (C-F3): `UIProviders` (motion + toast + confirm) ya no vive en el root. El stepper de alta lo necesita: sus
 * pasos usan Drawer, toasts y confirmaciones, y `useToast`/`useConfirm` tiran sin provider. Sin lógica: los guards
 * siguen en la página.
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <UIProviders>{children}</UIProviders>;
}
