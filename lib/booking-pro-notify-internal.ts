import "server-only";
// Sin Actor (turnero anónimo y webhook de Mercado Pago) → canal service (BYPASSRLS). `tenantId` a mano en cada where.
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (ver `lib/email/log.ts`: cada emisor lo importa junto con `sendEmail`).
import "@/lib/email/log";
import { bookingCreatedProEmail } from "@/lib/email/templates-bookings";
import { bookingAgendaUrl, bookingPushPayload, bookingWhenAR, patientShortName } from "@/lib/booking-pro-notify-logic";
// No arrastra `web-push`: el sender lo carga con `import()` solo si hay VAPID y dispositivos.
import { sendPushToUser } from "@/lib/web-push-internal";

/**
 * [CF2 · T-S1] Aviso al PROFESIONAL DEL TURNO cuando entra un turno online (plan §29, D-CF2-11; brief T.C).
 *
 * Quién lo llama y cuándo:
 *   • `submitPublicBooking` (`lib/public-booking.ts`), DESPUÉS del commit que dejó el turno CONFIRMED (alta sin cobro,
 *     OPTIONAL «Pagar ahora» o promoción de un PENDING legado). Nunca en un replay ni con REQUIRED sin pagar.
 *   • El webhook de Mercado Pago cuando el pago confirma un REQUIRED (otra sesión, W4).
 *   • NUNCA un turno cargado por el staff (D-CF2-20: esos solo dejan la campana). Por eso además se exige la key del
 *     turnero (`pub:`): un caller nuevo que lo llame con un turno de la agenda no manda nada.
 *
 * Contrato con el caller:
 *   • Nunca tira: corre con la reserva ya escrita; un Resend o un push service caído no puede volverla un error.
 *   • Tope de `PRO_NOTIFY_TIMEOUT_MS` en total: el caller lo ESPERA antes de responder (Vercel corta las promesas
 *     sueltas al devolver la respuesta y Next 14.2 no tiene `after()`), así que su latencia la paga el paciente en la
 *     pantalla de «Turno reservado». Mail y push van en paralelo; a los 3 s se devuelve `timeout` y lo que siga en vuelo
 *     se abandona (el sink de EmailLog lo registra igual si termina).
 *   • Con `hint.prefs` y los dos canales apagados (el default de M21: nacen apagados) vuelve SIN tocar la base: el
 *     submit ya leyó las preferencias en la lectura del profesional que hacía siempre, así el turnero no paga ni una
 *     sentencia por una función que casi nadie prende.
 *   • Sin hint (webhook): una lectura (turno + profesional + usuario + membresía activa + consultorio + sede + paciente).
 *     Lo que decide es la base, no el hint: si el profesional apagó los avisos entre la lectura y esta, no se manda.
 *
 * Log `booking.pro_notify`: solo ids y resultados por canal. Nada del paciente (nombre, DNI, teléfono), ni el email del
 * profesional (el de `sendEmail` ya va enmascarado), ni el endpoint del push.
 */

export const PRO_NOTIFY_TIMEOUT_MS = 3000;

export type ProNotifyOutcome = {
  /** off = no se miró (hint con los dos apagados); skipped = se miró y no correspondía; done = se intentó; timeout/error. */
  status: "off" | "skipped" | "done" | "timeout" | "error";
  reason?: "not-found" | "not-online" | "inactive-member" | "channels-off";
  email: "off" | "sent" | "skipped" | "failed" | "pending";
  push: "off" | "sent" | "none" | "failed" | "pending";
};

const OFF: ProNotifyOutcome = { status: "off", email: "off", push: "off" };

/** Membresía usable en ESTE consultorio: mismo criterio que `ACTIVE_MEMBER` de `notifyTenantOwners` (HD-12). */
function activeMemberWhere(tenantId: string) {
  return { tenantId, disabledAt: null, acceptedAt: { not: null } } as const;
}

