import "server-only";
/**
 * [BO3-B] El layout del detalle (`consultorios/[id]/layout.tsx`) y cada pestaña piden el mismo
 * `getPlatformTenantDetail`. `cache` de React lo deduplica dentro del MISMO request (no entre requests: el
 * superadmin siempre ve la foto actual, que es la que viaja como `expectedUpdatedAt` del CAS).
 */
import { cache } from "react";
import { getPlatformTenantDetail } from "@/lib/platform-tenants-read";

export const loadTenantDetail = cache(getPlatformTenantDetail);
