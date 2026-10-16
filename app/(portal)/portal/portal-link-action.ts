"use server";

import { requestPortalLink } from "@/lib/portal-auth";
import { formText, portalLinkStateFrom, type PortalLinkFormState } from "@/components/auth/auth-form-state";

/**
 * [VX-Z FX-portal] «Entrar con tu email» con la forma de `useFormState`: el form la recibe directa y anda sin JS (antes
 * era `onSubmit` + `preventDefault`, que sin JS mandaba un GET a /portal con el email en la URL y no pasaba nada).
 * Delega en `requestPortalLink` (validación, rate limit y respuesta genérica sin cambios).
 */
export async function portalLinkFormAction(_prev: PortalLinkFormState, fd: FormData): Promise<PortalLinkFormState> {
  const email = formText(fd, "email").trim();
  const body = new FormData();
  body.set("email", email);
  const slug = formText(fd, "slug");
  if (slug) body.set("slug", slug);
  return portalLinkStateFrom(await requestPortalLink(body), email);
}
