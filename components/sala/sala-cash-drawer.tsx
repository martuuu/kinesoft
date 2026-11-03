"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Drawer } from "@/components/ui/drawer";
import { fmtHour, type BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";
import { cashEntries, deskOwedCents } from "@/lib/reception-desk-state";
import type { SalaLive } from "./sala-live-types";
import { loadDeskPayModal } from "./sala-faces";

/*
 * El modal de cobro es el MISMO del escritorio (`DeskPayModal`: monto que falta, medio obligatorio, «Se imputa a …»,
 * stale → toast). Diferido y sin SSR, como en `reception-desk.tsx`: este drawer ya es un chunk aparte (lo baja
 * `sala-board-face` recién cuando alguien abre «Por cobrar»), y el modal se pide al montar el drawer.
 */
const DeskPayModal = dynamic(() => loadDeskPayModal().then((mod) => mod.DeskPayModal), { ssr: false });

const ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid rgba(15,30,51,0.08)",
} as const;

/**
 * [CF2-SB · D-CF2-3] Drawer «Por cobrar» del Tablero de /sala (brief CF2 A.2). El Tablero no muestra a los atendidos
 * (solo los cuenta), y eran justo los que había que cobrar: la Secretaria tenía que cambiar a «Lista y panel» para ver
 * quién se fue sin pagar. Acá están todos, con lo que FALTA (copago − seña online) y «Cobrar».
 *
 * - La lista es `cashEntries(live.entries, live.viewer)`: los que deben y que ESTE viewer cobra (Secretaria todo, el
 *   profesional lo suyo), en orden cronológico; el total es el mismo número que el botón del header. [CF2-ZF1] (ZB-1)
 *   «Deben» es el criterio único del tag de la card (`copagoOwedCents`): atendidos Y los que llegaron y no terminaron.
 *   Antes eran solo atendidos y una card «Por cobrar» del tablero no aparecía acá.
 * - «Cobrar» abre `DeskPayModal` con la fila VIGENTE (se busca en `live.rows` por id: su `updatedAt` es el de ahora) y
 *   al guardar `live.replaceRow`: la fila sale de la lista sola (pasa a PAID).
 * - Sin formulario propio: no hay dirty-guard que armar (el modal tiene el suyo de «guardando»).
 * - `live` llega ya recortado por sede (`SalaClient`): con una sede elegida se cobra lo de esa sede.
 */
export function SalaCashDrawer({ open, onClose, live }: { open: boolean; onClose: () => void; live: SalaLive }) {
  const { entries, totalCents } = useMemo(() => cashEntries(live.entries, live.viewer), [live.entries, live.viewer]);
  const proNames = useMemo(() => new Map(live.practitioners.map((p) => [p.id, p.name])), [live.practitioners]);
  const [payId, setPayId] = useState<string | null>(null);
  const [payMounted, setPayMounted] = useState(false);
  const payRow: BookingDTO | null = payId ? live.rows.find((r) => r.id === payId) ?? null : null;
  const closePay = useCallback(() => setPayId(null), []);

  // Quien abre «Por cobrar» va a cobrar: el chunk del modal se pide ya, así «Cobrar» no espera red.
  useEffect(() => {
    void loadDeskPayModal().catch(() => {});
  }, []);

  const count = entries.length;

  return (
    <>
      <Drawer open={open} onClose={onClose} title="Por cobrar" width={460}>
        {count === 0 ? (
          <p style={{ margin: 0, color: "var(--navy-500)", fontSize: 14 }}>No hay cobros pendientes de hoy.</p>
        ) : (
          <>
            <p style={{ margin: "0 0 8px", color: "var(--navy-500)", fontSize: 13 }}>
              {/* [CF2-ZF1] «turnos», no «turnos atendidos»: la lista suma también a los que están en la sala. */}
              {count === 1 ? "1 turno" : `${count} turnos`} · falta cobrar{" "}
              <strong className="k-mono" style={{ color: "var(--navy-900)" }}>
                {formatARS(totalCents)}
              </strong>
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {entries.map((e) => {
                const b = e.row;
                const time = fmtHour(new Date(b.scheduledFor));
                return (
                  <li key={b.id} style={ROW_STYLE} data-booking-id={b.id}>
                    <span className="k-mono" style={{ fontSize: 13, color: "var(--navy-500)" }}>
                      {time}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 700, overflowWrap: "anywhere" }}>{b.patientName}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>
                        {proNames.get(b.practitionerId) ?? "Profesional del turno"} · {b.serviceName}
                      </span>
                    </span>
                    <span className="k-mono" style={{ fontWeight: 700 }}>
                      {formatARS(deskOwedCents(b))}
                    </span>
                    <button
                      type="button"
                      className="k-btn k-btn-primary k-btn-sm"
                      aria-label={`Cobrar: ${b.patientName}, ${time}`}
                      onClick={() => {
                        setPayMounted(true);
                        setPayId(b.id);
                      }}
                    >
                      Cobrar
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Drawer>

      {payMounted && (
        <DeskPayModal
          row={payRow}
          practitionerName={payRow ? proNames.get(payRow.practitionerId) ?? null : null}
          viewer={live.viewer}
          onClose={closePay}
          onSaved={live.replaceRow}
        />
      )}
    </>
  );
}
