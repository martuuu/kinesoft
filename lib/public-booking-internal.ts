/**
 * Server-internal helpers for the public booking flow. Not "use server" —
 * these must NEVER be exposed as RPC endpoints, only invoked from server
 * components / server actions that have already validated the caller.
 *
 * Importantly, `findPatientByEmailForPrefill` returns PII and must only
 * be called from a context where the email has already been validated
 * against a verified Supabase session (`user.email_confirmed_at`).
 */
import "server-only";
// Cross-tenant prefill lookup, no single-tenant Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { PENDING_PUBLIC_HOLD_MS, isHoldingCapacity, isPublicReservation } from "@/lib/booking-capacity";
import { lockCapacityWindow } from "@/lib/booking-cap-lock";
import { expireOwnHoldChargeInTx } from "@/lib/public-booking-charge-internal";
import { isPublicBookingOpen, type TenantEntitlements } from "@/lib/tenant-modules";
import { tenantAccessEnforcement, whatsappMode, type WhatsappMode } from "@/lib/env";
import { getLiveAccountCached } from "@/lib/whatsapp/account-internal";
import { logger } from "@/lib/logger";
import {
  TENANT_ACCESS_SELECT,
  effectiveMode,
  publicSurfacesOpen,
  tenantAccessFor,
  type TenantAccessInput,
} from "@/lib/tenant-access";
import { getVerifiedSessionUser } from "@/lib/session-user";
// Ciclo de imports benigno: `public-booking.ts` importa helpers de este archivo
// y este usa `getPublicClinic` solo dentro de una función (nunca al cargar).
import { getPublicClinic } from "@/lib/public-booking";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import {
  normalizeDocumentId,
  normalizePhoneForCompare,
  type PrefillPatient,
  type PublicClinic,
} from "@/lib/public-booking-types";

// ──────────────────────────────────────────────────────────────────────
// WhatsApp del turnero (WA-S8, §26.5)
// ──────────────────────────────────────────────────────────────────────

/**
 * ¿El consultorio avisa por WhatsApp? (`PublicClinic.whatsappNotices` y la condición para guardar el consentimiento
 * del turnero.) Misma regla que el flag de la agenda (`agendaWhatsAppInTx`): modo ≠ off, cuenta ACTIVE del tenant y en
 * el MISMO modo que el env (una cuenta `fake` con `WHATSAPP_MODE=sandbox` no manda: el outbox re-chequea, C-WA7).
 *
 *   - Con `off` corta ANTES de leer la cuenta: 0 sentencias (regla de T6: el modo apagado no agrega queries).
 *   - La cuenta sale de `getLiveAccountCached` (tag `whatsappAccount(tenantId)`): en caliente 0 sentencias; el
 *     turnero es la superficie pública más visitada y no paga una lectura por request.
 *   - Si la lectura falla, false (no tira): el turnero sigue reservando sin la casilla. Sin PHI en el log.
 */
