import "server-only";
/**
 * Zod de las actions del reparto (`lib/revenue-share.ts`: `setRevenueShare`, `endRevenueShare`). CF2 · P.3.
 *
 * `server-only` (como `lib/clinical-notes-schemas.ts`): el editor valida con `parseSharePct` / `validateShareGraph`
 * de `lib/revenue-share-logic.ts`, que es liviano; zod entero no entra al bundle de Configuración.
 *
 * Los ids son SOLO forma: que el que destina y el que recibe sean del tenant (y el receptor reservable) lo valida la
 * action dentro de la tx con `assertSharePractitionersInTx`, porque las FK saltean RLS y en prod la conexión tiene
 * BYPASSRLS. El grafo (mutuo, cadenas) también se valida adentro, con las vigentes leídas bajo el lock.
 */
import { z } from "zod";
import { parseSharePct } from "@/lib/revenue-share-logic";
import { REVENUE_SHARE_COPY, SHARE_GRAPH_ERROR_COPY } from "@/lib/revenue-share-types";

/** Ids de Prisma (cuid) y de los tests: el molde de `UrlIdSchema` (lib/plans-deeplink.ts). */
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Id inválido");

/** El % como lo escribe el usuario («12,5»); sale como bps enteros. El tope de largo evita payloads absurdos. */
const SharePctSchema = z
  .string()
  .max(16, REVENUE_SHARE_COPY.invalidPct)
  .transform((raw, ctx) => {
    const bps = parseSharePct(raw);
    if (bps === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: REVENUE_SHARE_COPY.invalidPct });
      return z.NEVER;
    }
    return bps;
  });

/** Las 3 casillas, todas presentes; al menos una (= CHECK `PractitionerRevenueShare_sources_check`). */
const SourcesSchema = z
  .object({ manual: z.boolean(), online: z.boolean(), insurer: z.boolean() })
  .strict()
  .refine((s) => s.manual || s.online || s.insurer, { message: REVENUE_SHARE_COPY.noSources });

/**
 * Guardar «desde ahora»: cierra la vigente del que destina (si hay) en `now` y abre esta desde `now`.
 * `expectedOpenId` = el id de la vigente que vio el editor (`null` = no había): CAS contra otra pestaña; si no
 * coincide con la vigente leída bajo el lock → «Cambió mientras lo editabas».
 * Sale `{ giverPractitionerId, receiverPractitionerId, shareBps, sources, expectedOpenId }` (sin el texto del %).
 */
export const SetRevenueShareSchema = z
  .object({
    giverPractitionerId: IdSchema,
    receiverPractitionerId: IdSchema,
    sharePct: SharePctSchema,
    sources: SourcesSchema,
    expectedOpenId: IdSchema.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.giverPractitionerId === v.receiverPractitionerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiverPractitionerId"], message: SHARE_GRAPH_ERROR_COPY.self });
    }
  })
  .transform(({ sharePct, ...rest }) => ({
    giverPractitionerId: rest.giverPractitionerId,
    receiverPractitionerId: rest.receiverPractitionerId,
    shareBps: sharePct,
    sources: rest.sources,
    expectedOpenId: rest.expectedOpenId,
  }));
export type SetRevenueShareInput = z.output<typeof SetRevenueShareSchema>;

/** «Dejar de destinar»: cierra en `now` la vigente que vio el editor (CAS obligatorio: no se cierra a ciegas). */
export const EndRevenueShareSchema = z
  .object({
    giverPractitionerId: IdSchema,
    expectedOpenId: IdSchema,
  })
  .strict();
export type EndRevenueShareInput = z.output<typeof EndRevenueShareSchema>;