async function run(tenantId: string, bookingId: string): Promise<ProNotifyOutcome> {
  const b = await prismaService.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: {
      status: true,
      idempotencyKey: true,
      scheduledFor: true,
      durationMin: true,
      patient: { select: { firstName: true, lastName: true } },
      location: { select: { name: true } },
      tenant: { select: { name: true } },
      practitioner: {
        select: {
          tenantId: true,
          userId: true,
          notifyBookingEmail: true,
          notifyBookingPush: true,
          user: {
            select: {
              email: true,
              disabledAt: true,
              memberships: { where: activeMemberWhere(tenantId), select: { id: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!b) return { status: "skipped", reason: "not-found", email: "off", push: "off" };
  // Solo turnos ONLINE ya confirmados: REQUIRED sin pagar (PENDING) lo avisa el webhook al confirmarse; un CANCELLED
  // entre el commit y acá no se avisa; un turno del staff no lleva la key del turnero (D-CF2-20).
  if (b.status !== "CONFIRMED" || !b.idempotencyKey.startsWith("pub:")) {
    return { status: "skipped", reason: "not-online", email: "off", push: "off" };
  }
  const p = b.practitioner;
  const wantEmail = p.notifyBookingEmail;
  const wantPush = p.notifyBookingPush;
  if (!wantEmail && !wantPush) return { status: "skipped", reason: "channels-off", email: "off", push: "off" };
  // Suspendido, invitación sin aceptar, usuario deshabilitado en Plataforma o profesional de otro consultorio (las FK
  // saltean RLS): ya no entra a este consultorio, el aviso no le corresponde.
  if (p.tenantId !== tenantId || p.user.disabledAt || p.user.memberships.length === 0) {
    return { status: "skipped", reason: "inactive-member", email: "off", push: "off" };
  }

  const tenantName = b.tenant.name;
  const { dayKey } = bookingWhenAR(b.scheduledFor);

  const mail = async (): Promise<ProNotifyOutcome["email"]> => {
    if (!wantEmail) return "off";
    const url = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${bookingAgendaUrl(dayKey)}`;
    const r = await sendEmail({
      ...bookingCreatedProEmail({
        tenantName,
        patientShort: patientShortName(b.patient?.firstName, b.patient?.lastName),
        scheduledFor: b.scheduledFor,
        durationMin: b.durationMin,
        locationName: b.location?.name ?? null,
        url,
      }),
      kind: "booking_created_pro",
      to: p.user.email,
      tenantId,
      entity: "Booking",
      entityId: bookingId,
      fromName: tenantName,
    });
    if (r.ok) return "sent";
    return r.skipped ? "skipped" : "failed";
  };
  const push = async (): Promise<ProNotifyOutcome["push"]> => {
    if (!wantPush) return "off";
    const r = await sendPushToUser(p.userId, bookingPushPayload({ tenantName, scheduledFor: b.scheduledFor, bookingId }));
    return r.sent > 0 ? "sent" : r.failed > 0 ? "failed" : "none";
  };
  // `allSettled`: `sendEmail` y `sendPushToUser` no tiran por contrato, pero un canal roto no se lleva puesto al otro.
  const [e, x] = await Promise.allSettled([mail(), push()]);
  return {
    status: "done",
    email: e.status === "fulfilled" ? e.value : "failed",
    push: x.status === "fulfilled" ? x.value : "failed",
  };
}

export async function notifyPractitionerOfOnlineBooking(
  tenantId: string,
  bookingId: string,
  hint?: { prefs?: { userId: string; email: boolean; push: boolean } }
): Promise<ProNotifyOutcome> {
  if (hint?.prefs && !hint.prefs.email && !hint.prefs.push) return { ...OFF };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ProNotifyOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout", email: "pending", push: "pending" }), PRO_NOTIFY_TIMEOUT_MS);
    });
    const out = await Promise.race([
      run(tenantId, bookingId).catch(
        (err): ProNotifyOutcome => {
          // Solo el nombre del error: el mensaje de Prisma puede citar valores de la fila.
          logger.warn("booking.pro_notify_error", { tenantId, bookingId, error: err instanceof Error ? err.name : "unknown" });
          return { status: "error", email: "failed", push: "failed" };
        }
      ),
      timeout,
    ]);
    const bad = out.status === "timeout" || out.status === "error" || out.email === "failed" || out.push === "failed";
    try {
      logger[bad ? "warn" : "info"]("booking.pro_notify", { tenantId, bookingId, ...out });
    } catch {
      // Loguear nunca rompe la reserva.
    }
    return out;
  } catch {
    return { status: "error", email: "failed", push: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