export async function turneroWhatsAppActive(tenantId: string, mode: WhatsappMode = whatsappMode()): Promise<boolean> {
  if (mode === "off") return false;
  try {
    const a = await getLiveAccountCached(tenantId);
    return !!a && a.status === "ACTIVE" && a.mode === mode;
  } catch (e) {
    logger.warn("booking.public.whatsapp_account_failed", { tenantId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Switch del turnero (EV0, plan §15.3, EV-D2)
// ──────────────────────────────────────────────────────────────────────

/**
 * Columnas de `Tenant` que decide el switch (`TenantEntitlements`). Se suman al
 * `select` de cada lectura pública por slug para no hacer una query extra
 * (`getTenantModulesById` haría otra ida a la base por request del wizard).
 */
export const PUBLIC_BOOKING_SWITCH_SELECT = {
  vertical: true,
  // PL-1: sin `plan` — el turnero es un switch en todos los planes (C-PL1), y la columna legada
  // `Tenant.plan` ya no es el tipo de `TenantEntitlements.plan` (SaasPlan).
  publicBookingEnabled: true,
  // BO2-D: + las 4 columnas del acceso (C-BO1), en la misma lectura.
  ...TENANT_ACCESS_SELECT,
} as const;

/**
 * ¿Las superficies públicas SIN Actor de este consultorio están abiertas? (BO2-D, C-BO1 `publicSurfacesOpen`:
 * turnero, check-in del portal; el token realtime lo mira con el Actor). Con el modo EFECTIVO
 * (`TENANT_ACCESS_ENFORCEMENT`): con el default `banner` solo cierran suspendido y dado de baja (un trial vencido
 * sigue tomando turnos hasta que Martin pase a `enforce`); con `enforce`, también el solo lectura.
 * Lo que NUNCA se gatea acá: el webhook de MP (AUDIT §5.4: un pago siempre se concilia, aunque el consultorio
 * esté suspendido) y el estado de un turno ya reservado (`getPublicBookingStatus`, retorno de MP).
 */
export function publicSurfacesOpenFor(t: TenantAccessInput, now: Date = new Date()): boolean {
  return publicSurfacesOpen(effectiveMode(tenantAccessFor(t, now).mode, tenantAccessEnforcement()));
}

/** Turnero abierto = módulo prendido (switch EV0) Y superficies públicas abiertas (acceso BO2-D). */
export function isPublicTurneroOpen(
  t: Pick<TenantEntitlements, "publicBookingEnabled"> & TenantAccessInput,
  now: Date = new Date()
): boolean {
  return isPublicBookingOpen(t) && publicSurfacesOpenFor(t, now);
}

/** Contacto PÚBLICO del consultorio (lo que cargó en el onboarding para mostrar). */
export type PublicClinicContact = {
  name: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
};

export type PublicBookingGate =
  | { state: "open" }
  | { state: "closed"; contact: PublicClinicContact }
  /** BO2-D (BO-D9): el slug pedido es un alias viejo; `slug` es el vigente (la página redirige). */
  | { state: "moved"; slug: string };

/**
 * ¿Qué muestra `/c/[slug]/booking`? null = el slug no existe (404, como antes);
 * closed = el consultorio existe pero no toma turnos online → página "Turnos
 * online no disponibles" con su contacto público. Cerrado ≠ 404 a propósito:
 * el link del turnero ya circuló (Instagram, WhatsApp) y un 404 parece un link
 * roto; el contacto le da al paciente por dónde pedir el turno.
 *
 * Solo devuelve campos que el consultorio publicó (`phone`, `whatsapp`,
 * `publicEmail`); nunca profesionales, servicios ni nada de pacientes.
 */
export async function getPublicBookingGate(slug: string): Promise<PublicBookingGate | null> {
  const read = await readPublicBookingGate(slug);
  return read ? read.gate : null;
}

/**
 * `getPublicBookingGate` + el id del tenant, para uso interno del loader (el
 * prefill se acota a este consultorio, EV0 V.Z P2). El id no viaja en
 * `PublicBookingGate` ni en `PublicClinic`: no tiene por qué llegar al cliente.
 */
async function readPublicBookingGate(
  slug: string
): Promise<{ tenantId: string; gate: PublicBookingGate } | null> {
  const t = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, phone: true, whatsapp: true, publicEmail: true, ...PUBLIC_BOOKING_SWITCH_SELECT },
  });
  if (!t) {
    // BO2-D (BO-D9): ¿es un slug viejo? El slug VIVO gana siempre (se miró primero): si un alias quedara pisado
    // por un alta nueva con ese slug, el link va al consultorio que hoy lo tiene, nunca a otro por un alias.
    const moved = await resolveSlugAlias(slug);
    return moved ? { tenantId: moved.tenantId, gate: { state: "moved", slug: moved.slug } } : null;
  }
  // Abierto = switch + acceso (BO2-D). Un consultorio suspendido o dado de baja muestra la misma página
  // «Turnos online no disponibles» (molde EV0) con su contacto público: el link ya circuló y un 404 parece roto.
  if (isPublicTurneroOpen(t)) return { tenantId: t.id, gate: { state: "open" } };
  return {
    tenantId: t.id,
    gate: {
      state: "closed",
      contact: { name: t.name, phone: t.phone, whatsapp: t.whatsapp, email: t.publicEmail },
    },
  };
}

/**
 * Slug viejo → slug vigente del consultorio (BO2-D, BO-D9). `TenantSlugAlias` es SERVICE_ONLY: se lee por el
 * canal service (este módulo ya lo usa). null = no es un alias. Exportado para que otras superficies públicas por
 * slug (portal) puedan redirigir con la misma regla.
 */
export async function resolveSlugAlias(slug: string): Promise<{ tenantId: string; slug: string } | null> {
  const alias = await prisma.tenantSlugAlias.findUnique({
    where: { slug },
    select: { tenant: { select: { id: true, slug: true } } },
  });
  return alias ? { tenantId: alias.tenant.id, slug: alias.tenant.slug } : null;
}

export type PublicBookingPageData =
  | { state: "closed"; contact: PublicClinicContact }
  | { state: "moved"; slug: string }
  | {
      state: "open";
      clinic: PublicClinic;
      session: { email: string; fullName: string | null } | null;
      prefill: PrefillPatient | null;
    };

/**
 * Loader de `app/(booking)/c/[slug]/booking/page.tsx` (testeable sin render).
 * Con el turnero cerrado corta ANTES de leer la sesión de Supabase y del
 * prefill: `findPatientByEmailForPrefill` devuelve PII (DNI, nacimiento,
 * cobertura) y una página que no va a mostrar el wizard no tiene por qué
 * cargarla. null → `notFound()` en la página.
 */
export async function loadPublicBookingPage(slug: string): Promise<PublicBookingPageData | null> {
  const read = await readPublicBookingGate(slug);
  if (!read) return null;
  const { gate, tenantId } = read;
  if (gate.state === "closed") return { state: "closed", contact: gate.contact };
  // Alias: antes de la sesión y del prefill (la página redirige; no hay nada que cargar).
  if (gate.state === "moved") return { state: "moved", slug: gate.slug };

  // Re-chequea el switch adentro: si lo apagaron entre las dos lecturas, null
  // (404 de un request) es aceptable; mostrar el wizard con datos, no.
  const clinic = await getPublicClinic(slug);
  if (!clinic) return null;

  // Prefill is only attempted when the user has a verified Supabase
  // session — the `findPatientByEmailForPrefill` helper trusts the email
  // it receives, so we must prove it belongs to the requester first.
  let prefill: PrefillPatient | null = null;
  let session: { email: string; fullName: string | null } | null = null;
  try {
    // IAM-3a: un solo `auth.getUser()` por request (`getVerifiedSessionUser`, nunca tira).
    const user = await getVerifiedSessionUser();
    if (user?.email && user.emailConfirmedAt) {
      session = {
        email: user.email,
        fullName: user.fullName,
      };
      // EV0 V.Z (P2, PD-14): SOLO fichas de ESTE consultorio. Antes se buscaba
      // por email en todos (canal de servicio, BYPASSRLS): un paciente de A que
      // abría el turnero de B veía precargados DNI, nacimiento, cobertura y
      // contacto de emergencia que cargó A — y B, al reservar, los recibía.
      // Entre consultorios solo viaja el nombre de la sesión (`fullName`).
      prefill = await findPatientByEmailForPrefill(user.email, {
        tenantId,
        userId: user.id,
      });
    }
  } catch {
    /* Supabase not configured — anonymous flow is the default */
  }
  return { state: "open", clinic, session, prefill };
}

/**
 * Ficha de ESTE consultorio para precargar el wizard. El caller prueba que el
 * email (y el `userId`) son del que pide: sesión de Supabase verificada.
 *
 * EV0 V.Z (P2): `tenantId` es obligatorio. Antes era opcional y el único caller
 * no lo pasaba → `findFirst` por email en TODOS los consultorios. Criterio
 * determinístico dentro del consultorio:
 *   1. la ficha vinculada al usuario (`Patient.userId`, único por consultorio):
 *      el vínculo prueba identidad, gana aunque el email de la ficha sea otro;
 *   2. si no, la ficha con ese email, solo si es UNA. El único de la base es
 *      `(tenantId, email)` case-sensitive y acá se compara sin mayúsculas: dos
 *      fichas (p. ej. familiares que comparten casilla) son ambiguas → sin
 *      prefill, antes que mostrar los datos de la persona equivocada.
 *
 * IAM-0a: el email iba pelado a un `ILIKE` (`equals` + `mode: "insensitive"`):
 * `jpere_@hotmail.com` verificado recibía precargados DNI, nacimiento y
 * cobertura de `jperez@hotmail.com`. Filtro escapado + `sameEmail`.
 */
export async function findPatientByEmailForPrefill(
  email: string,
  opts: { tenantId: string; userId?: string | null }
): Promise<PrefillPatient | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !opts.tenantId) return null;
  const include = {
    coverages: { orderBy: { id: "desc" } },
    emergency: { orderBy: { id: "asc" } },
  } satisfies Prisma.PatientInclude;
  let row = opts.userId
    ? await prisma.patient.findFirst({
        where: { tenantId: opts.tenantId, userId: opts.userId },
        include,
      })
    : null;
  if (!row) {
    const byEmail = await prisma.patient.findMany({
      where: { tenantId: opts.tenantId, email: emailEqualsFilter(trimmed) },
      include,
      orderBy: { id: "asc" },
      take: 2,
    });
    // Post-filtro exacto (defensa en profundidad): devuelve PHI.
    const exact = byEmail.filter((p) => sameEmail(p.email, trimmed));
    if (exact.length !== 1 || byEmail.length !== 1) return null;
    row = exact[0];
  }
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? trimmed,
    phone: row.phone ?? "",
    documentId: row.documentId ?? "",
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : "",
    coverageInsurer: row.coverages[0]?.insurer ?? "",
    coveragePlan: row.coverages[0]?.planName ?? "",
    emergencyName: row.emergency[0]?.name ?? "",
    emergencyPhone: row.emergency[0]?.phone ?? "",
    notes: "",
  };
}

