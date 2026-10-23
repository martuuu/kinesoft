/**
 * [WA-U2] T6 (§26.5 «UI», WA-D21) · WhatsApp en la agenda: el mini-badge «Confirmó» / «Pidió cancelar» de la card y la
 * sección WhatsApp del drawer del turno (diferida por `import()`, solo con `whatsapp`).
 *
 * Render real (sin jsdom, como el resto de `tests/unit/render`): se afirma el markup. Se mockean solo las server
 * actions (red/DB) y el toast. Los efectos no corren en el render de servidor: el cuerpo de la sección
 * (`WhatsAppSectionBody`) es presentacional y recibe el panel; la carga y las acciones se testean contra las actions
 * mockeadas como espías llamando a los helpers que usan los handlers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const spy = vi.hoisted(() => ({
  panel: [] as unknown[],
  reminder: [] as unknown[],
  dismiss: [] as unknown[],
  reminderResult: { ok: true, data: { messageId: "m9", status: "SENT", reminderAvailableAt: "2026-10-05T11:10:00.000Z" } } as unknown,
}));
vi.mock("@/lib/whatsapp-booking-actions", () => ({
  getBookingWhatsAppPanel: async (id: string) => {
    spy.panel.push(id);
    return null;
  },
  sendBookingReminderNow: async (input: unknown) => {
    spy.reminder.push(input);
    return spy.reminderResult;
  },
  dismissPatientReply: async (input: unknown) => {
    spy.dismiss.push(input);
    return { ok: true, data: undefined };
  },
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { BookingCard, cardReplyBadge, type BookingCardSizing } from "@/components/agenda/grid/booking-card";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import {
  WA_SECTION_COPY,
  WhatsAppSectionBody,
  newReminderKey,
  reminderOutcome,
  runDismiss,
  runReminder,
  waHistoryLine,
  whatsappSectionWanted,
} from "@/components/agenda/booking-drawer/whatsapp-section";
import { WA_CHANNEL_BLOCK_LABEL, WA_COPY, WA_REPLY_BADGE, WA_SKIP_REASON_LABEL, waErrorLabel } from "@/lib/whatsapp/copy";
import type { BookingWaPanel, WaHistoryItem } from "@/lib/whatsapp/types";
import type { PatientReply } from "@/lib/bookings-types";

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T08:00:00-03:00`);
const SIZING: BookingCardSizing = { flexBasis: 200 };
const noop = () => {};

const B: BookingDTO = {
  id: "b1",
  scheduledFor: iso("10:00"),
  durationMin: 45,
  status: "CONFIRMED",
  serviceId: "s-kine",
  serviceName: "Kinesiología",
  serviceColor: "#3d74b5",
  practitionerId: "p1",
  patientId: "pat",
  patientName: "Juana Gómez",
  patientCondition: null,
  obraSocial: "Particular",
  copagoCents: 2_000_000,
  updatedAt: iso("07:00"),
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
  isOverbooked: false,
};
const withReply = (r: PatientReply) => ({ ...B, patientReply: r }) as BookingDTO;
const card = (b: BookingDTO) =>
  renderToStaticMarkup(<BookingCard b={b} onEdit={noop} highlight={null} compact sizing={SIZING} now={NOW} />);
const badgeTag = (html: string, key: string) => {
  const at = html.indexOf(`data-badge="${key}"`);
  expect(at, `sin data-badge="${key}"`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<span", at);
  return html.slice(open, html.indexOf("</span>", at) + 7);
};
const rootStyle = (html: string) => /^<button[^>]*style="([^"]*)"/.exec(html)![1];

describe("[WA-U2] BookingCard: badge «Confirmó» / «Pidió cancelar»", () => {
  it("[WA-U2] sin `patientReply`: la card queda con los mismos nodos (sin badge)", () => {
    const html = card(B);
    expect(html).not.toMatch(/data-badge="wa-/);
    expect(html).not.toContain("WhatsApp");
  });

  it("[WA-U2] «Confirmó»: texto visible + aria-label completo (role=img), sin relleno", () => {
    const tag = badgeTag(card(withReply("confirmed")), "wa-ok");
    expect(tag).toContain('role="img"');
    expect(tag).toContain(`aria-label="${WA_REPLY_BADGE.confirmed.ariaLabel}"`);
    expect(tag).toMatch(new RegExp(`>${WA_REPLY_BADGE.confirmed.text}</span>$`));
    expect(tag).not.toMatch(/background/);
  });

  it("[WA-U2] «Pidió cancelar»: texto visible + aria-label completo", () => {
    const tag = badgeTag(card(withReply("cancel_requested")), "wa-no");
    expect(tag).toContain(`aria-label="${WA_REPLY_BADGE.cancelRequested.ariaLabel}"`);
    expect(tag).toMatch(new RegExp(`>${WA_REPLY_BADGE.cancelRequested.text}</span>$`));
  });

  it("[WA-U2] canal no cromático: el fondo y la barra (estilo del botón raíz) no cambian con la respuesta", () => {
    const base = rootStyle(card(B));
    expect(rootStyle(card(withReply("confirmed")))).toBe(base);
    expect(rootStyle(card(withReply("cancel_requested")))).toBe(base);
  });

  it("[WA-U2] paridad: los literales copiados en la card son los de `WA_REPLY_BADGE`", () => {
    expect(cardReplyBadge("confirmed")?.slice(1)).toEqual([WA_REPLY_BADGE.confirmed.text, WA_REPLY_BADGE.confirmed.ariaLabel]);
    expect(cardReplyBadge("cancel_requested")?.slice(1)).toEqual([
      WA_REPLY_BADGE.cancelRequested.text,
      WA_REPLY_BADGE.cancelRequested.ariaLabel,
    ]);
    expect(cardReplyBadge(undefined)).toBeNull();
    expect(cardReplyBadge("otra" as PatientReply)).toBeNull();
  });
});

// ── Drawer: sección WhatsApp ───────────────────────────────────────────────────────────────────────────────────

const item = (over: Partial<WaHistoryItem> = {}): WaHistoryItem => ({
  id: "m1",
  kind: "BOOKING_REMINDER",
  trigger: "CRON",
  status: "SENT",
  toMasked: "+54 9 11 •••• 5678",
  bookingScheduledFor: B.scheduledFor,
  seriesCount: null,
  errorCode: null,
  skipReason: null,
  createdAt: iso("07:00"),
  sentAt: iso("07:01"),
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  ...over,
});
const panel = (over: Partial<BookingWaPanel> = {}): BookingWaPanel => ({
  channel: { state: "ready" },
  history: [],
  reply: null,
  canSendReminder: true,
  reminderAvailableAt: null,
  ...over,
});
const body = (p: BookingWaPanel | null, o: { error?: string | null; pending?: boolean; booking?: Partial<BookingDTO> } = {}) =>
  renderToStaticMarkup(
    <WhatsAppSectionBody
      booking={{ ...B, ...o.booking }}
      panel={p}
      now={NOW}
      pending={o.pending ?? false}
      error={o.error ?? null}
      onSend={noop}
      onDismiss={noop}
    />
  );

describe("[WA-U2] drawer: cuándo se monta la sección", () => {
  it("[WA-U2] solo con `whatsapp` y un turno con paciente", () => {
    expect(whatsappSectionWanted(B, false)).toBe(false);
    expect(whatsappSectionWanted({ ...B, patientId: null }, true)).toBe(false);
    expect(whatsappSectionWanted(B, true)).toBe(true);
  });

  it("[WA-U2] la sección baja SOLO por `import()` desde el drawer (nunca estática)", () => {
    const src = readFileSync(resolve(process.cwd(), "components/agenda/booking-drawer/index.tsx"), "utf8");
    expect(src).toMatch(/import\(\s*["']\.\/whatsapp-section["']\s*\)/);
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+["']\.\/whatsapp-section["']/m);
    // `ShareActions` (el wa.me manual) queda igual: `recepcion.spec.ts` lo prueba.
    expect(src).toContain("<ShareActions booking={booking} />");
  });
});

describe("[WA-U2] drawer: cuerpo de la sección WhatsApp", () => {
  it("[WA-U2] panel null (sin acceso / modo off): no renderiza nada", () => {
    expect(body(null)).toBe("");
  });

  it("[WA-U2] canal listo: botón «Enviar recordatorio por WhatsApp» habilitado e historial vacío", () => {
    const html = body(panel());
    expect(html).toContain(WA_SECTION_COPY.channelReady);
    expect(html).toContain(WA_SECTION_COPY.sendReminder);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Enviar recordatorio/);
    expect(html).toContain(WA_COPY.historyEmpty);
  });

  it("[WA-U2] canal bloqueado: el motivo con su etiqueta y el botón deshabilitado", () => {
    const html = body(panel({ channel: { state: "blocked", reason: "no_consent" } }));
    expect(html).toContain(WA_CHANNEL_BLOCK_LABEL.no_consent);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Enviar recordatorio/);
  });

  it("[WA-U2] tope de 1 cada 10′: con `reminderAvailableAt` futuro, deshabilitado con el copy del tope", () => {
    const html = body(panel({ reminderAvailableAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Enviar recordatorio/);
    expect(html).toContain(WA_COPY.reminderCooldown);
    // Vencido el tope, vuelve a estar habilitado.
    const later = body(panel({ reminderAvailableAt: new Date(NOW.getTime() - 1).toISOString() }));
    expect(later).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Enviar recordatorio/);
  });

  it("[WA-U2] sin permiso para mandar (Facturación) o turno no confirmado: no hay botón", () => {
    expect(body(panel({ canSendReminder: false }))).not.toContain(WA_SECTION_COPY.sendReminder);
    expect(body(panel(), { booking: { status: "PENDING" } })).not.toContain(WA_SECTION_COPY.sendReminder);
  });

  it("[WA-U2] historial: enviado, entregado, leído y falló con su etiqueta; salteado con el motivo", () => {
    const html = body(
      panel({
        history: [
          item({ id: "a", status: "SENT" }),
          item({ id: "b", status: "DELIVERED", deliveredAt: iso("07:02") }),
          item({ id: "c", status: "READ", deliveredAt: iso("07:02"), readAt: iso("07:05") }),
          item({ id: "d", status: "FAILED", failedAt: iso("07:03"), errorCode: "recipient:131026" }),
          item({ id: "e", status: "SKIPPED", sentAt: null, skipReason: "no_consent" }),
        ],
      })
    );
    for (const t of ["Enviado", "Entregado", "Leído", "No se pudo enviar", "No se envió"]) expect(html).toContain(t);
    expect(html).toContain(waErrorLabel("recipient:131026")!);
    expect(html).toContain(WA_SKIP_REASON_LABEL.no_consent);
    // Nunca el número completo: solo el enmascarado que manda el server.
    expect(html).toContain("•••• 5678");
  });

  it("[WA-U2] línea del historial: hora AR del último estado y aviso de otro horario", () => {
    const l = waHistoryLine(item({ status: "READ", readAt: iso("07:05") }), B.scheduledFor);
    expect(l.status).toBe("Leído");
    expect(l.when).toBe("05/10 07:05");
    expect(l.detail).toBeNull();
    const old = waHistoryLine(item({ bookingScheduledFor: iso("09:00") }), B.scheduledFor);
    expect(old.otherSlot).toBe(true);
    const fail = waHistoryLine(item({ status: "FAILED", failedAt: iso("07:03"), errorCode: "timeout" }), B.scheduledFor);
    expect(fail.detail).toBe(waErrorLabel("timeout"));
  });

  it("[WA-U2] respuesta vigente: «Confirmó» / «Pidió cancelar» con hora y «Descartar aviso»", () => {
    const html = body(
      panel({ reply: { confirmedAt: null, cancelRequestedAt: iso("07:30"), replyFor: B.scheduledFor, stale: false } })
    );
    expect(html).toContain(WA_REPLY_BADGE.cancelRequested.text);
    expect(html).toContain("05/10 07:30");
    expect(html).toContain(WA_SECTION_COPY.dismiss);
    const ok = body(panel({ reply: { confirmedAt: iso("07:10"), cancelRequestedAt: null, replyFor: B.scheduledFor, stale: false } }));
    expect(ok).toContain(WA_REPLY_BADGE.confirmed.text);
  });

  it("[WA-U2] respuesta a otro horario: el aviso de `staleReply` y se puede descartar igual", () => {
    const html = body(panel({ reply: { confirmedAt: iso("07:10"), cancelRequestedAt: null, replyFor: iso("09:00"), stale: true } }));
    expect(html).toContain(WA_COPY.staleReply);
    expect(html).toContain(WA_SECTION_COPY.dismiss);
  });

  it("[WA-U2] sin permiso para operar: la respuesta se ve pero no hay «Descartar aviso»", () => {
    const html = body(
      panel({
        canSendReminder: false,
        reply: { confirmedAt: iso("07:10"), cancelRequestedAt: null, replyFor: B.scheduledFor, stale: false },
      })
    );
    expect(html).toContain(WA_REPLY_BADGE.confirmed.text);
    expect(html).not.toContain(WA_SECTION_COPY.dismiss);
  });

  it("[WA-U2] error de la action: se muestra en un role=alert", () => {
    expect(body(panel(), { error: WA_COPY.reminderCooldown })).toMatch(/role="alert"[^>]*>[^<]*Ya se mandó un recordatorio/);
  });
});

describe("[WA-U2] drawer: acciones (contra las actions mockeadas)", () => {
  beforeEach(() => {
    spy.reminder.length = 0;
    spy.dismiss.length = 0;
  });

  it("[WA-U2] la key del recordatorio es un UUID (el server exige `z.string().uuid()`)", () => {
    const a = newReminderKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newReminderKey()).not.toBe(a);
  });

  it("[WA-U2] runReminder manda `{ bookingId, idempotencyKey }` y traduce el resultado", async () => {
    const r = await runReminder("b1", "11111111-1111-4111-8111-111111111111");
    expect(spy.reminder).toEqual([{ bookingId: "b1", idempotencyKey: "11111111-1111-4111-8111-111111111111" }]);
    expect(r).toEqual({ ok: true, tone: "success", title: WA_SECTION_COPY.sent });
  });

  it("[WA-U2] resultado del recordatorio: en cola, falló, salteado y error del server", () => {
    const ok = (status: string) => ({ ok: true as const, data: { messageId: "m", status: status as never, reminderAvailableAt: "x" } });
    expect(reminderOutcome(ok("DELIVERED"))).toEqual({ ok: true, tone: "success", title: WA_SECTION_COPY.sent });
    expect(reminderOutcome(ok("QUEUED"))).toEqual({ ok: true, tone: "info", title: WA_SECTION_COPY.queued });
    expect(reminderOutcome(ok("FAILED"))).toEqual({ ok: true, tone: "error", title: WA_SECTION_COPY.failed });
    expect(reminderOutcome(ok("SKIPPED"))).toEqual({ ok: true, tone: "error", title: WA_SECTION_COPY.failed });
    expect(reminderOutcome({ ok: false, error: WA_COPY.reminderCooldown })).toEqual({ ok: false, error: WA_COPY.reminderCooldown });
  });

  it("[WA-U2] runDismiss manda `{ bookingId }`", async () => {
    expect(await runDismiss("b1")).toEqual({ ok: true, data: undefined });
    expect(spy.dismiss).toEqual([{ bookingId: "b1" }]);
  });
});
