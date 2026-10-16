import { getDashboardPageData } from "@/lib/dashboard";
import { DashboardScreen } from "@/components/screens/dashboard-screen";

// PF1.1-dashboard (C-PF5.8): el nav la llama «Inicio»; la pestaña del navegador decía «Dashboard», en inglés.
export const metadata = { title: "Inicio · KineSoft" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // PF2-a (C-PF8): una sola carga con ≤ 2 tx en frío y ≤ 1 en caliente. Antes, `Promise.all` de
  // `getDashboardData`, `getUserPreferences` y `getMonthBookingDays`: 15-16 tx en frío, 4 en caliente, y las
  // preferencias leídas dos veces. El mes del mini-calendario sigue siendo el mes AR (no el del host), adentro.
  const { data, preferences, bookingDays } = await getDashboardPageData();
  return <DashboardScreen data={data} preferences={preferences} initialBookingDays={bookingDays} />;
}
