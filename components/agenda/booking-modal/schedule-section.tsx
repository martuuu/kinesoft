"use client";

/**
 * Fecha/hora + duración del turno nuevo, el slot picker (B5.2) y el aviso en
 * vivo del instante elegido.
 *
 * La entrada manual de fecha/hora SE QUEDA aunque haya picker: el staff carga
 * fuera de grilla (sobreturno, retroactivo, un hueco de 10' entre franjas) y
 * `createBooking` decide con sus `allowOutOfHours`/`allowBlocked`.
 *
 * El formulario sigue leyendo `scheduledFor` de FormData ("YYYY-MM-DDTHH:mm"
 * de pared AR; `submit` lo pasa por `localToARIso`): ahora el control es
 * controlado acá adentro y el valor viaja en un `<input type="hidden">`.
 * La duración es controlada por `index.tsx` (elegir un servicio copia su
 * `durationMin`).
 *
 * Props (B5.2, para que B5.1 las cablee en `index.tsx`; todas opcionales,
 * sin ellas se comporta como antes):
 *   • `slotPicker?: React.ReactNode` — el `<SlotPicker …/>` ya armado; se
 *     muestra arriba de la entrada manual.
 *   • `value?: string | null` — ISO elegido afuera (el `onChange` del
 *     SlotPicker, o "Usar próximo libre"). Cuando cambia, la entrada manual
 *     se mueve a ese instante. null/undefined = no la toca.
 *   • `onInstantChange?: (iso: string | null) => void` — el staff editó la
 *     fecha/hora a mano: ISO con offset AR, o null si quedó incompleta. Sirve
 *     para pasarle `value` al SlotPicker y mover su `dayKey`.
 *   • `classify?: { practitionerId, serviceId, patientId?, locationId?,
 *     excludeBookingId? }` — con profesional y servicio, la sección calcula
 *     ADENTRO el estado en vivo con `classifyBookingInstant` (debounce +
 *     secuencia) y lo muestra con el copy de `INSTANT_CLASS_LABEL`: Libre /
 *     Sobreturno 2/1 / Fuera de horario / Bloqueado: motivo / Paciente
 *     superpuesto / Duplicado. Sin `classify` (o con "any" sin resolver) no
 *     muestra nada. Se eligió calcularlo adentro (y no recibir un
 *     `instantStatus`) para que index no repita debounce/secuencia.
 *     SR-U5c: `classify.roomId` = la sala del select (undefined = según el
 *     horario: el server chequea la de la franja y la devuelve en
 *     `defaultRoomId`; null = "Sin sala": no se chequea). Si la sala está
 *     ocupada o bloqueada (`roomBusy`) se suma una línea al aviso.
 *   • `onInstantStatus?: (c: InstantCheck | null) => void` — el último
 *     resultado, por si index quiere usarlo (p. ej. preparar el prompt de
 *     bloqueado/fuera de horario). Es un aviso: la decisión final es del
 *     server al crear.
 */
import { useEffect, useRef, useState } from "react";
import { FormField } from "@/components/ui/form-field";
import styles from "./booking-modal.module.css";
import { classifyBookingInstant } from "@/lib/availability-actions";
import type { InstantCheck } from "@/lib/availability-actions-types";
import { isoToARLocalInput, localToARIso } from "@/lib/datetime-ar";
import { roomBusyLiveLine } from "@/lib/booking-modal-state";
import {
  SLOT_QUERY_DEBOUNCE_MS,
  createSequencer,
  instantStatusView,
  sanitizeDuration,
  type InstantTone,
} from "@/lib/slot-picker-state";

export type ScheduleClassifyContext = {
  practitionerId: string | null;
  serviceId: string | null;
  patientId?: string | null;
  locationId?: string | null;
  /** Edición: el turno que se mueve no cuenta contra sí mismo. */
  excludeBookingId?: string | null;
  /**
   * SR: sala a chequear. undefined = según el horario (NO viaja: el server usa
   * la de la franja); null = "Sin sala" (no chequea ocupación); un id = esa.
   */
  roomId?: string | null;
};

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** "YYYY-MM-DDTHH:mm" completo → ISO con offset AR; si no, null. */
function localToIsoOrNull(local: string): string | null {
  if (!LOCAL_RE.test(local)) return null;
  const iso = localToARIso(local);
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

type LiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; check: InstantCheck }
  | { status: "error" };

