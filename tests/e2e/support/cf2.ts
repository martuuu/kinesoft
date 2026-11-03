import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  addPatient,
  addPractitioner,
  addRevenueShare,
  addStaff,
  createEphemeralTenant,
  deleteTenantDeep,
  type EphemeralTenant,
} from "../../helpers/tenant-factory";
import { arAt, arDay } from "./cf";
import { E2E_PASSWORD, E2E_STATE_DIR, E2E_USERS_FILE } from "./e2e-constants.mjs";

/**
 * CF2-E2E (tanda CF2, §29.3) · consultorio propio de cada spec `cf2-*.spec.ts`, con la MISMA factory que la integración
 * (nunca seeds), igual que `support/cf.ts`. Lo arma cada spec en su `beforeAll` y lo borra en su `afterAll`: no toca el
 * global-setup ni le cambia la agenda al consultorio de siempre. Si una corrida se corta, `sweepOrphanTestTenants` lo
 * barre a los 30' (slug `test-`).
 *
 * Por qué consultorio propio:
 *  - CF2 es de consultorios con VARIOS profesionales y Secretaria (título «Todos los profesionales (N)», «Kinesiólogo»
 *    en Pacientes, reparto en la Caja); el de siempre es Individual (cupo 1, sin Recepción).
 *  - Plan CLÍNICA: la vista Recepción es del módulo `salaEspera` (Clínica/Libre, `lib/tenant-modules.ts`), y ahí cobra
 *    la Secretaria (D-CF2-3, [CF2-RC]).
 *
 * Datos (todos de HOY en Argentina salvo la visita de ayer):
 *  - Titular «Laura Pérez» (OWNER, atiende) + profesional «Martín Gómez» (PRACTITIONER) + Secretaria (ASSISTANT).
 *  - `owed`: turno de Martín de hoy 09:00, ATENDIDO, copago $60 sin cobrar → «Cobrar» en Recepción.
 *  - `paid`: turno de Martín de hoy 10:00, ya cobrado por la Secretaria ($70, Transferencia, `copagoPaidAt` = ahora):
 *    la Caja y «Cobrado hoy» lo cuentan. Transferencia (no Efectivo) para que no se confunda con el que cobra el spec.
 *  - `visited`: paciente a cargo de Laura con un turno de Martín AYER 11:00 (no cancelado) → «Última visita» = ayer,
 *    «Estado» = Activo y la columna «Kinesiólogo» con los dos (Laura «a cargo» primero).
 *  - Regla de reparto: Martín destina el 50 % de copagos y cobros online a Laura, vigente desde hace 1 h.
 */
type User = { id: string; email: string; password: string; fullName: string };

export type Cf2Tenant = {
  tenantId: string;
  slug: string;
  locationId: string;
  today: string;
  owner: User & { practitionerId: string };
  pro: User & { practitionerId: string };
  assistant: User;
  owed: { bookingId: string; patient: { id: string; firstName: string; lastName: string }; copagoCents: number };
  paid: { bookingId: string; patient: { id: string; firstName: string; lastName: string }; copagoCents: number };
  visited: { patient: { id: string; firstName: string; lastName: string } };
};

export const CF2_OWNER_NAME = "Laura Pérez";
export const CF2_PRO_NAME = "Martín Gómez";

function readUsers(): User[] {
  try {
    return JSON.parse(readFileSync(E2E_USERS_FILE, "utf8")) as User[];
  } catch {
    return [];
  }
}

async function named(db: PrismaClient, id: string, fullName: string): Promise<User> {
  const u = await db.userProfile.update({ where: { id }, data: { fullName }, select: { email: true } });
  return { id, email: u.email, password: E2E_PASSWORD, fullName };
}

