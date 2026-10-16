"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { inviteEmailStatusCopy } from "@/lib/invitations-constants";
import type { InvitationSendResult } from "@/lib/invitations-types";
import { shouldOfferCopyLink } from "./team-logic";

/**
 * Qué pasó con el mail de una invitación (crear o reenviar) y, si no salió, el link para pasarlo a mano. Mismo copy
 * que Configuración (`inviteEmailStatusCopy`, IAM-2a): dice la verdad sobre el envío en vez de «enviado».
 */
export function InviteResultNotice({ result }: { result: InvitationSendResult }) {
  const [copied, setCopied] = useState(false);
  const status = inviteEmailStatusCopy(result.emailStatus, result.emailReason);
  const url = shouldOfferCopyLink(result) ? result.url : null;
  const copy = () => {
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        role="status"
        style={{
          padding: 10,
          borderRadius: 10,
          background:
            status.tone === "ok" ? "rgba(200,245,100,0.18)" : status.tone === "warn" ? "var(--warn-bg)" : "var(--danger-bg)",
          color: status.tone === "ok" ? "var(--navy-900)" : status.tone === "warn" ? "var(--warn-fg)" : "var(--danger-fg)",
          fontSize: 12.5,
          lineHeight: 1.45,
        }}
      >
        {status.text}
      </div>
      {url && (
        <>
          <div
            data-testid="invite-link"
            style={{
              padding: 12,
              borderRadius: 12,
              background: "rgba(15,30,51,0.04)",
              fontSize: 12,
              wordBreak: "break-all",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {url}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={copy}>
              {copied ? (
                <>
                  <IconCheck size={12} stroke={3} /> Copiado
                </>
              ) : (
                "Copiar link"
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
