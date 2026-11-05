"use server";

import { z } from "zod";
import { getActor, writableError } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { patientAccessFor } from "@/lib/visibility";
import { normalizeArMobile } from "@/lib/phone-e164";
import { phoneActionsFor, UPCOMING_SHARE_MAX, type ShareContact } from "@/lib/booking-share";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { canCollectCopago } from "@/lib/capabilities";
import { env, mpConnectMode, tenantAccessEnforcement } from "@/lib/env";
import { isPublicBookingOpen } from "@/lib/tenant-modules";
import { effectiveMode, publicSurfacesOpen } from "@/lib/tenant-access";
import { bookingHref } from "@/lib/public-booking-links";
import { patientUpcomingBookingsInTx, shareBookingOf } from "@/lib/patient-profile-loader";
import type { PatientShareBundle } from "@/lib/patient-share-types";

/**
 * WA-0 (§21.6): el celular del paciente para el link `wa.me` del drawer del turno, ya normalizado a E.164.
 *
 * Por qué una lectura aparte y no un campo más del DTO de la agenda: la agenda baja cientos de filas y el teléfono
 * se usa en un turno a la vez; sumarlo a la proyección le daría a la vista contacto de todos los pacientes del día
 * (también a quien no lo ve: la fila manda `admin` como "basic"). Acá se pide uno, cuando se abre el drawer.
 *
 * Acceso = el del contacto en el perfil (`getPatientCore`): `full` y `admin` (Secretaria/Facturación: el contacto es
 * dato administrativo, AUDIT §5 / PD-13) lo ven; `basic` y `none` no. Se usa `patientAccessFor` y no el
 * `patientAccess` de la fila del drawer porque la fila colapsa `admin` en "basic" y la Secretaria, que es quien más
 * manda recordatorios, se quedaba sin número. `patientAccessFor` devuelve `none` para un id de otro tenant o
 * inexistente, y la lectura igual lleva `where: { tenantId }` (en prod la conexión tiene BYPASSRLS).
 *
 * Sin audit (`patient.read.*`) a propósito, como `getPatientName`: es un campo que el mismo actor ya ve en el
 * directorio y en el perfil, y el drawer lo pide en cada apertura; el audit del perfil seguiría duplicándose.
 *
 * Nunca tira hacia el cliente por un id malo: cualquier cosa rara → `hidden` (el link sale sin destinatario, como
 * antes). Sin sesión sí tira (`getActor`), como toda action.
 */
const Input = z.string().min(1).max(64);

export async function getPatientShareContact(patientId: string): Promise<ShareContact> {
  const actor = await getActor();
  const parsed = Input.safeParse(patientId);
  if (!parsed.success) return { status: "hidden" };
  const id = parsed.data;
  return runWithRls(actor.tenantId, async (tx) => {
    const access = await patientAccessFor(actor, id, tx);
    if (access !== "full" && access !== "admin") return { status: "hidden" } as const;
    const p = await tx.patient.findFirst({ where: { id, tenantId: actor.tenantId }, select: { phone: true } });
    if (!p) return { status: "hidden" } as const;
    const r = normalizeArMobile(p.phone);
    return r.ok ? ({ status: "ok", e164: r.e164 } as const) : ({ status: "invalid", reason: r.reason } as const);
  });
}

/**
 * CF3 (D-CF3-8, SH-S) · todo lo que el menú del teléfono del perfil necesita, en UNA tx y al abrirlo (el perfil no lo
 * carga: es un menú lazy y su peso no va en `/pacientes/[id]`).
 *
 * Acceso = el de `getPatientShareContact` (arriba): `full` y `admin` (Secretaria/Facturación, PD-13) ven contacto y
 * turnos; `basic`, `none`, otro tenant o un id malo → `{ contact: hidden }` y nada más (ni turnos, ni nombre). La
 * Secretaria es justamente quien más manda recordatorios: por eso `admin` entra.
 *
 * Nada clínico: los turnos salen de `patientUpcomingBookingsInTx` (sin título, notas ni descripción) y del paciente
 * solo se leen nombre, teléfono y si tiene email. Sin audit, como el contacto del drawer (mismo motivo: son datos que
 * el actor ya ve en el perfil y el menú se abre muchas veces).
 *
 * Sentencias: acceso (lo que cueste `patientAccessFor`) + paciente 1 + turnos 1. Capabilities, turnero y modo de
 * cobros salen del Actor y del entorno (0 sentencias; `memberCapabilitiesForActor` usa la membresía del Actor).
 *   - `turneroUrl`: la regla de `isPublicTurneroOpen` (switch del turnero + superficies públicas abiertas con el modo
 *     EFECTIVO de acceso), con el acceso que el Actor ya trae calculado. Cerrado → null (no se ofrece un link que da
 *     «turnos cerrados»).
 *   - `canPaymentLink` (sin turno) = la regla de `createPaymentLink` sin `bookingId`; por turno, `canCollectCopago`.
 *     Con `MP_CONNECT_MODE=off` o en soporte, nunca.
 *   - `canPortalInvite` = la de `sendPatientPortalInvite`: `full`, email cargado y consultorio que puede escribir.
 */
export async function getPatientShareBundle(patientId: string): Promise<PatientShareBundle> {
  const actor = await getActor();
  const hidden: PatientShareBundle = { contact: { status: "hidden" } };
  const parsed = Input.safeParse(patientId);
  if (!parsed.success) return hidden;
  const id = parsed.data;
  return runWithRls(actor.tenantId, async (tx): Promise<PatientShareBundle> => {
    const access = await patientAccessFor(actor, id, tx);
    if (access !== "full" && access !== "admin") return hidden;
    const p = await tx.patient.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { firstName: true, phone: true, email: true },
    });
    if (!p) return hidden;
    const rows = await patientUpcomingBookingsInTx(tx, actor.tenantId, id, UPCOMING_SHARE_MAX);

    const caps = await memberCapabilitiesForActor(actor);
    const online = mpConnectMode() !== "off" && !actor.support;
    const turneroOpen =
      isPublicBookingOpen(actor.entitlements) &&
      publicSurfacesOpen(effectiveMode(actor.access.mode, tenantAccessEnforcement()));

    const phone = phoneActionsFor(p.phone);
    const contact =
      phone.e164 != null
        ? ({ status: "ok", e164: phone.e164, phone } as const)
        : ({ status: "invalid", reason: phone.reason ?? "empty", phone } as const);

    return {
      contact,
      firstName: p.firstName,
      clinicName: actor.tenantName,
      turneroUrl: turneroOpen ? `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${bookingHref(actor.tenantSlug)}` : null,
      upcoming: rows.map((r) => ({
        ...shareBookingOf(r),
        canPaymentLink: online && canCollectCopago(caps, actor.practitionerId, r.practitionerId),
      })),
      canPaymentLink:
        online &&
        (caps.has("billing.collect") ||
          (caps.has("billing.collectOwn") && actor.practitionerId != null && access === "full")),
      canPortalInvite: access === "full" && !!p.email?.trim() && writableError(actor) == null,
    };
  });
}
