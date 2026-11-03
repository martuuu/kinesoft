/**
 * CF2 (§29, decisión 2 de Martin) · nombres de TODOS los profesionales del consultorio, para la celda
 * «Kinesiólogo»/«Profesional» del directorio de pacientes (`/pacientes`).
 *
 * Por qué no `listPractitioners` (lib/bookings.ts): ese filtra reservables y sin suspender (es el selector del alta y de
 * la agenda). La celda muestra el a cargo y los que tuvieron turnos con el paciente: un profesional suspendido o quitado
 * del equipo sigue siendo «a cargo» de sus pacientes y dueño de sus turnos pasados, y sin su nombre la celda caería al
 * fallback «Profesional». Por eso van todos, con su estado para que la UI pueda marcarlos.
 *
 * Estado: `removed` = la fila `Practitioner` queda pero ya no hay membership en este consultorio (`removeMemberInTx`
 * borra la membership y conserva el profesional por sus turnos); `suspended` = membership o usuario con `disabledAt`;
 * `active` = el resto.
 *
 * Cache: `unstable_cache` con `["practitioners:names", tenantId]` y el tag `tags.practitioners` (el mismo que
 * `listPractitioners`): lo revalidan ya las mutaciones de equipo (alta, suspensión, baja) y de perfil. `ttl.short`
 * acota un nombre viejo si algún escritor no revalida. Nombres con `displayMemberName` (nunca el email, guard
 * `no-email-as-name`). Datos no clínicos: los ve cualquier rol del consultorio.
 *
 * `server-only` y no "use server": lo llama la página (server component), no un cliente.
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { tags, ttl } from "@/lib/cache-tags";
import { displayMemberName } from "@/lib/display-name";

export type PractitionerNameStatus = "active" | "suspended" | "removed";
export type PractitionerName = { id: string; name: string; status: PractitionerNameStatus };

async function loadPractitionerNames(tenantId: string): Promise<PractitionerName[]> {
  const rows = await runWithRls(tenantId, (tx) =>
    tx.practitioner.findMany({
      // `tenantId` a mano: en prod la conexión es BYPASSRLS. La membership se filtra al MISMO consultorio (un usuario
      // puede ser miembro de varios desde IAM-1).
      where: { tenantId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        user: {
          select: {
            fullName: true,
            disabledAt: true,
            memberships: { where: { tenantId }, select: { disabledAt: true }, take: 1 },
          },
        },
      },
    }),
  );
  return rows.map((p) => {
    const m = p.user.memberships[0];
    const status: PractitionerNameStatus = !m ? "removed" : m.disabledAt || p.user.disabledAt ? "suspended" : "active";
    return { id: p.id, name: displayMemberName(p.user.fullName), status };
  });
}

export async function listPractitionerNames(): Promise<PractitionerName[]> {
  const actor = await getActor();
  const fetcher = unstable_cache(loadPractitionerNames, ["practitioners:names", actor.tenantId], {
    tags: [tags.practitioners(actor.tenantId)],
    revalidate: ttl.short,
  });
  return fetcher(actor.tenantId);
}
