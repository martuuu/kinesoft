"use client";

/**
 * WA-U2 (T6 §26.5 «UI», C-WA9 «Actions») · Sección WhatsApp del drawer del turno.
 *
 * Por qué es un chunk aparte: `/agenda` está en el tope de bundle (172,1 / 172,1 kB, §26.10) y la Secretaría abre el
 * drawer decenas de veces por día. El drawer la baja por `import()` SOLO si el consultorio manda WhatsApp
 * (`whatsapp` del loader: modo ≠ off y cuenta ACTIVE de ese modo) y el turno tiene paciente (`whatsappSectionWanted`):
 * con el modo `off` (prod hoy) nadie descarga ni el copy de WhatsApp ni las referencias a las actions.
 * `tests/unit/agenda-first-load-guard.test.ts` y `tests/unit/render/wa-u2-agenda.test.tsx` frenan un import estático.
 *
 * Qué muestra (lo decide el server en `getBookingWhatsAppPanel`; `null` = no se muestra nada: sin acceso full/admin
 * al paciente, turno ajeno o modo off):
 *   - el estado del canal del paciente (listo o el motivo del bloqueo: sin consentimiento, BAJA, celular inválido…);
 *   - la respuesta del paciente («Confirmó» / «Pidió cancelar», o que respondió a otro horario) con «Descartar aviso»;
 *   - «Enviar recordatorio por WhatsApp» (operador de agenda o el profesional del turno; 1 cada 10′ por turno);
 *   - el historial del turno: enviado, entregado, leído, falló con su etiqueta, salteado con el motivo. Nunca el número
 *     completo ni el cuerpo: el server ya manda el número enmascarado y no guarda el texto.
 *
 * La `idempotencyKey` es un UUID por instancia de la sección (AGENTS §4: por instancia de modal; el drawer la monta con
 * `key={booking.id}`): el doble clic devuelve el MISMO mensaje. Después de un envío OK se rota, así el próximo
 * recordatorio (pasado el tope de 10′) no se lee como un reintento del anterior.
 *
 * Se recarga el panel al cambiar de turno, cuando el cable trae otra respuesta (`patientReply`, que el webhook escribe
 * SIN mover `updatedAt`, WA-D22) o cuando el turno cambió (`updatedAt`), y después de cada acción.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  WA_CHANNEL_BLOCK_LABEL,
  WA_COPY,
  WA_MESSAGE_KIND_LABEL,
  WA_MESSAGE_STATUS_LABEL,
  WA_MESSAGE_TRIGGER_LABEL,
  WA_REPLY_BADGE,
  WA_SKIP_REASON_LABEL,
  waErrorLabel,
} from "@/lib/whatsapp/copy";
import type { BookingWaPanel, WaHistoryItem, WaMessageStatus, WaSkipReason } from "@/lib/whatsapp/types";
import type { ActionResult } from "@/lib/validation";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { useToast } from "@/components/ui/toast";
import { Skel } from "@/components/ui/skeleton";
import { miniGhostBtn, sectionCard } from "./styles";
import type { DrawerBooking } from "./types";

/**
 * Las actions se importan al usarlas (como `readBookingClinicalNote` del drawer): el módulo `"use server"` arrastra en
 * el server `lib/authz` (`React.cache`) y los tests que resuelven los `import()` del drawer de antemano
 * (`agenda-client.test.tsx`) no tienen por qué mockearlo. En el cliente son referencias livianas igual.
 */
const actions = () => import("@/lib/whatsapp-booking-actions");

/**
 * Copy propio de la sección. Los dos botones («Enviar recordatorio por WhatsApp», «Descartar aviso») salen de
 * `WA_COPY` desde ZF3: antes la sección tenía su copia y `WA_COPY` decía otra cosa.
 */
export const WA_SECTION_COPY = {
  channelReady: "El paciente recibe avisos de sus turnos por WhatsApp.",
  sending: "Enviando…",
  sent: "Recordatorio enviado por WhatsApp",
  queued: "El recordatorio quedó en cola: sale en unos minutos.",
  failed: "No se pudo enviar el recordatorio. Mirá el detalle en el historial.",
  dismissed: "Aviso descartado",
  otherSlot: "de otro horario",
  replyTitle: "Respuesta del paciente",
} as const;

/** El drawer monta la sección solo si el consultorio manda WhatsApp y el turno tiene paciente. Puro, para el test. */
export function whatsappSectionWanted(b: Pick<DrawerBooking, "patientId">, whatsapp: boolean): boolean {
  return whatsapp && !!b.patientId;
}

/**
 * «05/10 07:05» en hora AR. Con `lib/datetime-ar` (offset fijo) y no con `toLocaleString("es-AR")`: ICU devuelve
 * «5/10» o «05/10» según la versión (Node vs. navegador) y el test no puede fijar el formato.
 */
