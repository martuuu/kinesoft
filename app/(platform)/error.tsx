"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * [BO-Z B9] Error boundary del grupo `(platform)`. Sin este archivo, un error de una página de Plataforma (DB caída,
 * GoTrue lento) subía hasta el boundary raíz y se perdía el shell de Plataforma con su navegación: el superadmin
 * quedaba en una pantalla sin salida. Con este, el error queda dentro del shell (el layout del grupo sigue montado) y
 * «Reintentar» re-renderiza solo la sección. `RouteError` ya reporta el error y muestra el `digest`, nunca el mensaje.
 */
export default function PlatformSectionError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} kind="route" title="No pudimos cargar esta sección de Plataforma" />;
}