// ──────────────────────────────────────────────────────────────────────
// Resolución de la ficha en la reserva pública (H4, A2b-S-pub)
// ──────────────────────────────────────────────────────────────────────

/** Nota que ve el kine en el turno cuando el contacto tipeado no es el de la ficha. */
export const PUBLIC_CONTACT_MISMATCH_NOTE =
  "Reserva online · datos de contacto distintos a la ficha";
/**
 * T5 (TP-D22): el cobro online del turnero se calculó como PARTICULAR porque el contacto tipeado no es el de la ficha
 * (no se usa la obra social de una ficha ajena: revelaría su copago). Va a la nota del turno para que la recepción
 * sepa por qué el monto cobrado no es el copago de siempre; `getPublicBookingStatus` la usa para repetir la cuenta.
 */
export const PUBLIC_PARTICULAR_CHARGE_NOTE =
  "Reserva online · el pago online se calculó como particular (datos de contacto distintos a la ficha)";
/** Nota cuando la ficha nueva no pudo llevar el email/teléfono porque ya es de otra ficha. */
export const PUBLIC_SHARED_CONTACT_NOTE =
  "Reserva online · email o teléfono ya usado por otra ficha (¿familiar?): el contacto quedó en el turno";

export type PublicPatientInput = {
  firstName: string;
  lastName: string;
  email: string; // ya normalizado (trim + minúsculas) por el schema
  phone: string;
  documentId: string;
  dateOfBirth: Date;
  coverageInsurer?: string;
  coveragePlan?: string;
  emergencyName?: string;
  emergencyPhone?: string;
};

