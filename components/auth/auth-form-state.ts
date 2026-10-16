import type { ActionResult } from "@/lib/validation";

/**
 * [VX-Z FX-auth] Estado de los forms de auth con `useFormState` (signup, forgot, reset) y del email del portal.
 *
 * Por qué existe: los forms llamaban a la server action desde una función del cliente (`<form action={onSubmit}>`
 * con `useTransition`). Sin JS (o con el bundle todavía cargando en un 3G) React pinta ese form con un `action`
 * que no va a ningún lado: el clic no hacía nada (VX-Z revisor a, MEDIO «sin JS»). Ahora cada form usa
 * `useFormState(<action del server>, null)` con la action **directa** (`auth-form-actions.ts`, `"use server"`): sin
 * JS el POST va igual y la página vuelve con este estado. Puro, para testearlo sin red.
 *
 * Cada envío devuelve un objeto NUEVO: la pantalla usa esa identidad para «¿Email equivocado? Volver» (descarta el
 * estado actual sin borrar lo tipeado) y para mover el foco solo cuando cambia.
 */

export type FieldErrors = Record<string, string[] | undefined>;

export type SignupFormState =
  | null
  | { status: "error"; error: string; fieldErrors: FieldErrors; values: { fullName: string; email: string } }
  | { status: "sent"; email: string; message: string; values: { fullName: string; email: string } };

export type ForgotFormState =
  | null
  | { status: "error"; error: string; email: string }
  | { status: "sent"; email: string };

export type ResetFormState =
  | null
  | { status: "error"; error: string | null; fieldErrors: FieldErrors }
  | { status: "done" };

export type PortalLinkFormState =
  | null
  | { status: "error"; error: string; email: string }
  | { status: "sent"; email: string; message: string };

/** Texto de un campo del FormData (un `File` o la ausencia valen ""). */
export function formText(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

export function signupStateFrom(
  r: ActionResult<{ email: string; message: string }>,
  values: { fullName: string; email: string }
): Exclude<SignupFormState, null> {
  if (!r.ok) return { status: "error", error: r.error, fieldErrors: r.fieldErrors ?? {}, values };
  return { status: "sent", email: r.data.email, message: r.data.message, values };
}

export function forgotStateFrom(r: ActionResult, email: string): Exclude<ForgotFormState, null> {
  return r.ok ? { status: "sent", email } : { status: "error", error: r.error, email };
}

export const PASSWORD_MISMATCH = "Las contraseñas no coinciden.";

/** El chequeo de «confirmar» antes de ir al server (vivía en el cliente: sin JS no corría). */
export function resetMismatch(password: string, confirm: string): Exclude<ResetFormState, null> | null {
  return password === confirm ? null : { status: "error", error: null, fieldErrors: { confirm: [PASSWORD_MISMATCH] } };
}

export function resetStateFrom(r: ActionResult): Exclude<ResetFormState, null> {
  return r.ok ? { status: "done" } : { status: "error", error: r.error, fieldErrors: r.fieldErrors ?? {} };
}

/** Portal: el error de campo manda sobre el genérico (como antes: `fieldErrors.email[0] ?? error`). */
export function portalLinkStateFrom(
  r: ActionResult<{ message: string }>,
  email: string
): Exclude<PortalLinkFormState, null> {
  if (!r.ok) return { status: "error", error: r.fieldErrors?.email?.[0] ?? r.error, email };
  return { status: "sent", email, message: r.data.message };
}
