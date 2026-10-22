"use client";

/**
 * [TP-3d] Compartir un link de pago (§25.7 «Compartir»; paso «Link listo» del `PaymentLinkDrawer`): copiar, WhatsApp y
 * email.
 *
 * - **Copiar**: el link solo (para pegarlo donde sea) y el mensaje entero (el mismo texto que va por WhatsApp).
 * - **WhatsApp**: `wa.me` con el texto que arma el server (`getPaymentLinkShare` → `paymentLinkShareText`). Lleva el
 *   concepto (TP-D27: lo escribió el staff con el aviso de no poner datos clínicos) y nunca el servicio ni nada de la
 *   ficha. Sin celular válido (o sin acceso al contacto) el server devuelve `waUrl: null`: acá se cae al `wa.me` sin
 *   destinatario, como el «Compartir» del drawer del turno (WA-0, `lib/booking-share.ts`), con el mismo aviso. Un
 *   botón muerto obligaría a la Secretaría a copiar, abrir WhatsApp y pegar: el resultado es el mismo con más pasos.
 * - **Email**: `sendPaymentLinkEmail` (Resend, sin concepto ni datos clínicos, 3 por hora por cobro). Sin email cargado
 *   queda deshabilitado con el motivo a la vista (`emailButtonState`).
 *
 * Diferido (§25.11): solo lo monta el `PaymentLinkDrawer` y Facturación / /cobros por `import()`.
 */
import { useEffect, useId, useState } from "react";
import { Button, buttonClassName } from "@/components/ui/button";
import { whatsAppShareUrl, shareNotice, type ShareContact } from "@/lib/booking-share";
import { getPaymentLinkShare, sendPaymentLinkEmail } from "@/lib/payment-links";
import { emailButtonState, isNoEmailError, PAYMENT_LINK_SHARE_COPY as C } from "@/lib/payment-link-form";

export type PaymentLinkShareProps = {
  chargeId: string;
  /** El link público (ya lo devolvió `createPaymentLink`): se puede copiar aunque el texto todavía no llegó. */
  url: string;
  /** Nombre del paciente, solo para reconocer el error «… no tiene email cargado.» (nunca viaja al link). */
  patientName: string;
  /** Datos ya cargados (Facturación / /cobros los traen; el render test también): evita una ida al server. */
  initialShare?: { text: string; waUrl: string | null; contact: ShareContact } | null;
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PaymentLinkShare({ chargeId, url, patientName, initialShare = null }: PaymentLinkShareProps) {
  const [share, setShare] = useState(initialShare);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailDisabledReason, setEmailDisabledReason] = useState<string | null>(null);
  const reasonId = useId();
  const noticeId = useId();

  useEffect(() => {
    if (initialShare) return;
    let alive = true;
    getPaymentLinkShare({ chargeId })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setShare({ text: r.data.text, waUrl: r.data.waUrl, contact: r.data.contact });
        else setLoadError(r.error);
      })
      .catch(() => alive && setLoadError(C.loadFailed));
    return () => {
      alive = false;
    };
  }, [chargeId, initialShare]);

  async function onCopy(kind: "link" | "message") {
    const ok = await copyText(kind === "link" ? url : share?.text ?? url);
    setCopyFailed(!ok);
    setCopied(ok ? kind : null);
  }

  async function onEmail() {
    if (sending) return;
    setSending(true);
    setEmailError(null);
    try {
      const r = await sendPaymentLinkEmail({ chargeId });
      if (r.ok) setSentTo(r.data.sentToMasked);
      else if (isNoEmailError(r.error, patientName)) setEmailDisabledReason(r.error);
      else setEmailError(r.error);
    } finally {
      setSending(false);
    }
  }

  const waHref = share ? share.waUrl ?? whatsAppShareUrl(share.text, null) : null;
  const notice = share ? shareNotice(share.contact) : null;
  const email = emailButtonState({ sending, sentToMasked: sentTo, disabledReason: emailDisabledReason });

  return (
    <div data-testid="payment-link-share" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="button" variant="ghost" onClick={() => void onCopy("link")}>
          {copied === "link" ? C.copied : C.copyLink}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void onCopy("message")} disabled={!share}>
          {copied === "message" ? C.copied : C.copyMessage}
        </Button>
        {waHref ? (
          <a
            className={buttonClassName({ variant: "ghost" })}
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            data-share="whatsapp"
            aria-describedby={notice || share?.contact.status === "hidden" ? noticeId : undefined}
          >
            {C.whatsapp}
          </a>
        ) : (
          <Button type="button" variant="ghost" disabled aria-busy="true">
            {C.whatsapp}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => void onEmail()}
          disabled={email.disabled}
          aria-describedby={email.reason ? reasonId : undefined}
          data-share="email"
        >
          {email.label}
        </Button>
      </div>
      {!share && !loadError && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>{C.loading}</p>
      )}
      {(notice || share?.contact.status === "hidden") && (
        <p id={noticeId} style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
          {notice ? `${notice.title}. ${notice.detail}` : C.hiddenContact}
        </p>
      )}
      {email.reason && (
        <p id={reasonId} data-testid="email-disabled-reason" style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>
          {email.reason}
        </p>
      )}
      <div aria-live="polite" style={{ display: "grid", gap: 6 }}>
        {sentTo && (
          <p className="k-alert k-alert-success" style={{ margin: 0 }}>
            {C.emailSent(sentTo)}
          </p>
        )}
        {(emailError || loadError) && (
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {emailError ?? loadError}
          </p>
        )}
        {copyFailed && (
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {C.copyFailed}
          </p>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>{C.emailNote}</p>
    </div>
  );
}
