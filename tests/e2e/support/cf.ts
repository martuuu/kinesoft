import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient, SaasPlan, TenantVertical } from "@prisma/client";
import { addPatient, addService, addStaff, createEphemeralTenant, deleteTenantDeep, type EphemeralTenant } from "../../helpers/tenant-factory";
import { E2E_PASSWORD, E2E_STATE_DIR, E2E_USERS_FILE } from "./e2e-constants.mjs";

/**
 * CF-E2E (tanda CF, §28.3) · consultorios propios de los specs `cf-*.spec.ts`, con la MISMA factory que la integración
 * (nunca seeds). Los arma cada spec en su `beforeAll` y los borra en su `afterAll`: así no hace falta tocar el
 * global-setup (de otra sesión) y un spec CF no le cambia la agenda ni el turnero al consultorio de siempre. Si una
 * corrida se corta, `sweepOrphanTestTenants` los barre a los 30' (slug `test-`).
 *
 * Por qué consultorio propio y no el del fixture:
 *  - Secretaría: el Individual de siempre tiene cupo de 1 usuario y `plans-matrix.spec.ts` afirma «Cupo lleno».
 *  - Turnero: el bloqueo duro por «otro servicio» necesita un turno de A en la ventana de 5 días, y en el de siempre ese
 *    turno le cambiaría el primer horario a `turnero.spec.ts`.
 *
 * Los usuarios se suman al `users.json` del GoTrue falso (lo lee en CADA request, ver `start-server.mjs`) y se sacan al
 * borrar. Las sesiones que guarda `loginAs` (`qa-session-<id>.json`) también.
 */
type User = { id: string; email: string; password: string; fullName: string };

export type CfTenant = {
  tenantId: string;
  slug: string;
  practitionerId: string;
  locationId: string;
  owner: User;
  assistant: User | null;
  /** Dos servicios del MISMO profesional (60', ilimitados): A = el de la factory renombrado, B = uno nuevo. */
  serviceA: { id: string; name: string };
  serviceB: { id: string; name: string };
  patients: { id: string; firstName: string; lastName: string }[];
};

/** Hoy en Argentina (YYYY-MM-DD), corrido `addDays`. El host puede estar en cualquier TZ. */
export function arDay(addDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const d = new Date(`${today}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}
/** Instante de `day` a las `hh:mm` de Argentina (UTC−3 fijo, sin horario de verano desde 2009). */
export function arAt(day: string, hh: number, mm = 0): Date {
  return new Date(`${day}T${String(hh + 3).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);
}

async function userOf(db: PrismaClient, id: string): Promise<User> {
  const u = await db.userProfile.findUniqueOrThrow({ where: { id }, select: { email: true, fullName: true } });
  return { id, email: u.email, password: E2E_PASSWORD, fullName: u.fullName ?? "E2E" };
}

function readUsers(): User[] {
  try {
    return JSON.parse(readFileSync(E2E_USERS_FILE, "utf8")) as User[];
  } catch {
    return [];
  }
}

export async function createCfTenant(
  db: PrismaClient,
  opts: { saasPlan?: SaasPlan; vertical?: TenantVertical; withAssistant?: boolean; patients?: { firstName: string; lastName: string }[] } = {}
): Promise<CfTenant> {
  const t: EphemeralTenant = await createEphemeralTenant(db, { role: "OWNER", saasPlan: opts.saasPlan, vertical: opts.vertical });
  const location = await db.location.create({ data: { tenantId: t.tenantId, name: "Principal", isPrimary: true } });
  // Franjas de 08:00 a 19:00 los 7 días, como el global-setup: hay horarios cualquier día que corra la suite.
  await db.practitionerSchedule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
      tenantId: t.tenantId,
      practitionerId: t.practitionerId,
      locationId: location.id,
      dow,
      startMin: 8 * 60,
      endMin: 19 * 60,
    })),
  });
  // 60' y el turnero cada 30': la grilla pública cae en horas enteras (10:00 existe) sin depender del automático.
  const serviceA = { id: t.serviceId, name: "Kinesio A" };
  await db.service.update({ where: { id: t.serviceId }, data: { name: serviceA.name, durationMin: 60 } });
  const serviceB = { id: await addService(db, t, { name: "Osteo B", durationMin: 60, priceCents: 5000, maxConcurrent: null }), name: "Osteo B" };
  await db.tenant.update({ where: { id: t.tenantId }, data: { publicSlotStepMin: 30 } });
  const patients: CfTenant["patients"] = [];
  for (const p of opts.patients ?? []) patients.push({ id: await addPatient(db, t, p), ...p });
  const assistant = opts.withAssistant ? await userOf(db, (await addStaff(db, t, "ASSISTANT")).userId) : null;
  const fx: CfTenant = {
    tenantId: t.tenantId,
    slug: t.slug,
    practitionerId: t.practitionerId,
    locationId: location.id,
    owner: await userOf(db, t.userId),
    assistant,
    serviceA,
    serviceB,
    patients,
  };
  const users = readUsers();
  users.push(fx.owner, ...(assistant ? [assistant] : []));
  writeFileSync(E2E_USERS_FILE, JSON.stringify(users, null, 2));
  return fx;
}

export async function deleteCfTenant(db: PrismaClient, fx: CfTenant | null): Promise<void> {
  if (!fx) return;
  if (process.env.E2E_KEEP_DATA !== "1") await deleteTenantDeep(db, fx.tenantId);
  const ids = new Set([fx.owner.id, fx.assistant?.id].filter(Boolean) as string[]);
  if (existsSync(E2E_USERS_FILE)) writeFileSync(E2E_USERS_FILE, JSON.stringify(readUsers().filter((u) => !ids.has(u.id)), null, 2));
  for (const id of ids) rmSync(resolve(E2E_STATE_DIR, `qa-session-${id}.json`), { force: true });
}
