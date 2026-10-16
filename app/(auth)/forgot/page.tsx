import { ForgotScreen } from "@/components/screens/forgot-screen";
import { BRAND_NAME } from "@/lib/brand";

export const metadata = { title: `Recuperar contraseña · ${BRAND_NAME}` };

export default function ForgotPage() {
  return <ForgotScreen />;
}
