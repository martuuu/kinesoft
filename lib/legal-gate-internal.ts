import "server-only";
/**
 * LG-G (§27): `hasAcceptedCurrentLegal` memoizada POR REQUEST (`cache` de React: dura un render RSC) para el gate de
 * `app/(app)/layout.tsx`, que corre en cada carga completa del workspace: una sola sentencia por request aunque otro
 * server component del mismo render la vuelva a pedir.
 *
 * Es UNA sentencia liviana: `findFirst` (`LIMIT 1`) sobre el índice `(userId, createdAt)` de M8. No hay índice por
 * `(userId, kind)` y no hace falta: las filas por usuario son pocas (eventos de 2FA y aceptaciones; ningún login
 * escribe acá). Sin migración.
 *
 * Archivo aparte y no en `legal-acceptance-internal.ts`: ese módulo lo importa `lib/auth.ts`, que cargan tests unit
 * sin el build react-server (ahí `cache` no existe y el import tiraba). En una server action `cache` no memoiza; la
 * action de `/aceptar-terminos` usa igual la versión sin cache.
 */
import { cache } from "react";
import { hasAcceptedCurrentLegal } from "@/lib/legal-acceptance-internal";

export const hasAcceptedCurrentLegalCached: (userId: string) => Promise<boolean> = cache((userId: string) =>
  hasAcceptedCurrentLegal(userId)
);
