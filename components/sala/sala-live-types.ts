/**
 * RX-0 (C-RX4): contrato de `useSalaLive()`, el hook que RX-1a extrae de `SalaClient` SIN cambio de comportamiento
 * (realtime + polling en off, optimista con rollback, reloj de 30 s, diff de llegadas y llamados, banda «Pase …»).
 * Lo consumen las tres caras de `/sala`: el Tablero (SV10a) y el escritorio de Recepción (A «Lista y panel», B
 * «Flujo»). Solo tipos: vive aparte del hook para que las caras compilen contra la firma antes de que exista.
 *
 * PD-13: `rows` son filas del cable ya limpias (`fromSalaWire`: title/description/notes/patientCondition en null).
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { ReceptionAction } from "@/lib/reception-state";
import type { SalaPractitioner, SalaRoom } from "@/lib/sala-board-state";
import type { DeskEntry, DeskViewer } from "@/lib/reception-desk-state";

export type SalaLive = {
  /** Día AR del reloj (`dayKeyOf(clock)`). */
  dayKey: string;
  /** Reloj único de la pantalla (tick de 30 s): ninguna fila tiene timer propio. */
  clock: Date;
  /** Día nuevo pedido y sin respuesta (medianoche con la pestaña abierta): no decir «Hoy no hay turnos». */
  loading: boolean;
  /** Turnos de hoy con los overrides optimistas aplicados. */
  rows: BookingDTO[];
  /**
   * `deskEntries(rows, clock, viewer)`: estado de Recepción de CADA fila (atendidos, ausentes y cancelados
   * incluidos) + acciones por rol. Es un `ReceptionEntry<BookingDTO>` con `salaActions` (C-RX4 pedía
   * `ReceptionEntry`; el subtipo le ahorra a cada cara recalcular el rol).
   */
  entries: DeskEntry[];
  /** Filas con una acción en vuelo (botones deshabilitados). */
  pendingIds: ReadonlySet<string>;
  /** Optimista; si el server rechaza, rollback; «El turno cambió en otra sesión» → toast + re-pedido. */
  act: (b: BookingDTO, a: ReceptionAction) => Promise<void>;
  /** Reemplaza una fila (después de `setBookingCopagoPaid` OK, con la fila que devolvió el server). */
  replaceRow: (b: BookingDTO) => void;
  /** Banda «Pase María G. · Consultorio 2» (8 s); `key` cambia con cada llamado nuevo. */
  call: { key: string; text: string } | null;
  dismissCall: () => void;
  /** Llegadas nuevas (anillo una vez). Decorativo: con `reducedMotion` no se anima. */
  pulseIds: ReadonlySet<string>;
  /** Texto para la región `aria-live` (llegadas y llamados). */
  announce: string;
  practitioners: SalaPractitioner[];
  rooms: SalaRoom[];
  /** Catálogo de salas para `roomNameOf`; null sin salas. */
  roomById: Readonly<Record<string, { name: string }>> | null;
  viewer: DeskViewer;
};