export function fmtWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [, mm, dd] = toARDateKey(d).split("-");
  const m = toARMinutes(d);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${dd}/${mm} ${two(Math.floor(m / 60))}:${two(m % 60)}`;
}

export type WaHistoryLine = {
  id: string;
  title: string;
  status: string;
  when: string | null;
  /** Por qué falló o no se mandó (etiqueta, nunca el error crudo de Meta). */
  detail: string | null;
  toMasked: string;
  /** El mensaje era de otro horario del turno (se movió después). */
  otherSlot: boolean;
  failed: boolean;
};

/** Momento del último estado del mensaje. */
function lastAt(m: WaHistoryItem): string | null {
  switch (m.status) {
    case "READ":
      return m.readAt ?? m.deliveredAt ?? m.sentAt;
    case "DELIVERED":
      return m.deliveredAt ?? m.sentAt;
    case "SENT":
      return m.sentAt;
    case "FAILED":
      return m.failedAt;
    default:
      return null;
  }
}

/** Una fila del historial, ya en texto. Pura. */
export function waHistoryLine(m: WaHistoryItem, currentScheduledFor: string): WaHistoryLine {
  const failed = m.status === "FAILED";
  const detail = failed
    ? waErrorLabel(m.errorCode) ?? WA_MESSAGE_STATUS_LABEL.FAILED
    : m.status === "SKIPPED" || m.status === "CANCELLED" || m.status === "EXPIRED"
      ? (m.skipReason && WA_SKIP_REASON_LABEL[m.skipReason as WaSkipReason]) || null
      : null;
  return {
    id: m.id,
    title: `${WA_MESSAGE_KIND_LABEL[m.kind] ?? m.kind} · ${WA_MESSAGE_TRIGGER_LABEL[m.trigger] ?? m.trigger}`,
    status: WA_MESSAGE_STATUS_LABEL[m.status] ?? m.status,
    when: fmtWhen(lastAt(m) ?? m.createdAt),
    detail,
    toMasked: m.toMasked,
    otherSlot:
      !!m.bookingScheduledFor && new Date(m.bookingScheduledFor).getTime() !== new Date(currentScheduledFor).getTime(),
    failed,
  };
}

/** UUID v4 por instancia (el server exige `z.string().uuid()`: un fallback que no sea UUID rebotaría). */
export function newReminderKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type ReminderData = { messageId: string; status: WaMessageStatus; reminderAvailableAt: string };
export type ReminderOutcome = { ok: true; tone: "success" | "info" | "error"; title: string } | { ok: false; error: string };

/**
 * Resultado de `sendBookingReminderNow` → lo que ve la persona. OK con estado SENT/DELIVERED/READ = salió; QUEUED o
 * SENDING = quedó en la cola (el inline no llegó en 2,5 s: lo drena el webhook o el cron); FAILED/SKIPPED/EXPIRED =
 * la cola lo rechazó con el lock tomado (el motivo queda en el historial). `ok:false` = el texto del server tal cual
 * (tope de 10′, sin consentimiento, sin permiso…).
 */
export function reminderOutcome(r: ActionResult<ReminderData>): ReminderOutcome {
  if (!r.ok) return { ok: false, error: r.error };
  const s = r.data.status;
  if (s === "SENT" || s === "DELIVERED" || s === "READ") return { ok: true, tone: "success", title: WA_SECTION_COPY.sent };
  if (s === "QUEUED" || s === "SENDING") return { ok: true, tone: "info", title: WA_SECTION_COPY.queued };
  return { ok: true, tone: "error", title: WA_SECTION_COPY.failed };
}

export async function runReminder(bookingId: string, idempotencyKey: string): Promise<ReminderOutcome> {
  return reminderOutcome(await (await actions()).sendBookingReminderNow({ bookingId, idempotencyKey }));
}

export async function runDismiss(bookingId: string): Promise<ActionResult> {
  return (await actions()).dismissPatientReply({ bookingId });
}

type SectionBooking = Pick<DrawerBooking, "id" | "status" | "scheduledFor" | "patientId" | "updatedAt"> & {
  patientReply?: string | null;
};

// ── Cuerpo (presentacional) ────────────────────────────────────────────────────────────────────────────────────

const title = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-500)",
} as const;
const muted = { fontSize: 11.5, color: "var(--navy-500)" } as const;

export function WhatsAppSectionBody({
  booking,
  panel,
  now,
  pending,
  error,
  onSend,
  onDismiss,
}: {
  booking: SectionBooking;
  panel: BookingWaPanel | null;
  now: Date;
  pending: boolean;
  error: string | null;
  onSend: () => void;
  onDismiss: () => void;
}) {
  if (!panel) return null;
  const blocked = panel.channel.state === "blocked" ? panel.channel.reason : null;
  const cooling = !!panel.reminderAvailableAt && new Date(panel.reminderAvailableAt).getTime() > now.getTime();
  // Recordatorio = turno CONFIRMED (C-WA: es lo que la cola manda); en otro estado el botón no tiene sentido.
  const showSend = panel.canSendReminder && booking.status === "CONFIRMED";
  const reply = panel.reply;
  const lines = panel.history.map((m) => waHistoryLine(m, booking.scheduledFor));
  // ZF3: 44 px de alto (target táctil; la Secretaría también usa la agenda en tablet).
  const btn = { ...miniGhostBtn, display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44 } as const;

  return (
    <section aria-label={WA_COPY.sectionTitle} data-wa-section style={{ ...sectionCard, display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gap: 2 }}>
        <div style={title}>{WA_COPY.sectionTitle}</div>
        <div style={{ fontSize: 12, color: blocked ? "var(--warn-fg)" : "var(--navy-700)" }}>
          {blocked ? WA_CHANNEL_BLOCK_LABEL[blocked] : WA_SECTION_COPY.channelReady}
        </div>
      </div>

      {reply && (
        <div data-wa-reply style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--navy-700)" }}>
          <div style={{ ...title, fontSize: 10 }}>{WA_SECTION_COPY.replyTitle}</div>
          {reply.stale ? (
            <div style={muted}>{WA_COPY.staleReply}</div>
          ) : (
            <>
              {reply.confirmedAt && (
                <div>
                  <strong>{WA_REPLY_BADGE.confirmed.text}</strong> · {fmtWhen(reply.confirmedAt)}
                </div>
              )}
              {reply.cancelRequestedAt && (
                <div>
                  <strong>{WA_REPLY_BADGE.cancelRequested.text}</strong> · {fmtWhen(reply.cancelRequestedAt)}
                </div>
              )}
            </>
          )}
          {panel.canSendReminder && (
            <div>
              <button type="button" style={btn} disabled={pending} onClick={onDismiss}>
                {WA_COPY.dismissReply}
              </button>
            </div>
          )}
        </div>
      )}

      {showSend && (
        <div style={{ display: "grid", gap: 4 }}>
          <div>
            <button type="button" style={btn} disabled={pending || !!blocked || cooling} onClick={onSend}>
              {pending ? WA_SECTION_COPY.sending : WA_COPY.sendReminder}
            </button>
          </div>
          {cooling && <div style={muted}>{WA_COPY.reminderCooldown}</div>}
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: 10, borderRadius: 10, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ ...title, fontSize: 10 }}>{WA_COPY.historyTitle}</div>
        {lines.length === 0 ? (
          <div style={muted}>{WA_COPY.historyEmpty}</div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {lines.map((l) => (
              <li key={l.id} data-wa-status={l.status} style={{ display: "grid", gap: 1, fontSize: 12, color: "var(--navy-700)" }}>
                <div>
                  {l.title}
                  {l.otherSlot && <span style={muted}> ({WA_SECTION_COPY.otherSlot})</span>}
                </div>
                <div style={muted}>
                  <strong style={{ color: l.failed ? "var(--warn-fg)" : undefined }}>{l.status}</strong>
                  {l.when && ` · ${l.when}`} · {l.toMasked}
                </div>
                {l.detail && <div style={muted}>{l.detail}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Contenedor (carga y acciones) ──────────────────────────────────────────────────────────────────────────────

export function WhatsAppSection({ booking }: { booking: SectionBooking }) {
  const toast = useToast();
  const [state, setState] = useState<{ id: string; panel: BookingWaPanel | null } | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const keyRef = useRef<string | null>(null);
  const bookingId = booking.id;

  const load = useCallback(
    (alive: () => boolean = () => true) =>
      actions()
        .then((m) => m.getBookingWhatsAppPanel(bookingId))
        .then((panel) => alive() && setState({ id: bookingId, panel }))
        // Sesión vencida o red caída: la sección no se muestra (el resto del drawer sigue andando); sin toast, no es
        // algo que la persona hizo.
        .catch(() => alive() && setState({ id: bookingId, panel: null })),
    [bookingId]
  );

  useEffect(() => {
    let on = true;
    void load(() => on);
    return () => {
      on = false;
    };
    // `patientReply` y `updatedAt`: el cable trajo otra respuesta o el turno cambió → el panel ya no vale.
  }, [load, booking.patientReply, booking.updatedAt]);

  if (state === "loading" || state.id !== bookingId) {
    return <Skel h={72} r={14} />;
  }

  const send = () =>
    start(async () => {
      setError(null);
      keyRef.current ??= newReminderKey();
      const r = await runReminder(bookingId, keyRef.current);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      keyRef.current = null;
      if (r.tone === "success") toast.success(r.title);
      else if (r.tone === "info") toast.info(r.title);
      else toast.error(r.title);
      await load();
    });

  const dismiss = () =>
    start(async () => {
      setError(null);
      const r = await runDismiss(bookingId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(WA_SECTION_COPY.dismissed);
      await load();
    });

  return (
    <WhatsAppSectionBody
      booking={booking}
      panel={state.panel}
      now={new Date()}
      pending={pending}
      error={error}
      onSend={send}
      onDismiss={dismiss}
    />
  );
}
