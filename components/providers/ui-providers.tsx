"use client";

/**
 * Global client-side UI providers, mounted once at the root layout so
 * every surface (workspace, portal, public) can raise toasts + confirm
 * dialogs and inherit the shared motion config.
 *
 * `MotionConfig reducedMotion="user"` makes framer-motion honour the OS
 * "reduce motion" setting automatically — animations degrade to instant
 * for users who ask for it, no per-component handling needed.
 */
import { MotionConfig } from "framer-motion";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

export function UIProviders({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
