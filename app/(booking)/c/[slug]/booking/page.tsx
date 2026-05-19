import { BookingScreen } from "@/components/screens/booking-screen";

export const metadata = { title: "Reservá tu turno · KineSoft" };

export default function PublicBookingPage({
  params,
}: {
  params: { slug: string };
}) {
  return <BookingScreen tenantSlug={params.slug} />;
}
