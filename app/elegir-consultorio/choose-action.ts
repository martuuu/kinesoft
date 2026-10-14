"use server";

import { redirect } from "next/navigation";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { safeChoiceNext, setActiveTenant } from "@/lib/tenant-choice";

/**
 * Form de `/elegir-consultorio` (IAM-3a, decisión 6): deja el consultorio elegido como activo (`setActiveTenant`
 * valida que sea una membresía usable de la sesión, escribe la cookie y el preferido) y vuelve a donde iba.
 *
 * Sin `getActor()`: justamente se está eligiendo a qué consultorio entrar; la barrera es la validación de
 * membresía de `setActiveTenant` sobre el usuario verificado. `next` pasa por `safeChoiceNext` (nada de open redirect).
 * Los `redirect` van fuera del try: `redirect` tira `NEXT_REDIRECT` y el catch lo tragaría.
 */
export async function chooseTenantAction(formData: FormData): Promise<void> {
  const tenantId = String(formData.get("tenantId") ?? "");
  const next = safeChoiceNext(String(formData.get("next") ?? ""));
  let outcome: "ok" | "forbidden" | "no_session" = "ok";
  try {
    await setActiveTenant(tenantId);
  } catch (err) {
    if (err instanceof ForbiddenError) outcome = "forbidden";
    else if (err instanceof UnauthenticatedError) outcome = "no_session";
    else throw err;
  }
  if (outcome === "no_session") redirect(`/login?next=${encodeURIComponent(`/elegir-consultorio?next=${encodeURIComponent(next)}`)}`);
  if (outcome === "forbidden") {
    redirect(`/elegir-consultorio?error=no_disponible${next !== "/dashboard" ? `&next=${encodeURIComponent(next)}` : ""}`);
  }
  redirect(next);
}
