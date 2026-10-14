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
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { isPublicBookingOpen, type TenantEntitlements } from "@/lib/tenant-modules";
import { tenantAccessEnforcement } from "@/lib/env";
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
// Switch del turnero (EV0, plan §15.3, EV-D2)
// ──────────────────────────────────────────────────────────────────────

/**
 * Columnas de `Tenant` que decide el switch (`TenantEntitlements`). Se suman al
 * `select` de cada lectura pública por slug para no hacer una query extra
 * (`getTenantModulesById` haría otra ida a la base por request del wizard).
 */
export const PUBLIC_BOOKING_SWITCH_SELECT = {
  vertical: true,
  plan: true,
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
export function isPublicTurneroOpen(t: TenantEntitlements & TenantAccessInput, now: Date = new Date()): boolean {
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
    },
    data: { status: "CANCELLED" },
  });
  return res.count === 1
    ? { id: own.id, practitionerId: own.practitionerId, scheduledFor: own.scheduledFor, roomId: own.roomId }
    : null;
}
