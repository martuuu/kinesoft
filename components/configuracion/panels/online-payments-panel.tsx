"use client";

/**
 * [TP-K4] Pestaña «Cobros online» de Configuración (§25.10; `tenant.sensitive`: la Secretaría y Facturación no la ven,
 * ni con `?tab=`). Stub funcional de T5c con las props CONGELADAS de `components/payments/payments-ui-types.ts`: hoy
 * muestra el estado en solo lectura. TP-3a la completa (switch, OPTIONAL/REQUIRED con confirmación, «¿Cuánto se cobra
 * online?» con vista previa, nota de 280, acciones del Titular con step-up) y la registra en `TAB_DEFS`.
 *
 * Va en su propio chunk (`next/dynamic` desde `configuracion-client.tsx`, techo `/configuracion` +0,5 kB, §25.11).
 */
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { formatARS } from "@/lib/format";
import { quoteOnlineCharge } from "@/lib/online-charge-logic";
import { MP_ACCOUNT_STATUS_LABEL, MP_CONNECT_COPY, missingMpAccountsNotice } from "@/lib/online-payments-copy";
import type { OnlinePaymentsPanelProps } from "@/components/payments/payments-ui-types";

export function OnlinePaymentsPanel({ settings, previewServicePriceCents, mpReturn }: OnlinePaymentsPanelProps) {
  const { policy, clinicAccount, practitioners, withoutMpCount } = settings;
  const preview =
    previewServicePriceCents != null && policy.mode !== "OFF"
      ? quoteOnlineCharge({ policy, servicePriceCents: previewServicePriceCents })
      : null;

  return (
    <div data-mp-return={mpReturn ?? undefined}>
      {settings.connectMode === "off" && <p role="status">Los cobros online todavía no están habilitados.</p>}
      <Card>
        <h2>{MP_CONNECT_COPY.onlinePaymentsTab}</h2>
        <p>
          {MP_CONNECT_COPY.chargeOnlineSwitch} {policy.mode === "OFF" ? "No" : "Sí"}
        </p>
        {policy.mode !== "OFF" && (
          <p>
            {MP_CONNECT_COPY.allowBookWithoutPaying}: {policy.mode === "OPTIONAL" ? "Sí" : "No"}
          </p>
        )}
        {preview && (
          <p>
            {MP_CONNECT_COPY.howMuch} {formatARS(preview.amountCents)}
          </p>
        )}
        {withoutMpCount > 0 && <p role="status">{missingMpAccountsNotice(withoutMpCount)}</p>}
      </Card>
      <Card>
        <h3>{MP_CONNECT_COPY.clinicAccountCard}</h3>
        <p>
          {MP_ACCOUNT_STATUS_LABEL[clinicAccount.status]}
          {clinicAccount.nickname ? ` · ${clinicAccount.nickname}` : ""}
          {clinicAccount.badge && (
            <Tag tone="soft" variant="outline">
              {clinicAccount.badge === "fake" ? MP_CONNECT_COPY.badgeFake : MP_CONNECT_COPY.badgeSandbox}
            </Tag>
          )}
        </p>
      </Card>
      <Card>
        <h3>{MP_CONNECT_COPY.practitionersCard}</h3>
        <ul>
          {practitioners.map((p) => (
            <li key={p.practitionerId}>
              {p.name} · {MP_ACCOUNT_STATUS_LABEL[p.status]}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
