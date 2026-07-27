"use client";

import { useTransition } from "react";
import { Card } from "@/components/ui/card";
import { IconCheck } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { setBookingInsurerPaid, setBookingCopagoPaid } from "@/lib/bookings";
import { formatARS } from "@/lib/format";
import { Summary, BookingStatusTag } from "../ui";
import type { PatientBookingFull } from "@/lib/patients-types";

/** Facturación columns: Fecha · Servicio · Obra social · OS · Copago · Turno. */
const FACT_COLS = "92px 1fr 0.9fr 1.25fr 1.25fr 96px";

/** Money + a "Confirmar / Cobrado" toggle for one billing side (OS or copago). */
function PaidCell({
  amountCents,
  paid,
  available,
  pending,
  onToggle,
}: {
  amountCents: number;
  paid: boolean;
  available: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
}) {
  if (!available) return <span style={{ fontSize: 12, color: "var(--navy-300)" }}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <span className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
        {formatARS(amountCents)}
      </span>
      {paid ? (
        <button
          type="button"
          onClick={() => onToggle(false)}
          disabled={pending}
          title="Cobrado — click para deshacer"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", cursor: "pointer", background: "rgba(54,179,126,0.14)", color: "#1F7A52", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}
        >
          <IconCheck size={9} stroke={3} /> Cobrado
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(true)}
          disabled={pending}
          style={{ border: "1px solid var(--sky-700)", color: "var(--sky-700)", background: "rgba(31,79,190,0.06)", cursor: "pointer", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}
        >
          Confirmar
        </button>
      )}
    </div>
  );
}

export function FacturacionView({
  bookings,
  loading,
  patchBooking,
}: {
  bookings: PatientBookingFull[] | null;
  loading: boolean;
  patchBooking: (id: string, partial: Partial<PatientBookingFull>) => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();

  if (loading || bookings === null) {
    return (
      <Card glass style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        Cargando movimientos…
      </Card>
    );
  }

  // "Ya confirmado" → solo turnos que efectivamente facturan.
  const billable = bookings.filter((b) => b.status === "CONFIRMED" || b.status === "COMPLETED");
  const osPaid = billable.reduce((s, b) => s + (b.insurerPaidAt ? b.osAmountCents : 0), 0);
  const copagoPaid = billable.reduce((s, b) => s + (b.paymentStatus === "PAID" ? b.copagoCents : 0), 0);
  const pendingTotal = billable.reduce(
    (s, b) => s + (b.insurerPaidAt ? 0 : b.osAmountCents) + (b.paymentStatus === "PAID" ? 0 : b.copagoCents),
    0
  );

  const confirmOS = (b: PatientBookingFull, next: boolean) => {
    patchBooking(b.id, { insurerPaidAt: next ? new Date() : null });
    start(async () => {
      const r = await setBookingInsurerPaid(b.id, next);
      if (!r.ok) {
        patchBooking(b.id, { insurerPaidAt: b.insurerPaidAt });
        toast.error("No pudimos actualizar el pago de la obra social", { description: r.error });
      }
    });
  };
  const confirmCopago = (b: PatientBookingFull, next: boolean) => {
    patchBooking(b.id, { paymentStatus: next ? "PAID" : "UNPAID" });
    start(async () => {
      const r = await setBookingCopagoPaid(b.id, next);
      if (!r.ok) {
        patchBooking(b.id, { paymentStatus: b.paymentStatus });
        toast.error("No pudimos actualizar el copago", { description: r.error });
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card glass style={{ padding: 18, display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <Summary label="OS percibido" value={formatARS(osPaid)} tone="lime" />
        <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
        <Summary label="Copago percibido" value={formatARS(copagoPaid)} tone="lime" />
        <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
        <Summary label="Pendiente de cobro" value={formatARS(pendingTotal)} tone="sky" />
        <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
        <Summary label="Turnos facturados" value={String(billable.length)} />
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", display: "grid", gridTemplateColumns: FACT_COLS, gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-300)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
          <span>Fecha</span>
          <span>Servicio</span>
          <span>Obra social</span>
          <span>OS (prestadora)</span>
          <span>Copago (paciente)</span>
          <span style={{ textAlign: "right" }}>Turno</span>
        </div>
        {billable.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
            Sin turnos confirmados para facturar todavía.
          </div>
        ) : (
          billable.map((b) => {
            const hasOS = b.obraSocial.toLowerCase() !== "particular" && b.osAmountCents > 0;
            return (
              <div key={b.id} style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: FACT_COLS, gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)" }}>
                <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>
                  {b.scheduledFor.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "America/Argentina/Buenos_Aires" })}
                </span>
                <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
                <span style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hasOS ? b.obraSocial : "Particular"}
                </span>
                <PaidCell amountCents={b.osAmountCents} paid={!!b.insurerPaidAt} available={hasOS} pending={pending} onToggle={(n) => confirmOS(b, n)} />
                <PaidCell amountCents={b.copagoCents} paid={b.paymentStatus === "PAID"} available pending={pending} onToggle={(n) => confirmCopago(b, n)} />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <BookingStatusTag status={b.status} />
                </div>
              </div>
            );
          })
        )}
      </Card>
      <div style={{ fontSize: 11, color: "var(--navy-300)", paddingLeft: 4, lineHeight: 1.5 }}>
        <strong>OS</strong> = monto que reintegra la obra social al consultorio · <strong>Copago</strong> = lo que abona el paciente. Tocá «Confirmar» en cada lado cuando lo cobres.
      </div>
    </div>
  );
}
