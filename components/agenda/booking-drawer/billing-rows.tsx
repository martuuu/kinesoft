"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { formatARS } from "@/lib/format";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { setBookingCopagoPaid } from "@/lib/bookings";
import type { Capability } from "@/lib/capabilities";
import { COLLECT_COPY, UNDO_COLLECT_CONFIRM, copagoCollectView } from "@/lib/booking-collect";
import type { PaymentMethod } from "@/lib/payment-method";
import { isStaleError } from "@/lib/reception-view-state";
import { miniGhostBtn } from "./styles";
import type { CollectResult } from "./collect-modal";
import type { DrawerBooking } from "./types";

// T3d-1r: el modal (y el picker de medios) es un chunk aparte. El drawer ya es diferido, pero sin esto el picker
// viajaba con el drawer a cada apertura de turno aunque nadie cobre; /agenda estaba en 172,2 de 180 kB.
const CollectModal = dynamic(() => import("./collect-modal").then((m) => m.CollectModal), { ssr: false });

const NO_CAPS: ReadonlySet<Capability> = new Set();

/** Obra social name to show, or "" when particular (never prints the
 *  literal "Particular" / "Obra social" words). */
function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

/**
 * C13 "Copago (plan)" (S19d): el turno lo estampó el motor con la cuota de su
 * sesión (`pricedByPlan`, C5: `Session.priceCents` es la fuente y
 * `Booking.copagoCents` su espejo). Ese monto no se edita en el turno: el
 * drawer no tiene editor de copago (`updateBooking` no acepta `copagoCents`) y
 * el precio cambia desde el plan (reprecio, `plans.manage`). Sin C9
 * (`pricedByPlan` ausente) es "Copago" como siempre: no se adivina.
 */
export function copagoLabel(booking: Pick<DrawerBooking, "pricedByPlan">): string {
  return booking.pricedByPlan === true ? "Copago (plan)" : "Copago";
}

export const COPAGO_PLAN_HINT = "Es la cuota de la sesión del plan: se cambia desde el precio del plan.";

/**
 * Filas de detalle del turno: Cuándo, Duración, Servicio, Obra social, Copago,
 * Diagnóstico, Descripción y Notas. Fragmento: el contenedor (y lo que va
 * debajo, como el aviso de acceso básico) lo pone `index.tsx`.
 *
 * El estado y la acción del cobro (`copagoCollectView`) viven en `lib/booking-collect.ts` desde T3-Z (A3): los
 * comparte Facturación, que antes decía otra cosa sobre el mismo cobro.
 */
/** Lo que devolvió el server tras cobrar/deshacer, hasta que la agenda traiga una fila igual o más nueva. */
type CopagoOverride = { id: string; paymentStatus: "PAID" | "UNPAID"; copagoPaymentMethod: PaymentMethod | null; updatedAt: string };

/** Cambio de cobro ya confirmado por el server, para que el drawer lo propague (ver `onCopagoChanged`). */
export type CopagoChange = CopagoOverride;

