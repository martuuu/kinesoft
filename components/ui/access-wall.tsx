import type { SaasPlan } from "@prisma/client";
import { ButtonLink } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { MODULE_UI_LABEL } from "@/lib/saas-billing-view";
import { MODULE_REVOKED_COPY, SAAS_PLAN_LABEL, type TenantModule } from "@/lib/tenant-modules";
import { SUPPORT_HELP_HREF } from "@/components/layout/shell-links";
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

/**
 * T3c-1p (plan §23.6): título del muro de un módulo que Plataforma deshabilitó a mano. Mismo nombre de módulo que el
 * del upsell; sin nombre en «Plan y uso», el genérico.
 */
export function accessWallDisabledTitle(m: TenantModule): string {
  const label = MODULE_UI_LABEL[m];
  // T3-Z B6: «no está habilitado» y no «no está disponible»: el módulo existe, lo apagó Plataforma para este
  // consultorio; «disponible» sonaba a caída o a que no existe para su plan.
  return label ? `${label} no está habilitado` : "Este módulo no está habilitado";
}

/** Upsell (`plan` + `canBuy`) o módulo deshabilitado a mano (`disabled`): el layout pasa tal cual lo de `moduleWall`. */
export type AccessWallProps =
  | { module: TenantModule; plan: SaasPlan; canBuy: boolean; disabled?: never }
  | { module: TenantModule; disabled: true; plan?: never; canBuy?: never };

const wallStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: "48px 16px",
  minHeight: 320,
  textAlign: "center",
} as const;

const titleStyle = { fontSize: 24, margin: 0, color: "var(--navy-900)", maxWidth: 480, overflowWrap: "anywhere" } as const;

export function AccessWall(props: AccessWallProps) {
  if (props.disabled) {
    // T3c-1p: sin «Ver planes» ni «Pedile a quien administra»: ningún plan lo devuelve y el Titular tampoco puede
    // prenderlo. La salida es Soporte (`MODULE_REVOKED_COPY`, el mismo texto que el `ForbiddenError` de
    // `assertModule`, `moduleDeniedCopy`), con el mismo link que «Ayuda y soporte» del menú (cualquier miembro, PL-F1b).
    return (
      <section aria-labelledby="access-wall-title" style={wallStyle}>
        <EyebrowLabel tone="accent">Módulo no habilitado</EyebrowLabel>
        <h1 id="access-wall-title" className="k-display" style={titleStyle}>
          {accessWallDisabledTitle(props.module)}
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>{MODULE_REVOKED_COPY}</p>
        <div className={styles.actions} style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          <ButtonLink href={SUPPORT_HELP_HREF}>Escribir a Soporte</ButtonLink>
          <ButtonLink href="/dashboard" variant="ghost">
            Volver al inicio
          </ButtonLink>
        </div>
      </section>
    );
  }
  return <PlanWall module={props.module} plan={props.plan} canBuy={props.canBuy} />;
}

function PlanWall({ module: m, plan, canBuy }: { module: TenantModule; plan: SaasPlan; canBuy: boolean }) {
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
