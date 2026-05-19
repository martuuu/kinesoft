"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCheck, IconClock, IconX } from "@/components/ui/icons";
import { devMarkBookingPaid } from "@/lib/public-booking";
import type { PublicBookingStatus } from "@/lib/public-booking-types";

type Variant = "ok" | "pending" | "failed";

/**
 * Post-MP result page. Polls `/api/booking/:id/status` every 3 s for up
 * to 60 attempts (≈3 min) until the webhook flips the booking to PAID.
 * Renders one of three variants based on the URL but auto-promotes
 * pending → ok if the poller catches the transition.
 *
 * In development a "Simular pago" button is exposed when polling stalls,
 * since MP webhooks don't reach localhost.
 */
export function BookingResult({
  initial,
  variant,
}: {
  initial: PublicBookingStatus;
  variant: Variant;
}) {
  const [status, setStatus] = useState(initial);
  const [attempts, setAttempts] = useState(0);
  const effectiveVariant: Variant =
    status.paymentStatus === "PAID"
      ? "ok"
      : status.paymentStatus === "FAILED"
        ? "failed"
        : status.paymentStatus === "AUTHORIZED" || status.status === "PENDING"
          ? "pending"
          : variant;

  // Poll until we land on a terminal state or run out of tries.
  useEffect(() => {
    if (effectiveVariant === "ok" || effectiveVariant === "failed") return;
    if (attempts > 60) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/booking/${initial.bookingId}/status`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as PublicBookingStatus;
          setStatus(next);
        }
      } finally {
        setAttempts((a) => a + 1);
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [attempts, effectiveVariant, initial.bookingId]);

  const dev = process.env.NODE_ENV !== "production";

  return (
    <div
      className="k-app"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        className="k-glass"
        style={{
          margin: "18px 24px 0",
          padding: "12px 20px",
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <KineLogo size={24} />
        <span style={{ fontSize: 12, color: "var(--navy-300)" }}>· {status.tenantName}</span>
        <div style={{ flex: 1 }} />
        <Link
          href={`/c/${status.tenantSlug}/booking`}
          style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" }}
        >
          Reservar otro turno
        </Link>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Card
          glass
          style={{
            padding: 32,
            borderRadius: 24,
            maxWidth: 520,
            width: "100%",
            textAlign: "center",
          }}
        >
          <StatusIcon variant={effectiveVariant} />
          <h1
            className="k-display"
            style={{ fontSize: 26, margin: "16px 0 8px", letterSpacing: "-0.02em" }}
          >
            {effectiveVariant === "ok"
              ? "¡Turno confirmado!"
              : effectiveVariant === "pending"
                ? "Procesando tu pago…"
                : "El pago no se completó"}
          </h1>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
            {effectiveVariant === "ok"
              ? "Te mandamos un email con los detalles."
              : effectiveVariant === "pending"
                ? "Apenas Mercado Pago lo confirme te avisamos. No cierres esta pestaña."
                : "Probá nuevamente con otra forma de pago."}
          </p>

          <div
            style={{
              marginTop: 22,
              padding: 18,
              borderRadius: 16,
              background: "rgba(255,255,255,0.5)",
              border: "1px solid rgba(15,30,51,0.06)",
              textAlign: "left",
            }}
          >
            <DetailRow label="Centro" value={status.tenantName} />
            <DetailRow label="Profesional" value={status.practitionerName} />
            <DetailRow label="Servicio" value={status.serviceName} sub={`${status.durationMin} min`} />
            <DetailRow
              label="Fecha y hora"
              value={new Date(status.scheduledFor).toLocaleString("es-AR", {
                weekday: "long",
                day: "2-digit",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "America/Argentina/Buenos_Aires",
              })}
            />
            {status.amountCents != null && (
              <DetailRow
                label="Monto"
                value={new Intl.NumberFormat("es-AR", {
                  style: "currency",
                  currency: "ARS",
                  maximumFractionDigits: 0,
                }).format(status.amountCents / 100)}
              />
            )}
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: "var(--navy-500)" }}>Estado</span>
              <Tag
                tone={
                  effectiveVariant === "ok"
                    ? "lime"
                    : effectiveVariant === "pending"
                      ? "sky"
                      : "soft"
                }
              >
                {status.status} · {status.paymentStatus}
              </Tag>
            </div>
          </div>

          {effectiveVariant === "ok" && (
            <Link
              href="/portal"
              style={{ display: "block", textDecoration: "none", marginTop: 18 }}
            >
              <Button
                variant="primary"
                style={{ width: "100%", justifyContent: "center", padding: "14px" }}
              >
                Ver mis turnos <IconArrow size={14} />
              </Button>
            </Link>
          )}
          {effectiveVariant === "failed" && (
            <Link
              href={`/c/${status.tenantSlug}/booking`}
              style={{ display: "block", textDecoration: "none", marginTop: 18 }}
            >
              <Button
                variant="primary"
                style={{ width: "100%", justifyContent: "center", padding: "14px" }}
              >
                Reintentar reserva <IconArrow size={14} />
              </Button>
            </Link>
          )}
          {effectiveVariant === "pending" && (
            <div style={{ marginTop: 18, fontSize: 11.5, color: "var(--navy-300)" }}>
              Reintentos: {attempts} / 60
            </div>
          )}

          {dev && effectiveVariant !== "ok" && (
            <DevPaidStub bookingId={status.bookingId} onPaid={setStatus} />
          )}
        </Card>
      </main>
    </div>
  );
}

function StatusIcon({ variant }: { variant: Variant }) {
  const bg =
    variant === "ok"
      ? "var(--lime-300)"
      : variant === "pending"
        ? "var(--sky-100)"
        : "rgba(228,70,70,0.18)";
  const color =
    variant === "ok"
      ? "var(--navy-900)"
      : variant === "pending"
        ? "var(--sky-700)"
        : "#9F1F1F";
  return (
    <span
      style={{
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: bg,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {variant === "ok" ? (
        <IconCheck size={28} stroke={3} />
      ) : variant === "pending" ? (
        <IconClock size={28} />
      ) : (
        <IconX size={28} stroke={3} />
      )}
    </span>
  );
}

function DetailRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "8px 0",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
      }}
    >
      <div
        style={{
          width: 110,
          fontSize: 10.5,
          color: "var(--navy-300)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{sub}</div>}
      </div>
    </div>
  );
}

function DevPaidStub({
  bookingId,
  onPaid,
}: {
  bookingId: string;
  onPaid: (next: PublicBookingStatus) => void;
}) {
  const [pending, start] = useTransition();
  const click = () =>
    start(async () => {
      await devMarkBookingPaid(bookingId);
      const res = await fetch(`/api/booking/${bookingId}/status`, { cache: "no-store" });
      if (res.ok) onPaid((await res.json()) as PublicBookingStatus);
    });
  return (
    <div
      style={{
        marginTop: 20,
        padding: 12,
        borderRadius: 12,
        background: "rgba(228,70,70,0.06)",
        border: "1px dashed rgba(228,70,70,0.3)",
        fontSize: 11,
        color: "var(--navy-700)",
      }}
    >
      <strong>DEV ONLY</strong> — los webhooks de MP no llegan a localhost.
      <button
        type="button"
        onClick={click}
        disabled={pending}
        style={{
          marginTop: 8,
          display: "block",
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          border: "none",
          background: "var(--navy-900)",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        {pending ? "Simulando…" : "Simular webhook PAID"}
      </button>
    </div>
  );
}
