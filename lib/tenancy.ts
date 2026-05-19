import { headers } from "next/headers";
import { cache } from "react";
import { prisma } from "./db";

/**
 * Per-request tenant context. Resolved by middleware which sets the
 * `x-tenant-slug` header from subdomain or `/c/<slug>/...` path.
 */
export const getTenantContext = cache(async () => {
  const h = headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, palette: true, timezone: true, currency: true },
  });
  return tenant;
});

export async function requireTenant() {
  const t = await getTenantContext();
  if (!t) throw new Error("No tenant in context");
  return t;
}
