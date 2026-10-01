"use client";

/**
 * Guard de cambios sin guardar para el detalle de sesión (A2a-S03 ítem 2).
 *
 * Motivo: las notas / EVA / RPE del panel viven en estado local hasta que se
 * aprieta "Guardar anotaciones" o "Cerrar sesión". Salir de la página (rail de
 * sesiones, breadcrumbs, sidebar, cerrar la pestaña) las tiraba sin aviso.
 *
 * Cubre dos caminos:
 *   - `beforeunload` → recarga / cierre de pestaña / links `<a>` planos (el
 *     navegador muestra su propio aviso; no se puede estilar);
 *   - navegación cliente de Next (`<Link>`): no dispara `beforeunload`, así
 *     que se intercepta el click en fase de CAPTURA sobre `document` (corre
 *     antes que el handler de React del Link), se frena y se pregunta con
 *     `useConfirm`. Si confirma, se navega con `router.push`.
 * Solo links same-origin, click izquierdo sin modificadores y sin
 * `target=_blank` (abrir en otra pestaña no pierde nada).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/confirm-dialog";

export function useUnsavedGuard(dirty: boolean) {
  const confirm = useConfirm();
  const router = useRouter();

  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome todavía exige returnValue para mostrar el aviso.
      e.returnValue = "";
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({
        title: "¿Salir sin guardar?",
        message: "Tenés anotaciones de la sesión sin guardar (notas, EVA o RPE). Si salís, se pierden.",
        confirmLabel: "Salir sin guardar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      }).then((ok) => {
        if (ok) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, confirm, router]);
}