export type PublicPatientResolution = {
  patientId: string;
  created: boolean;
  /**
   * Contacto tipeado que NO quedó en la ficha: va al snapshot
   * `guestName/guestEmail/guestPhone` del turno para que el kine lo revise.
   */
  contactSnapshot: { guestName: string; guestEmail: string; guestPhone: string } | null;
  /** Líneas para la nota del turno (revisión del kine). */
  reviewNotes: string[];
  /**
   * T5 (TP-D22): el DNI matcheó una ficha EXISTENTE y el contacto o el nombre tipeados no son los de la ficha. El
   * cobro online se calcula como particular. Una ficha nueva sin email/teléfono (familia que comparte) NO cuenta: su
   * cobertura es la que tipeó quien reserva.
   */
  contactMismatch: boolean;
};

function isP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Encuentra o crea la ficha de quien reserva online. Reglas (H4):
 *
 *   - **Match SOLO por DNI normalizado** (ya no por email): antes un
 *     `OR [email, documentId]` hacía que alguien que tipeara el email de un
 *     familiar reservara a nombre de la ficha del familiar.
 *   - **Nunca se parchea una ficha existente** (ni email, ni teléfono, ni
 *     "solo si estaba vacío"). Antes se completaban los campos nulos: un
 *     anónimo con el DNI de otro dejaba SU email en esa ficha y, al loguearse
 *     con Google, `/portal` y el prefill le mostraban la HC ajena (takeover).
 *     Si el contacto tipeado difiere, va al snapshot del turno + nota.
 *     Obra social y contacto de emergencia de una ficha existente tampoco se
 *     escriben (la cobertura cambia el copago): van a la nota.
 *   - **Ficha nueva con email/teléfono de otra ficha** (familia que comparte
 *     celular o mail; índices únicos `(tenantId, email|phone)`): se crea SIN el
 *     campo que choca y el contacto queda en el snapshot. Antes el P2002
 *     reventaba el submit (error boundary, datos perdidos).
 *   - Un P2002 por carrera (dos submits con el mismo DNI/contacto a la vez) se
 *     reintenta desde cero: la segunda vuelta ve la fila que ganó.
 *
 * Corre en el canal de servicio (sin Actor): el `tenantId` lo resolvió el
 * caller por slug y todas las queries lo filtran a mano.
 */
