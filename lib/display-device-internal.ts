import "server-only";
/**
 * TV (T7 · TV-2d, contrato C-TV «Sesión y feed del dispositivo», plan §26.4; M17): la sesión de la PANTALLA de la sala
 * y su feed. Superficie SIN Actor: la identidad es la cookie `kine_tv` (`v1.<id>.<secreto>.<día>`, path `/tv`) y todo
 * va por `prismaService` (BYPASSRLS) con `id` + `tenantId` a mano. Como en prod esa conexión salta RLS, lo que aísla a
 * un consultorio de otro es este archivo: el `tenantId` sale SIEMPRE de la fila de la pantalla (nunca del cliente) y
 * cada lectura posterior lo lleva en el `where`.
 *
 * Lo usan `lib/display-device.ts` (actions de la TV), `lib/realtime-display-token.ts` (token del canal) y la página
 * `/tv` (vinculada → `<TvScreen>`, si no → `<TvPairScreen>`).
 *
 * Orden de `resolveDisplaySession` (C-TV): cookie (zod + formato) → fila por id → no revocada → secreto en tiempo
 * constante → acceso del consultorio abierto (`publicSurfacesOpenFor`, modo efectivo) → módulo `salaEspera` con los
 * grants/revokes de Plataforma (M12). DESVÍO del orden literal («hash → no revocada»): M17 obliga a que una pantalla
 * revocada no tenga `deviceSecretHash` (CHECK `_revoked_check`), así que con el hash primero el estado `revoked` era
 * inalcanzable y la TV mostraba «Vinculá esta pantalla» en vez de «Esta pantalla se desvinculó». Mirar `revokedAt`
 * antes del secreto solo le dice «revocada» a quien ya tiene el id (un cuid de la cookie de esa TV): no abre nada.
 *
 * Escrituras del dispositivo (`touchDisplaySeen`, y el vínculo en `display-device.ts`) van por SQL crudo a propósito:
 * `ReceptionDisplay.updatedAt` es `@updatedAt`, y Prisma lo pisa en cada `update`/`updateMany`. Ese `updatedAt` es el
 * CAS del drawer «Pantallas» (`updateReceptionDisplay` con `expectedUpdatedAt`): si el latido de la TV lo moviera cada
 * minuto, editar una pantalla prendida daría «otro cambio en el medio» casi siempre.
 */
import { z } from "zod";
import { cookies } from "next/headers";
import { prismaService as prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toARDateKey } from "@/lib/datetime-ar";
import { arDayStart } from "@/lib/time-blocks-window";
import { TENANT_ACCESS_SELECT } from "@/lib/tenant-access";
import { publicSurfacesOpenFor } from "@/lib/public-booking-internal";
import { modulesFor, parseModuleOverrides } from "@/lib/tenant-modules";
import { publicPractitionerName } from "@/lib/display-name";
import { buildDisplayFeed, finalizeDisplayFeed, type DisplayFeedRow } from "@/lib/display-feed-state";
import { parseDisplayCookie, secretMatches, type DisplayCookie } from "@/lib/display-pairing-internal";
import {
  DISPLAY_COOKIE,
  DISPLAY_COOKIE_RENEW_AFTER_DAYS,
  type DisplayConfig,
  type DisplayFeed,
} from "@/lib/reception-displays-types";
import type { RealtimeBootstrap } from "@/lib/realtime-events";

export type PairedDisplaySession = {
  state: "paired";
  displayId: string;
  /** De la FILA de la pantalla: nunca de algo que mande el cliente. */
  tenantId: string;
  /** Sede elegida; `null` = todo el consultorio. */
  locationId: string | null;
  /** La sede elegida es la principal → también ve los turnos sin sede (`Booking.locationId` null = principal). */
  isPrimaryLocation: boolean;
  clinicName: string;
  locationName: string | null;
  config: DisplayConfig;
  /** La cookie se emitió hace más de `DISPLAY_COOKIE_RENEW_AFTER_DAYS`: la action que pueda escribir cookies la renueva. */
  renewCookie: boolean;
};

/**
 * `unavailable.reason` es solo para el log del mint (`realtime-display-token.ts`); la TV recibe el estado pelado
 * (`DeviceFeedResult` no distingue suspendido de módulo apagado: para la sala es lo mismo).
 */
