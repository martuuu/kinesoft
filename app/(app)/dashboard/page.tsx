import { getDashboardData, getMonthBookingDays } from "@/lib/dashboard";
import { getUserPreferences } from "@/lib/preferences";
import { DashboardScreen } from "@/components/screens/dashboard-screen";

export const metadata = { title: "Dashboard · KineSoft" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const now = new Date();
  const [data, preferences, bookingDays] = await Promise.all([
    getDashboardData(),
    getUserPreferences(),
    getMonthBookingDays(now.getFullYear(), now.getMonth()),
  ]);
  return (
    <DashboardScreen data={data} preferences={preferences} initialBookingDays={bookingDays} />
  );
}
