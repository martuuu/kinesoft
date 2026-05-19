import { notFound } from "next/navigation";
import { getPublicBookingStatus } from "@/lib/public-booking";
import { BookingResult } from "@/components/booking/booking-result";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pago en proceso · KineSoft" };

export default async function BookingPendingPage({ params }: { params: { id: string } }) {
  const status = await getPublicBookingStatus(params.id);
  if (!status) notFound();
  return <BookingResult initial={status} variant="pending" />;
}