export function BillingRows({
  booking: bookingProp,
  caps = NO_CAPS,
  viewerPractitionerId = null,
  practitionerName = null,
  onCopagoChanged,
}: {
  booking: DrawerBooking;
  /** Capabilities del actor (las del drawer). Sin ellas, solo el estado del cobro. */
  caps?: ReadonlySet<Capability>;
  /** Profesional del actor (`viewer.practitionerId`): sin él, `billing.collectOwn` no cobra nada. */
  viewerPractitionerId?: string | null;
  /** Nombre público del profesional del turno para «Se imputa a …» del modal de cobro (T3-Y). */
  practitionerName?: string | null;
  /**
   * El cobro cambió en el server (nuevo `updatedAt`). La fila se actualiza sola con la respuesta; esto es para que el
   * drawer la propague a sus otras acciones (si no, salen con la versión vieja y rebotan por stale).
   */
  onCopagoChanged?: (c: CopagoChange) => void;
}) {
  // EV1-C1: en Clínica general el título del turno es el motivo de consulta.
  const diagnostico = useTenantModules().has("diagnostico");
  const toast = useToast();
  const confirm = useConfirm();
  const [collecting, setCollecting] = useState(false);
  const [modalMounted, setModalMounted] = useState(false);
  const openCollect = () => {
    setModalMounted(true);
    setCollecting(true);
  };
  const [busy, setBusy] = useState(false);
  // La agenda le pasa al drawer la fila viva pero con el `updatedAt` que se vio al abrir (SV09, agenda-client): sin
  // esto, después de cobrar la fila seguiría diciendo «Por cobrar» y «Deshacer» saldría con la versión vieja (stale).
  // Mismo criterio que el `receptionResult` del drawer: se descarta cuando la fila del padre es igual o más nueva.
  const [override, setOverride] = useState<CopagoOverride | null>(null);
  const booking: DrawerBooking =
    override && override.id === bookingProp.id && new Date(bookingProp.updatedAt).getTime() < new Date(override.updatedAt).getTime()
      ? { ...bookingProp, ...override }
      : bookingProp;
  const view = copagoCollectView(booking, caps, viewerPractitionerId);

  const applyChange = (c: CopagoOverride) => {
    setOverride(c);
    onCopagoChanged?.(c);
  };

  const onCollected = (r: CollectResult) =>
    applyChange({ id: booking.id, paymentStatus: "PAID", copagoPaymentMethod: r.method, updatedAt: r.updatedAt });

  async function undo() {
    if (busy) return;
    const ok = await confirm(UNDO_COLLECT_CONFIRM(formatARS(booking.copagoCents)));
    if (!ok) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof setBookingCopagoPaid>>;
    try {
      res = await setBookingCopagoPaid(booking.id, { paid: false }, booking.updatedAt);
    } catch {
      res = { ok: false, error: "Revisá la conexión y reintentá." };
    }
    setBusy(false);
    if (res.ok) {
      applyChange({ id: booking.id, paymentStatus: "UNPAID", copagoPaymentMethod: null, updatedAt: res.data.updatedAt });
      toast.success("Cobro deshecho", res.data.notice ? { description: res.data.notice } : undefined);
      return;
    }
    if (isStaleError(res.error)) {
      toast.warning("El turno cambió en otra sesión", { description: "Cerrá el turno y abrilo de nuevo para ver lo último." });
      return;
    }
    toast.error(COLLECT_COPY.undoFailed, { description: res.error });
  }

  return (
    <>
      <Row label="Cuándo">
        {new Date(booking.scheduledFor).toLocaleString("es-AR", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </Row>
      <Row label="Duración">{booking.durationMin} min</Row>
      <Row label="Servicio">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: booking.serviceColor ?? SERVICE_COLOR_FALLBACK,
              flexShrink: 0,
            }}
          />
          {booking.serviceName}
        </span>
      </Row>
      {osLabel(booking.obraSocial) && (
        <Row label="Obra social">{osLabel(booking.obraSocial)}</Row>
      )}
      {/* `formatARS` (P0-S04b): el drawer tenía su propio `fmtMoney` con
          `toLocaleString`; ahora es el mismo formateo que Lista y semana. */}
      <Row label={copagoLabel(booking)}>
        <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>
          {formatARS(booking.copagoCents)}
        </span>
        {booking.pricedByPlan === true && (
          <span style={{ display: "block", fontSize: 11.5, fontWeight: 500, color: "var(--navy-500)" }}>
            {COPAGO_PLAN_HINT}
          </span>
        )}
        {view.label && (
          <span
            data-testid="copago-collect"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: view.label === "Por cobrar" ? "var(--navy-500)" : "var(--lime-700)" }}>
              {view.label}
            </span>
            {view.action === "collect" && (
              <Button type="button" size="sm" variant="primary" onClick={openCollect}>
                Cobrar
              </Button>
            )}
            {view.action === "undo" && (
              <button type="button" onClick={() => void undo()} disabled={busy} aria-busy={busy || undefined} style={miniGhostBtn}>
                Deshacer cobro
              </button>
            )}
          </span>
        )}
      </Row>
      {/* Se monta al primer «Cobrar» (recién ahí baja el chunk) y queda montado para la animación de salida. */}
      {modalMounted && (
        <CollectModal booking={collecting ? booking : null} practitionerName={practitionerName} onClose={() => setCollecting(false)} onSaved={onCollected} />
      )}
      {booking.title && <Row label={diagnostico ? "Diagnóstico" : "Motivo"}>{booking.title}</Row>}
      {booking.description && <Row label="Descripción">{booking.description}</Row>}
      {booking.notes && <Row label="Notas">{booking.notes}</Row>}
    </>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div
        style={{
          width: 80,
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
      <div style={{ flex: 1, color: "var(--navy-900)", fontWeight: 500 }}>{children}</div>
    </div>
  );
}
