import { getDashboardData, getMonthBookingDays } from "@/lib/dashboard";
import { getUserPreferences } from "@/lib/preferences";
import { DashboardScreen } from "@/components/screens/dashboard-screen";
import { toARDateKey } from "@/lib/datetime-ar";

export const metadata = { title: "Dashboard · KineSoft" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // "Current month" for the mini-calendar is the AR calendar month, not the
  // host's — otherwise the initial dots load the wrong month near midnight.
  const [arYear, arMonth] = toARDateKey(new Date()).split("-").map(Number);
  const [data, preferences, bookingDays] = await Promise.all([
    getDashboardData(),
    getUserPreferences(),
    getMonthBookingDays(arYear, arMonth - 1),
  ]);
  return (
    <DashboardScreen data={data} preferences={preferences} initialBookingDays={bookingDays} />
  );
}
