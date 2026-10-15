"use client";

/**
 * Providers de UI de cliente: motion, toasts y confirmaciones.
 *
 * VX F-d (C-F3): antes se montaban en el root (`app/layout.tsx`) y arrastraban framer-motion completo (~35 kB) a
 * todas las superficies, incluidas la landing, el login, el turnero y el portal, que no usan ni toast ni modal. Ahora
 * se montan solo en los layouts que los necesitan: `app/(app)`, `app/(platform)`, `app/onboarding`, `app/cuenta`
 * (`/cuenta/seguridad` usa `useToast`/`useConfirm` y el `StepUpModal`) y `app/plataforma-mfa` (monta
 * `StepUpProvider`). `useToast`/`useConfirm` tiran sin provider, así que una pantalla nueva que los use fuera de
 * esos layouts falla en el primer render, no en silencio. Las superficies públicas (C-F7) no pueden importar este
 * archivo (guard `tests/unit/public-surface-imports.test.ts`).
 *
 * - `LazyMotion` con `features` asíncrono: el núcleo de `m.*` va en el bundle y `domMax` llega en un chunk aparte
 *   (`lib/motion-features.ts`). Mientras no llega, un `m.div` pinta su estado `initial` sin animar; los modales y
 *   toasts se abren después de una interacción, cuando el chunk ya está. Nada visible en el primer render depende de
 *   framer: las entradas de página son CSS (`.k-enter*`, `.k-page-in`).
 * - Sin `strict`: todavía hay ~20 archivos con `motion.*` (que traen sus features propias). Se prende en PF1-Z,
 *   cuando el ratchet de `public-surface-imports` llegue a 0.
 * - `MotionConfig reducedMotion="user"`: framer respeta «reducir movimiento» del sistema (las animaciones pasan a
 *   instantáneas, el estado final se ve completo) sin manejo por componente.
 */
import { LazyMotion, MotionConfig } from "framer-motion";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const loadMotionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

export function UIProviders({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadMotionFeatures}>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
