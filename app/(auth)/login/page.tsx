import { LoginScreen } from "@/components/screens/login-screen";
import { safeNext } from "@/lib/safe-next";

export const metadata = { title: "Ingresá a KineSoft" };

/**
 * `?error=` es un CÓDIGO (A3b-S-auth): la pantalla lo traduce con un mapa
 * cerrado (`loginErrorMessage`); antes se pintaba el texto crudo de la query,
 * así cualquiera podía mandar un link `/login?error=Tu cuenta fue suspendida,
 * llamá al 11…` con el dominio de KineSoft. `next` pasa por `safeNext` y se
 * propaga a los forms de login y Google.
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string; email?: string };
}) {
  const next = safeNext(searchParams.next);
  return (
    <LoginScreen
      error={searchParams.error}
      next={next === "/dashboard" ? undefined : next}
      email={typeof searchParams.email === "string" ? searchParams.email.slice(0, 120) : undefined}
    />
  );
}
