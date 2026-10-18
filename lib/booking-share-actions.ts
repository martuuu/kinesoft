"use server";

import { z } from "zod";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { patientAccessFor } from "@/lib/visibility";
import { normalizeArMobile } from "@/lib/phone-e164";
import type { ShareContact } from "@/lib/booking-share";

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
