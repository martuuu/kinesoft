import type { SaasPlan } from "@prisma/client";
import { ButtonLink } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { MODULE_UI_LABEL } from "@/lib/saas-billing-view";
import { SAAS_PLAN_LABEL, type TenantModule } from "@/lib/tenant-modules";
import styles from "./access-wall.module.css";

/**
 * Muro de módulo (VX2-b2, D-VX20). Lo monta el `layout.tsx` de un segmento cuando `moduleWall(m)` (`lib/module-wall.ts`)
 * dice que el módulo lo trae un plan mayor. Server-safe (sin "use client"): es solo copy y dos links.
 *
 * Es UX, no barrera: no recibe ni muestra nada del módulo, y las actions siguen chequeando `assertModule`.
 *  - `canBuy` (`account.billing`) → «Ver planes», a la pestaña «Plan y uso» de Configuración (`tab=plan`,
 *    `components/configuracion/controls.tsx`), que solo ve quien tiene esa capacidad.
 *  - el resto → a quién pedírselo; un link a una pestaña que no puede ver sería un callejón.
 */
export const ACCESS_WALL_PLANS_HREF = "/configuracion?tab=plan";

export function accessWallTitle(m: TenantModule, plan: SaasPlan): string {
  // `MODULE_UI_LABEL` es el nombre que ve el consultorio en «Plan y uso»; los que no se listan ahí caen al genérico.
  const label = MODULE_UI_LABEL[m] ?? "Este módulo";
  return `${label} está en el plan ${SAAS_PLAN_LABEL[plan]}`;
}

export function AccessWall({ module: m, plan, canBuy }: { module: TenantModule; plan: SaasPlan; canBuy: boolean }) {
  return (
    <section
      aria-labelledby="access-wall-title"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "48px 16px",
        minHeight: 320,
        textAlign: "center",
      }}
    >
      <EyebrowLabel tone="accent">Plan {SAAS_PLAN_LABEL[plan]}</EyebrowLabel>
      <h1
        id="access-wall-title"
        className="k-display"
        style={{ fontSize: 24, margin: 0, color: "var(--navy-900)", maxWidth: 480, overflowWrap: "anywhere" }}
      >
        {accessWallTitle(m, plan)}
      </h1>
      {canBuy ? (
        <>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>
            Cambiá de plan para usarlo en tu consultorio.
          </p>
          <div className={styles.actions} style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            <ButtonLink href={ACCESS_WALL_PLANS_HREF}>Ver planes</ButtonLink>
            <ButtonLink href="/dashboard" variant="ghost">
              Volver al inicio
            </ButtonLink>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>
            Pedile a quien administra la cuenta que cambie de plan.
          </p>
          <div className={styles.actions}>
            <ButtonLink href="/dashboard" variant="ghost">
              Volver al inicio
            </ButtonLink>
          </div>
        </>
      )}
    </section>
  );
}
