import { LoginScreen } from "@/components/screens/login-screen";

export const metadata = { title: "Ingresá a KineSoft" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  // /api/auth/sign-in redirects back here with a Spanish ?error= message on
  // bad/missing credentials; surface it instead of silently dropping it.
  return <LoginScreen error={searchParams.error} />;
}