export function ScheduleSection({
  defaultISO,
  durationMin,
  onDurationMinChange,
  slotPicker,
  value,
  onInstantChange,
  classify,
  onInstantStatus,
}: {
  /** Instante inicial (ISO) que viene de la celda clickeada en la agenda. */
  defaultISO?: string;
  durationMin: number;
  /** Recibe el valor ya acotado a 15–240 (45 si el input queda vacío). */
  onDurationMinChange: (min: number) => void;
  slotPicker?: React.ReactNode;
  value?: string | null;
  onInstantChange?: (iso: string | null) => void;
  classify?: ScheduleClassifyContext | null;
  onInstantStatus?: (c: InstantCheck | null) => void;
}) {
  const [local, setLocal] = useState(() => (defaultISO ? isoToARLocalInput(defaultISO) : ""));

  // Elegido afuera (picker) → mover la entrada manual. Si ya apunta al mismo
  // instante no se toca (evita pisar segundos/minutos fuera de la grilla de 5').
  useEffect(() => {
    if (!value) return;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return;
    setLocal((cur) => {
      const curIso = localToIsoOrNull(cur);
      if (curIso && Date.parse(curIso) === t) return cur;
      return isoToARLocalInput(value);
    });
  }, [value]);

  const onManual = (v: string) => {
    setLocal(v);
    onInstantChange?.(localToIsoOrNull(v));
  };

  // ── Aviso en vivo ──────────────────────────────────────────────────────────
  const iso = localToIsoOrNull(local);
  const pid = classify?.practitionerId && classify.practitionerId !== "any" ? classify.practitionerId : null;
  const sid = classify?.serviceId ?? null;
  const dur = sanitizeDuration(durationMin);
  // Sala en la clave: "" = según el horario (no viaja), "-" = Sin sala, o el id.
  const roomId = classify?.roomId;
  const roomKey = roomId === undefined ? "" : roomId === null ? "-" : roomId;
  const key = pid && sid && iso
    ? [pid, sid, iso, dur ?? "", classify?.patientId ?? "", classify?.locationId ?? "", classify?.excludeBookingId ?? "", roomKey].join("|")
    : null;

  const [live, setLive] = useState<LiveState>({ status: "idle" });
  const seq = useRef(createSequencer());
  const reqRef = useRef<Parameters<typeof classifyBookingInstant>[0] | null>(null);
  reqRef.current =
    pid && sid && iso
      ? {
          practitionerId: pid,
          serviceId: sid,
          scheduledFor: iso,
          durationMin: dur,
          patientId: classify?.patientId ?? null,
          locationId: classify?.locationId ?? null,
          excludeBookingId: classify?.excludeBookingId ?? null,
          // Ausente = según el horario (contrato `ClassifyInstantQuery.roomId`).
          ...(roomId !== undefined ? { roomId } : {}),
        }
      : null;
  const statusCb = useRef(onInstantStatus);
  statusCb.current = onInstantStatus;

  useEffect(() => {
    const req = reqRef.current;
    if (!key || !req) {
      seq.current.cancel();
      setLive({ status: "idle" });
      statusCb.current?.(null);
      return;
    }
    const s = seq.current;
    const n = s.next();
    setLive({ status: "loading" });
    const t = setTimeout(() => {
      classifyBookingInstant(req)
        .then((res) => {
          if (!s.isCurrent(n)) return;
          if (res.ok) {
            setLive({ status: "ok", check: res.data });
            statusCb.current?.(res.data);
          } else {
            setLive({ status: "error" });
            statusCb.current?.(null);
          }
        })
        .catch(() => {
          if (!s.isCurrent(n)) return;
          setLive({ status: "error" });
          statusCb.current?.(null);
        });
    }, SLOT_QUERY_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      s.cancel();
    };
  }, [key]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {slotPicker}
      <div className={styles.scheduleRow}>
        {/* Controlado: FormField no emite el hidden en ese modo, va abajo. */}
        <FormField
          label={slotPicker ? "Fecha y hora (o cargá a mano)" : "Fecha y hora"}
          type="datetime-local"
          required
          value={local}
          onChange={onManual}
        />
        <input type="hidden" name="scheduledFor" value={local} />
        <FormField
          label="Duración"
          tooltip="En minutos"
          name="durationMin"
          type="number"
          min={15}
          max={240}
          value={durationMin}
          onChange={(v) => onDurationMinChange(Math.max(15, Math.min(240, Number(v) || 45)))}
        />
      </div>
      {classify && <InstantStatusLine live={live} />}
    </div>
  );
}

const TONE_STYLE: Record<InstantTone, React.CSSProperties> = {
  // C-PF5.2: tokens de estado (AA) en vez del lima/rojo sueltos.
  ok: { background: "var(--success-bg)", color: "var(--success-fg)" },
  warn: { background: "var(--warn-bg)", color: "var(--warn-fg)" },
  danger: { background: "var(--danger-bg)", color: "var(--danger-fg)" },
};

function InstantStatusLine({ live }: { live: LiveState }) {
  return (
    <div role="status" aria-live="polite" style={{ minHeight: 0 }}>
      {live.status === "loading" && (
        <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Comprobando el horario…</span>
      )}
      {live.status === "error" && (
        <span style={{ fontSize: 12, color: "var(--navy-300)" }}>
          No pudimos comprobar el horario. Igual podés guardar: se valida al crear.
        </span>
      )}
      {live.status === "ok" && <InstantStatusBox check={live.check} />}
    </div>
  );
}

function InstantStatusBox({ check }: { check: InstantCheck }) {
  const view = instantStatusView(check);
  // SR-U5c: sala llena o bloqueada. Solo aviso (se puede agendar igual), así
  // que un "Libre" del profesional pasa a tono de aviso; nunca a "danger".
  const roomLine = roomBusyLiveLine(check.roomBusy);
  const tone: InstantTone = roomLine && view.tone === "ok" ? "warn" : view.tone;
  return (
    <div style={{ ...TONE_STYLE[tone], borderRadius: 8, padding: "6px 8px", fontSize: 12, lineHeight: 1.4 }}>
      <div style={{ fontWeight: 700 }}>{view.title}</div>
      {view.details.map((d) => (
        <div key={d}>{d}</div>
      ))}
      {roomLine && <div>{roomLine}</div>}
    </div>
  );
}
