"use server";

/**
 * Buscador de pacientes de la agenda (P2-FX1, ES2b ola P2.2).
 *
 * Por qué existe: el `PatientPicker` del modal y del drawer de turnos usaba
 * `searchPatientsForAssignment` (lib/diagnosis.ts). Desde H-b4 (ES1) esa
 * action devuelve solo pacientes con acceso `full` y desde S17d exige el
 * módulo `diagnostico`. Resultado: la Secretaria (nivel `admin`, PD-13) no
 * encontraba a nadie al crear/editar turnos (rompía PD-09), un PRACTITIONER
 * no encontraba a los pacientes que ve en básico y en un consultorio GENERAL
 * el buscador quedaba vacío.
 *
 * Reglas (las de la agenda, no las del Plan Builder):
 *  - sin gate de módulo: la agenda existe en todas las verticales;
 *  - sin filtro por nivel de acceso: nombre + DNI es justamente lo que
 *    muestran las proyecciones `basic` y `admin`, así que devolverlo no abre
 *    nada que el rol no vea ya en /pacientes. Operar el turno lo decide el
 *    server de turnos (`lib/bookings*.ts`), que ya rechaza donde no
 *    corresponde;
 *  - DTO mínimo `{ id, firstName, lastName, documentId }`: nada clínico, ni
 *    edad, ni plan, ni email/teléfono. Tampoco se busca por email: sería un
 *    oráculo de un dato que `basic` no muestra (mismo criterio que H-b1 en
 *    `listPatients`);
 *  - `where: { tenantId }` a mano: en prod la conexión tiene BYPASSRLS y es
 *    la única barrera (RLS queda como segunda capa en local/`kinesoft_app`);
 *  - archivados fuera, igual que el listado por defecto de /pacientes.
 *
 * Sin rate-limit: `globalSearch` (⌘K, `lib/search.ts`) tampoco lo usa y esta
 * action exige sesión con membresía; el `take` acota el costo por llamada.
 */
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { escapeLike } from "@/lib/email-match";
import type { BookingPatientHit } from "@/lib/patient-search-types";

/** Tope de filas: un dropdown, no un listado. */
const TAKE = 12;

const querySchema = z.string().trim().min(1).max(80);

/**
 * Variante "solo dígitos" de un término con forma de DNI tipeado con
 * separadores ("30.123.456", "30 123 456"). El DNI se guarda tal como se
 * cargó (trim, sin normalizar: `lib/validation.ts`), y la mayoría de las
 * fichas lo tiene sin puntos: sin esta variante, tipear con puntos no
 * encontraba al paciente. `null` si el término no es un DNI con separadores.
 */
function dniDigitsVariant(term: string): string | null {
  if (!/^[\d.\s-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  return digits.length >= 3 && digits !== term ? digits : null;
}

export async function searchPatientsForBooking(q: string): Promise<BookingPatientHit[]> {
  const actor = await getActor();
  // Término vacío o desmedido → [] sin query (el picker no busca con vacío).
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) return [];
  const term = parsed.data;
  const insensitive = "insensitive" as const;
  const matches = (t: string) => {
    const digits = dniDigitsVariant(t);
    // EV1 (integrador): Prisma no escapa `%`/`_` en `contains` + insensitive (ILIKE con el valor tal cual);
    // `digits` son solo [0-9], no necesitan escape.
    const like = escapeLike(t);
    return {
      OR: [
        { firstName: { contains: like, mode: insensitive } },
        { lastName: { contains: like, mode: insensitive } },
        { documentId: { contains: like, mode: insensitive } },
        ...(digits ? [{ documentId: { contains: digits } }] : []),
      ],
    };
  };
  // "Juan Pérez" (nombre + apellido, lo más común al dar un turno) no matchea
  // ningún campo entero: con varias palabras, cada una tiene que aparecer en
  // algún campo. El término completo también vale (apellidos compuestos
  // "De la Fuente", DNI con espacios).
  // Tope de 5 palabras: 80 caracteres podrían ser 40 tokens = 40 ORs.
  const words = term.split(/\s+/).filter(Boolean).slice(0, 5);
  const textMatch = words.length > 1 ? { OR: [matches(term), { AND: words.map(matches) }] } : matches(term);

  return runWithRls(actor.tenantId, (tx) =>
    tx.patient.findMany({
      where: {
        tenantId: actor.tenantId,
        archivedAt: null,
        ...textMatch,
      },
      take: TAKE,
      // `id` desempata homónimos: el orden (y qué entra en el take) es
      // determinístico.
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: { id: true, firstName: true, lastName: true, documentId: true },
    })
  );
}
