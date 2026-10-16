"use server";

import { redirect } from "next/navigation";
import { sendPasswordReset, signUpPractitioner, updatePasswordWithRecoverySession } from "@/lib/auth";
import {
  formText,
  forgotStateFrom,
  resetMismatch,
  resetStateFrom,
  signupStateFrom,
  type ForgotFormState,
  type ResetFormState,
  type SignupFormState,
} from "@/components/auth/auth-form-state";

/**
 * [VX-Z FX-auth] Server actions con la forma de `useFormState` (`(prev, formData) => estado`) para signup, forgot y
 * reset: el form las recibe DIRECTAS y funciona sin JS (ver `auth-form-state.ts`). No agregan superficie: leen el
 * FormData y llaman a las actions de `lib/auth.ts`, que validan (zod), limitan (rate limit) y responden igual que
 * antes. Solo exporta funciones async (archivo `"use server"`); los tipos y el mapeo puro viven en `auth-form-state`.
 */

export async function signupFormAction(_prev: SignupFormState, fd: FormData): Promise<SignupFormState> {
  const values = { fullName: formText(fd, "fullName"), email: formText(fd, "email") };
  const r = await signUpPractitioner({ ...values, password: formText(fd, "password"), inviteToken: "" });
  // Contrato de IAM-2c: `redirectTo` solo con invitación (no llega desde este form, que manda ""). Si llegara, se
  // sigue y NO se muestra «te mandamos un email» (el bug del QA del 14-oct, §19.1 #4). `redirect` anda con y sin JS.
  if (r.ok && r.data.redirectTo) redirect(r.data.redirectTo);
  return signupStateFrom(r, values);
}

export async function forgotFormAction(_prev: ForgotFormState, fd: FormData): Promise<ForgotFormState> {
  const email = formText(fd, "email").trim();
  return forgotStateFrom(await sendPasswordReset({ email }), email);
}

export async function resetFormAction(_prev: ResetFormState, fd: FormData): Promise<ResetFormState> {
  const password = formText(fd, "password");
  const mismatch = resetMismatch(password, formText(fd, "confirm"));
  if (mismatch) return mismatch;
  // `currentPassword` solo existe en el form del modo «change»; el server decide el modo por la cookie `ks_recovery`.
  return resetStateFrom(
    await updatePasswordWithRecoverySession({ password, currentPassword: formText(fd, "currentPassword") })
  );
}
