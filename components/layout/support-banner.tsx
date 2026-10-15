"use client";

/**
 * Banda de SOPORTE (BO3-F; decisión 3 de Martin, literal: «Entrar como soporte» abre el consultorio con banda
 * visible y registro en ese consultorio; sin vencimiento (termina con «Salir de soporte» o al cerrar sesión); solo
 * lectura en todo salvo Configuración, donde puede crear y modificar; sin acceso clínico (ve lo que ve la
 * Secretaria)).
 *
 * La monta el AppShell arriba de la columna de contenido cuando `actor.support`: sticky (siempre a la vista al
 * scrollear) pero EN el flujo, así empuja el layout en vez de tapar la primera fila de la agenda. Va en la columna y
 * no arriba de todo para no pisar el sidebar, que también es sticky.
 *
 * - «Salir de soporte»: `endSupport` (lib/platform-support.ts) cierra la fila y borra la cookie; después navegación
 *   DURA a lo que devuelva (hoy /plataforma): una blanda dejaba montados el canal realtime y el estado cliente del
 *   consultorio ajeno. La action llega por props desde el layout (mismo patrón que `switchTenant`): así este módulo no
 *   arrastra código de server a los tests de render.
 * - Red para las escrituras rechazadas: en soporte, todo lo que no es Configuración tira `ReadOnlyModeError`
 *   (C-BO4). Muchas pantallas no atrapan el throw de la action (p. ej. `createBooking`) y en producción Next lo
 *   redacta a un error genérico con `digest`: el usuario no veía nada. Mientras dure el soporte, un rechazo no
 *   atrapado de una action se muestra como Toast con el copy de soporte. Es una red, no el arreglo: cada action
 *   debería devolver `{ ok:false, error }` (handoffs en el reporte de BO3-F).
 */
import { useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/ui/toast";
import { SUPPORT_READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import type { ActionResult } from "@/lib/validation";
import { isWriteRejection, useWriteRejectionToast } from "@/hooks/use-write-rejection-toast";

export type EndSupportAction = () => Promise<ActionResult<{ redirectTo: string }>>;

export const SUPPORT_BANNER_PLATFORM_HREF = "/plataforma";

/**
 * Qué selector de consultorio publica el shell. En soporte, ninguno: las opciones son los consultorios PROPIOS del
 * superadmin y el activo es el de soporte (que no está en la lista), así que el selector mostraba el propio como si
 * fuera el actual, y elegirlo cambiaba la cookie de consultorio sin cerrar el soporte (que gana sobre ella). Se sale
 * con «Salir de soporte»; dónde está lo dice la banda. Puro y genérico para que el layout (server) y el test lo usen.
 */
export function shellTenantChoice<O, A>(
  support: boolean,
  options: readonly O[],
  switchAction: A
): { options: readonly O[]; switchAction: A | null } {
  return support ? { options: [], switchAction: null } : { options, switchAction };
}

/** Texto de la banda (exportado para el test de render). */
export function supportBannerText(tenantName: string): { title: string; detail: string } {
  return {
    title: `Estás como soporte en ${tenantName}`,
    detail: "Solo lectura, salvo Configuración · Sin historia clínica",
  };
}

/**
 * ¿Este rechazo no atrapado es una escritura frenada por el modo soporte? En dev llega el `ReadOnlyModeError` con su
 * mensaje; en producción Next lo reemplaza por un Error genérico con `digest` (el mensaje real no sale del server).
 * Cualquier otra cosa (un fetch del cliente, un bug de UI) no se toca. La lógica es la común de
 * `hooks/use-write-rejection-toast.ts` (BO-Z B10).
 */
export function isSupportWriteRejection(reason: unknown): boolean {
  return isWriteRejection(reason, [SUPPORT_READ_ONLY_MESSAGE]);
}

/**
 * [BO-Z C4] En /configuracion el soporte SÍ puede escribir (C-BO4): un rechazo redactado ahí no es el modo lectura
 * sino un error de verdad, y decirle «acá solo podés mirar» lo mandaba a buscar un permiso que ya tiene.
 */
export const SUPPORT_CONFIG_ERROR_MESSAGE = "Probá de nuevo; si sigue, avisá al equipo.";

export function supportRejectionMessage(pathname: string, reason: unknown): string {
  const r = (reason ?? {}) as { name?: unknown; message?: unknown };
  const explicitReadOnly = r.name === "ReadOnlyModeError" || r.message === SUPPORT_READ_ONLY_MESSAGE;
  if (!explicitReadOnly && (pathname === "/configuracion" || pathname.startsWith("/configuracion/"))) {
    return SUPPORT_CONFIG_ERROR_MESSAGE;
  }
  return SUPPORT_READ_ONLY_MESSAGE;
}

const supportDescription = (reason: unknown) =>
  supportRejectionMessage(typeof window === "undefined" ? "" : window.location.pathname, reason);

export function SupportBanner({
  tenantName,
  endSupportAction,
}: {
  tenantName: string;
  endSupportAction: EndSupportAction | null;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const { title, detail } = supportBannerText(tenantName);

  useWriteRejectionToast({ enabled: true, matches: isSupportWriteRejection, description: supportDescription });

  const exit = async () => {
    if (!endSupportAction || pending) return;
    setPending(true);
    try {
      const r = await endSupportAction();
      if (r.ok) {
        window.location.assign(r.data.redirectTo);
        return; // queda «Saliendo…» hasta que cargue la otra página
      }
      toast.error("No pudimos salir de soporte", { description: r.error });
    } catch {
      toast.error("No pudimos salir de soporte", { description: "Reintentá en un momento o cerrá sesión." });
    }
    setPending(false);
  };

  return (
    <div
      role="status"
      data-support-banner
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        margin: "14px 14px 0",
        padding: "10px 14px",
        borderRadius: "var(--r-md, 14px)",
        // navy-900 + blanco: 16:1, AA de sobra en cualquier paleta (los tokens de la paleta cambian con Tweaks; la
        // banda no tiene que perder contraste por eso).
        background: "#0f1e33",
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        boxShadow: "0 6px 18px rgba(15,30,51,0.18)",
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0, lineHeight: 1.4 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, overflowWrap: "anywhere" }}>{title}</div>
        {/* C6: bajo 640 px el detalle se esconde (globals.css) para que la banda sticky no se coma media pantalla. */}
        <div className="k-support-detail" style={{ fontSize: 12.5, color: "#d9e2ef" }}>
          {detail}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link
          href={SUPPORT_BANNER_PLATFORM_HREF}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "8px 14px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            color: "#ffffff",
            textDecoration: "none",
            border: "1px solid rgba(255,255,255,0.45)",
          }}
        >
          Volver a Plataforma
        </Link>
        <button
          type="button"
          onClick={() => void exit()}
          disabled={!endSupportAction || pending}
          aria-busy={pending || undefined}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            fontSize: 13,
            fontWeight: 700,
            // lime-300 sobre navy-900 en el texto: 13:1.
            background: "#c8f564",
            color: "#0f1e33",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "Saliendo…" : "Salir de soporte"}
        </button>
      </div>
    </div>
  );
}
