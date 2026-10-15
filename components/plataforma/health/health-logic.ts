/**
 * Lógica pura de presentación de /plataforma/salud (BO3-D, plan §19.5; absorbe la «4d» de IAM): texto de cada
 * detector, en qué orden se muestran y qué acción se ofrece en cada fila de la muestra. Sin React ni `next/*`: lo
 * importan el tablero (client) y su unit test (`tests/unit/render/platform-health-logic.test.tsx`).
 *
 * Qué acción por detector (contrato de la sesión):
 *  - Miembro clínico sin profesional → «Crear profesional» (`repairCreatePractitioner`).
 *  - Usuario de Auth huérfano → «Borrar» SOLO si `canDelete` (`repairDeleteAuthOrphan`, con confirmación).
 *  - Email distinto → «Sincronizar email» (`repairSyncProfileEmail`).
 *  - Consultorio sin titular → link al equipo del consultorio (se resuelve ahí, no con una reparación ciega).
 *  - Invitaciones vencidas y altas trabadas → solo link al consultorio.
 *  - Perfiles sin acceso → link al detalle del usuario; profesional sin membresía → link al equipo.
 */
import type { Role } from "@prisma/client";
import { roleLabel } from "@/lib/roles";
import type { HealthDetector, PlatformHealthReport } from "@/lib/platform-health-logic";

export type HealthDetectorKey = Exclude<keyof PlatformHealthReport, "generatedAt">;

export type HealthDetectorCopy = { key: HealthDetectorKey; title: string; description: string; emptyText: string };

/** Orden del tablero: primero lo que deja a alguien afuera hoy, al final lo que es limpieza. */
export const HEALTH_DETECTORS: readonly HealthDetectorCopy[] = [
  {
    key: "clinicalWithoutPractitioner",
    title: "Profesionales sin agenda",
    description: "Miembros que atienden pacientes pero no tienen su profesional creado: entran en un bucle y no pueden usar el consultorio.",
    emptyText: "Todos los miembros que atienden tienen su agenda.",
  },
  {
    key: "tenantsWithoutOwner",
    title: "Consultorios sin titular",
    description: "Nadie con rol de titular activo: no hay quién gestione el equipo.",
    emptyText: "Todos los consultorios tienen titular.",
  },
  {
    key: "emailMismatches",
    title: "Emails distintos",
    description: "El email del perfil no coincide con el de su cuenta de acceso (alguien lo cambió desde afuera). Los mails le llegan a la dirección equivocada.",
    emptyText: "Todos los emails coinciden.",
  },
  {
    key: "authOrphans",
    title: "Cuentas de acceso sin perfil",
    description: "Cuentas que existen en el servicio de acceso pero no en KineSoft: dejan el email ocupado para una invitación nueva.",
    emptyText: "No hay cuentas sueltas.",
  },
  {
    key: "stalledOnboarding",
    title: "Altas trabadas",
    description: "Consultorios que empezaron el alta hace más de 14 días y no la terminaron.",
    emptyText: "No hay altas trabadas.",
  },
  {
    key: "expiredInvitations",
    title: "Invitaciones vencidas",
    description: "Invitaciones que nadie aceptó ni anuló. Se reenvían o se anulan desde el equipo del consultorio.",
    emptyText: "No hay invitaciones vencidas.",
  },
  {
    key: "practitionersWithoutMembership",
    title: "Profesionales sin membresía",
    description: "Agendas de personas que ya no son parte del equipo del consultorio.",
    emptyText: "No hay agendas sueltas.",
  },
  {
    key: "profilesWithoutAccess",
    title: "Perfiles sin acceso",
    description: "Personas registradas que no son parte de ningún consultorio ni pacientes del portal.",
    emptyText: "No hay perfiles sin acceso.",
  },
];

export type DetectorState = "unavailable" | "ok" | "problem";

export function detectorState(d: HealthDetector<unknown>): DetectorState {
  if (!d.available) return "unavailable";
  return d.count > 0 ? "problem" : "ok";
}

export const UNAVAILABLE_COPY = "No disponible: no pudimos consultar el servicio de acceso. Buscá por email exacto en Usuarios para ver un caso puntual.";

/** «Sin problemas», «1 caso», «12 casos», o «No disponible». */
export function detectorCountLabel(d: HealthDetector<unknown>): string {
  if (!d.available) return "No disponible";
  if (d.count === 0) return "Sin problemas";
  return d.count === 1 ? "1 caso" : `${d.count} casos`;
}

