import { redirect } from "next/navigation";
import { getActor } from "@/lib/session";
import { getCapabilities } from "@/lib/authz";
import { displayMemberName } from "@/lib/display-name";
import { listPractitioners } from "@/lib/bookings";
import { listOnlineCharges } from "@/lib/online-charges-read";
import { COBROS_COPY, cobrosActionInput, cobrosHref, cobrosPeriodOptions, parseCobrosFilters } from "@/lib/cobros-view";
import { logger } from "@/lib/logger";
import { mpConnectMode } from "@/lib/env";
import { PageHeader } from "@/components/ui/page-header";
import { CobrosClient } from "@/components/cobros/cobros-client";

export const metadata = { title: "Cobros" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

/**
 * [TP-3g] /cobros (T5, §25.10): los cobros online del consultorio (turnero y links de pago), con filtros en la URL,
 * resumen del período y paginación por cursor.
 *
 * - **Gate = el de la lectura** (`listOnlineCharges`, C-TP9): `billing.collect` ve todo el consultorio;
 *   `billing.collectOwn` con profesional propio, solo lo suyo (sin filtro de profesional). Sin ninguna de las dos
 *   (soporte, un Profesional sin profesional) → /dashboard. La barrera real sigue siendo la action: esto es UX.
 * - En el nav está SOLO con `billing.collect` (TP-UI-D7, Anexo C 3g): el Profesional llega por URL o desde el turno.
 * - Sin cobros: estado vacío (TP-UI-D7), no una tabla vacía.
 * - Con `MP_CONNECT_MODE=off` la página no existe (TP-ZF3): el nav ya la esconde (TP-3z), pero por URL abría la tabla
 *   vacía de una función apagada. Se corta antes de leer la sesión: no hay nada que mostrar a nadie.
 * - Una lectura de cobros (página + resumen en la misma tx, 2 sentencias) y la lista de profesionales cacheada.
 */
export default async function CobrosPage({ searchParams }: { searchParams?: SP }) {
  if (mpConnectMode() === "off") redirect("/dashboard");
  const [actor, caps] = await Promise.all([getActor(), getCapabilities()]);
  const all = caps.has("billing.collect");
  const own = caps.has("billing.collectOwn") && actor.practitionerId != null;
  if (!all && !own) redirect("/dashboard");

  const parsed = parseCobrosFilters(searchParams ?? {});
  // Quien solo ve lo suyo no filtra por profesional: un `?profesional=` ajeno en la URL no puede dejarle la página en
  // «No hay cobros con estos filtros» (la action igual le devolvería vacío).
  const filters = all ? parsed : { ...parsed, practitionerId: null };

  const practitionersP = all
    ? listPractitioners()
        .then((ps) => ps.map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) || "Profesional" })))
        .catch((e) => {
          // Sin la lista, la página sigue: solo se pierde el filtro de profesional.
          logger.warn("cobros.listPractitioners_failed", { err: e instanceof Error ? e.message : String(e) });
          return null;
        })
    : Promise.resolve(null);
  const [res, practitioners] = await Promise.all([listOnlineCharges(cobrosActionInput(filters)), practitionersP]);

  return (
    <>
      <PageHeader title={COBROS_COPY.title} description={COBROS_COPY.description} />
      <CobrosClient
        key={cobrosHref(filters)}
        filters={filters}
        initial={res.ok ? res.data : null}
        initialError={res.ok ? null : res.error}
        practitioners={practitioners}
        periodOptions={cobrosPeriodOptions(new Date())}
      />
    </>
  );
}