export type DisplaySession =
  | PairedDisplaySession
  | { state: "unpaired" | "revoked" }
  | { state: "unavailable"; reason: "access_closed" | "no_module" };

/** La cookie cruda: string acotado (lo que no es nuestro formato lo descarta `parseDisplayCookie`, que nunca tira). */
const CookieSchema = z.string().min(1).max(128);

/** Cookie de la TV parseada, sin tocar la base (sirve para el rate limit por pantalla antes de leer nada). */
export function readDisplayCookie(): DisplayCookie | null {
  const parsed = CookieSchema.safeParse(cookies().get(DISPLAY_COOKIE)?.value);
  return parsed.success ? parseDisplayCookie(parsed.data) : null;
}

const DAY_MS = 86_400_000;

/** ¿Pasaron ≥ 30 días AR desde el día de emisión? Día inválido o futuro (reloj de la TV no importa: es el del server) → no. */
function shouldRenew(issuedDay: string, now: Date): boolean {
  const issued = arDayStart(issuedDay).getTime();
  const today = arDayStart(toARDateKey(now)).getTime();
  if (!Number.isFinite(issued)) return false;
  return Math.round((today - issued) / DAY_MS) >= DISPLAY_COOKIE_RENEW_AFTER_DAYS;
}

export async function resolveDisplaySession(now: Date = new Date()): Promise<DisplaySession> {
  const c = readDisplayCookie();
  if (!c) return { state: "unpaired" };

  const row = await prisma.receptionDisplay.findUnique({
    where: { id: c.id },
    select: {
      id: true,
      tenantId: true,
      locationId: true,
      nameMode: true,
      theme: true,
      mediaKind: true,
      mediaRef: true,
      mediaLayout: true,
      mediaMuted: true,
      mediaDuringCall: true,
      deviceSecretHash: true,
      revokedAt: true,
      location: { select: { name: true, isPrimary: true, tenantId: true } },
      tenant: {
        select: {
          name: true,
          vertical: true,
          saasPlan: true,
          publicBookingEnabled: true,
          moduleGrants: true,
          moduleRevokes: true,
          ...TENANT_ACCESS_SELECT,
        },
      },
    },
  });
  if (!row) return { state: "unpaired" };
  if (row.revokedAt) return { state: "revoked" };
  if (!secretMatches(c.secret, row.deviceSecretHash)) return { state: "unpaired" };

  const t = row.tenant;
  if (!publicSurfacesOpenFor(t, now)) return { state: "unavailable", reason: "access_closed" };
  const modules = modulesFor({
    vertical: t.vertical,
    plan: t.saasPlan,
    publicBookingEnabled: t.publicBookingEnabled,
    ...parseModuleOverrides(t),
  });
  if (!modules.has("salaEspera")) return { state: "unavailable", reason: "no_module" };

  // La FK compuesta de M17 ya garantiza que la sede es de este consultorio; el chequeo es la segunda barrera (la FK
  // es drift: si un `migrate diff` la borrara, una sede ajena no filtraría turnos de otro tenant porque el `where` del
  // feed igual lleva `tenantId`, pero el nombre de la sede sí saldría).
  const location = row.location && row.location.tenantId === row.tenantId ? row.location : null;

  return {
    state: "paired",
    displayId: row.id,
    tenantId: row.tenantId,
    locationId: location ? row.locationId : null,
    isPrimaryLocation: location?.isPrimary ?? false,
    clinicName: t.name,
    locationName: location?.name ?? null,
    config: {
      nameMode: row.nameMode,
      theme: row.theme,
      mediaKind: row.mediaKind,
      mediaRef: row.mediaRef,
      mediaLayout: row.mediaLayout,
      mediaMuted: row.mediaMuted,
      mediaDuringCall: row.mediaDuringCall,
    },
    renewCookie: shouldRenew(c.issuedDay, now),
  };
}

/**
 * Tope de filas del día: una sala con más de 300 llegadas en un día no existe; el tope solo evita que un dato roto
 * (un import masivo con `arrivedAt`) arme un feed enorme cada 15 s por TV.
 */
const FEED_ROWS_MAX = 300;