export async function resolvePublicPatient(
  tenantId: string,
  input: PublicPatientInput,
  opts: { practitionerId: string }
): Promise<PublicPatientResolution> {
  const dni = normalizeDocumentId(input.documentId);
  const fullName = `${input.firstName} ${input.lastName}`.trim();
  const snapshot = { guestName: fullName, guestEmail: input.email, guestPhone: input.phone };

  for (let attempt = 0; ; attempt++) {
    try {
      // Comparación contra la columna normalizada: una ficha cargada a mano
      // como "30.123.456" matchea "30123456". Primero las no archivadas.
      const hits = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Patient"
        WHERE "tenantId" = ${tenantId}
          AND upper(regexp_replace(coalesce("documentId", ''), '[^0-9A-Za-z]', '', 'g')) = ${dni}
        ORDER BY ("archivedAt" IS NOT NULL), "createdAt" ASC
        LIMIT 1`;

      if (hits.length > 0) {
        const p = await prisma.patient.findFirstOrThrow({
          where: { id: hits[0].id, tenantId },
          include: { coverages: true, emergency: true },
        });
        const reviewNotes: string[] = [];
        const contactDiffers =
          !sameText(p.email, input.email) ||
          normalizePhoneForCompare(p.phone) !== normalizePhoneForCompare(input.phone) ||
          !sameText(p.firstName, input.firstName) ||
          !sameText(p.lastName, input.lastName);
        if (contactDiffers) reviewNotes.push(PUBLIC_CONTACT_MISMATCH_NOTE);
        if (input.coverageInsurer) {
          const declared = [input.coverageInsurer, input.coveragePlan].filter(Boolean).join(" · ");
          const onFile = p.coverages.some((c) => sameText(c.insurer, input.coverageInsurer));
          if (!onFile) reviewNotes.push(`Obra social declarada online: ${declared}`);
        }
        if (input.emergencyName && input.emergencyPhone) {
          const onFile = p.emergency.some(
            (e) => normalizePhoneForCompare(e.phone) === normalizePhoneForCompare(input.emergencyPhone)
          );
          if (!onFile) {
            reviewNotes.push(`Contacto de emergencia declarado online: ${input.emergencyName} · ${input.emergencyPhone}`);
          }
        }
        return {
          patientId: p.id,
          created: false,
          contactSnapshot: contactDiffers ? snapshot : null,
          reviewNotes,
          contactMismatch: contactDiffers,
        };
      }

      // Ficha nueva: el email/teléfono que ya usa otra ficha del tenant no se
      // guarda en esta (quedan en el snapshot del turno).
      const [emailOwner, phoneOwner] = await Promise.all([
        prisma.patient.findFirst({
          // IAM-0a: escapado. Con el email pelado en el ILIKE, `ana_@x.com`
          // "chocaba" con la ficha de `anax@x.com` y la ficha nueva quedaba sin email.
          where: { tenantId, email: emailEqualsFilter(input.email) },
          select: { id: true },
        }),
        prisma.patient.findFirst({ where: { tenantId, phone: input.phone }, select: { id: true } }),
      ]);
      const dropped = !!emailOwner || !!phoneOwner;

      const created = await prisma.$transaction(async (tx) => {
        const p = await tx.patient.create({
          data: {
            tenantId,
            firstName: input.firstName,
            lastName: input.lastName,
            email: emailOwner ? null : input.email,
            phone: phoneOwner ? null : input.phone,
            documentId: input.documentId.trim(),
            dateOfBirth: input.dateOfBirth,
            // Dueño = el profesional elegido. Sin esto la ficha quedaba sin
            // dueño y, con la regla "acceso básico = solo ver" (A2), el propio
            // kine del turno no podía confirmarlo ni cobrarlo.
            assignedPractitionerId: opts.practitionerId,
          },
          select: { id: true },
        });
        if (input.coverageInsurer) {
          await tx.coverage.create({
            data: {
              patientId: p.id,
              insurer: input.coverageInsurer.trim().replace(/\s+/g, " "),
              planName: input.coveragePlan || null,
            },
          });
        }
        if (input.emergencyName && input.emergencyPhone) {
          await tx.emergencyContact.create({
            data: { patientId: p.id, name: input.emergencyName, phone: input.emergencyPhone },
          });
        }
        return p;
      });

      return {
        patientId: created.id,
        created: true,
        contactSnapshot: dropped ? snapshot : null,
        reviewNotes: dropped ? [PUBLIC_SHARED_CONTACT_NOTE] : [],
        contactMismatch: false,
      };
    } catch (e) {
      // Carrera con otro submit (mismo DNI, o el email/teléfono se ocupó entre
      // el chequeo y el INSERT): la vuelta siguiente ve la fila ganadora.
      if (isP2002(e) && attempt < 2) continue;
      throw e;
    }
  }
}

/**
 * El mismo paciente vuelve a reservar online el horario de SU reserva pública
 * vencida (revisión A2): abandonó Mercado Pago, volvió a los 40 min y el wizard
 * le ofrece el slot, porque la reserva vencida ya no retiene cupo. Pero la fila
 * PENDING/UNPAID vieja sigue ocupando el índice único parcial
 * `(tenantId, patientId, scheduledFor)` y el create chocaba (P2002) → "Ya tenés
 * un turno reservado en ese horario." sin salida (la key del wizard es nueva).
 *
 * Decisión: la vieja pasa a CANCELLED y el caller crea la nueva en la MISMA tx
 * (si el create falla, se deshace también la cancelación). Descartado:
 *   - reusar la fila vieja: puede ser de otro servicio/profesional (el índice
 *     es solo paciente + instante) y "renovar" la retención exigía pisar
 *     `createdAt`, que es el alta real del turno;
 *   - resolverlo en el catch del P2002: la tx ya quedó abortada.
 * Un pago tardío sobre la preferencia vieja llega al turno CANCELLED y el
 * webhook NO lo reactiva: registra el pago y avisa "Pago de un turno cancelado
 * · revisá el reembolso" (contrato de A2b-S-pub). Es el mismo camino que el de
 * cualquier reserva cancelada, auditable, y nunca deja dos turnos vivos.
 *
 * Solo toca una fila que (a) es de este tenant y paciente en ese instante, (b)
 * es reserva pública (`isPublicReservation`, por la key) y (c) ya no retiene
 * cupo. El `updateMany` repite las condiciones + `updatedAt`: si un webhook la
 * pagó en el medio, no la cancela (count 0) y el create choca como antes.
 * Devuelve la fila cancelada, o null si no había nada que liberar.
 *
 * SV06a: devuelve `{id, practitionerId, scheduledFor, roomId}` (antes solo el
 * id) porque esa cancelación también es un cambio de turno que la Sala de
 * Espera realtime tiene que ver: el caller la manda como segundo ref de
 * `afterBookingsCommitted`, en la MISMA llamada que el alta nueva (un commit =
 * un publish). Se lee en el mismo `findFirst`: 0 statements nuevos.
 */
export async function releaseOwnExpiredPublicHold(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; patientId: string; scheduledFor: Date; now: Date }
): Promise<{ id: string; practitionerId: string; scheduledFor: Date; roomId: string | null } | null> {
  const own = await tx.booking.findFirst({
    where: {
      tenantId: o.tenantId,
      patientId: o.patientId,
      scheduledFor: o.scheduledFor,
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      patientId: true,
      idempotencyKey: true,
      updatedAt: true,
      practitionerId: true,
      scheduledFor: true,
      roomId: true,
    },
  });
  if (!own || isHoldingCapacity(own, o.now)) return null;
  const res = await tx.booking.updateMany({
    where: {
      id: own.id,
      tenantId: o.tenantId,
      updatedAt: own.updatedAt,
      status: "PENDING",
      paymentStatus: { in: ["UNPAID", "FAILED"] },
      // T5 (TP-2c): un turno con un pago de MP en curso o acreditado (cobro TURNERO AUTHORIZED/PAID) no se libera,
      // aunque el webhook todavía no haya movido el turno: lo resuelve el webhook, no una reserva nueva.
      NOT: { onlineCharges: { some: { origin: "TURNERO", status: { in: ["AUTHORIZED", "PAID"] } } } },
    },
    data: { status: "CANCELLED" },
  });
  if (res.count !== 1) return null;
  // T5 (C-TP8): su cobro vence en la MISMA tx (si el create de la reserva nueva falla, vuelve todo). Sin esto quedaba
  // un cobro ACTIVE de un turno cancelado: el cron lo vencía recién a la hora y, mientras, bloqueaba links y cobros.
  await expireOwnHoldChargeInTx(tx, { tenantId: o.tenantId, bookingId: own.id });
  return { id: own.id, practitionerId: own.practitionerId, scheduledFor: own.scheduledFor, roomId: own.roomId };
}

// ──────────────────────────────────────────────────────────────────────
// Reserva sin cobro online (TP-0, H-TP0, plan §22.5)
// ──────────────────────────────────────────────────────────────────────

/**
 * Cobro TURNERO que impide promover un PENDING (C-TP8): ACTIVE (REQUIRED esperando el pago: promoverlo regalaría el
 * turno sin cobrar), AUTHORIZED (MP retiene el pago) o PAID (el webhook lo confirma en su tx). EXPIRED/CANCELLED/
 * REFUNDED no retienen nada.
 */
const LIVE_TURNERO_CHARGE = {
  origin: "TURNERO",
  status: { in: ["ACTIVE", "AUTHORIZED", "PAID"] },
} satisfies Prisma.OnlineChargeWhereInput;

export type PublicHoldPromotion =
  /** Esta llamada la pasó a CONFIRMED (count 1): el caller avisa (realtime + campana), una sola vez. */
  | { kind: "promoted"; ref: { id: string; practitionerId: string; scheduledFor: Date; roomId: string | null } }
  /** Ya no estaba PENDING (otro submit la promovió, el webhook la pagó, la confirmó la recepción): no se escribe. */
  | { kind: "already-confirmed" }
  | { kind: "cancelled" }
  /** Pasaron los 30 min (`isHoldingCapacity`): el cupo ya se pudo dar a otro. No se escribe. */
  | { kind: "expired" }
  /** Hay un pago en curso (AUTHORIZED: efectivo, revisión): lo resuelve el webhook, no esta reserva. */
  | { kind: "payment-in-flight" }
  /** No existe, es de otro tenant o no es una reserva pública (key `pub:`): no se toca. */
  | { kind: "not-public" };

/**
 * Promueve UNA VEZ un hold público PENDING vigente a CONFIRMED/UNPAID (reservado, se paga en el consultorio).
 *
 * Dos caminos lo usan (`submitPublicBooking`):
 *   - replay con la misma key de un PENDING que nació con el checkout prendido (o anterior a TP-0) y ahora no hay
 *     checkout: el paciente reintentó porque MP fallaba (H-TP0) y su turno no puede seguir venciendo;
 *   - la preferencia falla (`checkout_degraded`): el consultorio nunca eligió el pago obligatorio, así que no se le
 *     traba la reserva al paciente por una caída de MP.
 *
 * Condiciones (las mismas del `updateMany`, que las repite para no pisar una carrera): de este tenant, key pública
 * (`isPublicReservation`: nunca un PENDING de la agenda), PENDING, UNPAID|FAILED, sin `Payment` AUTHORIZED, sin cobro TURNERO vivo (T5: `LIVE_TURNERO_CHARGE`) y DENTRO del
 * plazo de 30 min (`createdAt >= now - PENDING_PUBLIC_HOLD_MS`, el complemento exacto de `publicHoldExpired`). Un
 * FAILED promovido pasa a UNPAID: el turno ya no espera pago online, se cobra en el consultorio; la fila `Payment`
 * FAILED queda como historia.
 *
 * Lock: el de cupo de (profesional, servicio, ventana), la MISMA clave que el create público y la agenda, ANTES del
 * `updateMany` y con `now` tomado después del lock. Sin él, un hold que vence entre el chequeo y el commit podía
 * quedar CONFIRMED mientras otro submit ya había tomado el cupo que veía libre (dos turnos en un cupo 1). Con él,
 * quien entró antes ya escribió (y para nosotros el hold también venció: `now` es posterior) y quien entra después ve
 * el CONFIRMED.
 *
 * Con count 0 (otro escritor en el medio) se relee y se clasifica SIN escribir: el aviso sale solo del que ganó.
 */
export async function promoteHeldPublicBookingInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string }
): Promise<PublicHoldPromotion> {
  const select = {
    id: true,
    tenantId: true,
    status: true,
    paymentStatus: true,
    createdAt: true,
    updatedAt: true,
    patientId: true,
    idempotencyKey: true,
    practitionerId: true,
    serviceId: true,
    scheduledFor: true,
    durationMin: true,
    roomId: true,
    payment: { select: { status: true } },
    // T5 (C-TP8): un cobro TURNERO vivo o pagado = el turno espera (o ya tiene) un pago de MP: no se promueve.
    onlineCharges: { where: LIVE_TURNERO_CHARGE, select: { id: true }, take: 1 },
  } satisfies Prisma.BookingSelect;
  type Row = Prisma.BookingGetPayload<{ select: typeof select }>;
  const read = () => tx.booking.findFirst({ where: { id: o.bookingId, tenantId: o.tenantId }, select });

  const classify = (b: Row | null, now: Date): PublicHoldPromotion | null => {
    // Solo la key actual `pub:<tenant>:<uuid>` (la que puede llegar acá: el replay busca por ella); una legada no se
    // promueve.
    if (!b || !b.idempotencyKey.startsWith("pub:") || !isPublicReservation(b)) return { kind: "not-public" };
    if (b.status === "CANCELLED") return { kind: "cancelled" };
    if (b.status !== "PENDING") return { kind: "already-confirmed" };
    if (b.paymentStatus === "AUTHORIZED" || b.payment?.status === "AUTHORIZED") return { kind: "payment-in-flight" };
    if (b.onlineCharges.length > 0) return { kind: "payment-in-flight" };
    // PAID/REFUNDED sobre un PENDING no lo deja el webhook (pasa a CONFIRMED): ante la duda, no se toca.
    if (b.paymentStatus !== "UNPAID" && b.paymentStatus !== "FAILED") return { kind: "payment-in-flight" };
    if (!isHoldingCapacity(b, now)) return { kind: "expired" };
    return null; // promovible
  };

  let row = await read();
  const early = classify(row, new Date());
  if (early || !row) return early ?? { kind: "not-public" };

  await lockCapacityWindow(tx, {
    tenantId: o.tenantId,
    practitionerId: row.practitionerId,
    serviceId: row.serviceId,
    start: row.scheduledFor,
    end: new Date(row.scheduledFor.getTime() + row.durationMin * 60_000),
  });
  // Dos vueltas: la segunda cubre un write ajeno que solo movió `updatedAt` (p. ej. la recepción editó la nota) y
  // dejó el hold promovible. Profesional, servicio y horario de un PENDING público no los cambia nadie sin pasar por
  // la agenda, que toma este mismo lock: el lock de arriba sigue siendo el correcto.
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    if (attempt > 0) {
      row = await read();
      const verdict = classify(row, now);
      if (verdict || !row) return verdict ?? { kind: "not-public" };
    }
    const b: Row = row!;
    const res = await tx.booking.updateMany({
      where: {
        id: b.id,
        tenantId: o.tenantId,
        updatedAt: b.updatedAt,
        status: "PENDING",
        paymentStatus: { in: ["UNPAID", "FAILED"] },
        idempotencyKey: { startsWith: "pub:" },
        createdAt: { gte: new Date(now.getTime() - PENDING_PUBLIC_HOLD_MS) },
        NOT: [{ payment: { is: { status: "AUTHORIZED" } } }, { onlineCharges: { some: LIVE_TURNERO_CHARGE } }],
      },
      data: { status: "CONFIRMED", paymentStatus: "UNPAID" },
    });
    if (res.count === 1) {
      return { kind: "promoted", ref: { id: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId } };
    }
  }
  // Dos carreras seguidas: se informa lo que hay, sin escribir.
  return classify(await read(), new Date()) ?? { kind: "expired" };
}