export async function createCf2Tenant(db: PrismaClient): Promise<Cf2Tenant> {
  const t: EphemeralTenant = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "CLINICA", vertical: "KINESIOLOGY" });
  const location = await db.location.create({ data: { tenantId: t.tenantId, name: "Principal", isPrimary: true } });
  const pro = await addPractitioner(db, t, "PRACTITIONER");
  const staff = await addStaff(db, t, "ASSISTANT");
  const owner = { ...(await named(db, t.userId, CF2_OWNER_NAME)), practitionerId: t.practitionerId };
  const proUser = { ...(await named(db, pro.userId, CF2_PRO_NAME)), practitionerId: pro.practitionerId };
  const assistant = await named(db, staff.userId, "Sofía Secretaria");

  // Franjas de 08:00 a 19:00 los 7 días para los dos (como el global-setup): el candado y el Mes tienen «atiende».
  await db.practitionerSchedule.createMany({
    data: [t.practitionerId, pro.practitionerId].flatMap((practitionerId) =>
      [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        tenantId: t.tenantId,
        practitionerId,
        locationId: location.id,
        dow,
        startMin: 8 * 60,
        endMin: 19 * 60,
      }))
    ),
  });
  const proService = await db.service.create({
    data: { tenantId: t.tenantId, practitionerId: pro.practitionerId, name: "Kinesio CF2", durationMin: 60, priceCents: 6000 },
    select: { id: true },
  });

  const owedPatient = { firstName: "Ramiro", lastName: "Cobro CF2" };
  const paidPatient = { firstName: "Paula", lastName: "Caja CF2" };
  const visitedPatient = { firstName: "Nora", lastName: "Directorio CF2" };
  const owedPatientId = await addPatient(db, t, { ...owedPatient, assignedPractitionerId: pro.practitionerId });
  const paidPatientId = await addPatient(db, t, { ...paidPatient, assignedPractitionerId: pro.practitionerId });
  const visitedPatientId = await addPatient(db, t, { ...visitedPatient, assignedPractitionerId: t.practitionerId });

  const today = arDay(0);
  const booking = (patientId: string, at: Date, key: string, extra: Record<string, unknown>) =>
    db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        practitionerId: pro.practitionerId,
        serviceId: proService.id,
        locationId: location.id,
        scheduledFor: at,
        durationMin: 60,
        status: "CONFIRMED",
        idempotencyKey: `e2e-cf2-${key}-${t.tenantId}`,
        ...extra,
      },
      select: { id: true },
    });
  const owed = await booking(owedPatientId, arAt(today, 9), "owed", { status: "COMPLETED", copagoCents: 6000 });
  const paid = await booking(paidPatientId, arAt(today, 10), "paid", {
    copagoCents: 7000,
    paymentStatus: "PAID",
    copagoPaidAt: new Date(),
    copagoPaymentMethod: "TRANSFER",
    copagoCollectedById: assistant.id,
  });
  await booking(visitedPatientId, arAt(arDay(-1), 11), "visited", {});

  await addRevenueShare(db, t, {
    giverPractitionerId: pro.practitionerId,
    receiverPractitionerId: t.practitionerId,
    shareBps: 5000,
    appliesInsurer: false,
  });

  const fx: Cf2Tenant = {
    tenantId: t.tenantId,
    slug: t.slug,
    locationId: location.id,
    today,
    owner,
    pro: proUser,
    assistant,
    owed: { bookingId: owed.id, patient: { id: owedPatientId, ...owedPatient }, copagoCents: 6000 },
    paid: { bookingId: paid.id, patient: { id: paidPatientId, ...paidPatient }, copagoCents: 7000 },
    visited: { patient: { id: visitedPatientId, ...visitedPatient } },
  };
  writeFileSync(E2E_USERS_FILE, JSON.stringify([...readUsers(), owner, proUser, assistant], null, 2));
  return fx;
}

export async function deleteCf2Tenant(db: PrismaClient, fx: Cf2Tenant | null): Promise<void> {
  if (!fx) return;
  if (process.env.E2E_KEEP_DATA !== "1") await deleteTenantDeep(db, fx.tenantId);
  const ids = new Set([fx.owner.id, fx.pro.id, fx.assistant.id]);
  if (existsSync(E2E_USERS_FILE)) writeFileSync(E2E_USERS_FILE, JSON.stringify(readUsers().filter((u) => !ids.has(u.id)), null, 2));
  for (const id of ids) rmSync(resolve(E2E_STATE_DIR, `qa-session-${id}.json`), { force: true });
}

/** `$ 70` / `$70` con o sin espacio duro: el formato de `formatARS` (Intl es-AR). */
export function arsRe(cents: number): RegExp {
  const n = (cents / 100).toLocaleString("es-AR");
  return new RegExp(`\\$\\s*${n.replace(/\./g, "\\.")}(?![\\d,])`);
}