/**
 * Feed de la pantalla. Día AR (00:00-24:00 `-03:00`; Argentina no tiene horario de verano, así que el día dura 24 h
 * exactas), turnos con `arrivedAt`, no CANCELLED, de la sede elegida (la principal también ve los sin sede).
 *
 * PHI: el select es el mínimo para el feed. Se lee el nombre y el apellido del paciente porque `shortPatientName`
 * necesita la inicial, pero sale solo «María G.»; nunca se seleccionan DNI, teléfono, servicio, notas, email ni el
 * paciente/turno más allá de su id (que `buildDisplayFeed` convierte en una `key` opaca). La salida pasa por
 * `DisplayFeedSchema` strict (`finalizeDisplayFeed`).
 */
export async function loadDisplayFeed(s: PairedDisplaySession, now: Date): Promise<DisplayFeed> {
  const dayStart = arDayStart(toARDateKey(now));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const locationWhere = !s.locationId
    ? {}
    : s.isPrimaryLocation
      ? { OR: [{ locationId: s.locationId }, { locationId: null }] }
      : { locationId: s.locationId };

  const rows = await prisma.booking.findMany({
    where: {
      tenantId: s.tenantId,
      scheduledFor: { gte: dayStart, lt: dayEnd },
      arrivedAt: { not: null },
      status: { not: "CANCELLED" },
      ...locationWhere,
    },
    select: {
      id: true,
      scheduledFor: true,
      status: true,
      guestName: true,
      arrivedAt: true,
      calledAt: true,
      attendingAt: true,
      patient: { select: { firstName: true, lastName: true } },
      room: { select: { name: true } },
      practitioner: { select: { user: { select: { fullName: true } } } },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: FEED_ROWS_MAX,
  });

  const feedRows: DisplayFeedRow[] = rows.map((b) => ({
    bookingId: b.id,
    startTime: b.scheduledFor,
    status: b.status,
    patientName: b.patient ? `${b.patient.firstName} ${b.patient.lastName}`.trim() : null,
    guestName: b.guestName,
    arrivedAt: b.arrivedAt,
    calledAt: b.calledAt,
    attendingAt: b.attendingAt,
    room: b.room?.name ?? null,
    practitioner: publicPractitionerName(b.practitioner.user.fullName),
  }));

  return finalizeDisplayFeed(
    { now, clinicName: s.clinicName, locationName: s.locationName, config: s.config },
    buildDisplayFeed(feedRows, { nameMode: s.config.nameMode, now })
  );
}

/** Latido: a lo sumo una escritura por minuto (la TV pide cada 15 s; «En línea» es una ventana de 3 min). */
const SEEN_THROTTLE_MS = 60_000;

/**
 * `lastSeenAt = now` si pasó más de un minuto desde el último (o nunca se vio). `true` si escribió. SQL crudo para no
 * mover `updatedAt` (ver cabecera). La condición va en el UPDATE, no en un read previo: dos polls simultáneos no
 * escriben dos veces.
 */
export async function touchDisplaySeen(s: PairedDisplaySession, now: Date): Promise<boolean> {
  const threshold = new Date(now.getTime() - SEEN_THROTTLE_MS);
  const n = await prisma.$executeRaw`
    UPDATE "ReceptionDisplay" SET "lastSeenAt" = ${now}
    WHERE "id" = ${s.displayId} AND "tenantId" = ${s.tenantId} AND "revokedAt" IS NULL
      AND ("lastSeenAt" IS NULL OR "lastSeenAt" < ${threshold})`;
  return n === 1;
}

/**
 * Bootstrap del canal para la TV: como `realtimeBootstrap` (lib/realtime-bootstrap.ts) pero sin Actor (la sesión ya
 * pasó acceso y módulo). D13: con el driver `local` la TV SOLO hace polling (`off`): el SSE local vive en
 * `/api/realtime/local`, que exige Actor, y una TV no lo tiene. Con `supabase` sin URL/anon/secreto también `off`:
 * `mintDisplayRealtimeToken` fallaría siempre y el cliente reintentaría en loop.
 */
export async function displayRealtimeBootstrap(tenantId: string): Promise<RealtimeBootstrap> {
  const off: RealtimeBootstrap = { driver: "off", tenantId };
  if (env.REALTIME_DRIVER !== "supabase") return off;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !env.SUPABASE_JWT_SECRET) return off;
  return { driver: "supabase", tenantId, url, anonKey };
}
