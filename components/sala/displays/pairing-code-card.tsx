"use client";

/**
 * [TV-2w1] Código de vínculo de una pantalla (§26.4 «código visible una sola vez con cuenta regresiva»).
 *
 * El código en claro sale UNA vez del server (respuesta de `createReceptionDisplay` / `regenerateDisplayPairingCode`):
 * la base guarda solo su HMAC y `getDisplaysPanel` nunca lo devuelve. Por eso esta tarjeta vive en el estado del drawer
 * y no en la lista: si se cierra, el código no se puede volver a ver y hay que generar otro (el drawer avisa con su
 * dirty-guard antes de cerrar con un código vivo a la vista).
 *
 * Al vencer se deja de mostrar el código (que ya no sirve: `pairDisplay` lo rechaza con el mismo copy genérico) y se
 * ofrece generar uno nuevo. La cuenta regresiva es mm:ss sobre el reloj del navegador: un desfase de segundos con el
 * server no cambia nada práctico en un TTL de 10 min.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export const PAIRING_COPY = {
  title: (name: string) => `Código para «${name}»`,
  step1: "En la TV, abrí esta dirección en el navegador:",
  step2: "Cargá este código:",
  countdown: (mmss: string) => `Vence en ${mmss}`,
  expired: "El código venció. Generá uno nuevo.",
  regenerate: "Generar uno nuevo",
  copy: "Copiar",
  copied: "Código copiado.",
  copyFailed: "No pudimos copiar. Anotá el código a mano.",
  once: "Lo mostramos una sola vez: si cerrás, vas a tener que generar otro.",
  done: "Listo",
} as const;

/** Tiempo que falta hasta `expiresAt`, como «9:42». Inválido o pasado → vencido («0:00»). */
export function pairingCountdown(expiresAt: string, nowMs: number): { expired: boolean; label: string } {
  const left = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(left) || left <= 0) return { expired: true, label: "0:00" };
  const s = Math.ceil(left / 1000);
  return { expired: false, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

const codeStyle: CSSProperties = {
  margin: 0,
  fontSize: 40,
  lineHeight: 1.1,
  fontWeight: 800,
  letterSpacing: "0.12em",
  fontVariantNumeric: "tabular-nums",
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  color: "var(--navy-900)",
  textAlign: "center",
  wordBreak: "keep-all",
};

const noteStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--navy-500)" };

export function PairingCodeCard({
  code,
  expiresAt,
  displayName,
  origin,
  now,
  onRegenerate,
  onDismiss,
  regenerating = false,
}: {
  code: string;
  expiresAt: string;
  displayName: string;
  /** `window.location.origin`; vacío hasta hidratar (se muestra «/tv» solo). */
  origin: string;
  /** Solo para el render test: arranca el reloj en este instante. */
  now?: number;
  onRegenerate: () => void;
  onDismiss: () => void;
  regenerating?: boolean;
}) {
  const toast = useToast();
  const [nowMs, setNowMs] = useState(() => now ?? Date.now());
  const { expired, label } = pairingCountdown(expiresAt, nowMs);

  useEffect(() => {
    if (expired) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [expired]);

  const tvUrl = `${origin}/tv`;

  async function copy() {
    // El clipboard pide contexto seguro y permiso: puede no estar o rechazar (Safari viejo, http en la red local).
    try {
      await navigator.clipboard.writeText(code);
      toast.success(PAIRING_COPY.copied);
    } catch {
      toast.error(PAIRING_COPY.copyFailed);
    }
  }

  return (
    <section
      aria-label={PAIRING_COPY.title(displayName)}
      style={{
        display: "grid",
        gap: 12,
        padding: 16,
        borderRadius: "var(--r-lg)",
        background: "var(--card-bg)",
        border: "1px solid var(--sky-200)",
      }}
      data-testid="pairing-card"
    >
      <strong style={{ fontSize: 15, color: "var(--navy-900)" }}>{PAIRING_COPY.title(displayName)}</strong>
      {expired ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {PAIRING_COPY.expired}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              {PAIRING_COPY.done}
            </Button>
            <Button type="button" size="sm" onClick={onRegenerate} disabled={regenerating} aria-busy={regenerating || undefined}>
              {PAIRING_COPY.regenerate}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)" }}>
            1. {PAIRING_COPY.step1}{" "}
            <span style={{ fontWeight: 700, color: "var(--navy-900)", wordBreak: "break-all" }} data-testid="pairing-url">
              {tvUrl}
            </span>
          </p>
          <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)" }}>2. {PAIRING_COPY.step2}</p>
          <p style={codeStyle} data-testid="pairing-code">
            {code}
          </p>
          <p style={{ ...noteStyle, textAlign: "center", fontVariantNumeric: "tabular-nums" }} data-testid="pairing-countdown">
            {PAIRING_COPY.countdown(label)}
          </p>
          <p style={noteStyle}>{PAIRING_COPY.once}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
              {PAIRING_COPY.copy}
            </Button>
            <Button type="button" size="sm" onClick={onDismiss}>
              {PAIRING_COPY.done}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
