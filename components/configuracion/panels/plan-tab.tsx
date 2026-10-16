"use client";

import type { ComponentProps } from "react";
import { StepUpProvider } from "@/components/account/step-up-modal";
import { PlanUsagePanel } from "./plan-usage-panel";

/**
 * [PF1.1-config · C-PF2] Pestaña «Plan y uso» = `StepUpProvider` + `PlanUsagePanel`. Vive aparte para que
 * `configuracion-client.tsx` la baje con `next/dynamic` junto con el provider del step-up (PL-D11: cambiar de plan pide
 * el código de la 2FA): antes el provider (y su modal) viajaba en el JS inicial de /configuracion aunque la pestaña no
 * se abriera nunca.
 */
export function PlanTab(props: ComponentProps<typeof PlanUsagePanel>) {
  return (
    <StepUpProvider>
      <PlanUsagePanel {...props} />
    </StepUpProvider>
  );
}
