"use client";

/**
 * [TP-K4] Pestaña «Mi Mercado Pago» (§25.10; TP-UI-D2: pestaña de Configuración + ítem del menú de cuenta). Stub
 * funcional de T5c con las props CONGELADAS de `components/payments/payments-ui-types.ts`; TP-3b la completa (avisos
 * de cada estado, badges con estilo, avisos `?mp=`) y TP-3a la registra en `TAB_DEFS`. Acá no se monta en ningún lado.
 *
 * Arranque OAuth por server action + `location.assign` (TP-UI-D3): la URL de autorización la arma el server con el
 * state firmado; el cliente solo navega, así la CSP no cambia. Desconectar confirma con `useConfirm` (AGENTS §5).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { disconnectMpAccount, setMpLinksDelegated, startMpConnect } from "@/lib/mp-connect-actions";
import { MP_ACCOUNT_STATUS_LABEL, MP_CONNECT_COPY } from "@/lib/online-payments-copy";
import type { MyMpPanelProps } from "@/components/payments/payments-ui-types";

export function MyMpPanel({ account, mpReturn, support = false }: MyMpPanelProps) {
  const confirm = useConfirm();
  const [delegated, setDelegated] = useState(account.linksDelegated);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const connected = account.status === "ACTIVE";

  async function connect() {
    setPending(true);
    setError(null);
    const res = await startMpConnect({ target: "own" });
    if (res.ok) {
      window.location.assign(res.data.url);
      return;
    }
    setError(res.error);
    setPending(false);
  }

  async function disconnect() {
    const ok = await confirm({ title: "¿Desconectar tu Mercado Pago?", confirmLabel: "Desconectar", tone: "danger" });
    if (!ok) return;
    setPending(true);
    const res = await disconnectMpAccount({ target: "own" });
    setPending(false);
    if (!res.ok) setError(res.error);
  }

  async function toggleDelegation() {
    const next = !delegated;
    setDelegated(next);
    const res = await setMpLinksDelegated({ target: "own", delegated: next });
    if (!res.ok) {
      setDelegated(!next);
      setError(res.error);
    }
  }

  return (
    <Card data-mp-return={mpReturn ?? undefined}>
      <h2>{MP_CONNECT_COPY.myMpTab}</h2>
      <p>
        {MP_ACCOUNT_STATUS_LABEL[account.status]}
        {account.nickname ? ` · ${account.nickname}` : ""}
        {account.badge && (
          <Tag tone="soft" variant="outline">
            {account.badge === "fake" ? MP_CONNECT_COPY.badgeFake : MP_CONNECT_COPY.badgeSandbox}
          </Tag>
        )}
      </p>
      {account.status === "REAUTH_REQUIRED" && <p role="status">{MP_CONNECT_COPY.reauthBody}</p>}
      {!support && (
        <div>
          {connected ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => void disconnect()}>
              Desconectar
            </Button>
          ) : (
            <Button type="button" disabled={pending} onClick={() => void connect()}>
              {account.status === "NONE" ? "Conectar Mercado Pago" : "Reconectar Mercado Pago"}
            </Button>
          )}
        </div>
      )}
      {connected && (
        <label>
          <Switch
            on={delegated}
            onChange={() => void toggleDelegation()}
            disabled={support}
            aria-label={MP_CONNECT_COPY.delegationSwitch}
          />
          {MP_CONNECT_COPY.delegationSwitch}
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