/** Nota cuando la muestra no cubre el total («Mostramos los primeros 10 de 37»). */
export function sampleNote(d: HealthDetector<unknown>): string | null {
  if (!d.available || d.count <= d.sample.length) return null;
  return `Mostramos los primeros ${d.sample.length} de ${d.count}.`;
}

/** Problemas totales (para el encabezado). Los no disponibles no suman: se informan aparte. */
export function healthSummary(r: PlatformHealthReport): { problems: number; unavailable: number } {
  let problems = 0;
  let unavailable = 0;
  for (const c of HEALTH_DETECTORS) {
    const d = r[c.key] as HealthDetector<unknown>;
    if (!d.available) unavailable++;
    else problems += d.count;
  }
  return { problems, unavailable };
}

// ── Filas ────────────────────────────────────────────────────────────────────

export type HealthRowAction =
  | { kind: "createPractitioner"; tenantId: string; userId: string }
  | { kind: "deleteAuthOrphan"; authUserId: string; email: string | null }
  | { kind: "syncEmail"; userId: string; profileEmail: string; authEmail: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "none"; note: string };

export type HealthRowView = { id: string; primary: string; secondary: string; action: HealthRowAction };

const tenantPath = (id: string) => `/plataforma/consultorios/${encodeURIComponent(id)}`;
const teamPath = (id: string) => `${tenantPath(id)}/equipo`;
const userPath = (id: string) => `/plataforma/usuarios/${encodeURIComponent(id)}`;

function dateAR(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "short", year: "numeric" });
}

const role = (r: Role) => roleLabel(r);

/** Las filas de la muestra de un detector, ya con texto y acción. */
export function healthRows(key: HealthDetectorKey, r: PlatformHealthReport): HealthRowView[] {
  switch (key) {
    case "clinicalWithoutPractitioner":
      return r.clinicalWithoutPractitioner.sample.map((x) => ({
        id: `${x.tenantId}:${x.userId}`,
        primary: x.email,
        secondary: `${role(x.role)} en ${x.tenantName}`,
        action: { kind: "createPractitioner", tenantId: x.tenantId, userId: x.userId },
      }));
    case "tenantsWithoutOwner":
      return r.tenantsWithoutOwner.sample.map((x) => ({
        id: x.tenantId,
        primary: x.name,
        secondary: x.status === "SUSPENDED" ? `${x.slug} · suspendido` : x.slug,
        action: { kind: "link", href: teamPath(x.tenantId), label: "Ver equipo" },
      }));
    case "emailMismatches":
      return r.emailMismatches.sample.map((x) => ({
        id: x.userId,
        primary: x.profileEmail,
        secondary: `En la cuenta de acceso: ${x.authEmail}`,
        action: { kind: "syncEmail", userId: x.userId, profileEmail: x.profileEmail, authEmail: x.authEmail },
      }));
    case "authOrphans":
      return r.authOrphans.sample.map((x) => ({
        id: x.authUserId,
        primary: x.email ?? "(sin email)",
        secondary: `Creada ${dateAR(x.createdAt)}`,
        action: x.canDelete
          ? { kind: "deleteAuthOrphan", authUserId: x.authUserId, email: x.email }
          : { kind: "none", note: "Se usó (confirmó el email o entró): no se borra desde acá." },
      }));
    case "stalledOnboarding":
      return r.stalledOnboarding.sample.map((x) => ({
        id: x.tenantId,
        primary: x.name,
        secondary: `${x.slug} · empezó ${dateAR(x.createdAt)}`,
        action: { kind: "link", href: tenantPath(x.tenantId), label: "Ver consultorio" },
      }));
    case "expiredInvitations":
      return r.expiredInvitations.sample.map((x) => ({
        id: x.invitationId,
        primary: x.email,
        secondary: `${role(x.role)} en ${x.tenantName} · venció ${dateAR(x.expiresAt)}`,
        action: { kind: "link", href: tenantPath(x.tenantId), label: "Ver consultorio" },
      }));
    case "practitionersWithoutMembership":
      return r.practitionersWithoutMembership.sample.map((x) => ({
        id: x.practitionerId,
        primary: x.email,
        secondary: `Agenda en ${x.tenantName}`,
        action: { kind: "link", href: teamPath(x.tenantId), label: "Ver equipo" },
      }));
    case "profilesWithoutAccess":
      return r.profilesWithoutAccess.sample.map((x) => ({
        id: x.userId,
        primary: x.email,
        secondary: `Alta ${dateAR(x.createdAt)}`,
        action: { kind: "link", href: userPath(x.userId), label: "Ver usuario" },
      }));
  }
}
