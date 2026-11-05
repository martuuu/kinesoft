/**
 * CF3b CT-L (M23): forma del input de `setOwnLicense` (`lib/user-license.ts`). zod solo acota la FORMA (strings cortos o
 * null) y descarta lo que no es del contrato; las reglas del dominio y su copy por campo son de
 * `parseUserLicenseInput` (`lib/user-license-logic.ts`, pura, la misma que usa el formulario).
 *
 * `z.object` descarta las claves desconocidas: un `userId` (o cualquier otra cosa) que el cliente mande en el objeto no
 * llega ni al parser. El `userId` sale SIEMPRE de la sesión (UserProfile no tiene RLS: es la única barrera).
 *
 * Separado de la lógica para que zod no entre al chunk del formulario.
 */
import { z } from "zod";

/** Tope de forma (no de dominio): el número válido llega a 30; esto solo corta basura grande antes de normalizar. */
const field = z.union([z.string().max(200), z.null()]).optional();

export const setOwnLicenseSchema = z.object({ kind: field, number: field, jurisdiction: field });

export type SetOwnLicenseInput = {
  kind: "MN" | "MP" | null;
  number: string | null;
  /** Código de provincia (`ProvinceCode`, `lib/ar-provinces.ts`); solo con MP. */
  jurisdiction: string | null;
};
